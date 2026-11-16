/**
 * The transcript tool view: one call rendered with the same card the history
 * sidebar uses.
 *
 * The shell dispatches `tool.call.toolview` by wire tool name, so each of the
 * ten tools registers a view here. A view is mounted three times over a call's
 * life:
 *
 * - **preparing / start** — a compact card in the same visual language, with the
 *   time, an action title derived from whatever arguments have arrived, the
 *   available Parameters, and a subtle running state;
 * - **result** — the durable history record is fetched through the existing
 *   `/dsh-unreal snapshot` channel by `callId` (polling briefly, because the
 *   write can land just after the result event) and the SAME {@link OperationCard}
 *   the sidebar renders is drawn, so both surfaces are one design;
 * - **no record** — a compact fallback card built from the block's own args and
 *   result text, rather than a blank.
 *
 * No client package is imported as a runtime value: the shell's props are read
 * structurally, the channel caller and session resolver come through the
 * registration's `inject` face, and each tool's registration sits in its own
 * guard so a refused seat costs only that one card.
 *
 * @module dsh-unreal/client/toolview
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import css from './panel.module.css'
import { DetailsView, LocalizedNamesProvider, cultureFromText } from './details-view.tsx'
import type { LocalizeNames } from './details-view.tsx'
import { localize, NS } from './locales.ts'
import type { MsgKey, Translator } from './locales.ts'
import { formatClock } from './format.ts'
import type { ClientHostContext } from './dock.tsx'
import { OperationCard } from './panel.tsx'
import {
  argsDetails,
  isSettledBlock,
  operationFromBlock,
  resultTextOf,
  runningTitle,
} from './toolview-model.ts'
import type { ToolBlockLike } from './toolview-model.ts'
import { MAX_ROW_LIMIT, fetchSnapshot, localizeTexts } from './wire.ts'
import type { OperationView, RpcCaller } from './wire.ts'

/** One poll's budget: how many snapshot reads a result card makes for its record. */
const POLL_ATTEMPTS = 16

/** Delay between those reads. */
const POLL_INTERVAL_MS = 700

/** How many rows the lookup asks the session snapshot for. */
const LOOKUP_LIMIT = Math.min(200, MAX_ROW_LIMIT)

/**
 * The structural props the shell composes for one `tool.call.toolview` entry.
 *
 * Declared locally: the plugin must not take a dependency on the tool UI
 * package (whose props also change between releases), and the fields read here
 * are the documented owner currency.
 */
export interface ToolViewPropsLike {
  /** Stage tag. */
  readonly phase: 'preparing' | 'start' | 'result'
  /** Stage-specific call material. */
  readonly block: ToolBlockLike
  /** Wire tool name from the seat. */
  readonly toolName?: string | undefined
  /** Session the card belongs to (session-scope slot standard prop). */
  readonly sessionId?: string | undefined
  /** The framework's translator for this plugin's namespace. */
  readonly t?: Translator | undefined
  /** Injected channel caller. */
  readonly caller?: RpcCaller | undefined
  /** Injected structural session resolver. */
  readonly resolveSessionId?: (() => string | undefined) | undefined
  /** The seat may inject owner props alongside these; the card ignores them. */
  readonly [key: string]: unknown
}

/** The running/fetching/fallback card's props. */
interface CompactCardProps {
  readonly operation: OperationView
  readonly callId: string
  readonly phase: string
  readonly tr: (key: MsgKey) => string
  /** The visible state badge; the card is always a card, never a spinner-only row. */
  readonly state: 'running' | 'loading' | 'fallback'
  /** Result text for the fallback arm. */
  readonly resultText?: string | undefined
  /** Note explaining a fallback card. */
  readonly note?: string | undefined
}

/**
 * The compact card: the same header geometry and body table as the full card,
 * with one state badge and (on the fallback arm) the raw result text.
 *
 * @param props - the synthetic record, translator and state.
 * @returns the card.
 */
