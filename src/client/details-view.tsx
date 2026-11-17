/**
 * The history card's structured body: typed Details sections and reflection
 * info listings.
 *
 * Two rendering paths:
 *
 * 1. **Enriched details** ({@link DetailsView}) — the typed sections this
 *    plugin records: parameters with name/type/direction/value, returns, out
 *    parameters, old → new for writes. Nested structs/arrays/maps expand like a
 *    Details panel, with member types when the reflection cache knew them.
 * 2. **Info payloads** ({@link InfoResultView}) — a reflection call's own
 *    listing (enum entries, struct members, class properties/functions,
 *    function signature) rendered structurally from `result`.
 *
 * The raw wire payloads live in the card's single Raw data disclosure
 * (`raw-data.tsx`), not here.
 *
 * @module dsh-unreal/client/details-view
 */

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode } from 'react'

import css from './panel.module.css'
import { formatValue } from './format.ts'
import type { MsgKey } from './locales.ts'
import { typeLabel } from './type-label.ts'
import { fetchScreenshot } from './wire.ts'
import type { DetailFieldView, DetailMemberTypeView, DetailSectionView, DetailView, OperationView, RpcCaller } from './wire.ts'

/** A message lookup, as the seat's translator provides it. */
type Tr = (key: MsgKey) => string

/** Resolve display-name keys for the shell's current culture. */
export type LocalizeNames = (keys: readonly string[]) => Promise<ReadonlyMap<string, string>>

const LocalizedNamesContext = createContext<LocalizeNames | undefined>(undefined)

/** Provide localized display names to the info tables below. */
export function LocalizedNamesProvider(props: {
  readonly localize: LocalizeNames | undefined
  readonly children: ReactNode
}): ReactNode {
  return <LocalizedNamesContext.Provider value={props.localize}>{props.children}</LocalizedNamesContext.Provider>
}

/** Resolve the UE culture from the shell's actual translated copy. */
export function cultureFromText(text: string): string {
  return /[\u3400-\u9fff]/.test(text) ? 'zh-Hans' : 'en'
}

/** How deep the nested-value tree may open before it stops offering a toggle. */
/** Minimum width a resized column may shrink to. */
const MIN_COLUMN_WIDTH = 48

/** Drag state shared by both table renderers. */
interface ColumnResizer {
  readonly setHeader: (element: HTMLDivElement | null) => void
  readonly template: string
  readonly startResize: (index: number, event: ReactPointerEvent<HTMLSpanElement>) => void
}

/**
 * Equal default columns plus pointer-drag resizing. Widths start undefined so
 * CSS owns the equal split; the first drag measures the real header cells and
 * switches to explicit pixel widths, which every row in the table then shares
 * through one CSS variable.
 */
