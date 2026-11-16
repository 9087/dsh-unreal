/**
 * Presentation-only formatters for the call-history panel.
 *
 * Every function here is pure and total: the values come off the wire, so each
 * one degrades to something readable rather than throwing. Row text is composed
 * **here, at render time, from the recorded fields** — nothing is read out of a
 * persisted sentence, because a sentence would freeze whichever language was in
 * force when the call was made.
 *
 * @module dsh-unreal/client/format
 */

import { errorKey, toolKey } from './locales.ts'
import type { MsgKey } from './locales.ts'
import { typeLabel } from './type-label.ts'
import type { EditorIdentityView, OperationView } from './wire.ts'

/** A message lookup, as the seat's translator provides it. */
export type Lookup = (key: MsgKey) => string

/** Default character budget for one rendered path. */
const PATH_BUDGET = 72
/** Default character budget for one rendered value. */
const VALUE_BUDGET = 160

/**
 * Shorten a path for a row, keeping the part that identifies the object.
 *
 * @param path - full object path.
 * @param max - character budget.
 * @returns a shortened path, prefixed with `…` when anything was dropped.
 */
export function shortenPath(path: string, max: number = PATH_BUDGET): string {
  if (path.length <= max) return path
  const budget = Math.max(8, max - 1)
  const tail = path.slice(-budget)
  const colon = tail.indexOf(':')
  if (colon >= 0) return `…${tail.slice(colon)}`
  const dot = tail.indexOf('.')
  if (dot >= 0 && dot < tail.length - 1) return `…${tail.slice(dot)}`
  return `…${tail}`
}

/**
 * The one line naming what a call targeted.
 *
 * The row already carries the tool name, so this line is composed from the
 * recorded identity fields in the order that says the most first: a property
 * path, then a function name, then an object path or a reflection Type.
 *
 * @param operation - the recorded call.
 * @returns the target line, or `undefined` when the record names none.
 */
export function targetLabel(operation: OperationView): string | undefined {
  const member = operation.propertyPath ?? operation.functionName
  if (operation.objectPath !== undefined && operation.objectPath !== '') {
    const path = shortenPath(operation.objectPath)
    return member === undefined ? path : `${path}.${member}`
  }
  if (operation.targetType !== undefined && operation.targetType !== '') {
    // Reflection rows read best with the short Type; the full canonical string
    // stays on the row's title/tooltip.
    const label = typeLabel(operation.targetType) ?? operation.targetType
    return member === undefined ? label : `${label} · ${member}`
  }
  return member
}

/**
 * A collapsed-row summary that is safe to show.
 *
 * Records written before the summary was humanized carry the raw payload JSON
 * in `resultSummary`; a collapsed row must never print that. Anything that
 * still looks like JSON is treated as absent — the payload remains available
 * inside the Advanced/raw JSON disclosure.
 *
 * @param summary - the recorded summary.
 * @returns the summary when it is readable prose/scalars, else `undefined`.
 */
export function readableSummary(summary: string | undefined): string | undefined {
  if (summary === undefined) return undefined
  const trimmed = summary.trim()
  if (trimmed === '') return undefined
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return undefined
  return summary
}

/**
 * The class/struct/enum name at the tail of a canonical Type string.
 *
 * `class(/Script/Engine.StaticMeshActor)` reads as `StaticMeshActor`.
 *
 * @param type - canonical Type string.
 * @returns the tail name, or `undefined` when there is none.
 */
export function typeLeaf(type: string | undefined): string | undefined {
  if (type === undefined || type === '') return undefined
  const close = type.lastIndexOf(')')
  const source = close < 0 ? type : type.slice(0, close)
  const cut = Math.max(source.lastIndexOf('.'), source.lastIndexOf('/'), source.lastIndexOf('('))
  const name = source.slice(cut + 1)
  return name === '' ? type : name
}

/**
 * A readable label for a tool name.
 *
 * `unreal_add_event_node` → `Add event node`. This is the last-resort fallback
 * for titles and labels: a card must never render an empty title, even for a
 * tool (or an old record) whose dictionary entry is missing.
 *
 * @param tool - wire tool name.
 * @returns the humanized label; never empty.
 */
export function humanizeToolName(tool: string): string {
  const bare = tool.replace(/^unreal_/, '').replace(/_/g, ' ').trim()
  if (bare === '') return tool === '' ? 'Unreal call' : tool
  return bare.charAt(0).toUpperCase() + bare.slice(1)
}

