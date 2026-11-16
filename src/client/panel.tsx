/**
 * The EditorAutomation call-history panel.
 *
 * One React tree over the host's `snapshot` reply: it renders what was
 * recorded for **the session the tab is attached to** and nothing else. The
 * session id comes from the sidebar seat (`sidebar.right.pane.tab` is a
 * session-scope slot, so the framework hands the body its `sessionId`), with a
 * structural fallback for hosts that compose it differently.
 *
 * The data contract lives in `wire.ts`, which narrows the untrusted reply.
 *
 * @module dsh-unreal/client/panel
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

import css from './panel.module.css'
import { actionTitle, failureLine } from './card-title.ts'
import { DetailsView, LocalizedNamesProvider, cultureFromText } from './details-view.tsx'
import type { LocalizeNames } from './details-view.tsx'
import { localize } from './locales.ts'
import type { MsgKey, Translator } from './locales.ts'
import { errorLabel, editorIdentityLabel, formatClock, toolLabel } from './format.ts'
import type { Lookup } from './format.ts'
import { RawDataDisclosure } from './raw-data.tsx'
import { MAX_ROW_LIMIT, clearHistory, fetchSnapshot, localizeTexts } from './wire.ts'
import type { OperationView, RpcCaller, SnapshotView } from './wire.ts'

/** How many operations the panel asks for. The host caps this itself. */
const ROW_LIMIT = Math.min(200, MAX_ROW_LIMIT)

/**
 * How often the panel re-reads the snapshot. The read is in-memory work on the
 * host, so this is cheap; a fetch already in flight is aborted rather than
 * queued, so a slow host degrades to fewer reads, never to a pile.
 */
const POLL_MS = 4000

/** What the panel currently knows. */
type PanelState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly snapshot: SnapshotView }
  | { readonly phase: 'error'; readonly code: string; readonly message: string }

/** Props the seat supplies: the channel caller and the session. */
export interface PanelProps {
  /** The plugin's channel caller, when the host has one. */
  readonly caller?: RpcCaller | undefined
  /** The session this tab belongs to, when the shell composes one. */
  readonly sessionId?: string | undefined
  /** Resolve the session structurally for hosts that do not pass it as a prop. */
  readonly resolveSessionId?: (() => string | undefined) | undefined
  /** The framework's translator for this plugin's locale namespace. */
  readonly t?: Translator | undefined
  /** The seat injects owner props alongside these; the panel ignores them. */
  readonly [key: string]: unknown
}

/** Props of the right-sidebar tab chip. */
export interface ChipProps {
  /** The framework's translator for this plugin's locale namespace. */
  readonly t?: Translator | undefined
  /** The seat injects owner props alongside these; the component ignores them. */
  readonly [key: string]: unknown
}

/**
 * Case-insensitive substring match over the fields a reader would search by.
 *
 * The haystack includes the composed labels, so what the user can see is what
 * the filter matches: a row showing 「写入属性」 is found by typing that, not only
 * by typing `unreal_set`.
 *
 * @param operations - the returned operations.
 * @param query - the raw filter text.
 * @param tr - message lookup, for the composed labels.
 * @returns the operations to draw.
 */
/** Bound on how much text one card contributes to the filter corpus. */
const SEARCH_TEXT_LIMIT = 600

/** A card field, narrowed to what the filter can read as text. */
interface SearchField {
  readonly name?: string | undefined
  readonly type?: string | undefined
  readonly value?: unknown
  readonly raw?: string | undefined
  readonly enumLabel?: string | undefined
  readonly note?: string | undefined
  readonly omitted?: boolean | undefined
}

/** Recursively append scalar values and object keys to the filter corpus. */
function collectSearchText(value: unknown, out: string[], depth = 0): void {
  if (out.length >= SEARCH_TEXT_LIMIT || depth > 8) return
  if (typeof value === 'string') {
    if (value !== '') out.push(value)
    return
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    out.push(String(value))
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSearchText(item, out, depth + 1)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out.push(key)
      collectSearchText(item, out, depth + 1)
    }
  }
}

