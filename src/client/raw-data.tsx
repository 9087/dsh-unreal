/**
 * The single, closed-by-default "Raw data" disclosure of one history card.
 *
 * Everything that is metadata rather than the action itself lives here: the
 * timestamp, status, call id, tool name, entry counts, canonical Type echoes,
 * the legacy-record note, the raw params/result JSON, and the error code/hint.
 * A card keeps exactly one `<details>` element, so there is no second nested
 * fold to open before reaching the wire payload.
 *
 * @module dsh-unreal/client/raw-data
 */

import type { ReactNode } from 'react'

import css from './panel.module.css'
import { isLegacyRecord } from './card-title.ts'
import { formatDuration, formatJson } from './format.ts'
import type { MsgKey } from './locales.ts'
import type { OperationView, RcCallView } from './wire.ts'

/** A message lookup, as the panel render supplies it. */
type Tr = (key: MsgKey) => string

/** One `label: value` line of the metadata grid. */
interface MetaRow {
  readonly label: string
  readonly value: string
}

/** A `result` value read as a record, or `undefined`. */
function resultRecord(operation: OperationView): Record<string, unknown> | undefined {
  const result = operation.result
  return result !== null && typeof result === 'object' && !Array.isArray(result)
    ? result as Record<string, unknown>
    : undefined
}

/**
 * The entry/member counts an info tool reported, as metadata lines.
 *
 * @param operation - the recorded call.
 * @param tr - message lookup.
 * @returns label/value rows, empty when the record reports no counts.
 */
function countRows(operation: OperationView, tr: Tr): MetaRow[] {
  const result = resultRecord(operation)
  if (result === undefined) return []
  const rows: MetaRow[] = []
  const number = (key: string): number | undefined => {
    const value = result[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  }
  const entries = number('count')
  if (entries !== undefined) rows.push({ label: tr('info.entries'), value: String(entries) })
  const properties = number('propertyCount')
  if (properties !== undefined) rows.push({ label: tr('info.properties'), value: String(properties) })
  const functions = number('functionCount')
  if (functions !== undefined) rows.push({ label: tr('info.functions'), value: String(functions) })
  const parameters = result['parameters']
  if (Array.isArray(parameters)) rows.push({ label: tr('info.parameters'), value: String(parameters.length) })
  return rows
}

/** The full canonical Type echoes the record carries, as metadata lines. */
function typeRows(operation: OperationView, tr: Tr): MetaRow[] {
  const result = resultRecord(operation)
  const rows: MetaRow[] = []
  if (operation.targetType !== undefined && operation.targetType !== '') {
    rows.push({ label: tr('raw.targetType'), value: operation.targetType })
  }
  if (operation.propertyType !== undefined && operation.propertyType !== '') {
    rows.push({ label: tr('raw.propertyType'), value: operation.propertyType })
  }
  const classType = result?.['classType']
  if (typeof classType === 'string' && classType !== '') {
    rows.push({ label: tr('raw.classType'), value: classType })
  }
  return rows
}

/** Render one metadata row. */
function MetaLine(props: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <>
      <span className={css.rawMetaKey}>{props.label}</span>
      <span className={css.rawMetaValue}>{props.value}</span>
    </>
  )
}

/**
 * Render one JSON text with lightweight syntax colours.
 *
 * The payload is already bounded by `formatJson`, so a regex tokenizer is enough:
 * strings (keys split from values), numbers, true/false/null and punctuation.
 *
 * @param text - pretty-printed JSON text.
 * @returns highlighted nodes.
 */
function highlightedJson(text: string): ReactNode[] {
  const nodes: ReactNode[] = []
  const token = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],:])/g
  let last = 0
  let key = 0
  for (let match = token.exec(text); match !== null; match = token.exec(text)) {
    const index = match.index
    if (index > last) nodes.push(text.slice(last, index))
    const [whole, quoted, colon, literal, number, punct] = match
    if (quoted !== undefined) {
      nodes.push(<span key={key++} className={colon === undefined ? css.jsonString : css.jsonKey}>{quoted}</span>)
      if (colon !== undefined) nodes.push(colon)
    } else if (literal !== undefined) {
      nodes.push(<span key={key++} className={css.jsonLiteral}>{literal}</span>)
    } else if (number !== undefined) {
      nodes.push(<span key={key++} className={css.jsonNumber}>{number}</span>)
    } else if (punct !== undefined) {
      nodes.push(<span key={key++} className={css.jsonPunct}>{punct}</span>)
    }
    last = index + whole.length
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

/** Parse one nested-JSON text for a raw block; an unparsable payload keeps its text. */
function parseRawBlock(text: string | undefined): unknown {
  const trimmed = (text ?? '').trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return trimmed
  }
}

/** Metadata lines for one RC call: which object/function it reached. */
function callRows(call: RcCallView, tr: Tr): MetaRow[] {
  return [
    { label: tr('raw.object'), value: call.objectPath },
    { label: tr('raw.function'), value: call.functionName },
    ...(call.errorMessage === undefined || call.errorMessage === ''
      ? []
      : [{ label: tr('raw.errorMessage'), value: call.errorMessage }]),
  ]
}

