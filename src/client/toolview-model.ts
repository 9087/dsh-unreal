/**
 * Pure model helpers for the transcript tool view.
 *
 * The transcript hands a tool view a *block* — preparing, started, or settled —
 * not a history record. This module turns that block into the two shapes the
 * card needs: a synthetic {@link OperationView} (so the same action-title logic
 * can name a running call from its arguments) and the compact Details table of
 * whatever arguments have arrived so far. Nothing here touches React, the DOM
 * or the plugin services, so the title/fallback rules are unit-testable.
 *
 * The block contract is structural on purpose: the plugin must not take a hard
 * dependency on the tool UI package (this file is also loaded by tests under
 * Node's type-stripping loader, where a JSX package could not be imported).
 *
 * @module dsh-unreal/client/toolview-model
 */

import type { MsgKey } from './locales.ts'
import { actionTitle } from './card-title.ts'
import { toolLabel } from './format.ts'
import type { DetailFieldView, DetailView, OperationView } from './wire.ts'

/** Every wire tool name this plugin contributes a transcript view for. */
export const TRANSCRIPT_TOOL_NAMES = [
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

/**
 * The lazy argument reader the shell hands a tool view.
 *
 * A `PartialArguments` instance in the real shell; declared structurally so
 * this module never imports that package.
 */
export interface PartialArgsLike {
  /** Top-level keys seen so far. */
  keys?(): readonly string[]
  /** Whether a top-level field has appeared. */
  has(key: string): boolean
  /** A string field's decoded text so far. */
  text(key: string): string | undefined
  /** A completed non-string field's parsed value. */
  value(key: string): unknown
}

/** The one call block shape the transcript view reads. */
export interface ToolBlockLike {
  /** Stage tag the shell attaches (`preparing`, `start`, `result`). */
  readonly phase?: 'preparing' | 'start' | 'result' | undefined
  /** Settled blocks also carry `kind: 'tool-result'`. */
  readonly kind?: string | undefined
  /** Stable call identity. */
  readonly callId?: string | undefined
  /** Wire tool name. */
  readonly name?: string | undefined
  /** Unix epoch ms of the call. */
  readonly time?: number | undefined
  /** Lazy argument reader, present on every stage. */
  readonly args?: PartialArgsLike | null | undefined
  /** Complete argument text, present from `start` on. */
  readonly argsRaw?: string | undefined
  /** The paired call head, when the shell still has it in window. */
  readonly call?: { readonly name?: string | undefined; readonly argsRaw?: string | undefined } | null | undefined
  /** Settled result content blocks. */
  readonly content?: readonly unknown[] | undefined
  /** Settled failure flag. */
  readonly isError?: boolean | undefined
}

/** The argument fields this tool family has, so a synthetic title can be built. */
const KNOWN_ARG_KEYS = [
  'type',
  'objectPath',
  'propertyPath',
  'functionName',
  'value',
  'valueJson',
  'parameters',
  'parametersJson',
  'generateTransaction',
] as const

/** Clip one display string. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * Tolerantly parse argument text.
 *
 * A streaming call's text can be an incomplete prefix; a prefix that parses is
 * used, anything else yields `{}` rather than throwing.
 *
 * @param text - raw argument JSON text.
 * @returns the parsed object, or `{}`.
 */
export function parseArgumentText(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {}
  const trimmed = text.trim()
  if (trimmed === '') return {}
  const asObject = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  try {
    return asObject(JSON.parse(trimmed))
  } catch {
    // A truncated prefix: the longest `}`-closed prefix wins.
    const lastClose = trimmed.lastIndexOf('}')
    if (lastClose > 0) {
      try {
        return asObject(JSON.parse(trimmed.slice(0, lastClose + 1)))
      } catch {
        // fall through to field-boundary repair
      }
    }
    // A prefix cut inside a field: close the object after the last complete
    // top-level field (a few candidates only; this runs per render at most).
    let cursor = trimmed.length
    for (let attempts = 0; attempts < 24; attempts += 1) {
      const comma = trimmed.lastIndexOf(',', cursor - 1)
      if (comma <= 0) break
      try {
        const parsed = asObject(JSON.parse(`${trimmed.slice(0, comma)}}`))
        if (Object.keys(parsed).length > 0) return parsed
      } catch {
        // Try an earlier field boundary.
      }
      cursor = comma
    }
    return {}
  }
}

/**
 * Read the arguments available so far, whatever stage the block is in.
 *
 * @param block - the running or settled call block.
 * @returns the present argument fields (bounded in size).
 */
export function readToolArgs(block: ToolBlockLike | null | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const args = block?.args
  if (args !== null && args !== undefined) {
    let keys: readonly string[] = KNOWN_ARG_KEYS
    if (typeof args.keys === 'function') {
      try {
        const discovered = args.keys()
        keys = [...new Set([...discovered, ...KNOWN_ARG_KEYS])].slice(0, 24)
      } catch {
        // A reader that throws only costs the extra keys; the known set stands.
      }
    }
    for (const key of keys) {
      try {
        if (!args.has(key)) continue
        const text = typeof args.text === 'function' ? args.text(key) : undefined
        const value = text ?? (typeof args.value === 'function' ? args.value(key) : undefined)
        if (value !== undefined) result[key] = typeof value === 'string' ? clip(value, 800) : value
      } catch {
        // One unreadable field must not cost the others.
      }
    }
  }
  if (Object.keys(result).length === 0) {
    const parsed = parseArgumentText(block?.argsRaw ?? block?.call?.argsRaw)
    for (const [key, value] of Object.entries(parsed)) {
      if (key.length > 64) continue
      result[key] = typeof value === 'string' ? clip(value, 800) : value
      if (Object.keys(result).length >= 24) break
    }
  }
  return result
}

/** Read a string field from the parsed arguments. */
function argText(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Build the synthetic record a running call's card is drawn from.
 *
 * The target fields are filled from whatever arguments have arrived, so the
 * action title can already say `Read Cube_1.RelativeLocation` while the call is
 * still open; fields the prepare stage has not produced yet stay absent.
 *
 * @param block - the call block.
 * @param fallbackTool - the wire name from the seat, used when the block omits it.
 * @returns a record-shaped view (never a durable record).
 */
export function operationFromBlock(block: ToolBlockLike | null | undefined, fallbackTool?: string): OperationView {
  const args = readToolArgs(block)
  const tool = block?.name ?? block?.call?.name ?? fallbackTool ?? 'unknown'
  const time = typeof block?.time === 'number' && Number.isFinite(block.time) ? block.time : Date.now()
  return {
    id: block?.callId ?? 'transcript-call',
    time,
    tool,
    ok: block?.isError !== true,
    ...(argText(args, 'type') === undefined ? {} : { targetType: argText(args, 'type') }),
    ...(argText(args, 'objectPath') === undefined ? {} : { objectPath: argText(args, 'objectPath') }),
    ...(argText(args, 'propertyPath') === undefined ? {} : { propertyPath: argText(args, 'propertyPath') }),
    ...(argText(args, 'functionName') === undefined ? {} : { functionName: argText(args, 'functionName') }),
    ...(Object.keys(args).length === 0 ? {} : { params: args }),
  }
}

/**
 * The compact Parameters table for a running or fallback card.
 *
 * @param operation - the synthetic record (its `params` carry the available args).
 * @returns a Details view, or `undefined` when no arguments have arrived.
 */
export function argsDetails(operation: OperationView): DetailView | undefined {
  const params = operation.params
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return undefined
  const fields: DetailFieldView[] = Object.entries(params as Record<string, unknown>)
    .slice(0, 24)
    .map(([name, value]) => ({
      name,
      ...(value === undefined ? {} : { value }),
    }))
  return fields.length === 0 ? undefined : { v: 1, sections: [{ kind: 'inputs', fields }] }
}

/**
 * The settled result text to show when no durable record can be fetched.
 *
 * @param block - the settled block.
 * @param maxChars - display budget.
 * @returns the joined text content, or `undefined` when there is none.
 */
export function resultTextOf(block: ToolBlockLike | null | undefined, maxChars = 1_200): string | undefined {
  const content = block?.content
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const entry of content.slice(0, 12)) {
    if (typeof entry === 'string') {
      parts.push(entry)
      continue
    }
    if (entry === null || typeof entry !== 'object') continue
    const text = (entry as { text?: unknown }).text
    if (typeof text === 'string') parts.push(text)
  }
  const joined = parts.join('\n').trim()
  return joined === '' ? undefined : clip(joined, maxChars)
}

/** Whether a block has already produced a result. */
export function isSettledBlock(block: ToolBlockLike | null | undefined): boolean {
  if (block === null || block === undefined) return false
  if (block.phase === 'result') return true
  if (block.kind === 'tool-result') return true
  return Array.isArray(block.content)
}

/**
 * The action title of a running call, falling back to the tool's short name
 * while the argument that names its target has not arrived.
 *
 * @param operation - the synthetic record built from the block.
 * @param tr - message lookup.
 * @returns the title.
 */
export function runningTitle(operation: OperationView, tr: (key: MsgKey) => string): string {
  const complete = (() => {
    switch (operation.tool) {
      case 'unreal_ping':
      case 'unreal_get_editor_info':
        return true
      case 'unreal_get_enum_info':
      case 'unreal_get_struct_info':
      case 'unreal_get_class_info':
        return operation.targetType !== undefined
      case 'unreal_get_function_info':
        return operation.functionName !== undefined
      case 'unreal_get_property_type':
        return operation.propertyPath !== undefined
      case 'unreal_get_object_class':
        return operation.objectPath !== undefined
      case 'unreal_get_property_value':
      case 'unreal_set_property_value':
        return operation.objectPath !== undefined && operation.propertyPath !== undefined
      case 'unreal_call_function':
        return operation.objectPath !== undefined && operation.functionName !== undefined
      default:
        return true
    }
  })()
  return complete ? actionTitle(operation, tr) : toolLabel(operation.tool, tr)
}