/** Append one visible field's name, type, labels and value. */
function collectFieldText(field: SearchField, out: string[]): void {
  if (field.name !== undefined) out.push(field.name)
  if (field.type !== undefined) out.push(field.type)
  if (field.raw !== undefined) out.push(field.raw)
  if (field.enumLabel !== undefined) out.push(field.enumLabel)
  if (field.note !== undefined) out.push(field.note)
  if (field.omitted === true) out.push('omitted')
  collectSearchText(field.value, out)
}

/**
 * One card's searchable text: the visible title, result summary, errors, and
 * the actual Details / Info data the card renders. Computed once per snapshot
 * so a future virtual list filters the same corpus without reading the DOM.
 */
function searchableText(operation: OperationView, tr: Lookup): string {
  const parts: string[] = [
    actionTitle(operation, tr),
    operation.resultSummary ?? '',
    errorLabel(operation.errorCode, tr) ?? '',
    operation.errorMessage ?? '',
  ]
  for (const section of operation.details?.sections ?? []) {
    for (const field of section.fields ?? []) collectFieldText(field, parts)
    if (section.before !== undefined) collectFieldText(section.before, parts)
    if (section.after !== undefined) collectFieldText(section.after, parts)
  }
  collectSearchText(operation.params, parts)
  collectSearchText(operation.result, parts)
  return parts.join('\n').toLowerCase()
}