function useResizableColumns(columnCount: number): ColumnResizer {
  const [widths, setWidths] = useState<readonly number[] | undefined>(undefined)
  const headerRef = useRef<HTMLDivElement | null>(null)
  const setHeader = (element: HTMLDivElement | null): void => { headerRef.current = element }

  const startResize = (index: number, event: ReactPointerEvent<HTMLSpanElement>): void => {
    const header = headerRef.current
    if (header === null) return
    event.preventDefault()
    event.stopPropagation()
    const cells = Array.from(header.children).filter((child): child is HTMLElement => child instanceof HTMLElement)
    const startWidths = cells.map(cell => cell.getBoundingClientRect().width)
    const startX = event.clientX
    setWidths(startWidths)

    const onMove = (moveEvent: PointerEvent): void => {
      const delta = moveEvent.clientX - startX
      setWidths(startWidths.map((width, column) => {
        if (column === index) return Math.max(MIN_COLUMN_WIDTH, width + delta)
        if (column === index + 1) return Math.max(MIN_COLUMN_WIDTH, width - delta)
        return width
      }))
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return {
    setHeader,
    template: widths === undefined
      ? `repeat(${String(columnCount)}, minmax(0, 1fr))`
      : widths.map(width => `${String(width)}px`).join(' '),
    startResize,
  }
}

/** The handle straddling one header column boundary. */
function ColumnResizeHandle(props: {
  readonly index: number
  readonly resizer: ColumnResizer
}): ReactNode {
  return (
    <span
      className={css.colResizer}
      role="separator"
      aria-orientation="vertical"
      onPointerDown={(event) => { props.resizer.startResize(props.index, event) }}
    />
  )
}

/**
 * The tools whose `result` is a reflection listing the panel renders structurally.
 * Exported because the Raw data disclosure needs the same classification (an
 * info record legitimately carries no `details`).
 */
export const INFO_TOOLS = new Set([
  'unreal_get_enum_info',
  'unreal_get_struct_info',
  'unreal_get_class_info',
  'unreal_get_function_info',
  'unreal_get_object_class',
  'unreal_get_property_type',
  'unreal_get_editor_info',
])

/** Localized name of one parameter direction. */
export function directionLabel(direction: string, tr: Tr): string {
  switch (direction) {
    case 'input': return tr('direction.input')
    case 'output': return tr('direction.output')
    case 'input-output': return tr('direction.input-output')
    case 'return': return tr('direction.return')
    default: return direction
  }
}

/** Whether a value is a plain object (not an array/null). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Render one scalar value: strings quoted, everything else textual. */
function scalarText(value: unknown): string {
  if (value === undefined) return '—'
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  return formatValue(value, 200)
}

/** The disclosure glyph: a rounded triangle that rotates when open. */
function Chevron(props: { readonly expanded: boolean }): ReactNode {
  return (
    <span className={css.chevron} data-expanded={props.expanded} aria-hidden="true">
      <svg viewBox="0 0 10 10" focusable="false">
        <path
          d="M3.2 0.8 8 5 3.2 9.2Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
    </span>
  )
}

/** Integer/float Type words whose wire values are strings but display unquoted. */
const NUMERIC_TYPES = new Set([
  'int8', 'int16', 'int32', 'int64',
  'uint8', 'uint16', 'uint32', 'uint64',
  'float', 'double', 'byte',
])

/** Whether a canonical Type is numeric (including enum values). */
function isNumericType(type: string | undefined): boolean {
  if (type === undefined) return false
  const trimmed = type.trim()
  return NUMERIC_TYPES.has(trimmed) || trimmed.startsWith('enum(')
}

/** Whether a canonical Type is an enum. */
function isEnumType(type: string | undefined): boolean {
  return type !== undefined && type.trim().startsWith('enum(')
}

/** A read-only scalar cell: quoted strings and a disabled checkbox for booleans. */
function ScalarValue(props: {
  readonly value: unknown
  readonly type?: string | undefined
  readonly enumLabel?: string | undefined
  readonly omitted?: boolean | undefined
}): ReactNode {
  if (isEnumType(props.type)) {
    return <span className={css.valueEnum}>{props.enumLabel ?? '—'}</span>
  }
  const bool = typeof props.value === 'boolean'
    ? props.value
    : props.type === 'bool' && (props.value === 'true' || props.value === 'false')
      ? props.value === 'true'
      : undefined
  if (props.omitted === true && props.type === 'bool') {
    return (
      <input
        type="checkbox"
        className={css.valueBool}
        checked={false}
        disabled
        readOnly
        tabIndex={-1}
        aria-readonly="true"
        title="Omitted; the Engine default applies"
        ref={element => { if (element !== null) element.indeterminate = true }}
      />
    )
  }
  if (bool !== undefined) {
    return (
      <input
        type="checkbox"
        className={css.valueBool}
        checked={bool}
        disabled
        readOnly
        tabIndex={-1}
        aria-readonly="true"
      />
    )
  }
  if (isNumericType(props.type)) {
    if (typeof props.value === 'number' || typeof props.value === 'bigint') {
      return <span className={css.valueScalar}>{String(props.value)}</span>
    }
    if (typeof props.value === 'string' && props.value !== '') {
      return <span className={css.valueScalar}>{props.value}</span>
    }
  }
  return <span className={typeof props.value === 'string' ? css.valueString : css.valueScalar}>{scalarText(props.value)}</span>
}

/** Whether a value is a compound (object/array) value. */
function isCompoundValue(value: unknown): boolean {
  return value !== null && typeof value === 'object'
}

/** The entries a compound value offers, bounded to the tree's display limit. */
function compoundEntries(value: unknown): readonly (readonly [string, unknown])[] {
  if (Array.isArray(value)) return value.slice(0, 64).map((item, index) => [`[${index}]`, item] as const)
  if (value !== null && typeof value === 'object') return Object.entries(value as Record<string, unknown>).slice(0, 64)
  return []
}

/** A field's display name: the return sentinel becomes prose. */
function textRefNative(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const native = (value as Record<string, unknown>)['nativeText']
  return typeof native === 'string' && native !== '' ? native : undefined
}

function fieldDisplayName(field: DetailFieldView, tr: Tr): string {
  if (field.direction === 'return' && field.name === 'ReturnValue') return tr('detail.defaultReturn')
  return textRefNative(field.displayNameText) ?? field.name
}

/** One container Type split into its kind and element/key-value parts. */
function containerInfo(type: string | undefined): { kind: 'array' | 'set' | 'map'; key?: string; value?: string } | undefined {
  if (type === undefined) return undefined
  const trimmed = type.trim()
  const open = trimmed.indexOf('(')
  if (open <= 0 || !trimmed.endsWith(')')) return undefined
  const kind = trimmed.slice(0, open)
  if (kind !== 'array' && kind !== 'set' && kind !== 'map') return undefined
  const inner = trimmed.slice(open + 1, -1)
  if (kind !== 'map') return { kind, value: inner.trim() }
  let depth = 0
  let split = -1
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index]
    if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    else if (character === ',' && depth === 0) {
      split = index
      break
    }
  }
  if (split < 0) return undefined
  return { kind, key: inner.slice(0, split).trim(), value: inner.slice(split + 1).trim() }
}

/** Whether a Type string names a struct (the only container element whose members are kept). */
function isStructType(type: string | undefined): boolean {
  return type !== undefined && type.trim().startsWith('struct(')
}

/** One visible row of the flattened tree table. */
interface FlatTreeRow {
  readonly key: string
  readonly name: string
  readonly childName?: string | undefined
  readonly type?: string | undefined
  readonly displayNameKey?: string | undefined
  readonly enumLabel?: string | undefined
  readonly enumLabelKey?: string | undefined
  readonly enumName?: string | undefined
  readonly direction?: string | undefined
  readonly value: unknown
  readonly depth: number
  readonly expandable: boolean
  readonly expanded: boolean
  readonly monoName: boolean
  readonly omitted?: boolean | undefined
}