function CompactCard(props: CompactCardProps): ReactNode {
  const { operation, callId, phase, tr, state, resultText, note } = props
  const title = runningTitle(operation, tr)
  const details = argsDetails(operation)
  const failed = operation.ok === false
  return (
    <div
      className={failed ? `${css.row} ${css.rowFailed}` : css.row}
      data-unreal-toolview-card
      data-unreal-toolview-running={state === 'running' || state === 'loading' ? 'true' : 'false'}
      data-unreal-toolview-fallback={state === 'fallback' ? 'true' : 'false'}
    >
      <div className={css.cardHead}>
        <span
          className={failed ? `${css.cardTitle} ${css.cardTitleFail}` : css.cardTitle}
          data-unreal-title
          data-unreal-title-tone={failed ? 'failed' : 'ok'}
        >
          {title}{' '}
          <span className={css.cardTime} data-unreal-time title={new Date(operation.time).toLocaleString()}>
            {formatClock(operation.time, Date.now())}
          </span>
        </span>
        <span
          className={css.toolviewState}
          data-unreal-toolview-state={state}
          title={state === 'fallback' ? tr('toolview.fallbackNote') : tr('toolview.running')}
        >
          <span className={css.toolviewDot} aria-hidden="true" />
          {state === 'fallback' ? tr('toolview.incomplete') : tr('toolview.running')}
        </span>
      </div>
      {failed && resultText !== undefined && (
        <div className={css.cardError} data-unreal-error-line>{resultText.length > 220 ? `${resultText.slice(0, 220)}…` : resultText}</div>
      )}
      <div className={css.cardBody} data-unreal-card-body>
        {details !== undefined && <DetailsView details={details} tr={tr} />}
        {state === 'fallback' && resultText !== undefined && !failed && (
          <>
            <div className={css.detailSection}>
              <div className={css.sectionTitle}>{tr('toolview.result')}</div>
              <pre className={css.payload} data-unreal-toolview-result>{resultText}</pre>
            </div>
          </>
        )}
        {note !== undefined && <div className={css.detailNote} data-unreal-toolview-note>{note}</div>}
      </div>
      <span hidden data-unreal-toolview-phase-label={phase} />
      <span hidden data-unreal-toolview-call-id={callId} />
    </div>
  )
}

/** What the result-stage card currently knows about the durable record. */
type RecordState =
  | { readonly phase: 'waiting' }
  | { readonly phase: 'record'; readonly record: OperationView }
  | { readonly phase: 'fallback' }

/**
 * The registered transcript component.
 *
 * @param props - the seat's structural props plus this plugin's injected face.
 * @returns one card for the call.
 */