/** The card's three-dot menu: one radio item toggles the Raw data disclosure. */
function CardMenu(props: {
  readonly rawOpen: boolean
  readonly onToggleRaw: () => void
  readonly tr: (key: MsgKey) => string
}): ReactNode {
  const { rawOpen, onToggleRaw, tr } = props
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | undefined>(undefined)
  const hostRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const place = useCallback((): void => {
    const button = buttonRef.current
    if (button === null) return
    const rect = button.getBoundingClientRect()
    const estimatedHeight = 44
    const below = rect.bottom + 4
    const top = below + estimatedHeight > window.innerHeight && rect.top > estimatedHeight
      ? rect.top - estimatedHeight - 4
      : below
    setAnchor({ top, right: Math.max(8, window.innerWidth - rect.right) })
  }, [])

  useEffect(() => {
    if (!open) return
    place()
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      if (hostRef.current?.contains(target) === true || menuRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open, place])

  return (
    <div className={css.cardMenuHost} ref={hostRef}>
      <button
        ref={buttonRef}
        type="button"
        className={css.cardMenuButton}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={tr('menu.more')}
        title={tr('menu.more')}
        data-unreal-card-menu={open ? 'open' : 'closed'}
        onClick={() => { setOpen(value => !value) }}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
          <circle cx="3.2" cy="8" r="1.25" />
          <circle cx="8" cy="8" r="1.25" />
          <circle cx="12.8" cy="8" r="1.25" />
        </svg>
      </button>
      {open && anchor !== undefined && createPortal(
        <div
          ref={menuRef}
          className={css.cardMenuList}
          role="menu"
          data-unreal-card-menu-list
          style={{ position: 'fixed', top: anchor.top, right: anchor.right }}
        >
          <button
            type="button"
            role="menuitemradio"
            aria-checked={rawOpen}
            className={css.cardMenuItem}
            data-unreal-menu-raw
            onClick={() => {
              setOpen(false)
              onToggleRaw()
            }}
          >
            <span className={css.cardMenuRadio} aria-hidden>{rawOpen ? '●' : '○'}</span>
            <span>{tr('raw.title')}</span>
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}

/**
 * One recorded call as a single always-expanded card.
 *
 * The card leads with the action ("Read Cube_1.RelativeLocation"), shows the
 * call's structured body immediately, and keeps everything else — time, status,
 * call id, counts, canonical Types, legacy note, raw JSON, error code/hint —
 * behind its one Raw data menu.
 *
 * Reused by the transcript tool view (`toolview.tsx`), which is why the root tag
 * is selectable: the sidebar wants an `li` inside its list, the transcript wants
 * a `div` inside the shell's tool row.
 *
 * @param props - the record, the current time, the translator and the root tag.
 * @returns the card.
 */
export function OperationCard(props: {
  readonly operation: OperationView
  readonly now: number
  readonly tr: (key: MsgKey) => string
  /** Root element: `li` in the sidebar list, `div` in the transcript. */
  readonly as?: 'li' | 'div'
  /** Channel caller, for artifacts rendered from the host (screenshot previews). */
  readonly caller?: RpcCaller | undefined
}): ReactNode {
  const { operation, now, tr, as = 'li', caller } = props
  const [rawOpen, setRawOpen] = useState(false)
  const title = actionTitle(operation, tr)
  const failure = failureLine(operation, tr)
  const content = (
    <>
      <div className={css.cardHead}>
        <span
          className={operation.ok ? css.cardTitle : `${css.cardTitle} ${css.cardTitleFail}`}
          data-unreal-title
          data-unreal-title-tone={operation.ok ? 'ok' : 'failed'}
          // The full identity stays one hover away; the title itself is short.
          title={operation.objectPath ?? operation.targetType}
        >
          {title}{' '}
          <span className={css.cardTime} data-unreal-time title={new Date(operation.time).toLocaleString()}>
            {formatClock(operation.time, now)}
          </span>
        </span>
        {operation.cached === true && (
          <span className={css.badge} data-unreal-cached title={tr('row.cached')}>{tr('row.cached')}</span>
        )}
        <CardMenu rawOpen={rawOpen} onToggleRaw={() => { setRawOpen(value => !value) }} tr={tr} />
      </div>
      {!operation.ok && failure !== undefined && (
        <div className={css.cardError} data-unreal-error-line>{failure}</div>
      )}
      <div className={css.cardBody} data-unreal-card-body>
        {operation.details !== undefined && (
          <DetailsView
            details={operation.details}
            tr={tr}
            caller={caller}
            recordId={operation.id}
            tool={operation.tool}
            result={operation.result}
          />
        )}
        <RawDataDisclosure operation={operation} tr={tr} open={rawOpen} />
      </div>
    </>
  )
  const className = operation.ok ? css.row : `${css.row} ${css.rowFailed}`
  const attributes = {
    className,
    'data-unreal-row': true,
    'data-unreal-row-id': operation.id,
    'data-unreal-ok': operation.ok ? 'true' : 'false',
  }
  return as === 'div'
    ? <div {...attributes}>{content}</div>
    : <li {...attributes}>{content}</li>
}

/**
 * A toolbar button with a popover menu. The popover is portalled to the body so
 * it is never clipped by the panel's scroller, and closes on outside pointer or
 * Escape.
 */
function ToolbarMenu(props: {
  readonly label: ReactNode
  readonly title: string
  readonly dataAttr: 'data-unreal-filter-menu' | 'data-unreal-more-menu'
  readonly children: (close: () => void) => ReactNode
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState<{ top: number; right: number } | undefined>(undefined)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const place = useCallback((): void => {
    const button = buttonRef.current
    if (button === null) return
    const rect = button.getBoundingClientRect()
    setAnchor({ top: rect.bottom + 4, right: Math.max(8, window.innerWidth - rect.right) })
  }, [])

  useEffect(() => {
    if (!open) return
    place()
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (menuRef.current?.contains(target) === true || buttonRef.current?.contains(target) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', place)
    }
  }, [open, place])

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className={css.toolbarButton}
        aria-haspopup="menu"
        aria-expanded={open}
        data-unreal-tooltip={props.title}
        {...{ [props.dataAttr]: true }}
        onClick={() => {
          if (open) {
            setOpen(false)
            return
          }
          place()
          setOpen(true)
        }}
      >
        {props.label}
      </button>
      {open && anchor !== undefined && createPortal(
        <div
          ref={menuRef}
          className={css.menuPopover}
          style={{ top: anchor.top, right: anchor.right }}
          role="menu"
        >
          {props.children(() => { setOpen(false) })}
        </div>,
        document.body,
      )}
    </>
  )
}

/** A DSH-styled confirmation dialog (dark mask, layer-2 panel, outline actions). */
function ConfirmDialog(props: {
  readonly open: boolean
  readonly title: string
  readonly description: string
  readonly confirmLabel: string
  readonly cancelLabel: string
  readonly closeLabel: string
  readonly busy: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
}): ReactNode {
  useEffect(() => {
    if (!props.open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') props.onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [props.open, props.onCancel])

  if (!props.open) return null
  return createPortal(
    <div
      className={css.modalRoot}
      role="presentation"
      onMouseDown={(event) => { if (event.target === event.currentTarget) props.onCancel() }}
    >
      <div className={css.modalMask} aria-hidden="true" onClick={props.onCancel} />
      <div className={css.modalDialog} role="dialog" aria-modal="true" aria-labelledby="unreal-confirm-title">
        <div className={css.modalHeader}>
          <h2 className={css.modalTitle} id="unreal-confirm-title">{props.title}</h2>
          <button type="button" className={css.modalClose} aria-label={props.closeLabel} onClick={props.onCancel}>
            ×
          </button>
        </div>
        <p className={css.modalDescription}>{props.description}</p>
        <div className={css.modalFooter}>
          <button type="button" className={css.dialogButtonOutline} disabled={props.busy} onClick={props.onCancel}>
            {props.cancelLabel}
          </button>
          <button type="button" className={css.dialogButtonDanger} disabled={props.busy} onClick={props.onConfirm}>
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}

/**
 * The docked panel body.
 *
 * @param props - the seat's runtime props plus this plugin's channel caller.
 * @returns the panel.
 */
export function UnrealHistoryPanel(props: PanelProps): ReactNode {
  const { caller } = props

  // The translator identity is not guaranteed stable across renders, so it is
  // read through a ref: a fresh `tr` every render would otherwise re-create the
  // fetch callback and restart the poll on every frame.
  const tRef = useRef<Translator | undefined>(props.t)
  tRef.current = props.t
  const tr = useCallback((key: MsgKey): string => localize(tRef.current, key), [])

  // The session is resolved through a ref for the same reason: the fallback
  // reader may be a fresh closure per render, while the resolved ID is what the
  // fetch effect actually keys on.
  const resolveRef = useRef(props.resolveSessionId)
  resolveRef.current = props.resolveSessionId
  const sessionId = props.sessionId ?? resolveRef.current?.() ?? undefined

  const [state, setState] = useState<PanelState>({ phase: 'loading' })
  const [query, setQuery] = useState('')
  const [selectedTools, setSelectedTools] = useState<ReadonlySet<string>>(new Set())
  const [selectedOutcomes, setSelectedOutcomes] = useState<ReadonlySet<string>>(new Set())
  const [clearing, setClearing] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  /** The one read in flight; a new read aborts it rather than queueing behind it. */
  const live = useRef<AbortController | undefined>(undefined)

  const pull = useCallback(async (): Promise<void> => {
    if (caller === undefined) {
      setState({ phase: 'error', code: 'no-channel', message: localize(tRef.current, 'state.noChannel') })
      return
    }
    if (sessionId === undefined) {
      setState({ phase: 'error', code: 'no-session', message: localize(tRef.current, 'state.noSession') })
      return
    }
    live.current?.abort()
    const controller = new AbortController()
    live.current = controller
    try {
      const outcome = await fetchSnapshot(caller, { sessionId, limit: ROW_LIMIT }, controller.signal)
      if (controller.signal.aborted || live.current !== controller) return
      setState(outcome.ok
        ? { phase: 'ready', snapshot: outcome.snapshot }
        : { phase: 'error', code: outcome.code, message: outcome.message })
    } finally {
      if (live.current === controller) {
        live.current = undefined
      }
    }
  }, [caller, sessionId])

  useEffect(() => {
    void pull()
    const timer = window.setInterval(() => { void pull() }, POLL_MS)
    return () => {
      window.clearInterval(timer)
      live.current?.abort()
      live.current = undefined
    }
  }, [pull])

  const clearCurrentHistory = useCallback(async (): Promise<void> => {    if (caller === undefined || sessionId === undefined) return
    setClearing(true)
    try {
      const outcome = await clearHistory(caller, sessionId, new AbortController().signal)
      if (outcome.ok) await pull()
    } finally {
      setClearing(false)
    }
  }, [caller, sessionId, pull])

  const snapshot = state.phase === 'ready' ? state.snapshot : undefined
  const operations = snapshot?.operations
  const toolChoices = useMemo(() => {
    const found = new Set((operations ?? []).map(operation => operation.tool))
    return [...found].sort((left, right) => toolLabel(left, tr).localeCompare(toolLabel(right, tr)))
  }, [operations, tr])
  const searchCorpus = useMemo(
    () => new Map((operations ?? []).map(operation => [operation.id, searchableText(operation, tr)])),
    [operations, tr],
  )
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const textRows = needle === ''
      ? operations ?? []
      : (operations ?? []).filter(operation => (searchCorpus.get(operation.id) ?? '').includes(needle))
    return textRows.filter(operation => {
      if (selectedTools.size > 0 && !selectedTools.has(operation.tool)) return false
      if (selectedOutcomes.size > 0 && !selectedOutcomes.has(operation.ok ? 'ok' : 'failed')) return false
      return true
    })
  }, [operations, searchCorpus, query, selectedTools, selectedOutcomes])
  const now = Date.now()
  // The session row is gone from the header on purpose: the panel is already
  // scoped to ONE session, so naming it and counting sessions was noise. The
  // filter below still uses `sessionId` exactly as before.
  const editorIdentity = snapshot === undefined ? undefined : editorIdentityLabel(snapshot.editor)
  const localizeNames = useCallback<LocalizeNames>(async (keys) => {
    if (caller === undefined || keys.length === 0) return new Map()
    const culture = cultureFromText(tr('panel.title'))
    const texts = await localizeTexts(caller, keys, culture, new AbortController().signal)
    return new Map(keys.map((key, index) => [key, texts[index] ?? '']))
  }, [caller, tr])

  // Highlight actual rendered card text without mutating React's DOM: the
  // CSS Custom Highlight API gives us ranges over the existing text nodes.
  useEffect(() => {
    const registry = (globalThis as unknown as {
      CSS?: { highlights?: { set(name: string, value: unknown): void; delete(name: string): void } }
    }).CSS?.highlights
    const HighlightCtor = (globalThis as unknown as {
      Highlight?: new () => { add(range: Range): void }
    }).Highlight
    if (registry === undefined || HighlightCtor === undefined) return

    const name = 'unreal-filter-match'
    registry.delete(name)
    const needle = query.trim().toLowerCase()
    if (needle === '') return

    const highlight = new HighlightCtor()
    let count = 0
    for (const row of document.querySelectorAll('[data-unreal-row]')) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node !== null && count < 500; node = walker.nextNode()) {
        const text = node.textContent ?? ''
        const haystack = text.toLowerCase()
        for (let at = haystack.indexOf(needle); at >= 0 && count < 500; at = haystack.indexOf(needle, at + needle.length)) {
          const range = document.createRange()
          range.setStart(node, at)
          range.setEnd(node, at + needle.length)
          highlight.add(range)
          count += 1
        }
      }
    }
    if (count > 0) registry.set(name, highlight)
    return () => { registry.delete(name) }
  }, [query, rows])

  return (
    <LocalizedNamesProvider localize={localizeNames}>
      <div className={css.panel} data-unreal-panel data-unreal-session={sessionId ?? ''}>
      <div className={css.header}>
        {snapshot !== undefined && (
          <div className={css.editorRow} data-unreal-editor-row>
            <span className={css.factLabel}>{tr('label.editor')}</span>
            <span
              className={`${css.factValue} ${css.mono}`}
              title={snapshot.baseUrl}
              data-unreal-base-url
            >
              {snapshot.baseUrl === '' ? tr('value.empty') : snapshot.baseUrl}
            </span>
            {editorIdentity !== undefined && (
              <span
                className={css.editorIdentity}
                title={editorIdentity}
                data-unreal-editor-identity
              >
                {editorIdentity}
              </span>
            )}
          </div>
        )}
      </div>

      <div className={css.toolbar}>
        <input
          className={css.filter}
          type="search"
          value={query}
          placeholder={tr('filter.placeholder')}
          onChange={(event) => { setQuery(event.target.value) }}
          data-unreal-filter
        />
        <ToolbarMenu
          label={(
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
              <path d="M2 3h12l-4.5 5v4l-3 1.5V8z" strokeLinejoin="round" />
            </svg>
          )}
          title={tr('filter.title')}
          dataAttr="data-unreal-filter-menu"
        >
          {() => (
            <div className={css.menuBody}>
              <div className={css.menuHeading}>{tr('filter.byTool')}</div>
              {toolChoices.length === 0
                ? <div className={css.menuEmpty}>{tr('filter.none')}</div>
                : toolChoices.map(tool => (
                  <label className={css.menuCheck} key={tool}>
                    <input
                      type="checkbox"
                      checked={selectedTools.has(tool)}
                      onChange={() => {
                        setSelectedTools((previous) => {
                          const next = new Set(previous)
                          if (next.has(tool)) next.delete(tool)
                          else next.add(tool)
                          return next
                        })
                      }}
                    />
                    <span>{toolLabel(tool, tr)}</span>
                  </label>
                ))}
              <div className={css.menuDivider} />
              <div className={css.menuHeading}>{tr('filter.byStatus')}</div>
              {(['ok', 'failed'] as const).map(status => (
                <label className={css.menuCheck} key={status}>
                  <input
                    type="checkbox"
                    checked={selectedOutcomes.has(status)}
                    onChange={() => {
                      setSelectedOutcomes((previous) => {
                        const next = new Set(previous)
                        if (next.has(status)) next.delete(status)
                        else next.add(status)
                        return next
                      })
                    }}
                  />
                  <span>{tr(status === 'ok' ? 'row.ok' : 'row.failed')}</span>
                </label>
              ))}
            </div>
          )}
        </ToolbarMenu>
        <ToolbarMenu
          label="⋯"
          title={tr('menu.more')}
          dataAttr="data-unreal-more-menu"
        >
          {(close) => (
            <div className={css.menuBody}>
              <button
                type="button"
                className={css.menuItem}
                disabled={clearing}
                onClick={() => { close(); setConfirmingClear(true) }}
              >
                {tr('menu.clear')}
              </button>
            </div>
          )}
        </ToolbarMenu>
      </div>

      <div className={css.scroller}>
        {state.phase === 'loading' && (
          <div className={css.state} data-unreal-state="loading">
            <span className={css.stateTitle}>{tr('state.loading')}</span>
          </div>
        )}

        {state.phase === 'error' && (
          <div className={css.errorBox} data-unreal-state="error" data-unreal-error-code={state.code}>
            <span className={css.stateTitle}>{tr('error.title')}</span>
            <span className={css.errorMessage}>{state.message}</span>
            <span className={`${css.grantMeta ?? ''} ${css.mono ?? ''}`}>
              {tr('error.code')}: {state.code}
            </span>
          </div>
        )}

        {state.phase === 'ready' && rows.length === 0 && (
          <div className={css.state} data-unreal-state="empty">
            <span className={css.stateTitle}>
              {state.snapshot.operations.length === 0 ? tr('state.empty') : tr('filter.none')}
            </span>
            {state.snapshot.operations.length === 0 && (
              <span className={css.stateHint}>{tr('state.emptyHint')}</span>
            )}
          </div>
        )}

        {rows.length > 0 && (
          <ul className={css.list} data-unreal-list>
            {rows.map(operation => (
              <OperationCard
                key={operation.id}
                operation={operation}
                now={now}
                tr={tr}
                caller={caller}
              />
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirmingClear}
        title={tr('menu.clear')}
        description={tr('menu.clearConfirm')}
        confirmLabel={tr('menu.clear')}
        cancelLabel={tr('action.cancel')}
        closeLabel={tr('action.close')}
        busy={clearing}
        onConfirm={() => { setConfirmingClear(false); void clearCurrentHistory() }}
        onCancel={() => { if (!clearing) setConfirmingClear(false) }}
      />
      </div>
    </LocalizedNamesProvider>
  )
}

/**
 * The tab chip: the panel's name, drawn in the sidebar's keyed title seat.
 *
 * @param props - the seat's runtime props.
 * @returns the chip content.
 */
export function UnrealHistoryChip(props: ChipProps): ReactNode {
  const tr = useCallback((key: MsgKey): string => localize(props.t, key), [props.t])
  return <span className={css.chip} data-unreal-chip>{tr('panel.chip')}</span>
}

/**
 * The EditorAutomation mark: a small cube outline, drawn so it takes `currentColor`
 * and needs no per-theme variant.
 *
 * @param props - glyph size in pixels, and an optional class from the seat.
 * @returns the glyph.
 */
export function UnrealIcon({ size = 16, className }: { size?: number; className?: string }): ReactNode {
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
      style={{ flex: '0 0 auto' }}
    >
      <path d="M8 1.6 14 5v6L8 14.4 2 11V5z" />
      <path d="M2 5l6 3.2L14 5M8 8.2V14.4" />
    </svg>
  )
}