/** The payload blocks of one RC call, parsed so a JSON answer renders as JSON. */
function callBlocks(call: RcCallView, tr: Tr): { label: string; value: unknown }[] {
  const blocks: { label: string; value: unknown }[] = [
    { label: tr('detail.rawParams'), value: parseRawBlock(call.parametersJson) },
  ]
  const outParameters = parseRawBlock(call.outParametersJson)
  if (outParameters !== undefined) blocks.push({ label: tr('detail.rawOutParams'), value: outParameters })
  const returnValue = parseRawBlock(call.returnValueJson)
  if (returnValue !== undefined) blocks.push({ label: tr('detail.rawResult'), value: returnValue })
  return blocks
}

/**
 * One card's raw payload view, shown while the card menu's radio item is checked.
 * It replaces the formatted body instead of stacking below it: the menu switches
 * the card between the readable view and the wire view.
 *
 * @param props - the record, the current time, the translator and the open state.
 * @returns the view, or nothing when closed.
 */
export function RawDataDisclosure(props: {
  readonly operation: OperationView
  readonly tr: Tr
  readonly open: boolean
}): ReactNode {
  const { operation, tr, open } = props
  if (!open) return undefined
  const rcCalls = operation.rcCalls ?? (operation.rc === undefined ? [] : [operation.rc])
  const meta: MetaRow[] = [
    { label: tr('raw.status'), value: operation.ok ? tr('row.ok') : tr('row.failed') },
    { label: tr('raw.tool'), value: operation.tool },
    ...(operation.durationMs === undefined ? [] : [{ label: tr('raw.duration'), value: formatDuration(operation.durationMs) }]),
    ...(operation.callId === undefined ? [] : [{ label: tr('raw.callId'), value: operation.callId }]),
    ...(operation.cached === undefined ? [] : [{ label: tr('raw.cached'), value: operation.cached ? tr('raw.yes') : tr('raw.no') }]),
    ...(rcCalls.length > 1 ? [{ label: tr('raw.calls'), value: String(rcCalls.length) }] : []),
    ...countRows(operation, tr),
  ]
  const types = typeRows(operation, tr)
  const errorRows: MetaRow[] = [
    ...(operation.errorCode === undefined ? [] : [{ label: tr('raw.errorCode'), value: operation.errorCode }]),
    ...(operation.errorMessage === undefined ? [] : [{ label: tr('raw.errorMessage'), value: operation.errorMessage }]),
    ...(operation.errorHint === undefined ? [] : [{ label: tr('raw.errorHint'), value: operation.errorHint }]),
  ]
  const legacy = isLegacyRecord(operation)
  // A record without captured calls (an old row, or a local tool that never reached
  // the editor) keeps the tool-level payloads as its raw data.
  const toolBlocks: { label: string; value: unknown }[] = []
  if (rcCalls.length === 0) {
    if (operation.params !== undefined) toolBlocks.push({ label: tr('detail.rawParams'), value: operation.params })
    if (operation.result !== undefined) toolBlocks.push({ label: tr('detail.rawResult'), value: operation.result })
  }

  return (
    <div className={css.rawJson} data-unreal-raw>
      <div className={css.rawContent}>
        <div className={css.rawMeta}>
          {meta.map(row => <MetaLine key={row.label} label={row.label} value={row.value} />)}
          {types.map(row => <MetaLine key={`type-${row.label}`} label={row.label} value={row.value} />)}
          {errorRows.map(row => <MetaLine key={`error-${row.label}`} label={row.label} value={row.value} />)}
          {operation.details?.truncated === true && (
            <MetaLine label={tr('raw.truncated')} value={tr('raw.yes')} />
          )}
        </div>
        {legacy && <div className={css.detailNote} data-unreal-legacy>{tr('detail.legacy')}</div>}
        {rcCalls.map((call, index) => (
          <div className={css.rawCall} key={`call-${String(index)}`} data-unreal-rc-call>
            {rcCalls.length > 1 && (
              <div className={css.detailLabel}>{`${tr('raw.rcCall')} #${String(index + 1)}`}</div>
            )}
            <div className={css.rawMeta}>
              {callRows(call, tr).map(row => <MetaLine key={row.label} label={row.label} value={row.value} />)}
            </div>
            {callBlocks(call, tr).map(block => (
              <div className={css.rawBlock} key={block.label}>
                <div className={css.detailLabel}>{block.label}</div>
                <pre className={css.payload} data-unreal-raw-block>{highlightedJson(formatJson(block.value, 4000))}</pre>
              </div>
            ))}
          </div>
        ))}
        {toolBlocks.map(block => (
          <div className={css.rawBlock} key={block.label}>
            <div className={css.detailLabel}>{block.label}</div>
            <pre className={css.payload} data-unreal-raw-block>{highlightedJson(formatJson(block.value, 4000))}</pre>
          </div>
        ))}
      </div>
    </div>
  )
}