/**
 * The localized name of the tool that made a call.
 *
 * When the dictionary has no entry (a tool added after the last dictionary
 * update, or an old record) the label is humanized instead of left empty: a
 * blank row is worse than a generic name.
 *
 * @param tool - wire tool name.
 * @param tr - message lookup.
 * @returns the label.
 */
export function toolLabel(tool: string, tr: Lookup): string {
  const key = toolKey(tool)
  if (key === undefined) return tool
  const label = tr(key)
  return typeof label === 'string' && label.trim() !== '' ? label : humanizeToolName(tool)
}

/**
 * A sentence for a classified failure code, with the code kept beside it.
 *
 * @param code - failure code, when the call failed.
 * @param tr - message lookup.
 * @returns the label, or `undefined` for a successful call.
 */
export function errorLabel(code: string | undefined, tr: Lookup): string | undefined {
  if (code === undefined || code === '') return undefined
  const key = errorKey(code)
  const sentence = key === undefined ? code : tr(key)
  return `${sentence} (${code})`
}

/**
 * Render one wire value compactly: strings unquoted, everything else as JSON,
 * truncated past a budget.
 *
 * @param value - the value, of unknown shape.
 * @param max - character budget.
 * @returns a one-line rendering.
 */
export function formatValue(value: unknown, max: number = VALUE_BUDGET): string {
  if (value === undefined) return '—'
  if (value === null) return 'null'
  if (typeof value === 'string') return clip(value, max)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : clip(text, max)
  } catch {
    return '<unprintable>'
  }
}

/**
 * Render one payload as indented JSON for the expanded section.
 *
 * A bounded payload may already have been degraded to a truncated string by the
 * host (`boundSnapshot`): that string is shown as-is rather than quoted twice.
 *
 * @param value - the payload.
 * @param max - character budget.
 * @returns the block text.
 */
export function formatJson(value: unknown, max = 4000): string {
  if (value === undefined) return '—'
  let text: string
  if (typeof value === 'string') {
    text = value
  } else {
    try {
      text = JSON.stringify(value, null, 2) ?? String(value)
    } catch {
      text = String(value)
    }
  }
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more chars)`
}

/** Clip a string to a budget, marking the cut. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * Local wall-clock time for a row: the clock alone for today, the full local
 * stamp otherwise.
 *
 * @param time - epoch milliseconds.
 * @param now - current epoch milliseconds.
 * @returns a local time string.
 */
export function formatClock(time: number, now: number): string {
  const at = new Date(time)
  if (Number.isNaN(at.getTime())) return '—'
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  const clock = `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}.${pad(at.getMilliseconds(), 3)}`
  return at.toDateString() === new Date(now).toDateString()
    ? clock
    : `${at.toLocaleDateString()} ${clock}`
}

/**
 * A compact age, language-neutral so the header needs no interpolation.
 *
 * @param ageMs - milliseconds since the snapshot was taken.
 * @returns e.g. `4s`, `3m`, `2h`, `5d`.
 */
export function formatAge(ageMs: number): string {
  const seconds = Math.max(0, Math.round(ageMs / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/**
 * A call duration.
 *
 * @param ms - measured duration.
 * @returns milliseconds under a second, seconds above it.
 */
export function formatDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

/**
 * The right-aligned editor identity line: `PID 76644 · UE 5.5.0-0+UE5 · Game`.
 *
 * Every part is optional and omitted independently: an older EditorAutomation, or an
 * `isEditor`-only answer, still shows whatever it could name. A part that is
 * empty or not a finite number is dropped rather than rendered as `PID NaN`.
 *
 * @param editor - the snapshot's editor identity, or null when unavailable.
 * @returns the identity line, or `undefined` when there is nothing to show.
 */
export function editorIdentityLabel(editor: EditorIdentityView | null | undefined): string | undefined {
  if (editor === null || editor === undefined) return undefined
  const parts: string[] = []
  if (typeof editor.processId === 'number' && Number.isFinite(editor.processId)) {
    parts.push(`PID ${editor.processId}`)
  }
  if (typeof editor.engineVersion === 'string' && editor.engineVersion.trim() !== '') {
    parts.push(`UE ${editor.engineVersion.trim()}`)
  }
  if (typeof editor.projectName === 'string' && editor.projectName.trim() !== '') {
    parts.push(editor.projectName.trim())
  }
  return parts.length === 0 ? undefined : parts.join(' \u00b7 ')
}
