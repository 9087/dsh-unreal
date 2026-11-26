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
import { FailureNoticeView } from './card-failure.tsx'
import type { CardFailure } from './card-failure.tsx'
import { formatValue } from './format.ts'
import type { MsgKey } from './locales.ts'
import { typeLabel } from './type-label.ts'
import { cachedMembers, ensureMembers } from './member-cache.ts'
import { fetchPropertyType, fetchScreenshot } from './wire.ts'
import type { DetailFieldView, DetailMemberTypeView, DetailSectionView, DetailView, OperationView, RpcCaller } from './wire.ts'

/** A message lookup, as the seat's translator provides it. */
export type Tr = (key: MsgKey) => string

/** Resolve display-name keys for the shell's current culture. */
export type LocalizeNames = (keys: readonly string[]) => Promise<ReadonlyMap<string, string>>

const LocalizedNamesContext = createContext<LocalizeNames | undefined>(undefined)

/** The channel caller, for schemas the Details tree fetches while expanding. */
const RpcCallerContext = createContext<RpcCaller | undefined>(undefined)

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

  // A column-set change (e.g. the Type column disappearing while a schema loads)
  // invalidates the measured widths; let the template fall back to equal fractions.
  useEffect(() => {
    setWidths(undefined)
  }, [columnCount])

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
  readonly tr?: Tr | undefined
}): ReactNode {
  if (isEnumType(props.type)) {
    // An enum cell shows the resolved enum label; when the value has no matching entry
    // (a rejected string such as "editor", or an uncached numeric value) show the value
    // itself, and say so when the value is not a legal enum kind at all.
    const invalid = typeof props.value === 'string' && !/^-?\d+$/.test(props.value)
    const fallback = props.value === undefined || props.value === null
      ? '—'
      : typeof props.value === 'string'
        ? props.value
        : String(props.value)
    return (
      <span className={css.valueEnum}>
        {props.enumLabel ?? fallback}
        {invalid && <span className={css.valueInvalid}> ({props.tr?.('detail.invalidEnum') ?? 'not a valid value'})</span>}
      </span>
    )
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
        readOnly
        tabIndex={-1}
        aria-readonly="true"
        aria-disabled="true"
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
        readOnly
        tabIndex={-1}
        aria-readonly="true"
        aria-disabled="true"
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

/**
 * A string that carries nested-JSON text as its value, as a compound value when it parses.
 *
 * The wire convention encodes structs/arrays as nested JSON text in string parameters
 * (e.g. `OutValueJson`), so Details can expand such a row like the struct it holds
 * instead of printing the whole text on one line. Text that is not a compound JSON
 * document stays a plain string.
 *
 * @param value - one field value.
 * @returns the parsed compound value, or the original value.
 */
function nestedJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return parsed !== null && typeof parsed === 'object' ? parsed : value
  } catch {
    return value
  }
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
  const native = textRefNative(field.displayNameText)
  if (native !== undefined) {
    // The Engine's display name keeps the C++ Out prefix when no UPARAM(DisplayName)
    // is set; hide only that prefix for rendered output rows (Raw data keeps the key).
    if (field.direction !== 'input') {
      const stripped = native.replace(/^Out\s+/i, '').trim()
      if (stripped !== '') return stripped
    }
    return native
  }
  // Out parameter names are C++ identifiers, not FText; render the readable form
  // (OutDirtyAssets → Dirty Assets) while the field's name stays the exact key.
  if (field.direction !== 'input' && field.name.startsWith('Out') && field.name.length > 3) return outParameterLabel(field.name)
  return field.name
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

/** Rendered label for one struct member: the Engine's display text, else the member name. */
function memberLabel(member: DetailMemberTypeView): string {
  const native = textRefNative(member.displayNameText)
  return native === undefined || native === '' ? member.name : native
}

/** One failed result-envelope return, as the card shows it. */
interface EnvelopeFailureView {
  readonly code: number
  readonly message: string
  readonly hint: string
}

/**
 * Recognise an FEditorAutomationResult returned as the call's return value.
 *
 * Every library call returns an envelope, but its success/failure is already reported
 * through the call's status and Out parameters; showing the envelope as a Return Value
 * table is noise. A failed envelope instead renders its Error Message (falling back to
 * the numeric code) with the Hint on the next line.
 *
 * @param fields - the returns section fields.
 * @returns null for a successful envelope (render nothing), the failure view for a
 *   failed envelope, or undefined when the return value is not an envelope at all.
 */
function envelopeFailure(fields: readonly DetailFieldView[]): EnvelopeFailureView | null | undefined {
  if (fields.length !== 1) return undefined
  const value = fields[0]!.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (!('ErrorCode' in record) || !('bSuccess' in record)) return undefined
  const rawCode = record['ErrorCode']
  const code = Number(typeof rawCode === 'string' ? rawCode : String(rawCode ?? '0'))
  const success = record['bSuccess'] === true || record['bSuccess'] === 'true'
  if (success && (Number.isNaN(code) || code === 0)) return null
  const message = typeof record['ErrorMessage'] === 'string' ? record['ErrorMessage'].trim() : ''
  const hint = typeof record['Hint'] === 'string' ? record['Hint'].trim() : ''
  return { code: Number.isNaN(code) ? 0 : code, message, hint }
}

/**
 * The rows a Return Value table shows.
 *
 * A struct return is one value, but its members are the useful rows: render them from
 * the members the Details already carry, without a wrapper row to expand. Primitive
 * and array returns keep their single `ReturnValue` row, having no sub-properties.
 *
 * @param fields - the returns section's fields.
 * @returns the rows to render.
 */
function returnValueFields(fields: readonly DetailFieldView[]): readonly DetailFieldView[] {
  if (fields.length !== 1) return fields
  const field = fields[0]!
  const members = field.members ?? []
  const value = field.value
  if (members.length === 0 || value === null || typeof value !== 'object' || Array.isArray(value)) return fields
  const record = value as Record<string, unknown>
  return members.slice(0, 64).map(member => ({
    name: member.name,
    ...(member.type === undefined || member.type === '' ? {} : { type: member.type }),
    ...(member.displayNameText === undefined ? {} : { displayNameText: member.displayNameText }),
    ...(Object.prototype.hasOwnProperty.call(record, member.name) ? { value: record[member.name] } : {}),
  }))
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
  resolveMembers: (type: string) => readonly DetailMemberTypeView[] | undefined,
  missing: Set<string>,
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
    const shownValue = nestedJsonValue(value)
    const entries = isCompoundValue(shownValue) ? compoundEntries(shownValue) : []
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
      value: shownValue,
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
      // struct, so expanding one element can label that struct's fields. When the
      // record only carried the top-level shape, the element's schema is fetched
      // on demand (the resolver caches it) and the effect below re-renders.
      const elementType = container.value
      const elementStruct = isStructType(elementType) ? elementType : undefined
      const elementMembers = elementStruct === undefined ? undefined : (members ?? resolveMembers(elementStruct))
      if (elementStruct !== undefined && elementMembers === undefined) missing.add(elementStruct)
      const elementLabels = new Map((elementMembers ?? []).map(member => [member.name, memberLabel(member)]))
      for (const [entryName, entryValue] of entries) {
        walk(elementLabels.get(entryName) ?? entryName, elementType, entryValue, elementMembers, depth + 1, `${path}.${entryName}`, undefined, entryName)
      }
      return
    }
    const structType = isStructType(type) ? type : undefined
    const structMembers = members ?? (structType === undefined ? undefined : resolveMembers(structType))
    if (structType !== undefined && structMembers === undefined) missing.add(structType)
    const memberTypes = new Map((structMembers ?? []).map(member => [member.name, member.type]))
    const memberLabels = new Map((structMembers ?? []).map(member => [member.name, memberLabel(member)]))
    const memberNested = new Map((structMembers ?? []).map(member => [member.name, member.members]))
    for (const [entryName, entryValue] of entries) {
      walk(
        memberLabels.get(entryName) ?? entryName,
        memberTypes.get(entryName),
        entryValue,
        memberNested.get(entryName),
        depth + 1,
        `${path}.${entryName}`,
        undefined,
        entryName,
      )
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

/** A Details table column that a caller can hide. */
export type DetailColumn = 'type' | 'value'

/**
 * A whole Details section as one flattened tree table. Every root field is an
 * ordinary row and every expanded descendant is appended below it, so the
 * columns, direction labels and zebra striping stay aligned at any depth.
 *
 * The Type column disappears automatically when every row lacks a Type (no schema
 * was resolvable), and callers may hide a column explicitly via `hiddenColumns`.
 */
function FlatTreeSection(props: {
  readonly fields: readonly DetailFieldView[]
  readonly tr: Tr
  readonly hiddenColumns?: readonly DetailColumn[] | undefined
}): ReactNode {
  const { fields, tr } = props
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const [, bumpRevision] = useState(0)
  const caller = useContext(RpcCallerContext)
  const missing = new Set<string>()
  const rows = flattenTreeRows(fields, expanded, tr, cachedMembers, missing)
  const hidden = props.hiddenColumns ?? []
  // An all-empty Type column is noise (the value could not be typed at all), so it
  // is not rendered; an explicit hiddenColumns entry wins regardless.
  const showType = !hidden.includes('type') && rows.some(row => row.type !== undefined && row.type !== '')
  const showValue = !hidden.includes('value')
  const resizer = useResizableColumns(1 + (showType ? 1 : 0) + (showValue ? 1 : 0))
  const missingKey = [...missing].sort().join('\u0000')
  useEffect(() => {
    if (caller === undefined || missingKey === '') return
    const controller = new AbortController()
    let alive = true
    void Promise.all(missingKey.split('\u0000').map(type => ensureMembers(caller, type, controller.signal)))
      .then(() => { if (alive) bumpRevision(value => value + 1) })
      .catch(() => {})
    return () => { alive = false; controller.abort() }
  }, [caller, missingKey, bumpRevision])
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
          {(showType || showValue) && <ColumnResizeHandle index={0} resizer={resizer} />}
        </span>
        {showType && (
          <span>
            {tr('column.type')}
            {showValue && <ColumnResizeHandle index={1} resizer={resizer} />}
          </span>
        )}
        {showValue && <span>{tr('column.value')}</span>}
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
              {showType && (
                <span className={css.treeType} title={row.type}>
                  {row.type === undefined ? '' : typeLabel(row.type) ?? row.type}
                </span>
              )}
              {showValue && (
                <span className={css.treeValue}>
                  {isCompoundValue(row.value) ? '' : <ScalarValue value={row.value} type={row.type} enumLabel={enumLabel} omitted={row.omitted} tr={tr} />}
                </span>
              )}
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
export function ScreenshotSection(props: {
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
  // Records written since typed Details exist already carry their own sections; only
  // pre-Details records need the synthetic calls list. Synthesising on top of real
  // sections would show the same single call twice.
  if (sections.length > 0) return sections
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
 * Readable label for one out parameter: drop the C++ `Out` prefix and split the
 * CamelCase identifier (`OutDirtyAssets` → `Dirty Assets`). The row's key stays the
 * exact identifier, so Raw data and future lookups are unaffected.
 *
 * @param name - the reflected parameter name.
 * @returns the rendered label.
 */
function outParameterLabel(name: string): string {
  const base = name.startsWith('Out') && name.length > 3 ? name.slice(3) : name
  return base
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
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
              <span className={ok ? css.batchCallTitle : `${css.batchCallTitle} ${css.cardTitleFail}`} title={objectPath}>{title}</span>
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
                      <div className={css.cardError}>{error === '' ? tr('row.failed') : error}</div>
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
              {!ok && innerSections.length > 0 && (
                <div className={css.cardError}>{error === '' ? tr('row.failed') : error}</div>
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
  const { section, tr, recordId, caller, result } = props
  const fields = section.fields ?? []
  if (section.kind === 'returns') {
    const envelope = envelopeFailure(fields)
    if (envelope === null) return null
    if (envelope !== undefined) {
      const message = envelope.message !== ''
        ? envelope.message
        : tr('detail.errorCodeFallback').replace('{code}', String(envelope.code))
      return (
        <div className={css.detailSection} data-unreal-section="returns">
          <div className={css.cardError}>{message}</div>
          {envelope.hint !== '' && <div className={css.cardError}>{envelope.hint}</div>}
        </div>
      )
    }
  }
  const shownFields = section.kind === 'returns' ? returnValueFields(fields) : fields
  if (section.kind === 'screenshot') {
    return (
      <div className={css.detailSection} data-unreal-section="screenshot">
        <div className={css.sectionTitle}>{sectionTitle(section, tr)}</div>
        <ScreenshotSection recordId={recordId} caller={caller} tr={tr} note={section.note} />
      </div>
    )
  }
  if (section.kind === 'calls') {
    // The calls list is the generic multi-RC-call card shape; no tool exemption.
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
        <FlatTreeSection fields={shownFields} tr={tr} />
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
/** Whether a value is a plain object map. */
function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Rows for the fallback Inputs / Outputs sections. */
function genericFields(value: unknown): DetailFieldView[] {
  if (isRecordValue(value)) return Object.entries(value).map(([name, fieldValue]) => ({ name, value: fieldValue }))
  if (value === undefined || value === null) return []
  return [{ name: 'Value', value }]
}

/**
 * The fallback Inputs / Outputs sections.
 *
 * Host-built Details (reflected names, Types and DisplayNameText) are authoritative and
 * win whenever the matching section exists. Older records — and a host that has not yet
 * been restarted onto the default-RC-details build — may carry no such section, so the
 * card falls back to the recorded tool parameters/result instead of rendering nothing.
 *
 * @param sections - the record's typed Details sections.
 * @param params - the recorded tool parameters.
 * @param result - the recorded tool result.
 * @returns the extra sections, inputs before and outputs after the typed ones.
 */
function fallbackSections(
  sections: readonly DetailSectionView[],
  params: unknown,
  result: unknown,
): { readonly inputs: DetailSectionView[]; readonly outputs: DetailSectionView[] } {
  const kinds = new Set(sections.map(section => section.kind))
  const inputs: DetailSectionView[] = []
  const outputs: DetailSectionView[] = []
  if (!kinds.has('inputs') && !kinds.has('calls')) {
    const fields = genericFields(params)
    if (fields.length > 0) inputs.push({ kind: 'inputs', fields })
  }
  const rendered = kinds.has('outputs') || kinds.has('returns') || kinds.has('screenshot') ||
    kinds.has('calls') || kinds.has('change') || kinds.has('value') || kinds.has('type')
  if (!rendered) {
    const fields = genericFields(result)
    if (fields.length > 0) outputs.push({ kind: 'outputs', fields })
  }
  return { inputs, outputs }
}

/**
 * The enriched Details view of one record.
 *
 * The host builds the sections from the RC calls the tool actually made: one call
 * is a normal single-call card, several calls are a `calls` list. This component
 * only renders them (plus the legacy param/result fallback for records written
 * before Details existed); it applies no tool-specific shape.
 *
 * @param props - the record's typed Details, its raw parameters/result for legacy
 *   records, and the panel context.
 * @returns the sections, or nothing when the record has no displayable data.
 */
export function DetailsView(props: {
  readonly details?: DetailView | undefined
  readonly tr: Tr
  readonly caller?: RpcCaller | undefined
  readonly recordId?: string | undefined
  readonly tool?: string | undefined
  readonly params?: unknown
  readonly result?: unknown
  /**
   * The owner's failure notice, shown after the body instead of above it. Supplied by
   * the card; the legacy callers (transcript during a run) leave it undefined.
   */
  readonly failure?: CardFailure | undefined
}): ReactNode {
  const base = props.details === undefined
    ? []
    : withLegacyCalls(props.details.sections, props.tool, props.result)
  // A failed envelope is already summarised by the failure notice below the body;
  // rendering it again as a Returns row would print the same error twice.
  const visibleBase = props.failure === undefined
    ? base
    : base.filter(section =>
        !(section.kind === 'returns' && envelopeFailure(section.fields ?? []) !== undefined))
  const { inputs, outputs } = fallbackSections(visibleBase, props.params, props.result)
  // A failed `FEditorAutomationResult` envelope can arrive as a `returns` section
  // even when the transport-level call was a success (for example a generic
  // call_function). Keep that error last, after Output Parameters, so it reads as
  // the outcome of the call rather than another input.
  const errorReturns = visibleBase.filter(section =>
    section.kind === 'returns' && envelopeFailure(section.fields ?? []) !== undefined)
  const bodySections = errorReturns.length === 0
    ? visibleBase
    : visibleBase.filter(section => !errorReturns.includes(section))
  const sections = [...inputs, ...bodySections, ...outputs, ...errorReturns]
  if (sections.length === 0 && props.failure === undefined) return undefined
  return (
    <RpcCallerContext.Provider value={props.caller}>
      <div className={css.detailsView} data-unreal-details-view>
        {sections.map((section, index) => (
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
        {props.details?.truncated === true && (
          <div className={css.detailNote} data-unreal-truncated>{props.tr('detail.truncated')}</div>
        )}
        {props.failure !== undefined && <FailureNoticeView failure={props.failure} tr={props.tr} />}
      </div>
    </RpcCallerContext.Provider>
  )
}

/**
 * The sections host recorded for one RC call.
 *
 * A single-call record keeps them at the top level; a multi-call record keeps one
 * entry per call inside its `calls` section. Custom cards use this to render only
 * the call they care about without knowing the record shape.
 *
 * @param operation - the recorded call.
 * @param callIndex - zero-based index into the record's RC calls.
 * @returns the sections for that call, empty when the record cannot supply them.
 */
function sectionsForCall(operation: OperationView, callIndex: number): readonly DetailSectionView[] {
  const sections = operation.details?.sections ?? []
  const callsSection = sections.find(section => section.kind === 'calls')
  if (callsSection !== undefined) {
    const value = callsSection.fields?.[callIndex]?.value
    if (isRecord(value) && Array.isArray(value['sections'])) {
      return value['sections'] as DetailSectionView[]
    }
    return []
  }
  const callCount = operation.rcCalls?.length ?? (operation.rc === undefined ? 0 : 1)
  return callCount > 1 ? [] : sections
}

/**
 * One RC call's details, as a reusable building block for custom cards.
 *
 * @param props - the record, which call to show, optional section kinds and context.
 * @returns that call's typed sections, or nothing when it has none.
 */
export function RcCallDetails(props: {
  readonly operation: OperationView
  readonly callIndex: number
  readonly kinds?: readonly string[] | undefined
  readonly tr: Tr
  readonly caller?: RpcCaller | undefined
  readonly recordId?: string | undefined
}): ReactNode {
  const sections = sectionsForCall(props.operation, props.callIndex)
    .filter(section => props.kinds === undefined || props.kinds.includes(section.kind))
  if (sections.length === 0) return undefined
  return (
    <div className={css.detailsView} data-unreal-rc-details={String(props.callIndex)}>
      {sections.map((section, index) => (
        <Section
          key={`${section.kind}-${String(index)}`}
          section={section}
          tr={props.tr}
          caller={props.caller}
          recordId={props.recordId}
        />
      ))}
    </div>
  )
}

/**
 * The multi-call list (`Calls` sub-cards), optionally only some of the calls.
 *
 * @param props - the record, the call indices to render and context.
 * @returns the nested sub-cards, or nothing when the record has no calls list.
 */
export function CallsDetails(props: {
  readonly operation: OperationView
  readonly calls?: readonly number[] | undefined
  readonly tr: Tr
  readonly caller?: RpcCaller | undefined
  readonly recordId?: string | undefined
}): ReactNode {
  const section = props.operation.details?.sections.find(candidate => candidate.kind === 'calls')
  if (section === undefined) return undefined
  const all = section.fields ?? []
  const fields = props.calls === undefined
    ? all
    : props.calls.map(index => all[index]).filter((field): field is DetailFieldView => field !== undefined)
  if (fields.length === 0) return undefined
  return (
    <Section
      section={{ ...section, fields }}
      tr={props.tr}
      caller={props.caller}
      recordId={props.recordId}
    />
  )
}

/**
 * A plain label/value list, for custom cards whose content is a few fields.
 *
 * @param props - the rows to show.
 * @returns the list.
 */
export function KeyValueRows(props: { readonly rows: readonly { readonly label: string; readonly value: string }[] }): ReactNode {
  if (props.rows.length === 0) return undefined
  return (
    <div className={css.customKv}>
      {props.rows.map(row => (
        <div className={css.customKvRow} key={row.label}>
          <span className={css.customKvLabel}>{row.label}</span>
          <span className={css.customKvValue}>{row.value}</span>
        </div>
      ))}
    </div>
  )
}

/** The struct Type inside a `struct(...)` Type string. */
function structValueType(type: string): string | undefined {
  const match = /^struct\((.+)\)$/.exec(type.trim())
  return match?.[1]
}

/**
 * The root row for a typed value.
 *
 * The value is always rendered as one row carrying its own Type — a struct keeps
 * itself as the root (`RelativeLocation`, type `struct(...)`) and expands into its
 * members through the normal Details tree, instead of flattening members to the top
 * level. The same row also covers scalars: `bHidden` + `bool` renders as a checkbox.
 *
 * @param type - the value's canonical Type.
 * @param value - the already-parsed value.
 * @param name - the row name.
 * @param displayNameText - UE display-name text for the row.
 * @param members - the Type's members, when it is a resolved struct.
 * @returns the single root row.
 */
function typedValueRows(
  type: string,
  value: unknown,
  name: string,
  displayNameText: unknown,
  members: readonly DetailMemberTypeView[] | undefined,
): DetailFieldView[] {
  return [{
    name,
    ...(displayNameText === undefined ? {} : { displayNameText }),
    ...(type === '' ? {} : { type }),
    ...(members === undefined ? {} : { members }),
    value,
  }]
}

/**
 * One typed value as a Details table.
 *
 * The caller supplies only a Type and a decoded value; expansion of nested structs,
 * containers, member labels and per-Type value rendering all happen in the shared
 * Details tree below (the same code path a record's Inputs/Outputs sections use).
 *
 * @param props - the Type, decoded value, optional row name/DisplayName label.
 * @returns the value section.
 */
export function TypedValueSection(props: {
  readonly type: string
  readonly value: unknown
  readonly name?: string | undefined
  readonly displayNameText?: unknown
  readonly members?: readonly DetailMemberTypeView[] | undefined
  readonly label?: string | undefined
  /** A short note under the table (e.g. the schema could not be fetched). */
  readonly note?: string | undefined
  readonly tr: Tr
}): ReactNode {
  const fields = typedValueRows(
    props.type,
    props.value,
    props.name ?? 'Value',
    props.displayNameText,
    props.members,
  )
  return (
    <div className={css.detailSection} data-unreal-typed-value>
      {props.label !== undefined && <div className={css.sectionTitle}>{props.label}</div>}
      <FlatTreeSection fields={fields} tr={props.tr} />
      {props.note !== undefined && <div className={css.detailNote}>{props.note}</div>}
    </div>
  )
}

/**
 * One property value as typed Details rows, with its schema fetched on demand.
 *
 * The record keeps only the raw value text; this component asks the host for the
 * property's Type and DisplayName (and a struct Type's members) when it renders, then
 * hands both to `TypedValueSection` — so names, Type cells and value formatting come
 * from UE's reflection and the normal Details tree, not from guessing the JSON shape.
 *
 * @param props - the property identity, raw value text, optional label and context.
 * @returns the value section.
 */
/** The property schema one value/change card renders from. */
interface PropertySchemaState {
  readonly type: string
  readonly displayNameText?: unknown
  readonly members?: readonly DetailMemberTypeView[] | undefined
}

/**
 * Fetch one property's schema once for a card (Type, DisplayName, struct members).
 *
 * @param props - the property identity, optional caller and translator.
 * @returns the schema and the host's failure reason when it could not be resolved.
 */
function usePropertySchema(props: {
  readonly objectPath: string
  readonly propertyPath: string
  readonly caller?: RpcCaller | undefined
  readonly tr: Tr
}): { readonly schema: PropertySchemaState | undefined; readonly error: string | undefined } {
  const [schema, setSchema] = useState<PropertySchemaState | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  useEffect(() => {
    const caller = props.caller
    if (caller === undefined) {
      setError(props.tr('custom.schemaNoCaller'))
      return undefined
    }
    const controller = new AbortController()
    let alive = true
    void (async () => {
      try {
        const property = await fetchPropertyType(caller, props.objectPath, props.propertyPath, controller.signal)
        if (!alive) return
        if (property.view === undefined) {
          setError(property.error ?? props.tr('custom.schemaUnavailableReason'))
          return
        }
        const view = property.view
        const struct = structValueType(view.type)
        // `members` takes the canonical Type (`struct(...)`), not the bare struct path.
        const members = struct === undefined ? undefined : await ensureMembers(caller, view.type, controller.signal)
        if (!alive) return
        setSchema({
          type: view.type,
          ...(view.displayNameText === undefined ? {} : { displayNameText: view.displayNameText }),
          ...(members === undefined ? {} : { members }),
        })
      } catch (error: unknown) {
        // A schema miss leaves the rows untyped; the value itself still renders.
        if (alive) setError(error instanceof Error ? error.message : String(error))
      }
    })()
    return () => {
      alive = false
      controller.abort()
    }
  }, [props.caller, props.objectPath, props.propertyPath])
  return { schema, error }
}

/**
 * The localized one-line note for a schema that could not be fetched.
 *
 * @param error - the host's reason.
 * @param tr - message lookup.
 * @returns the note text, or `undefined` when the schema resolved.
 */
function schemaNote(error: string | undefined, tr: Tr): string | undefined {
  return error === undefined ? undefined : tr('custom.schemaUnavailable').replace('{reason}', error)
}

/**
 * One property value as typed Details rows, with its schema fetched on demand.
 *
 * The record keeps only the raw value text; this component asks the host for the
 * property's Type and DisplayName (and a struct Type's members) when it renders, then
 * hands both to `TypedValueSection` — so names, Type cells and value formatting come
 * from UE's reflection and the normal Details tree, not from guessing the JSON shape.
 *
 * @param props - the property identity, raw value text, optional label and context.
 * @returns the value section.
 */
export function PropertyValueSection(props: {
  readonly objectPath: string
  readonly propertyPath: string
  readonly valueJson: string
  readonly label?: string | undefined
  readonly tr: Tr
  readonly caller?: RpcCaller | undefined
}): ReactNode {
  const { schema, error } = usePropertySchema(props)
  return (
    <TypedValueSection
      type={schema?.type ?? ''}
      value={parseCallText(props.valueJson)}
      name={props.propertyPath}
      displayNameText={schema?.displayNameText}
      members={schema?.members}
      label={props.label}
      tr={props.tr}
      note={schemaNote(error, props.tr)}
    />
  )
}

/**
 * The before/after pair of one property write, sharing one schema fetch and one note.
 *
 * Both values are typed the same way; the schema-unavailable note is printed once,
 * after the pair, instead of repeating under each side.
 *
 * @param props - the property identity, both raw values and context.
 * @returns the two value sections and (when needed) the single note.
 */
export function PropertyChangeSection(props: {
  readonly objectPath: string
  readonly propertyPath: string
  readonly oldValueJson: string
  readonly newValueJson: string
  readonly oldLabel: string
  readonly newLabel: string
  readonly tr: Tr
  readonly caller?: RpcCaller | undefined
}): ReactNode {
  const { schema, error } = usePropertySchema(props)
  return (
    <>
      <TypedValueSection
        type={schema?.type ?? ''}
        value={parseCallText(props.oldValueJson)}
        name={props.propertyPath}
        displayNameText={schema?.displayNameText}
        members={schema?.members}
        label={props.oldLabel}
        tr={props.tr}
      />
      <TypedValueSection
        type={schema?.type ?? ''}
        value={parseCallText(props.newValueJson)}
        name={props.propertyPath}
        displayNameText={schema?.displayNameText}
        members={schema?.members}
        label={props.newLabel}
        tr={props.tr}
      />
      {error !== undefined && <div className={css.detailNote}>{schemaNote(error, props.tr)}</div>}
    </>
  )
}

/** One row of a simple list card: a stable key and its visible one-line text. */
export interface ListCardRow {
  readonly key: string
  readonly text: string
}

/**
 * The shared shape of list-style custom cards: one summary sentence, one data block
 * of rows, and an empty-state note.
 *
 * It is deliberately only a presentation primitive — each tool still supplies its
 * own sentence, empty text and row formatting, so a list card never needs a
 * tool-specific renderer inside the component.
 *
 * @param props - summary, rows and the empty note.
 * @returns the list section.
 */
export function ListCard(props: {
  readonly summary: string
  readonly rows: readonly ListCardRow[]
  readonly emptyText: string
}): ReactNode {
  return (
    <div className={css.detailSection} data-unreal-list-card>
      <div className={css.customSentence}>{props.summary}</div>
      {props.rows.length === 0
        ? <div className={css.detailNote}>{props.emptyText}</div>
        : (
            <div className={css.customList}>
              {props.rows.map(row => <span className={css.customListRow} key={row.key}>{row.text}</span>)}
            </div>
          )}
    </div>
  )
}

/**
 * A rendered cell of a reflection info table.
 */
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
          { text: <ScalarValue value={value} type={type} tr={tr} />, className: css.fieldValue },
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

export { DetailsView as DefaultDetailsView }