/**
 * Flatten a compound field and whichever descendants are expanded into one
 * ordinary row list — the way an STreeView works. Indentation is applied only
 * to the name cell later, so all rows share the same three columns.
 */
function flattenTreeRows(
  fields: readonly DetailFieldView[],
  expanded: ReadonlySet<string>,
  tr: Tr,
): FlatTreeRow[] {
  const rows: FlatTreeRow[] = []
  const walk = (
    name: string,
    type: string | undefined,
    value: unknown,
    members: readonly DetailMemberTypeView[] | undefined,
    depth: number,
    path: string,
    direction?: string,
    childName?: string,
    monoName = false,
    displayNameKey?: string,
    enumLabel?: string,
    enumLabelKey?: string,
    enumName?: string,
    omitted?: boolean,
  ): void => {
    const entries = isCompoundValue(value) ? compoundEntries(value) : []
    const expandable = entries.length > 0
    const open = expandable && expanded.has(path)
    rows.push({
      key: path,
      name,
      ...(childName === undefined ? {} : { childName }),
      ...(type === undefined || type === '' ? {} : { type }),
      ...(displayNameKey === undefined || displayNameKey === '' ? {} : { displayNameKey }),
      ...(enumLabel === undefined ? {} : { enumLabel }),
      ...(enumLabelKey === undefined || enumLabelKey === '' ? {} : { enumLabelKey }),
      ...(enumName === undefined ? {} : { enumName }),
      ...(direction === undefined ? {} : { direction }),
      value,
      depth,
      expandable,
      expanded: open,
      monoName,
      ...(omitted === true ? { omitted: true } : {}),
    })
    if (!open) return
    const container = containerInfo(type)
    if (container?.kind === 'map') {
      const entryMembers: DetailMemberTypeView[] = [
        { name: 'Key', type: container.key ?? '' },
        { name: 'Value', type: container.value ?? '' },
      ]
      for (const [entryName, entryValue] of entries) {
        walk(entryName, undefined, entryValue, entryMembers, depth + 1, `${path}.${entryName}`, undefined, entryName)
      }
      return
    }
    if (container !== undefined) {
      // A container of structs carries the member types resolved for its element
      // struct, so expanding one element can label that struct's fields.
      const elementMembers = isStructType(container.value) ? members : undefined
      for (const [entryName, entryValue] of entries) {
        walk(entryName, container.value, entryValue, elementMembers, depth + 1, `${path}.${entryName}`, undefined, entryName)
      }
      return
    }
    const memberTypes = new Map((members ?? []).map(member => [member.name, member.type]))
    for (const [entryName, entryValue] of entries) {
      walk(entryName, memberTypes.get(entryName), entryValue, undefined, depth + 1, `${path}.${entryName}`, undefined, entryName)
    }
  }
  for (const field of fields) {
    const rootName = fieldDisplayName(field, tr)
    walk(
      rootName,
      field.type,
      field.value,
      field.members,
      0,
      field.name,
      field.direction,
      undefined,
      rootName !== field.name,
      textKey(field.displayName),
      field.enumLabel,
      textKey(field.enumLabelRef),
      undefined,
      field.omitted,
    )
  }
  return rows
}

/**
 * A whole Details section as one flattened tree table. Every root field is an
 * ordinary row and every expanded descendant is appended below it, so the
 * columns, direction labels and zebra striping stay aligned at any depth.
 */