export function UnrealToolView(props: ToolViewPropsLike): ReactNode {
  const tRef = useRef<Translator | undefined>(props.t)
  tRef.current = props.t
  const tr = useCallback((key: MsgKey): string => localize(tRef.current, key), [])

  const localizeNames = useCallback<LocalizeNames>(async (keys) => {
    const caller = props.caller
    if (caller === undefined || keys.length === 0) return new Map()
    const culture = cultureFromText(tr('panel.title'))
    const texts = await localizeTexts(caller, keys, culture, new AbortController().signal)
    return new Map(keys.map((key, index) => [key, texts[index] ?? '']))
  }, [props.caller, tr])


  const resolveRef = useRef(props.resolveSessionId)
  resolveRef.current = props.resolveSessionId
  const sessionId = props.sessionId ?? props.resolveSessionId?.()
  const callId = props.block?.callId ?? ''
  const isResult = props.phase === 'result' || isSettledBlock(props.block)

  const [recordState, setRecordState] = useState<RecordState>({ phase: 'waiting' })

  // The result-stage lookup: bounded, abortable, cleaned up with the card.
  useEffect(() => {
    if (!isResult) return undefined
    const caller = props.caller
    if (caller === undefined || sessionId === undefined || callId === '') {
      setRecordState({ phase: 'fallback' })
      return undefined
    }
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempts = 0
    let disposed = false

    const finish = (state: RecordState): void => {
      if (disposed) return
      setRecordState(state)
    }

    const attempt = async (): Promise<void> => {
      attempts += 1
      try {
        const outcome = await fetchSnapshot(caller, { sessionId, limit: LOOKUP_LIMIT }, controller.signal)
        if (disposed || controller.signal.aborted) return
        if (!outcome.ok) {
          finish({ phase: 'fallback' })
          return
        }
        const found = outcome.snapshot.operations.find(operation =>
          operation.callId === callId || operation.id.endsWith(`-${callId}`))
        if (found !== undefined) {
          finish({ phase: 'record', record: found })
          return
        }
      } catch {
        if (disposed || controller.signal.aborted) return
        finish({ phase: 'fallback' })
        return
      }
      if (disposed || controller.signal.aborted) return
      if (attempts >= POLL_ATTEMPTS) {
        finish({ phase: 'fallback' })
        return
      }
      timer = setTimeout(() => { void attempt() }, POLL_INTERVAL_MS)
    }

    void attempt()
    return () => {
      disposed = true
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
    // `props.caller` is the injected face's function-backed object; the scope
    // values here are the call identity and session, which are stable per card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isResult, callId, sessionId, props.caller])

  const operation = operationFromBlock(props.block, props.toolName)
  const fallbackText = isResult ? resultTextOf(props.block) : undefined

  if (!isResult) {
    return (
      <div
        className={css.toolview}
        data-unreal-toolview
        data-unreal-toolview-phase={props.phase}
        data-unreal-toolview-call={callId}
      >
        <CompactCard
          operation={operation}
          callId={callId}
          phase={props.phase}
          tr={tr}
          state="running"
        />
      </div>
    )
  }

  if (recordState.phase === 'record') {
    return (
      <div
        className={css.toolview}
        data-unreal-toolview
        data-unreal-toolview-phase="result"
        data-unreal-toolview-call={callId}
      >
        <LocalizedNamesProvider localize={localizeNames}>
          <OperationCard operation={recordState.record} now={Date.now()} tr={tr} as="div" />
        </LocalizedNamesProvider>
      </div>
    )
  }

  const fallback = recordState.phase === 'fallback'
  return (
    <div
      className={css.toolview}
      data-unreal-toolview
      data-unreal-toolview-phase={fallback ? 'fallback' : 'result'}
      data-unreal-toolview-call={callId}
    >
      <CompactCard
        operation={operation}
        callId={callId}
        phase={props.phase}
        tr={tr}
        state={fallback ? 'fallback' : 'loading'}
        {...(fallbackText === undefined ? {} : { resultText: fallbackText })}
        {...(fallback ? { note: tr('toolview.fallbackNote') } : {})}
      />
    </div>
  )
}

/** Structural view of the slot service, declared locally. */
interface SlotServiceFace {
  /** Fill a slot once its declaration exists. */
  inject(name: string, callback: () => unknown): void
  /** Register one component into a live slot. */
  register(config: Record<string, unknown>, component: unknown): unknown
}

/** What the transcript views need from the plugin entry. */
export interface ToolViewOptions {
  /** The channel caller shared with the sidebar panel. */
  readonly caller: RpcCaller
  /** Structural session resolver shared with the sidebar panel. */
  readonly resolveSessionId: () => string | undefined
}

/**
 * Register one `tool.call.toolview` entry per owned tool name.
 *
 * @param ctx - the client context, structurally.
 * @param options - the caller and session resolver.
 */
export function attachToolViews(ctx: ClientHostContext, options: ToolViewOptions): void {
  let slots: SlotServiceFace | undefined
  try {
    slots = ctx.get('slots') as SlotServiceFace | undefined
  } catch (error: unknown) {
    console.warn('dsh-unreal: slot lookup failed; transcript tool views are not mounted', error)
    return
  }
  if (slots === undefined || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

  for (const toolName of TOOL_NAMES) {
    try {
      slots.inject('tool.call.toolview', () => slots.register({
        name: 'tool.call.toolview',
        key: toolName,
        locale: NS,
        inject: () => ({ caller: options.caller, resolveSessionId: options.resolveSessionId }),
      }, UnrealToolView))
    } catch (error: unknown) {
      // A refused seat must cost this one card, not the client boot.
      console.error(`dsh-unreal: could not fill tool.call.toolview for ${toolName}:`, error)
    }
  }
}

/** The wire names this module registers, kept beside the component. */
const TOOL_NAMES = [
  'unreal_ping',
  'unreal_get_editor_info',
  'unreal_get_enum_info',
  'unreal_get_struct_info',
  'unreal_get_class_info',
  'unreal_get_function_info',
  'unreal_get_object_class',
  'unreal_get_property_type',
  'unreal_get_property_value',
  'unreal_set_property_value',
  'unreal_call_function',
] as const