function FlatTreeSection(props: {
  readonly fields: readonly DetailFieldView[]
  readonly tr: Tr
}): ReactNode {
  const { fields, tr } = props
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const resizer = useResizableColumns(3)
  const rows = flattenTreeRows(fields, expanded, tr)
  const localize = useContext(LocalizedNamesContext)
  const keys = [...new Set(rows.flatMap(row => [row.displayNameKey ?? '', row.enumLabelKey ?? '']).filter(key => key !== ''))]
  const keySignature = keys.join('\u0000')
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map())
  useEffect(() => {
    if (localize === undefined || keys.length === 0) return
    let alive = true
    void localize(keys).then(resolved => { if (alive) setNames(resolved) }).catch(() => {})
    return () => { alive = false }
  }, [localize, keySignature])

  const toggle = (path: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  return (
    <div
      className={css.treeTable}
      style={{ '--unreal-grid-template': resizer.template } as CSSProperties}
    >
      <div
        ref={resizer.setHeader}
        className={`${css.fieldRow} ${css.fieldHeader} ${css.treeFlatHeader}`}
        data-unreal-tree-header
      >
        <span className={css.fieldNameCell}>
          <span className={css.treeToggleSpacer} aria-hidden="true" />
          {tr('column.name')}
          <ColumnResizeHandle index={0} resizer={resizer} />
        </span>
        <span>
          {tr('column.type')}
          <ColumnResizeHandle index={1} resizer={resizer} />
        </span>
        <span>{tr('column.value')}</span>
      </div>
      <div className={css.treeFlatRows} data-unreal-tree>
        {rows.map(row => {
          const suffix = row.direction === 'input-output' ? ` (${directionLabel(row.direction, tr)})` : ''
          const localizedName = row.displayNameKey === undefined ? undefined : names.get(row.displayNameKey)
          const displayName = localizedName === undefined || localizedName === '' ? row.name : localizedName
          const localizedEnum = row.enumLabelKey === undefined ? undefined : names.get(row.enumLabelKey)
          const enumLabel = localizedEnum === undefined || localizedEnum === ''
            ? row.enumLabel
            : `${row.enumName ?? ''} (${localizedEnum})`
          return (
            <div
              className={`${css.fieldRow} ${css.treeFlatRow}`}
              data-unreal-tree-row
              {...(row.childName === undefined ? {} : { 'data-unreal-tree-name': row.childName })}
              data-unreal-tree-depth={row.depth}
              key={row.key}
            >
              <span className={css.treeName} style={{ paddingLeft: `${String(row.depth * 16)}px` }}>
                {row.expandable ? (
                  <button
                    type="button"
                    className={css.treeToggle}
                    onClick={() => { toggle(row.key) }}
                    aria-expanded={row.expanded}
                    title={`${tr('detail.toggle')} — ${row.name}`}
                    data-unreal-tree-toggle
                  >
                    <Chevron expanded={row.expanded} />
                  </button>
                ) : (
                  <span className={css.treeToggleSpacer} aria-hidden="true" />
                )}
                <span className={row.monoName ? css.treeNameText : css.treeLabel} title={row.name}>{displayName}{suffix}</span>
              </span>
              <span className={css.treeType} title={row.type}>
                {row.type === undefined ? '' : typeLabel(row.type) ?? row.type}
              </span>
              <span className={css.treeValue}>
                {isCompoundValue(row.value) ? '' : <ScalarValue value={row.value} type={row.type} enumLabel={enumLabel} omitted={row.omitted} />}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** The localized section title. */
function sectionTitle(section: DetailSectionView, tr: Tr): string {
  switch (section.kind) {
    case 'inputs': return tr('detail.parameters')
    case 'outputs': return tr('detail.outputs')
    case 'returns': return tr('detail.returns')
    case 'change': return tr('detail.change')
    case 'value': return tr('detail.value')
    case 'screenshot': return tr('detail.screenshot')
    case 'calls': return tr('detail.calls')
    default: return tr('column.type')
  }
}

/** One section: a header plus either a field table or a before → after pair. */
/** Loaded screenshot previews, keyed by record id, so a 4 s snapshot poll does not refetch. */
const screenshotCache = new Map<string, string | undefined>()

/** One screenshot section: the recorded PNG, rendered from the host on demand. */
function ScreenshotSection(props: {
  readonly recordId?: string | undefined
  readonly caller?: RpcCaller | undefined
  readonly tr: Tr
  readonly note?: string | undefined
}): ReactNode {
  const { recordId, caller, tr, note } = props
  const cached = recordId === undefined ? undefined : screenshotCache.get(recordId)
  const [dataUrl, setDataUrl] = useState<string | undefined>(cached)
  const [failed, setFailed] = useState(recordId !== undefined && screenshotCache.has(recordId) && cached === undefined)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (recordId === undefined || caller === undefined) {
      setFailed(true)
      return
    }
    if (screenshotCache.has(recordId)) {
      const value = screenshotCache.get(recordId)
      setDataUrl(value)
      setFailed(value === undefined)
      return
    }
    const controller = new AbortController()
    let active = true
    void fetchScreenshot(caller, recordId, controller.signal).then(
      (value) => {
        if (!active) return
        screenshotCache.set(recordId, value)
        setDataUrl(value)
        setFailed(value === undefined)
      },
      () => {
        if (!active) return
        screenshotCache.set(recordId, undefined)
        setFailed(true)
      },
    )
    return () => {
      active = false
      controller.abort()
    }
  }, [recordId, caller])
  if (dataUrl !== undefined) {
    return (
      <div className={css.screenshotSection} data-unreal-screenshot>
        <button
          type="button"
          className={css.screenshotThumb}
          onClick={() => { setOpen(true) }}
          title={tr('screenshot.open')}
        >
          <img className={css.screenshotImage} src={dataUrl} alt={tr('screenshot.alt')} />
        </button>
        {note !== undefined && <div className={css.fieldNote}>{note}</div>}
        {open && createPortal(
          <div
            className={css.screenshotOverlay}
            role="dialog"
            aria-modal="true"
            data-unreal-screenshot-overlay
            onClick={() => { setOpen(false) }}
          >
            <img
              className={css.screenshotFull}
              src={dataUrl}
              alt={tr('screenshot.alt')}
              onClick={event => { event.stopPropagation() }}
            />
          </div>,
          document.body,
        )}
      </div>
    )
  }
  return (
    <div className={css.screenshotSection} data-unreal-screenshot>
      {failed ? tr('screenshot.unavailable') : tr('screenshot.loading')}
    </div>
  )
}

/** One nested call card of a `calls` section; the batch itself already shows the time. */
/** One entry of a batch record's `result.calls`, matched by the field's `#index` name. */
function legacyCallOf(result: unknown, fieldName: string): Record<string, unknown> | undefined {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return undefined
  const calls = (result as Record<string, unknown>)['calls']
  if (!Array.isArray(calls)) return undefined
  const index = Number(fieldName.replace('#', ''))
  const entry = calls[index]
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined
}

/**
 * Older batch records predate the `calls` Details section but always carried
 * `result.calls` / `result.results`; synthesize the section at render time so
 * history needs no re-run to show the call layer.
 */
function withLegacyCalls(
  sections: readonly DetailSectionView[],
  tool: string | undefined,
  result: unknown,
): readonly DetailSectionView[] {
  if (tool !== 'unreal_call_functions') return sections
  if (sections.some(section => section.kind === 'calls')) return sections
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return sections
  const record = result as Record<string, unknown>
  const calls = Array.isArray(record['calls']) ? record['calls'] : []
  if (calls.length === 0) return sections
  const failures = Array.isArray(record['results']) ? record['results'] : []
  const fields: DetailFieldView[] = calls.map((raw, index) => {
    const call = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
    const failure = failures[index] !== null && typeof failures[index] === 'object' && !Array.isArray(failures[index])
      ? failures[index] as Record<string, unknown>
      : {}
    const ok = failure['errorCode'] === 0 || failure['errorCode'] === '0' || failure['errorCode'] === undefined
    return {
      name: `#${index}`,
      type: 'call',
      value: {
        index,
        objectPath: typeof call['objectPath'] === 'string' ? call['objectPath'] : '',
        functionName: typeof call['functionName'] === 'string' ? call['functionName'] : '',
        ok,
        parameters: typeof call['parametersJson'] === 'string' ? call['parametersJson'] : '{}',
        result: typeof failure['returnValueJson'] === 'string' ? failure['returnValueJson'] : '',
        outParameters: typeof failure['outParametersJson'] === 'string' ? failure['outParametersJson'] : '{}',
        returnType: typeof failure['returnType'] === 'string' ? failure['returnType'] : '',
        errorMessage: typeof failure['errorMessage'] === 'string' ? failure['errorMessage'] : '',
      },
    }
  })
  return [...sections, { kind: 'calls', fields }]
}
/** JSON text of a recorded calls entry, when it parses. */
function parseCallText(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return text
  }
}

/** One parameter/out-parameter object as Details rows (one row per key). */
function callObjectFields(text: string): DetailFieldView[] {
  const parsed = parseCallText(text)
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return parsed === undefined ? [] : [{ name: 'Value', value: parsed }]
  }
  return Object.entries(parsed as Record<string, unknown>).map(([name, value]) => ({ name, value }))
}

/**
 * One batch call's nested card: a history-card header and body (Parameters /
 * Returns / Out) per sub-call, without a timestamp or Raw data disclosure.
 */
function BatchCallsSection(props: { readonly fields: readonly DetailFieldView[]; readonly tr: Tr; readonly result?: unknown }): ReactNode {
  const { fields, tr, result: recordResult } = props
  return (
    <div className={css.batchCalls}>
      {fields.map((field) => {
        const value = field.value !== null && typeof field.value === 'object' && !Array.isArray(field.value)
          ? field.value as Record<string, unknown>
          : {}
        const ok = value['ok'] === true
        const objectPath = typeof value['objectPath'] === 'string' ? value['objectPath'] : ''
        const functionName = typeof value['functionName'] === 'string' ? value['functionName'] : field.name
        const rawLeaf = objectPath === '' ? '' : objectPath.slice(Math.max(objectPath.lastIndexOf('.'), objectPath.lastIndexOf('/')) + 1)
        const leaf = rawLeaf.startsWith('Default__') ? rawLeaf.slice('Default__'.length) : rawLeaf
        const title = leaf === '' ? functionName : `${leaf}.${functionName}`
        const result = typeof value['result'] === 'string' ? value['result'] : ''
        const legacyCall = legacyCallOf(recordResult, field.name)
        const parameters = typeof value['parameters'] === 'string'
          ? value['parameters']
          : (typeof legacyCall?.['parametersJson'] === 'string' ? legacyCall['parametersJson'] : '')
        const outParameters = typeof value['outParameters'] === 'string'
          ? value['outParameters']
          : (typeof legacyCall?.['outParametersJson'] === 'string' ? legacyCall['outParametersJson'] : '')
        const returnType = typeof value['returnType'] === 'string' ? value['returnType'] : ''
        const error = typeof value['errorMessage'] === 'string' ? value['errorMessage'] : ''
        const innerSections = Array.isArray(value['sections']) ? value['sections'] as DetailSectionView[] : []
        const parameterFields = callObjectFields(parameters)
        const outFields = callObjectFields(outParameters)
        const returnValue = result === '' ? tr('detail.noReturn') : parseCallText(result)
        const returnField: DetailFieldView = {
          name: 'ReturnValue',
          ...(returnType === '' ? {} : { type: returnType }),
          value: returnValue,
        }
        return (
          <div key={field.name} className={ok ? css.batchCall : `${css.batchCall} ${css.batchCallFail}`} data-unreal-batch-call>
            <div className={css.batchCallHead}>
              <span className={css.batchCallTitle} title={objectPath}>{title}</span>
              <span className={css.batchCallStatus}>{ok ? tr('row.ok') : tr('row.failed')}</span>
            </div>
            <div className={css.cardBody}>
              {innerSections.length > 0 ? (
                innerSections.map((innerSection, innerIndex) => (
                  <Section key={`${field.name}-${String(innerIndex)}`} section={innerSection} tr={tr} />
                ))
              ) : (
                <>
                  {parameterFields.length > 0 && (
                    <div className={css.detailSection}>
                      <div className={css.sectionTitle}>{tr('detail.parameters')}</div>
                      <FlatTreeSection fields={parameterFields} tr={tr} />
                    </div>
                  )}
                  {ok ? (
                    <div className={css.detailSection}>
                      <div className={css.sectionTitle}>{tr('detail.returns')}</div>
                      <FlatTreeSection fields={[returnField]} tr={tr} />
                    </div>
                  ) : (
                    <div className={css.detailSection}>
                      <div className={css.sectionTitle}>{tr('error.title')}</div>
                      <div className={css.fieldNote}>{error === '' ? tr('row.failed') : error}</div>
                    </div>
                  )}
                  {outFields.length > 0 && (
                    <div className={css.detailSection}>
                      <div className={css.sectionTitle}>{tr('detail.outputs')}</div>
                      <FlatTreeSection fields={outFields} tr={tr} />
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        )
      })}
    </div>
  )
}
function Section(props: {
  readonly section: DetailSectionView
  readonly tr: Tr
  readonly recordId?: string | undefined
  readonly caller?: RpcCaller | undefined
  readonly tool?: string | undefined
  readonly result?: unknown
}): ReactNode {
  const { section, tr, recordId, caller, tool, result } = props
  const fields = section.fields ?? []
  if (section.kind === 'screenshot') {
    return (
      <div className={css.detailSection} data-unreal-section="screenshot">
        <div className={css.sectionTitle}>{sectionTitle(section, tr)}</div>
        <ScreenshotSection recordId={recordId} caller={caller} tr={tr} note={section.note} />
      </div>
    )
  }
  if (section.kind === 'calls') {
    // Only the batch tool has a call layer; records written by older builds may
    // still carry a calls section, and those must not render one.
    if (tool !== undefined && tool !== 'unreal_call_functions') return null
    return (
      <div className={css.detailSection} data-unreal-section="calls">
        <div className={css.sectionTitle}>{sectionTitle(section, tr)}</div>
        <BatchCallsSection fields={fields} tr={tr} result={result} />
        {section.note !== undefined && <div className={css.fieldNote}>{section.note}</div>}
      </div>
    )
  }
  return (
    <div className={css.detailSection} data-unreal-section={section.kind}>
      <div className={css.sectionTitle}>{sectionTitle(section, tr)}</div>
      {section.before !== undefined || section.after !== undefined ? (
        <div className={css.changeTables}>
          {section.before !== undefined && (
            <FlatTreeSection
              fields={[{ ...section.before, name: tr('detail.before') }]}
              tr={tr}
            />
          )}
          {section.after !== undefined && (
            <FlatTreeSection
              fields={[{ ...section.after, name: tr('detail.after') }]}
              tr={tr}
            />
          )}
        </div>
      ) : (
        <FlatTreeSection fields={fields} tr={tr} />
      )}
      {section.note !== undefined && <div className={css.fieldNote}>{section.note}</div>}
    </div>
  )
}

/**
 * The enriched Details view of one record.
 *
 * @param props - the persisted details and the translator.
 * @returns the sections.
 */
export function DetailsView(props: {
  readonly details: DetailView
  readonly tr: Tr
  readonly caller?: RpcCaller | undefined
  readonly recordId?: string | undefined
  readonly tool?: string | undefined
  readonly result?: unknown
}): ReactNode {
  return (
    <div className={css.detailsView} data-unreal-details-view>
      {withLegacyCalls(props.details.sections, props.tool, props.result).map((section, index) => (
        <Section
          key={`${section.kind}-${String(index)}`}
          section={section}
          tr={props.tr}
          caller={props.caller}
          recordId={props.recordId}
          tool={props.tool}
          result={props.result}
        />
      ))}
    </div>
  )
}

/** A rendered cell of a reflection info table. */
interface InfoCell {
  readonly text: ReactNode
  readonly className?: string | undefined
  readonly title?: string | undefined
  readonly isType?: boolean | undefined
  /** UObjectDisplayNames key resolved through the host localizer. */
  readonly displayKey?: string | undefined
}

/** One reflection info table, with columns chosen for the tool. */
interface InfoTableData {
  readonly columns: readonly string[]
  readonly template: string
  readonly rows: readonly InfoCell[][]
}

/** One type cell: short label in the table, canonical Type on hover. */
function typeCell(type: string): InfoCell {
  return {
    text: type === '' ? '' : typeLabel(type) ?? type,
    className: css.fieldType,
    title: type,
    isType: true,
  }
}

/** The code name and its tooltip title for one reflection entry. */
function entryName(entry: Record<string, unknown>): { readonly text: string; readonly title: string } {
  const code = String(entry['name'] ?? '')
  return { text: code, title: code }
}

/** One name/type pair row. */
function nameTypeRow(name: string, type: string, title = name, displayKey?: string): InfoCell[] {
  return [
    {
      text: name,
      className: css.fieldName,
      title,
      ...(displayKey === undefined || displayKey === '' ? {} : { displayKey }),
    },
    typeCell(type),
  ]
}

/** The UObjectDisplayNames key for one reflection entry. */
function textKey(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ''
  const key = (value as Record<string, unknown>)['key']
  return typeof key === 'string' ? key : ''
}

function entryKey(entry: Record<string, unknown>): string {
  return textKey(entry['displayName']) || textKey(entry['displayNameRef'])
}

/** Render one reflection info table. */
function InfoTable(props: { readonly table: InfoTableData }): ReactNode {
  const resizer = useResizableColumns(props.table.columns.length)
  const localize = useContext(LocalizedNamesContext)
  const keys = [...new Set(props.table.rows.flatMap(cells => cells.map(cell => cell.displayKey ?? '')).filter(key => key !== ''))]
  const keySignature = keys.join('\u0000')
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map())
  useEffect(() => {
    if (localize === undefined || keys.length === 0) return
    let alive = true
    void localize(keys).then(resolved => { if (alive) setNames(resolved) }).catch(() => {})
    return () => { alive = false }
  }, [localize, keySignature])
  return (
    <div
      className={css.fieldTable}
      style={{ '--unreal-grid-template': resizer.template } as CSSProperties}
    >
      <div
        ref={resizer.setHeader}
        className={`${css.fieldRow} ${css.fieldHeader}`}
      >
        {props.table.columns.map((label, index) => (
          <span className={index === 0 ? css.fieldNameCell : undefined} key={label}>
            {index === 0 && <span className={css.treeToggleSpacer} aria-hidden="true" />}
            {label}
            {index < props.table.columns.length - 1 && <ColumnResizeHandle index={index} resizer={resizer} />}
          </span>
        ))}
      </div>
      {props.table.rows.map((cells, index) => (
        <div
          key={`info-${String(index)}`}
          className={css.fieldRow}
          data-unreal-info-row
        >
          {cells.map((cell, cellIndex) => {
            const localized = cell.displayKey === undefined ? undefined : names.get(cell.displayKey)
            const cellText = localized === undefined || localized === '' ? cell.text : localized
            return cellIndex === 0 ? (
            <span
              key={`cell-${String(cellIndex)}`}
              className={css.fieldNameCell}
              {...(cell.title === undefined ? {} : { title: cell.title })}
            >
              <span className={css.treeToggleSpacer} aria-hidden="true" />
              {cellText}
            </span>
          ) : (
            <span
              key={`cell-${String(cellIndex)}`}
              className={cell.className}
              {...(cell.title === undefined ? {} : { title: cell.title })}
              {...(cell.isType === true ? { 'data-unreal-field-type': '' } : {})}
            >
              {cellText}
            </span>
          )})}
        </div>
      ))}
    </div>
  )
}

/** One class-info function signature with localized function and parameter names. */
function FunctionSignature(props: { readonly entry: Record<string, unknown>; readonly tr: Tr }): ReactNode {
  const { entry, tr } = props
  const localize = useContext(LocalizedNamesContext)
  const parameters = Array.isArray(entry['parameters']) ? entry['parameters'] as unknown[] : []
  const fnKey = entryKey(entry)
  const parameterKeys = parameters.map(parameter => isRecord(parameter) ? entryKey(parameter) : '')
  const keys = [...new Set([fnKey, ...parameterKeys].filter(key => key !== ''))]
  const keySignature = keys.join('\u0000')
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map())
  useEffect(() => {
    if (localize === undefined || keys.length === 0) return
    let alive = true
    void localize(keys).then(resolved => { if (alive) setNames(resolved) }).catch(() => {})
    return () => { alive = false }
  }, [localize, keySignature])

  const codeName = String(entry['name'] ?? '')
  const displayName = names.get(fnKey) ?? codeName
  const signature = parameters.map((parameter) => {
    if (!isRecord(parameter)) return '?'
    const direction = typeof parameter['direction'] === 'string' ? parameter['direction'] : 'input'
    const code = String(parameter['name'] ?? '')
    return `${direction === 'input' ? '' : `${directionLabel(direction, tr)} `}${textRefNative(parameter['displayNameText']) ?? names.get(entryKey(parameter)) ?? code}: ${String(parameter['type'] ?? '')}`
  }).join(', ')
  const codeSignature = parameters.map((parameter) => {
    if (!isRecord(parameter)) return '?'
    const direction = typeof parameter['direction'] === 'string' ? parameter['direction'] : 'input'
    return `${direction === 'input' ? '' : `${direction} `}${String(parameter['name'] ?? '')}: ${String(parameter['type'] ?? '')}`
  }).join(', ')
  const returnType = String(entry['returnType'] ?? '')
  const suffix = returnType === '' ? '' : ` -> ${returnType}`
  return <span title={`${codeName}(${codeSignature})${suffix}`}>{displayName}({signature}){suffix}</span>
}

/**
 * Render a reflection tool's result listing with the columns that tool owns.
 *
 * Enums have no parameter direction, so their table is Name | Value | Display Name;
 * only the function signature keeps a Direction column.
 */
function infoTable(operation: OperationView, tr: Tr): InfoTableData | undefined {
  const result = operation.result
  if (!isRecord(result)) return undefined
  const list = (key: string): unknown[] => Array.isArray(result[key]) ? result[key] as unknown[] : []

  switch (operation.tool) {
    case 'unreal_get_enum_info': {
      const rows: InfoCell[][] = []
      for (const entry of list('rows').slice(0, 200)) {
        if (!isRecord(entry)) continue
        rows.push([
          { text: String(entry['name'] ?? ''), className: css.fieldName, title: String(entry['name'] ?? '') },
          { text: String(entry['value'] ?? ''), className: css.fieldValue },
          {
            text: String(entry['name'] ?? ''),
            className: css.fieldValue,
            ...(entryKey(entry) === '' ? {} : { displayKey: entryKey(entry) }),
          },
        ])
      }
      return {
        columns: [tr('column.name'), tr('column.value'), tr('column.displayName')],
        template: 'minmax(90px, 1.2fr) 64px minmax(90px, 2fr)',
        rows,
      }
    }
    case 'unreal_get_struct_info': {
      const rows: InfoCell[][] = []
      for (const entry of list('rows').slice(0, 200)) {
        if (!isRecord(entry)) continue
        const display = entryName(entry)
        rows.push(nameTypeRow(display.text, String(entry['type'] ?? ''), display.title, entryKey(entry)))
      }
      return { columns: [tr('column.name'), tr('column.type')], template: 'minmax(100px, 1.4fr) minmax(100px, 2fr)', rows }
    }
    case 'unreal_get_class_info': {
      const rows: InfoCell[][] = []
      for (const entry of list('properties').slice(0, 200)) {
        if (!isRecord(entry)) continue
        const display = entryName(entry)
        rows.push(nameTypeRow(display.text, String(entry['type'] ?? ''), display.title, entryKey(entry)))
      }
      for (const entry of list('functions').slice(0, 200)) {
        if (!isRecord(entry)) continue
        rows.push([
          { text: <FunctionSignature entry={entry} tr={tr} />, className: css.fieldName },
          typeCell(String(entry['returnType'] ?? '')),
        ])
      }
      return { columns: [tr('column.name'), tr('column.type')], template: 'minmax(140px, 2fr) minmax(90px, 1.2fr)', rows }
    }
    case 'unreal_get_function_info': {
      const rows: InfoCell[][] = []
      for (const entry of list('parameters').slice(0, 200)) {
        if (!isRecord(entry)) continue
        const direction = typeof entry['direction'] === 'string' ? entry['direction'] : 'input'
        const display = entryName(entry)
        rows.push([
          {
            text: display.text,
            className: css.fieldName,
            title: display.title,
            ...(entryKey(entry) === '' ? {} : { displayKey: entryKey(entry) }),
          },
          typeCell(String(entry['type'] ?? '')),
          { text: directionLabel(direction, tr), className: css.fieldDirection },
        ])
      }
      return {
        columns: [tr('column.name'), tr('column.type'), tr('column.direction')],
        template: 'minmax(90px, 1.2fr) minmax(100px, 1.6fr) 66px',
        rows,
      }
    }
    case 'unreal_get_object_class': {
      const objectPath = operation.objectPath ?? String(result['objectPath'] ?? '')
      return {
        columns: [tr('column.object'), tr('column.type')],
        template: 'minmax(120px, 2fr) minmax(90px, 1.2fr)',
        rows: [nameTypeRow(objectPath, String(result['classType'] ?? ''))],
      }
    }
    case 'unreal_get_property_type': {
      const propertyPath = operation.propertyPath ?? String(result['propertyPath'] ?? '')
      return {
        columns: [tr('column.property'), tr('column.type')],
        template: 'minmax(120px, 2fr) minmax(90px, 1.2fr)',
        rows: [nameTypeRow(propertyPath, String(result['propertyType'] ?? ''))],
      }
    }
    case 'unreal_get_editor_info': {
      const rows: InfoCell[][] = []
      const push = (label: string, value: unknown, type?: string): void => {
        if (value === undefined || value === null || value === '') return
        rows.push([
          { text: label, className: css.fieldNameText },
          { text: <ScalarValue value={value} type={type} />, className: css.fieldValue },
        ])
      }
      const processId = result['processId']
      const numericProcessId = typeof processId === 'string' ? Number(processId) : processId
      push(tr('info.processId'), Number.isFinite(numericProcessId) ? numericProcessId : processId, 'int64')
      push(tr('info.engineVersion'), result['engineVersion'], 'string')
      push(tr('info.projectName'), result['projectName'], 'string')
      push(tr('info.projectDir'), result['projectDir'], 'string')
      const isEditor = result['isEditor']
      if (typeof isEditor === 'boolean') push(tr('info.isEditor'), isEditor, 'bool')
      else if (isEditor === 'true' || isEditor === 'false') push(tr('info.isEditor'), isEditor === 'true', 'bool')
      return {
        columns: [tr('column.name'), tr('column.value')],
        template: 'minmax(90px, 1fr) minmax(140px, 2.4fr)',
        rows,
      }
    }
    default:
      return undefined
  }
}

/**
 * A reflection tool's info payload, rendered structurally.
 *
 * @param props - the record and the translator.
 * @returns the listing, or `undefined` when this record has none.
 */
export function InfoResultView(props: { readonly operation: OperationView; readonly tr: Tr }): ReactNode {
  if (!INFO_TOOLS.has(props.operation.tool)) return undefined
  const table = infoTable(props.operation, props.tr)
  if (table === undefined || table.rows.length === 0) return undefined
  return (
    <div className={css.detailSection} data-unreal-info>
      <div className={css.sectionTitle}>{props.tr('detail.info')}</div>
      <InfoTable table={table} />
    </div>
  )
}

