/**
 * The model-facing tool surface: one tool per EditorAutomation entry point.
 *
 * Every tool does four things and nothing else: normalize its arguments, call
 * the EditorAutomation class default object through Remote Control, assert the
 * result struct's `ErrorCode`, record one durable history row, and return a
 * canonical value. Whether a call should be allowed is not decided here —this
 * plugin adds no approval policy of its own; the harness's permission system
 * governs the tools like any other.
 *
 * The result structs are mirrored faithfully (`kit/types.ts`), including the
 * nested-JSON-text convention: `ValueJson`, `ParametersJson`, `OldValueJson`,
 * `NewValueJson`, `ReturnValueJson` and `OutParametersJson` are **strings that
 * contain JSON**. Scalars inside them are strings and enums are numeric, which
 * is exactly what the tool descriptions tell the model.
 *
 * @module dsh-unreal/tools
 */

import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import type { ResolvedConfig } from './config.ts'
import { buildBatchCallDetails, buildCallFunctionDetails, buildPropertyValueDetails, buildPropertyWriteDetails, buildScreenshotDetails } from './details.ts'
import type { CallDetails, DetailsDeps } from './details.ts'
import { EditorAutomationClient, assertKitResult } from './kit/client.ts'
import { KitError, asKitError } from './kit/errors.ts'
import type {
  ClassInfoView,
  EditorInfoView,
  EnumInfoView,
  FunctionView,
  MemberView,
  ReflectionService,
  StructInfoView,
} from './kit/reflection.ts'
import type {
  KitBatchCallEntry,
  KitBatchCallResult,
  KitCallFunctionResult,
} from './kit/types.ts'
import { newScreenshotPath, pngSize } from './screenshots.ts'
import { boundSnapshot } from './store.ts'
import type { UnrealStore } from './store.ts'

/**
 * One-line reminder of the wire conventions, shared by the tool descriptions.
 *
 * The Engine's nested JSON text is the part every caller gets wrong, so it is
 * stated once and repeated where a tool takes or returns such text.
 */
export const WIRE_CONVENTIONS =
  'EditorAutomation encodes values as nested JSON text: struct members are camel-free C++ names, every scalar is a JSON STRING (a double reads "12.5", a bool "true", a name "Cube"), and enum values are NUMBERS. Type strings are canonical: "class(/Script/Engine.Actor)", "struct(/Script/CoreUObject.Vector)", "enum(/Script/Engine.ECollisionEnabled)", "object(/Script/Engine.Default__Actor)". Property paths are dotted and may index arrays: "RelativeLocation.X", "OverrideMaterials[0]".'

/** Everything a tool body needs. */
export interface ToolDeps {
  /** HTTP client for one editor. */
  readonly client: EditorAutomationClient
  /** Cached reflection lookups, shared with the record-enrichment layer. */
  readonly reflection: ReflectionService
  /** Durable call history. */
  readonly store: UnrealStore
  /** Resolved plugin config. */
  readonly config: ResolvedConfig
  /** Injectable clock, so tests can pin timestamps. */
  readonly now: () => number
}

/** Every tool name this plugin owns. */
export const OWNED_TOOLS: ReadonlySet<string> = new Set([
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
  'unreal_call_functions',
  'unreal_start_pie',
  'unreal_stop_pie',
  'unreal_is_pie_running',
  'unreal_focus_pie',
  'unreal_send_key',
  'unreal_screenshot',
  'unreal_get_recent_log',
  'unreal_set_tool_groups',
  'unreal_get_widget_roots',
  'unreal_get_widget_blueprint_path',
  'unreal_get_widget_class_path',
  'unreal_get_widget_tree_diff',
  'unreal_reset_widget_tree_diff_cache',
  'unreal_get_widget_geometry',
  'unreal_widget_click',
  'unreal_focus_widget',
  'unreal_send_key_with_modifiers',
  'unreal_send_text',
  'unreal_widget_mouse_move',
  'unreal_widget_mouse_wheel',
  'unreal_widget_drag',
  'unreal_is_mouse_input_pending',
  'unreal_get_list_view_info',
  'unreal_get_list_entry_info',
  'unreal_scroll_to_list_entry',
  'unreal_scroll_to_list_entry_and_click',
  'unreal_capture_widget_screenshot',
  'unreal_is_widget_variable',
  'unreal_get_user_widget_root',
  'unreal_get_widget_text_active_states',
  'unreal_get_dirty_assets',
  'unreal_save_dirty_assets',
  'unreal_get_blueprint_lua_path',
  'unreal_get_blueprint_info',
  'unreal_set_blueprint_dirty',
  'unreal_compile_blueprint',
  'unreal_save_blueprint',
  'unreal_create_blueprint',
  'unreal_delete_blueprint',
  'unreal_get_current_level_info',
  'unreal_is_current_level_dirty',
  'unreal_get_level_script_blueprint',
  'unreal_create_level',
  'unreal_open_level',
  'unreal_save_current_level',
  'unreal_get_blueprint_graphs',
  'unreal_get_graph_nodes',
  'unreal_get_node_pins',
  'unreal_add_call_function_node',
  'unreal_add_event_node',
  'unreal_add_component_bound_event_node',
  'unreal_add_branch_node',
  'unreal_add_variable_get_node',
  'unreal_add_variable_set_node',
  'unreal_add_blueprint_variable',
  'unreal_connect_pins',
  'unreal_set_pin_default_value',
  'unreal_set_pin_default_object',
  'unreal_set_node_position',
  'unreal_remove_graph_node',
  'unreal_remove_graph_nodes_by_class',
  'unreal_list_assets',
  'unreal_list_folders',
  'unreal_get_asset_info',
  'unreal_does_asset_exist',
  'unreal_load_asset',
  'unreal_unload_asset',
  'unreal_create_widget_blueprint',
  'unreal_add_root_widget',
  'unreal_get_umg_widget_tree',
  'unreal_get_umg_widget_parent',
  'unreal_get_umg_widget_children',
  'unreal_get_umg_widget_slot',
  'unreal_add_umg_widget',
  'unreal_remove_umg_widget',
  'unreal_rename_umg_widget',
  'unreal_reparent_umg_widget',
  'unreal_set_umg_widget_property',
  'unreal_set_umg_widget_slot_property',
])

/** Trim a long rendered block to a character budget on a line boundary. */
function clip(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const cut = text.lastIndexOf('\n', maxChars)
  return { text: `${text.slice(0, cut === -1 ? maxChars : cut)}\n—truncated`, truncated: true }
}

/**
 * Deep-convert a value into lossless JSON.
 *
 * The registry snapshots a tool's canonical value as lossless JSON anyway, so
 * this is the documented semantic rather than a workaround; it also drops
 * `undefined` object members, which JSON has no representation for.
 *
 * @param value - any value, including `undefined`.
 * @returns a JSON value; `undefined` becomes `null`.
 */
function toJson(value: unknown): JsonValue {
  try {
    return JSON.parse(JSON.stringify(value) ?? 'null') as JsonValue
  } catch {
    return '<unserializable>'
  }
}

/** Session id of the calling agent, when the call is agent-scoped. */
function sessionOf(exec: { readonly agent?: { readonly id: unknown } | undefined }): string | undefined {
  const id = exec.agent?.id
  return id === undefined ? undefined : String(id)
}

/** Structural view of the tool run context this file uses. */
interface RunContext {
  readonly callId: string
  readonly signal?: AbortSignal | undefined
  readonly agent?: { readonly id: unknown } | undefined
}

/**
 * Target identity a body learns while it runs.
 *
 * Fields are written **as soon as the body knows them**, not returned at the
 * end: a body that throws never reaches its return statement, so anything
 * carried only by the return value is lost exactly when the history needs it
 * most —the row about a failed call still names what it tried to touch.
 */
interface AuditTrail {
  targetType?: string | undefined
  objectPath?: string | undefined
  propertyPath?: string | undefined
  functionName?: string | undefined
  propertyType?: string | undefined
  /** Whether this call's reflection answer came from the schema cache. */
  cacheHit?: boolean | undefined
}

/** What a tool body reports back for the operation log. */
interface Audited<T> {
  /** Canonical value returned to the model. */
  readonly value: T
  /** Free-text summary of the outcome. */
  readonly resultSummary?: string | undefined
}

/** The outcome of one tool body, as the Details builder sees it. */
interface AuditedOutcome {
  /** Present on success. */
  readonly value?: unknown
  /** Present on failure. */
  readonly error?: KitError | undefined
}

/** Static identity of the call being recorded. */
interface AuditMeta {
  readonly tool: string
  /** The parsed tool arguments, kept as a bounded snapshot. */
  readonly params?: unknown
  /**
   * Typed-enrichment builder, run after the body so it can see the result too.
   * Best-effort: a builder that throws or times out only costs this record's
   * Details, never the call itself.
   */
  readonly details?: ((outcome: AuditedOutcome) => Promise<CallDetails | undefined>) | undefined
}

/**
 * Run one tool body under the operation log.
 *
 * Timing lives here rather than in a `tools/result` listener because the event
 * carries no timestamps and cannot see the arguments. Recording is best-effort:
 * an audit failure must never turn a successful editor call into a
 * model-visible error.
 *
 * @param deps - tool dependencies.
 * @param exec - the tool run context, for call, session and cancellation identity.
 * @param meta - static identity of the call.
 * @param run - the body, writing target fields into the trail as it goes.
 * @returns the canonical value.
 */
async function audited<T>(
  deps: ToolDeps,
  exec: RunContext,
  meta: AuditMeta,
  run: (trail: AuditTrail) => Promise<Audited<T>>,
): Promise<T> {
  const started = deps.now()
  const trail: AuditTrail = {}
  try {
    const outcome = await run(trail)
    const details = await enrich(deps, meta, { value: outcome.value })
    await record(deps, exec, meta, {
      ok: true,
      durationMs: deps.now() - started,
      trail,
      ...(details === undefined ? {} : { details }),
      ...(outcome.resultSummary === undefined ? {} : { resultSummary: outcome.resultSummary }),
      result: toJson(outcome.value),
    })
    return outcome.value
  } catch (error: unknown) {
    const failure = asKitError(error)
    const details = await enrich(deps, meta, { error: failure })
    await record(deps, exec, meta, {
      ok: false,
      durationMs: deps.now() - started,
      errorCode: failure.code,
      // The record keeps the Engine's own text; the model gets the hint folded
      // in below, where it costs the record nothing.
      errorMessage: recordedErrorMessage(failure),
      ...(failure.hint === undefined ? {} : { errorHint: failure.hint }),
      ...(details === undefined ? {} : { details }),
      trail,
    })
    throw withHint(failure)
  }
}

/**
 * Build one record's typed Details, best-effort and time-bounded.
 *
 * Three rules keep enrichment from ever costing the call it describes:
 * a builder is optional; a builder that throws is swallowed; and the whole
 * build is raced against `enrichmentTimeoutMs`, so a slow reflection lookup
 * (the editor's game thread stalling) writes the record without Details rather
 * than delaying the model's result. A transport failure skips enrichment
 * entirely —the editor is gone, so the signature lookups would only time out.
 *
 * @param deps - tool dependencies.
 * @param meta - the call's static identity and optional builder.
 * @param outcome - what the body produced.
 * @returns the details, or `undefined` when none could be built in time.
 */
async function enrich(deps: ToolDeps, meta: AuditMeta, outcome: AuditedOutcome): Promise<CallDetails | undefined> {
  const builder = meta.details
  if (builder === undefined) return undefined
  if (outcome.error !== undefined && outcome.error.code.startsWith('rc/')) return undefined
  let timer: NodeJS.Timeout | undefined
  try {
    const timeout = new Promise<undefined>((settle) => {
      timer = setTimeout(() => { settle(undefined) }, deps.config.enrichmentTimeoutMs)
    })
    return await Promise.race([builder(outcome), timeout])
  } catch {
    return undefined
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * The Details builders' dependencies for one tool call.
 *
 * @param deps - tool dependencies.
 * @param exec - the tool run context, for cancellation.
 * @returns the enrichment dependencies.
 */
function detailsDeps(deps: ToolDeps, exec: RunContext): DetailsDeps {
  return {
    reflection: deps.reflection,
    maxChars: deps.config.detailsMaxChars,
    signal: exec.signal,
  }
}

/**
 * The Engine's own failure text, with the adapter's `ErrorCode N (name):`
 * prefix removed.
 *
 * The classification belongs in the record's `errorCode` and the raw metadata;
 * the visible card line should read like a sentence, not like a diagnostic
 * header. The thrown (model-visible) error keeps the prefix —that is where it
 * helps.
 *
 * @param error - the classified failure.
 * @returns the message to persist as `errorMessage`.
 */
function recordedErrorMessage(error: KitError): string {
  if (!error.code.startsWith('editorautomation/')) return error.message
  return error.message.replace(/^ErrorCode -?\d+ \([^)]+\):\s*/, '')
}

/**
 * Fold a failure's hint into the message the model reads.
 *
 * The registry builds a thrown tool error's content from `message` alone, so a
 * `hint` on a plain `Error` subclass never reaches anyone.
 *
 * @param error - the classified failure.
 * @returns an equivalent error whose message carries the hint, or the original.
 */
function withHint(error: KitError): KitError {
  if (error.hint === undefined) return error
  return new KitError(error.code, `${error.message}\nHint: ${error.hint}`, {
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.functionName === undefined ? {} : { functionName: error.functionName }),
    ...(error.detail === undefined ? {} : { detail: error.detail }),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  })
}

/** Append one operation, swallowing storage failures. */
async function record(
  deps: ToolDeps,
  exec: RunContext,
  meta: AuditMeta,
  outcome: {
    ok: boolean
    durationMs: number
    errorCode?: string | undefined
    errorMessage?: string | undefined
    errorHint?: string | undefined
    resultSummary?: string | undefined
    trail?: AuditTrail | undefined
    result?: JsonValue | undefined
    details?: CallDetails | undefined
  },
): Promise<void> {
  const time = deps.now()
  const sessionId = sessionOf(exec)
  const trail = outcome.trail
  const record = {
    id: `${time}-${exec.callId === '' ? randomUUID() : exec.callId}`,
    time,
    tool: meta.tool,
    ok: outcome.ok,
    // Record schema generation: absent on rows written before typed Details.
    recordVersion: 2,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(exec.callId === '' ? {} : { callId: exec.callId }),
    ...(outcome.errorCode === undefined ? {} : { errorCode: outcome.errorCode }),
    ...(outcome.errorMessage === undefined ? {} : { errorMessage: outcome.errorMessage }),
    ...(outcome.errorHint === undefined ? {} : { errorHint: outcome.errorHint }),
    durationMs: outcome.durationMs,
    ...(trail?.targetType === undefined ? {} : { targetType: trail.targetType }),
    ...(trail?.objectPath === undefined ? {} : { objectPath: trail.objectPath }),
    ...(trail?.propertyPath === undefined ? {} : { propertyPath: trail.propertyPath }),
    ...(trail?.functionName === undefined ? {} : { functionName: trail.functionName }),
    ...(trail?.propertyType === undefined ? {} : { propertyType: trail.propertyType }),
    ...(trail?.cacheHit === undefined ? {} : { cached: trail.cacheHit }),
    ...(meta.params === undefined ? {} : { params: boundSnapshot(meta.params, deps.config.snapshotMaxChars) }),
    ...(outcome.result === undefined ? {} : { result: boundSnapshot(outcome.result, deps.config.snapshotMaxChars) }),
    ...(outcome.resultSummary === undefined ? {} : { resultSummary: outcome.resultSummary }),
    ...(outcome.details === undefined ? {} : { details: outcome.details }),
  }
  try {
    await deps.store.recordOperation(record)
  } catch {
    // The editor call already happened; losing the log entry must not surface.
  }
}

/**
 * Require a non-empty string argument.
 *
 * @param value - the parsed argument.
 * @param name - parameter name, for the failure message.
 * @returns the trimmed value.
 * @throws {KitError} `editorautomation/invalid-argument`.
 */
function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new KitError('editorautomation/invalid-argument', `"${name}" must be a non-empty string.`)
  }
  return value.trim()
}

/**
 * Project the cached member view into the shape the tools return.
 *
 * @param members - cached struct/class member views.
 * @returns one `{name, type}` row per member.
 */
function viewMembers(members: readonly MemberView[]): { name: string; displayName: MemberView['displayName']; type: string }[] {
  return members.map(member => ({ name: member.name, displayName: member.displayName, type: member.type }))
}

/**
 * Project the cached function view into the shape the tools return.
 *
 * @param functions - cached function views.
 * @returns the same functions with their parameter directions already named.
 */
function viewFunctions(functions: readonly FunctionView[]): {
  name: string
  displayName: unknown
  blueprintCallable: boolean
  blueprintPure: boolean
  static: boolean
  parameters: { name: string; displayNameText: unknown; type: string; direction: string }[]
  returnType: string
  toolTip: string
}[] {
  return functions.map(fn => ({
    name: fn.name,
    displayName: fn.displayName,
    blueprintCallable: fn.blueprintCallable,
    blueprintPure: fn.blueprintPure,
    static: fn.static,
    parameters: fn.parameters.map(parameter => ({
      name: parameter.name,
      displayNameText: parameter.displayNameText,
      type: parameter.type,
      direction: parameter.direction,
    })),
    returnType: fn.returnType,
    toolTip: fn.tooltip,
  }))
}

/** Render one function as a line a model can read. */
function functionLine(fn: ReturnType<typeof viewFunctions>[number]): string {
  const parameters = fn.parameters
    .map(parameter => `${parameter.direction === 'input' ? '' : `${parameter.direction} `}${parameter.name}: ${parameter.type}`)
    .join(', ')
  const returns = fn.returnType === '' ? '' : ` -> ${fn.returnType}`
  return `  ${fn.static ? 'static ' : ''}${fn.name}(${parameters})${returns}`
}

/** Render one property as a line a model can read. */
function propertyLine(property: { name: string; type: string }): string {
  return `  ${property.name}: ${property.type}`
}

/**
 * A `(cached)` marker for a result summary, in the same shape for every tool.
 *
 * @param cached - whether the reflection answer came from the schema cache.
 * @returns the suffix, or an empty string.
 */
function cachedSuffix(cached: boolean): string {
  return cached ? ' (cached)' : ''
}

/** Parse one nested-JSON-text payload, reporting a failure instead of throwing. */
function parseNestedJson(text: string | undefined, label: string): {
  value: JsonValue
  parseError?: string
} {
  const raw = text ?? ''
  if (raw.trim() === '') return { value: null }
  try {
    return { value: JSON.parse(raw) as JsonValue }
  } catch (error: unknown) {
    return {
      value: raw as JsonValue,
      parseError: `${label} is not valid JSON (${error instanceof Error ? error.message : String(error)}); returning the raw text instead.`,
    }
  }
}

/**
 * A short display label for one canonical Type, for a row summary.
 *
 * `class(/Script/Engine.StaticMeshComponent)` —`class StaticMeshComponent`.
 * The panel's tables use the richer Type labels in `client/type-label.ts`; this
 * helper exists so a *recorded* summary does not carry a long canonical string.
 *
 * @param type - canonical Type string.
 * @returns the short label (the input unchanged when it is not `kind(...)`).
 */
function shortTypeLabel(type: string): string {
  const open = type.indexOf('(')
  if (open <= 0 || !type.endsWith(')')) return type
  const inner = type.slice(open + 1, -1)
  const cut = Math.max(inner.lastIndexOf('.'), inner.lastIndexOf('/'))
  const tail = inner.slice(cut + 1)
  return tail === '' ? type : `${type.slice(0, open)} ${tail}`
}

/**
 * Render a property value for a one-line row summary —never as raw JSON.
 *
 * The collapsed history row is read at a glance, and a `{"X":"0.0",…}` blob is
 * not readable there; the full payload lives behind the Advanced/raw JSON
 * disclosure. Scalars print as themselves, composites print their shape
 * (field names when few enough, a count otherwise).
 *
 * @param value - the decoded value.
 * @returns a compact, JSON-free description.
 */
function valueSummary(value: unknown): string {
  if (value === undefined || value === null) return 'none'
  if (typeof value === 'string') return value.length > 200 ? `${value.slice(0, 200)}…` : value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) return `[${value.length} items]`
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>)
    if (keys.length === 0) return 'empty'
    if (keys.length <= 6) return keys.join(', ')
    return `${keys.length} fields`
  }
  return String(value)
}

/**
 * Serialize one JSON value into the nested-JSON text the Engine reads.
 *
 * @param value - the value the model passed.
 * @returns JSON text, exactly as the Engine's `ValueJson`/`ParametersJson` takes it.
 */
function nestedJsonText(value: unknown): string {
  try {
    return JSON.stringify(value ?? null) ?? 'null'
  } catch {
    throw new KitError('editorautomation/invalid-argument', 'The value could not be serialized to JSON text.')
  }
}

/**
 * Resolve a nested-JSON argument pair: the raw text wins when both are given,
 * and exactly one of them is required.
 *
 * @param text - `valueJson`/`parametersJson`, passed through verbatim.
 * @param value - the structured alternative, serialized here.
 * @param textName - parameter name, for the failure message.
 * @param valueName - parameter name, for the failure message.
 * @param fallback - text to use when neither is given, or `undefined` when one is required.
 * @returns the JSON text to put on the wire.
 */
function resolveNestedArg(
  text: unknown,
  value: unknown,
  textName: string,
  valueName: string,
  fallback?: string,
): string {
  const hasText = typeof text === 'string' && text.trim() !== ''
  const hasValue = value !== undefined
  if (hasText && hasValue) {
    throw new KitError(
      'editorautomation/invalid-argument',
      `Pass either "${textName}" or "${valueName}", not both: "${textName}" is the raw JSON text the Engine takes, "${valueName}" is the same thing as a structured value.`,
    )
  }
  if (hasText) return text as string
  if (hasValue) return nestedJsonText(value)
  if (fallback !== undefined) return fallback
  throw new KitError('editorautomation/invalid-argument', `One of "${textName}" or "${valueName}" is required.`)
}

/** The `PID — UE — project` line shared by ping and the editor-info tool. */
function editorIdentity(value: {
  readonly processId?: number | undefined
  readonly engineVersion?: string | undefined
  readonly projectName?: string | undefined
}): string {
  const parts: string[] = []
  if (typeof value.processId === 'number' && Number.isFinite(value.processId)) parts.push(`PID ${value.processId}`)
  if (typeof value.engineVersion === 'string' && value.engineVersion !== '') parts.push(`UE ${value.engineVersion}`)
  if (typeof value.projectName === 'string' && value.projectName !== '') parts.push(value.projectName)
  return parts.join(', ')
}

/**
 * A one-to-two line identity summary: `PID 21844, UE 5.5.4, Game —C:\…\Game`.
 *
 * @param info - the normalized editor identity.
 * @returns the summary text.
 */
function editorInfoText(info: EditorInfoView): string {
  const identity = editorIdentity(info)
  const parts: string[] = []
  if (identity !== '') parts.push(identity)
  if (info.projectDir !== undefined) parts.push(info.projectDir)
  if (info.isEditor === false) parts.push('not an editor process')
  return parts.length === 0 ? 'EditorAutomation did not report the editor identity.' : parts.join(' \u2014 ')
}

/**
 * Best-effort `GetEditorInfo` for ping.
 *
 * Ping's contract is “Ping answered pong”; identity is an enrichment. An older
 * EditorAutomation build that does not have the function, or any transient failure
 * while reading it, must not turn a healthy editor into a failed probe.
 *
 * @param deps - tool dependencies.
 * @param signal - caller cancellation.
 * @returns the identity, or an empty view when it could not be read.
 */
async function bestEffortEditorInfo(deps: ToolDeps, signal?: AbortSignal): Promise<EditorInfoView> {
  try {
    return await deps.reflection.getEditorInfo(signal)
  } catch {
    return {}
  }
}

/** Output schema shared by the reflection tools that return a listing. */
const LISTING_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    targetType: { type: 'string', required: true },
    path: { type: 'string', required: true },
    count: { type: 'integer', required: true },
    rows: { type: 'json', required: true },
    text: { type: 'string', required: true },
    truncated: { type: 'boolean', required: true },
    cached: { type: 'boolean', required: true },
  },
} as const

/**
 * Register every tool.
 *
 * @param ctx - plugin context with the tool registry.
 * @param deps - the editor client, the history store, config and clock.
 */
const enabledToolGroups = new Map<string, Set<string>>()

function groupsFor(agentId: string | undefined): Set<string> {
  const key = agentId ?? 'global'
  let groups = enabledToolGroups.get(key)
  if (groups === undefined) {
    groups = new Set()
    enabledToolGroups.set(key, groups)
  }
  return groups
}

export function registerTools(ctx: Context, deps: ToolDeps): void {
  // Tell the model to stay on this plugin's path rather than hand-rolling the
  // same HTTP calls: a shell `curl` at the Remote Control port would skip the
  // result-struct checks and leave no history row for the user to review.
  ctx.inject(['systemPrompt'], scoped => {
    const prompt = scoped.get('systemPrompt') as
      | {
        section?: (
          section: { name: string; order: number; text: string | (() => string) },
        ) => () => void
      }
      | undefined
    const section = prompt?.section
    if (section === undefined) return
    const text =
      'To inspect or change the Unreal editor, use the `unreal_*` tools. They are the only sanctioned path: they call the EditorAutomation plugin\'s class default object through Remote Control, assert its result struct, and record each call in the user\'s per-session call history. Do not drive the editor by hand —no shell `curl`/`Invoke-RestMethod` against the Remote Control port —because those bypass the result checks and leave no trace for the user to review.'
    scoped.effect(
      () => section.call(prompt, { name: 'dsh-unreal', order: 900, text }),
      'dsh-unreal: system prompt section',
    )
  })

  ctx.tools.register(defineTool({
    name: 'unreal_ping',
    description:
      'Liveness probe for the Unreal EditorAutomation plugin. Calls EditorAutomationLibrary.Ping and returns "pong" when the plugin module is loaded and Remote Control answered. When the plugin also supports GetEditorInfo, the answer carries the editor process id, engine version and project, so one probe identifies the editor too. Use it before a batch of editor work when you are unsure the editor is running.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pong: { type: 'boolean', required: true },
          value: { type: 'string', required: true },
          processId: { type: 'integer' },
          engineVersion: { type: 'string' },
          projectName: { type: 'string' },
          projectDir: { type: 'string' },
          isEditor: { type: 'boolean' },
        },
      },
      render: (_args, value) => {
        if (!value.pong) return [{ type: 'text', text: 'EditorAutomation did not answer "pong".' }]
        const identity = editorIdentity(value)
        return [{
          type: 'text',
          text: `EditorAutomation answered: ${value.value}${identity === '' ? '' : ` (${identity})`}`,
        }]
      },
    },
    async execute(_args, exec) {
      return await audited(deps, exec, { tool: 'unreal_ping', params: {} }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.core, 'Ping', {})
        const value = typeof result.payload === 'string' ? result.payload : ''
        if (value !== 'pong') {
          throw new KitError('rc/bad-response', `Ping answered ${JSON.stringify(value)} instead of "pong".`, {
            detail: String(JSON.stringify(result.payload) ?? result.payload).slice(0, 200),
          })
        }
        const info = await bestEffortEditorInfo(deps, exec.signal)
        const identity = editorIdentity(info)
        return {
          value: {
            pong: value === 'pong',
            value,
            ...(info.processId === undefined ? {} : { processId: info.processId }),
            ...(info.engineVersion === undefined ? {} : { engineVersion: info.engineVersion }),
            ...(info.projectName === undefined ? {} : { projectName: info.projectName }),
            ...(info.projectDir === undefined ? {} : { projectDir: info.projectDir }),
            ...(info.isEditor === undefined ? {} : { isEditor: info.isEditor }),
          },
          resultSummary: `${value}${identity === '' ? '' : ` (${identity})`}`,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_editor_info',
    description:
      'Describe the Unreal editor process behind the Remote Control endpoint: its OS process id (PID), engine version, project name and directory, and whether the answering process is an editor. Use it to identify which editor instance the tools are talking to; the PID is also what a person needs to find the process in a task manager.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          processId: { type: 'integer' },
          engineVersion: { type: 'string' },
          projectName: { type: 'string' },
          projectDir: { type: 'string' },
          isEditor: { type: 'boolean' },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(_args, exec) {
      return await audited(deps, exec, { tool: 'unreal_get_editor_info', params: {} }, async () => {
        const info = await deps.reflection.getEditorInfo(exec.signal)
        const text = editorInfoText(info)
        return {
          value: {
            ...(info.processId === undefined ? {} : { processId: info.processId }),
            ...(info.engineVersion === undefined ? {} : { engineVersion: info.engineVersion }),
            ...(info.projectName === undefined ? {} : { projectName: info.projectName }),
            ...(info.projectDir === undefined ? {} : { projectDir: info.projectDir }),
            ...(info.isEditor === undefined ? {} : { isEditor: info.isEditor }),
            text,
          },
          resultSummary: text,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_enum_info',
    description:
      `Describe one Unreal enum by its canonical Type string: every entry's C++ name, display name and numeric value. Enum values on the wire are NUMBERS; resolve a number to a name here before writing it into any ValueJson. ${WIRE_CONVENTIONS}`,
    parameters: {
      type: {
        type: 'string',
        required: true,
        description: 'The enum Type, e.g. "enum(/Script/Engine.ECollisionEnabled)".',
      },
    },
    output: {
      schema: LISTING_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      return await audited(deps, exec, { tool: 'unreal_get_enum_info', params: args }, async trail => {
        const targetType = requiredString(args.type, 'type')
        trail.targetType = targetType
        // Cached: the schema exists so the harness can display it, and a repeat
        // read must not cost another game-thread round trip.
        const lookup = await deps.reflection.enumInfo(targetType, exec.signal)
        trail.cacheHit = lookup.cached
        const info: EnumInfoView = lookup.value
        const lines = [`${targetType} (${info.entries.length} entries):`]
        for (const entry of info.entries) lines.push(`  ${entry.value} = ${entry.name}  (${entry.displayName})`)
        const rendered = clip(lines.join('\n'), 12_000)
        return {
          value: {
            targetType,
            path: info.path,
            count: info.entries.length,
            rows: toJson(info.entries),
            text: rendered.text,
            truncated: rendered.truncated,
            cached: lookup.cached,
          },
          resultSummary: `${info.entries.length} entries${cachedSuffix(lookup.cached)}`,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_struct_info',
    description:
      `Describe one Unreal struct: every member's name and canonical Type. Use it to learn the keys and scalar encodings of a struct before writing a struct property or a struct-typed function parameter as nested JSON text. ${WIRE_CONVENTIONS}`,
    parameters: {
      type: {
        type: 'string',
        required: true,
        description: 'The struct Type, e.g. "struct(/Script/CoreUObject.Vector)".',
      },
    },
    output: {
      schema: LISTING_OUTPUT,
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      return await audited(deps, exec, { tool: 'unreal_get_struct_info', params: args }, async trail => {
        const targetType = requiredString(args.type, 'type')
        trail.targetType = targetType
        const lookup = await deps.reflection.structInfo(targetType, exec.signal)
        trail.cacheHit = lookup.cached
        const info: StructInfoView = lookup.value
        const rows = viewMembers(info.members)
        const lines = [`${targetType} (${rows.length} properties):`]
        for (const row of rows) lines.push(propertyLine(row))
        const rendered = clip(lines.join('\n'), 12_000)
        return {
          value: {
            targetType,
            path: info.path,
            count: rows.length,
            rows: toJson(rows),
            text: rendered.text,
            truncated: rendered.truncated,
            cached: lookup.cached,
          },
          resultSummary: `${rows.length} properties${cachedSuffix(lookup.cached)}`,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_class_info',
    description:
      `Describe one Unreal class (or the class of an object Type): its properties and every BlueprintCallable function with parameter names, directions and return type. This is how you learn valid property paths and exact function parameter names before calling unreal_get_property_value, unreal_set_property_value or unreal_call_function. ${WIRE_CONVENTIONS}`,
    parameters: {
      type: {
        type: 'string',
        required: true,
        description: 'A class Type, e.g. "class(/Script/Engine.StaticMeshComponent)", or an object Type "object(/Script/Engine.Default__Actor)".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetType: { type: 'string', required: true },
          path: { type: 'string', required: true },
          properties: { type: 'json', required: true },
          functions: { type: 'json', required: true },
          propertyCount: { type: 'integer', required: true },
          functionCount: { type: 'integer', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          cached: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      return await audited(deps, exec, { tool: 'unreal_get_class_info', params: args }, async trail => {
        const targetType = requiredString(args.type, 'type')
        trail.targetType = targetType
        const lookup = await deps.reflection.classInfo(targetType, exec.signal)
        trail.cacheHit = lookup.cached
        const info: ClassInfoView = lookup.value
        const properties = viewMembers(info.properties)
        const functions = viewFunctions(info.functions)
        const lines = [
          `${info.path} (${properties.length} properties, ${functions.length} functions):`,
          'Properties:',
        ]
        for (const property of properties) lines.push(propertyLine(property))
        lines.push('Functions:')
        for (const fn of functions) lines.push(functionLine(fn))
        const rendered = clip(lines.join('\n'), 14_000)
        return {
          value: {
            targetType,
            path: info.path,
            properties: toJson(properties),
            functions: toJson(functions),
            propertyCount: properties.length,
            functionCount: functions.length,
            text: rendered.text,
            truncated: rendered.truncated,
            cached: lookup.cached,
          },
          resultSummary: `${properties.length} properties, ${functions.length} functions${cachedSuffix(lookup.cached)}`,
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_function_info',
    description:
      `Describe one BlueprintCallable function of a class: its parameters (names, canonical Types, directions), its return Type and its editor tooltip. Use it to learn the exact parameter keys for unreal_call_function —keys are C++ parameter names, not display names —and to know which out parameters come back. ${WIRE_CONVENTIONS}`,
    parameters: {
      type: {
        type: 'string',
        required: true,
        description: 'The class/object Type, e.g. "class(/Script/Engine.StaticMeshComponent)".',
      },
      functionName: {
        type: 'string',
        required: true,
        description: 'The UFunction name, e.g. "GetClosestPointOnCollision".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetType: { type: 'string', required: true },
          path: { type: 'string', required: true },
          parameters: { type: 'json', required: true },
          returnType: { type: 'string', required: true },
          tooltip: { type: 'string', required: true },
          text: { type: 'string', required: true },
          truncated: { type: 'boolean', required: true },
          cached: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      return await audited(
        deps,
        exec,
        { tool: 'unreal_get_function_info', params: args },
        async trail => {
          const targetType = requiredString(args.type, 'type')
          const functionName = requiredString(args.functionName, 'functionName')
          trail.targetType = targetType
          trail.functionName = functionName
          const lookup = await deps.reflection.functionInfo(targetType, functionName, exec.signal)
          trail.cacheHit = lookup.cached
          const info = lookup.value
          const [mapped] = viewFunctions([info.function])
          const parameters = mapped?.parameters ?? []
          const returnType = mapped?.returnType ?? ''
          const toolTip = mapped?.toolTip ?? ''
          const lines = [
            `${info.path}(${parameters.map(parameter => `${parameter.name}: ${parameter.type}`).join(', ')})${returnType === '' ? '' : ` -> ${returnType}`}`,
            `Parameters (${parameters.length}):`,
          ]
          for (const parameter of parameters) lines.push(`  ${parameter.direction} ${parameter.name}: ${parameter.type}`)
          if (toolTip !== '') lines.push('', `ToolTip: ${toolTip}`)
          const rendered = clip(lines.join('\n'), 12_000)
          return {
            value: {
              targetType,
              path: info.path,
              parameters: toJson(parameters),
              returnType,
              tooltip: toolTip,
              text: rendered.text,
              truncated: rendered.truncated,
              cached: lookup.cached,
            },
            resultSummary: `${parameters.length} parameters${returnType === '' ? '' : `, returns ${returnType}`}${cachedSuffix(lookup.cached)}`,
          }
        },
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_property_type',
    description:
      `Resolve the canonical Type of one property path without touching an object instance. Purely schema-based, so it works for a class Type you have not opened and can be cached by the caller. Returns the Type string the reflection API would report. ${WIRE_CONVENTIONS}`,
    parameters: {
      type: {
        type: 'string',
        required: true,
        description: 'The class/object Type, e.g. "class(/Script/Engine.StaticMeshComponent)".',
      },
      propertyPath: {
        type: 'string',
        required: true,
        description: 'The property path, e.g. "RelativeLocation.X" or "OverrideMaterials[0]".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          targetType: { type: 'string', required: true },
          propertyPath: { type: 'string', required: true },
          propertyType: { type: 'string', required: true },
          cached: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.targetType}.${value.propertyPath}: ${value.propertyType}` }],
    },
    async execute(args, exec) {
      return await audited(
        deps,
        exec,
        { tool: 'unreal_get_property_type', params: args },
        async trail => {
          const targetType = requiredString(args.type, 'type')
          const propertyPath = requiredString(args.propertyPath, 'propertyPath')
          trail.targetType = targetType
          trail.propertyPath = propertyPath
          const lookup = await deps.reflection.propertyType(targetType, propertyPath, exec.signal)
          const propertyType = lookup.value.type
          trail.propertyType = propertyType
          trail.cacheHit = lookup.cached
          return {
            value: { targetType, propertyPath, propertyType, cached: lookup.cached },
            resultSummary: `${shortTypeLabel(propertyType)}${cachedSuffix(lookup.cached)}`,
          }
        },
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_object_class',
    description:
      'Resolve the canonical class Type of a live Unreal object from its object path. Useful for level instances, whose path names no class: the returned "class(/Script/Engine.…)" Type is what unreal_get_class_info, unreal_get_function_info and unreal_get_property_type accept. Cached per object path, so repeated lookups do not cost another round trip.',
    parameters: {
      objectPath: {
        type: 'string',
        required: true,
        description: 'Full object path, e.g. "/Game/Maps/Demo.Demo:PersistentLevel.Cube_1".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          objectPath: { type: 'string', required: true },
          classType: { type: 'string', required: true },
          cached: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `${value.objectPath}: ${value.classType}` }],
    },
    async execute(args, exec) {
      return await audited(
        deps,
        exec,
        { tool: 'unreal_get_object_class', params: args },
        async trail => {
          const objectPath = requiredString(args.objectPath, 'objectPath')
          trail.objectPath = objectPath
          const lookup = await deps.reflection.objectClass(objectPath, exec.signal)
          const classType = lookup.value.classType
          trail.targetType = classType === '' ? undefined : classType
          trail.cacheHit = lookup.cached
          return {
            value: { objectPath, classType, cached: lookup.cached },
            resultSummary: `${classType === '' ? '' : shortTypeLabel(classType)}${cachedSuffix(lookup.cached)}`,
          }
        },
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_property_value',
    description:
      `Read one property of a live Unreal object as nested JSON text. PropertyPath accepts dotted struct traversal and array indices ("RelativeLocation.X", "OverrideMaterials[0]"). The result carries both "valueJson" (the Engine's exact text, scalars as strings, enums numeric) and "value" (that text parsed, when it parses). ${WIRE_CONVENTIONS}`,
    parameters: {
      objectPath: {
        type: 'string',
        required: true,
        description: 'Full object path, e.g. "/Script/Engine.Default__StaticMeshComponent" or a level object path.',
      },
      propertyPath: {
        type: 'string',
        required: true,
        description: 'The property path to read, e.g. "RelativeLocation.X".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          objectPath: { type: 'string', required: true },
          propertyPath: { type: 'string', required: true },
          valueJson: { type: 'string', required: true },
          value: { type: 'json', required: true },
          parseError: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `${value.objectPath}.${value.propertyPath} = ${value.valueJson}` },
      ],
    },
    async execute(args, exec) {
      // Filled by the body; the Details builder runs after it and reads these.
      let wire: { objectPath: string; propertyPath: string; valueJson: string } | undefined
      return await audited(
        deps,
        exec,
        {
          tool: 'unreal_get_property_value',
          params: args,
          details: async outcome => {
            const value = outcome.value as { valueJson?: unknown } | undefined
            if (wire === undefined || outcome.error !== undefined) return undefined
            if (typeof value?.valueJson !== 'string') return undefined
            return await buildPropertyValueDetails(detailsDeps(deps, exec), {
              objectPath: wire.objectPath,
              propertyPath: wire.propertyPath,
              valueJson: value.valueJson,
            })
          },
        },
        async trail => {
          const objectPath = requiredString(args.objectPath, 'objectPath')
          const propertyPath = requiredString(args.propertyPath, 'propertyPath')
          trail.objectPath = objectPath
          trail.propertyPath = propertyPath
          const propertyValueJson = await requireEditorAutomationString(
            deps,
            exec.signal,
            EDITOR_AUTOMATION_LIBRARIES.core,
            'GetPropertyValue',
            { ObjectPath: objectPath, PropertyPath: propertyPath },
            `${objectPath}.${propertyPath}`,
          )
          const parsed = parseNestedJson(propertyValueJson, 'ValueJson')
          wire = { objectPath, propertyPath, valueJson: propertyValueJson }
          return {
            value: {
              objectPath,
              propertyPath,
              valueJson: propertyValueJson,
              value: parsed.value,
              ...(parsed.parseError === undefined ? {} : { parseError: parsed.parseError }),
            },
            resultSummary: valueSummary(parsed.value),
          }
        },
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_set_property_value',
    description:
      `Write one property of a live Unreal object from nested JSON text. Pass either "valueJson" (the raw JSON text the Engine takes: scalars as strings, enums numeric) or "value" (the same thing as a structured value, which this tool serializes). The result reports the value before and after the write. Set generateTransaction to make the write an editor undo step. ${WIRE_CONVENTIONS}`,
    parameters: {
      objectPath: {
        type: 'string',
        required: true,
        description: 'Full object path.',
      },
      propertyPath: {
        type: 'string',
        required: true,
        description: 'The property path to write, e.g. "RelativeLocation.Z".',
      },
      valueJson: {
        type: 'string',
        description: 'The new value as nested JSON text, e.g. "\\"12.5\\"" for a double or "{\\"X\\":\\"1\\",\\"Y\\":\\"2\\",\\"Z\\":\\"3\\"}" for a Vector.',
      },
      value: {
        type: 'json',
        description: 'The new value as a structured JSON value; serialized to text for the Engine. Mutually exclusive with valueJson.',
      },
      generateTransaction: {
        type: 'boolean',
        description: 'Wrap the write in an editor transaction (undoable).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          objectPath: { type: 'string', required: true },
          propertyPath: { type: 'string', required: true },
          oldValueJson: { type: 'string', required: true },
          newValueJson: { type: 'string', required: true },
          oldValue: { type: 'json', required: true },
          newValue: { type: 'json', required: true },
          changed: { type: 'boolean', required: true },
          transaction: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `Set ${value.objectPath}.${value.propertyPath}: ${value.oldValueJson} -> ${value.newValueJson}${value.changed ? '' : ' (unchanged)'}`,
        },
      ],
    },
    async execute(args, exec) {
      // Filled by the body; the Details builder runs after it and reads these.
      let wire: { objectPath: string; propertyPath: string; oldValueJson: string; newValueJson: string } | undefined
      return await audited(
        deps,
        exec,
        {
          tool: 'unreal_set_property_value',
          params: args,
          details: async outcome => {
            if (wire === undefined || outcome.error !== undefined) return undefined
            return await buildPropertyWriteDetails(detailsDeps(deps, exec), wire)
          },
        },
        async trail => {
          const objectPath = requiredString(args.objectPath, 'objectPath')
          const propertyPath = requiredString(args.propertyPath, 'propertyPath')
          const valueJson = resolveNestedArg(args.valueJson, args.value, 'valueJson', 'value')
          const transaction = args.generateTransaction ?? false
          trail.objectPath = objectPath
          trail.propertyPath = propertyPath
          const write = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.core, 'SetPropertyValue', {
            ObjectPath: objectPath,
            PropertyPath: propertyPath,
            ValueJson: valueJson,
            bGenerateTransaction: transaction,
          })
          if (!structBool(write.payload, 'bSuccess')) {
            throw new KitError(
              'editorautomation/SetPropertyValueFailed',
              `SetPropertyValue reported failure for ${objectPath}.${propertyPath}.`,
              { functionName: 'SetPropertyValue', hint: 'Call unreal_get_recent_log for the engine log reason.' },
            )
          }
          const oldText = structString(write.payload, 'OldValueJson')
          const newText = structString(write.payload, 'NewValueJson')
          const oldParsed = parseNestedJson(oldText, 'OldValueJson')
          const newParsed = parseNestedJson(newText, 'NewValueJson')
          wire = { objectPath, propertyPath, oldValueJson: oldText, newValueJson: newText }
          return {
            value: {
              objectPath,
              propertyPath,
              oldValueJson: oldText,
              newValueJson: newText,
              oldValue: oldParsed.value,
              newValue: newParsed.value,
              changed: oldText !== newText,
              transaction,
            },
            resultSummary: `${valueSummary(oldParsed.value)} -> ${valueSummary(newParsed.value)}`,
          }
        },
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_call_function',
    description:
      `Call one BlueprintCallable function on a live Unreal object with nested-JSON parameters. Pass either "parametersJson" (a JSON object keyed by parameter name, which is what the Engine takes) or "parameters" (the same as a structured value, serialized here); omitted parameters keep their defaults. The result carries "returnValueJson"/"returnValue", out parameters and the return Type; an empty return value means the function returned nothing, which is success. Set generateTransaction to make the call an editor undo step. ${WIRE_CONVENTIONS}`,
    parameters: {
      objectPath: {
        type: 'string',
        required: true,
        description: 'Full object path.',
      },
      functionName: {
        type: 'string',
        required: true,
        description: 'The UFunction name exactly as unreal_get_class_info reports it.',
      },
      parametersJson: {
        type: 'string',
        description: 'Input parameters as JSON object text, e.g. "{\\"bNewVisibility\\":\\"true\\"}", or "{}". Mutually exclusive with parameters.',
      },
      parameters: {
        type: 'json',
        description: 'Input parameters as a structured object; serialized to text for the Engine. Mutually exclusive with parametersJson.',
      },
      generateTransaction: {
        type: 'boolean',
        description: 'Wrap the call in an editor transaction (undoable).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          objectPath: { type: 'string', required: true },
          functionName: { type: 'string', required: true },
          returnValueJson: { type: 'string', required: true },
          returnValue: { type: 'json', required: true },
          outParametersJson: { type: 'string', required: true },
          outParameters: { type: 'json', required: true },
          returnType: { type: 'string', required: true },
          returnedNothing: { type: 'boolean', required: true },
          transaction: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.returnedNothing
            ? `${value.objectPath}.${value.functionName}() returned nothing (success).`
            : `${value.objectPath}.${value.functionName}() -> ${value.returnValueJson}${value.returnType === '' ? '' : ` (${value.returnType})`}`,
        },
      ],
    },
    async execute(args, exec) {
      // Filled by the body; the Details builder runs after it and reads these —     // including on a failed call, where only the inputs are known.
      let wire: { objectPath: string; functionName: string; parametersJson: string } | undefined
      let result: { returnValueJson: string; outParametersJson: string; returnType: string } | undefined
      return await audited(
        deps,
        exec,
        {
          tool: 'unreal_call_function',
          params: args,
          details: async outcome => {
            if (wire === undefined) return undefined
            return await buildCallFunctionDetails(detailsDeps(deps, exec), {
              ...wire,
              ...(outcome.error === undefined && result !== undefined ? { result } : {}),
            })
          },
        },
        async trail => {
          const objectPath = requiredString(args.objectPath, 'objectPath')
          const functionName = requiredString(args.functionName, 'functionName')
          const parametersJson = resolveNestedArg(args.parametersJson, args.parameters, 'parametersJson', 'parameters', '{}')
          const transaction = args.generateTransaction ?? false
          trail.objectPath = objectPath
          trail.functionName = functionName
          wire = { objectPath, functionName, parametersJson }
          const returned = await deps.client.call(
            'CallFunction',
            {
              ObjectPath: objectPath,
              FunctionName: functionName,
              ParametersJson: parametersJson,
              bGenerateTransaction: transaction,
            },
            exec.signal,
          )
          const kitResult = assertKitResult<KitCallFunctionResult>('CallFunction', returned)
          const returnText = kitResult.ReturnValueJson ?? ''
          const outText = kitResult.OutParametersJson ?? '{}'
          const returnParsed = parseNestedJson(returnText, 'ReturnValueJson')
          const outParsed = parseNestedJson(outText, 'OutParametersJson')
          const returnedNothing = returnText.trim() === ''
          result = { returnValueJson: returnText, outParametersJson: outText, returnType: kitResult.ReturnType ?? '' }
          return {
            value: {
              objectPath,
              functionName,
              returnValueJson: returnText,
              returnValue: returnParsed.value,
              outParametersJson: outText,
              outParameters: outParsed.value,
              returnType: kitResult.ReturnType ?? '',
              returnedNothing,
              transaction,
            },
            resultSummary: returnedNothing
              ? 'returned nothing'
              : `${valueSummary(returnParsed.value)}${kitResult.ReturnType === undefined || kitResult.ReturnType === '' ? '' : ` (${kitResult.ReturnType})`}`,
          }
        },
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_call_functions',
    description:
      `Call several EditorAutomation functions in one Remote Control round trip. Each entry is {objectPath, functionName, parametersJson | parameters, generateTransaction?}; calls run sequentially so later calls see earlier side effects, a failing entry does not stop the batch, and every entry reports its own result. Use this instead of many unreal_call_function calls when a task is a known list of calls; up to 256 calls per batch. ${WIRE_CONVENTIONS}`,
    parameters: {
      calls: {
        type: 'json',
        required: true,
        description: 'JSON array of calls: [{ objectPath, functionName, parametersJson | parameters, generateTransaction? }, ...].',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [
        {
          type: 'text',
          text: `unreal_call_functions: ${JSON.stringify(value, null, 2)}`,
        },
      ],
    },
    async execute(args, exec) {
      const callsInput = args.calls
      if (!Array.isArray(callsInput)) {
        throw new KitError('editorautomation/invalid_argument', 'calls must be a JSON array of call objects.', {
          functionName: 'CallFunctions',
        })
      }
      const calls = callsInput.map((raw, index) => {
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
          throw new KitError('editorautomation/invalid_argument', `calls[${index}] must be an object.`, {
            functionName: 'CallFunctions',
          })
        }
        const entry = raw as Record<string, unknown>
        const objectPath = requiredString(entry.objectPath, `calls[${index}].objectPath`)
        const functionName = requiredString(entry.functionName, `calls[${index}].functionName`)
        const parametersJson = resolveNestedArg(
          entry.parametersJson,
          entry.parameters,
          `calls[${index}].parametersJson`,
          `calls[${index}].parameters`,
          '{}',
        )
        return { objectPath, functionName, parametersJson, generateTransaction: entry.generateTransaction === true }
      })
      const callsJson = JSON.stringify(calls)
      let batchDetails: CallDetails | undefined
      return await audited(
        deps,
        exec,
        {
          tool: 'unreal_call_functions',
          params: { calls: calls.map(call => ({ objectPath: call.objectPath, functionName: call.functionName })) },
          details: async () => batchDetails,
        },
        async () => {
          const returned = await deps.client.call('CallFunctions', { CallsJson: callsJson }, exec.signal)
          const kitResult = returned as KitBatchCallResult | null
          if (kitResult === null || typeof kitResult !== 'object' || Array.isArray(kitResult)) {
            throw new KitError('rc/bad-response', 'CallFunctions answered something that is not its result struct.', {
              functionName: 'CallFunctions',
              detail: String(JSON.stringify(returned) ?? returned).slice(0, 400),
            })
          }
          const entries = kitResult.Results ?? []
          if (kitResult.bSuccess === false && entries.length === 0) {
            throw new KitError(
              'editorautomation/CallFunctionsFailed',
              `CallFunctions batch was rejected: ${kitResult.ErrorMessage?.trim() || 'unknown reason'}`,
              { functionName: 'CallFunctions' },
            )
          }
          const results = entries.map((entry: KitBatchCallEntry, position: number) => {
            const index = typeof entry.Index === 'number' ? entry.Index : position
            const errorCode = typeof entry.ErrorCode === 'number' ? entry.ErrorCode : 0
            const returnText = entry.ReturnValueJson ?? ''
            const outText = entry.OutParametersJson ?? '{}'
            return {
              index,
              ok: errorCode === 0,
              objectPath: entry.ObjectPath ?? calls[index]?.objectPath ?? '',
              functionName: entry.FunctionName ?? calls[index]?.functionName ?? '',
              errorCode,
              errorMessage: entry.ErrorMessage ?? '',
              hint: entry.Hint ?? '',
              returnValueJson: returnText,
              returnValue: parseNestedJson(returnText, `results[${index}].returnValueJson`).value,
              outParametersJson: outText,
              outParameters: parseNestedJson(outText, `results[${index}].outParametersJson`).value,
              returnType: entry.ReturnType ?? '',
            }
          })
          const failed = results.filter(result => !result.ok).length
          batchDetails = await buildBatchCallDetails(detailsDeps(deps, exec), results.map(result => ({
            index: result.index,
            objectPath: result.objectPath,
            functionName: result.functionName,
            ok: result.ok,
            parametersJson: calls[result.index]?.parametersJson ?? '{}',
            returnValueJson: result.returnValueJson,
            outParametersJson: result.outParametersJson,
            returnType: result.returnType,
            errorMessage: result.errorMessage,
          })))
          return {
            value: {
              batchSuccess: kitResult.bSuccess !== false,
              batchErrorMessage: kitResult.ErrorMessage ?? '',
              calls,
              results,
              failed,
            },
            resultSummary: `${results.length - failed}/${results.length} calls ok`,
          }
        },
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_start_pie',
    description: 'Start Play-In-Editor. Pass levelPath to play a specific map; omit it to use the currently open level.',
    parameters: {
      levelPath: { type: 'string', description: 'Map asset path, e.g. /Game/Maps/UMGTestMap.' },
      newWindow: { type: 'boolean', description: 'Play in a separate Game Preview window instead of the editor viewport; default false.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const levelPath = typeof args.levelPath === 'string' ? args.levelPath : ''
      const newWindow = args.newWindow === true
      return await audited(deps, exec, { tool: 'unreal_start_pie', params: { levelPath, newWindow } }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.core, 'StartPIE', { LevelPath: levelPath, bNewWindow: newWindow }, levelPath === '' ? 'the current level' : levelPath)
        return { value: { success: true, levelPath, newWindow }, resultSummary: 'PIE start requested' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_stop_pie',
    description: 'Request the current Play-In-Editor session to stop.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      return await audited(deps, exec, { tool: 'unreal_stop_pie', params: {} }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.core, 'StopPIE', {}, 'the PIE session')
        return { value: { success: true }, resultSummary: 'PIE stop requested' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_is_pie_running',
    description: 'Whether a Play-In-Editor session is running or queued.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      return await audited(deps, exec, { tool: 'unreal_is_pie_running', params: {} }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.core, 'IsPIERunning', {})
        return { value: { running: payloadBool(result.payload) }, resultSummary: 'PIE state read' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_focus_pie',
    description: 'Bring the running PIE game viewport to the front, give it keyboard focus, and force game-only input mode. Physical keys only reach a game PlayerController while the game viewport owns keyboard focus.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      return await audited(deps, exec, { tool: 'unreal_focus_pie', params: {} }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.core, 'FocusPIEViewport', {}, 'the PIE viewport')
        return { value: { success: true }, resultSummary: 'PIE viewport focused' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_send_key',
    description: 'Simulate one key press (down + up) inside the running PIE session, routed to the game viewport. KeyName is an FKey name such as Up, Down, Left, Right, W, A, S, D, R, Space, Enter.',
    parameters: {
      keyName: { type: 'string', required: true, description: 'FKey name, e.g. Up, Down, Left, Right, R, Space.' },
      focusViewport: { type: 'boolean', description: 'Focus the PIE game viewport before sending; default true.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const keyName = typeof args.keyName === 'string' ? args.keyName : ''
      const focusViewport = args.focusViewport !== false
      return await audited(deps, exec, { tool: 'unreal_send_key', params: { keyName, focusViewport } }, async () => {
        await requireEditorAutomationBool(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.core,
          'SendKeyToPIE',
          { KeyName: keyName, bFocusViewport: focusViewport },
          `key ${keyName}`,
        )
        return { value: { success: true, keyName, focusViewport }, resultSummary: `key ${keyName} sent` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_screenshot',
    description:
      'Capture a PNG screenshot. target "game" (default) captures the running PIE game viewport —the actual game picture —and is asynchronous: this tool waits for the engine to write the file (up to waitMs) and reports whether it exists. target "editor" captures the active editor window synchronously. Omit filePath and the adapter writes a uniquely named PNG under its own temp screenshot directory (two captures can never overwrite each other, so the recorded history preview keeps its bytes).',
    parameters: {
      target: {
        type: 'string',
        enum: ['game', 'editor'],
        description: 'What to capture: the PIE game viewport (default) or the editor window.',
      },
      filePath: { type: 'string', description: 'Absolute PNG path; omit to let the adapter name a fresh file under its temp screenshot directory.' },
      showUI: { type: 'boolean', description: 'Include HUD/UMG overlays (game target only); default true.' },
      waitMs: { type: 'number', description: 'For the game target: how long to wait for the PNG to appear; default 5000, max 30000.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) =>
        value.exists === true
          ? [{ type: 'text', text: `${value.target} screenshot: ${value.filePath} (${value.bytes} bytes, waited ${value.waitedMs} ms)` }]
          : [
              {
                type: 'text',
                text: `${value.target} screenshot requested but no file appeared at ${value.filePath} after ${value.waitedMs} ms${value.errorMessage === '' ? '' : `: ${value.errorMessage}`}`,
              },
            ],
    },
    async execute(args, exec) {
      const target = args.target === 'editor' ? 'editor' : 'game'
      const filePath = typeof args.filePath === 'string' ? args.filePath : ''
      const showUI = args.showUI !== false
      const requestedWait = typeof args.waitMs === 'number' && Number.isFinite(args.waitMs) ? args.waitMs : 5000
      const waitMs = Math.max(0, Math.min(30000, requestedWait))
      // The adapter owns the file name: a temp directory plus a timestamp+uuid name means
      // two captures can never overwrite each other, so a recorded preview keeps its bytes.
      const screenshotPath = filePath === '' ? await newScreenshotPath() : filePath
      let details: CallDetails | undefined
      return await audited(
        deps,
        exec,
        {
          tool: 'unreal_screenshot',
          params: { target, filePath: screenshotPath, showUI, waitMs },
          details: async () => details,
        },
        async () => {
          const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.core, 'CaptureScreenshot', {
            FilePath: screenshotPath,
            Target: target === 'editor' ? 1 : 0,
            bShowUI: showUI,
          })
          const resolvedPath = typeof result.payload === 'string' ? result.payload : ''
          if (resolvedPath === '') {
            throw new KitError('editorautomation/CaptureScreenshotFailed', `CaptureScreenshot returned no PNG path for target ${target}.`, {
              functionName: 'CaptureScreenshot',
              hint: 'Call unreal_get_recent_log for the engine log reason.',
            })
          }
          const waitedStarted = Date.now()
          let exists = false
          let bytes = 0
          for (;;) {
            try {
              const info = await stat(resolvedPath)
              if (info.isFile() && info.size > 0) {
                exists = true
                bytes = info.size
                break
              }
            } catch {
              // The engine writes the PNG after the next rendered frame; keep polling.
            }
            if (Date.now() - waitedStarted >= waitMs) break
            await new Promise(resolve => setTimeout(resolve, 100))
          }
          const waitedMs = Date.now() - waitedStarted
          const size = exists ? await pngSize(resolvedPath) : undefined
          if (exists) {
            details = buildScreenshotDetails({
              target,
              filePath: resolvedPath,
              bytes,
              ...(size === undefined ? {} : { width: size.width, height: size.height }),
            })
          }
          return {
            value: {
              target,
              filePath: resolvedPath,
              requested: target === 'game',
              exists,
              bytes,
              waitedMs,
              errorMessage: '',
            },
            resultSummary: exists ? `${target} screenshot written (${bytes} bytes)` : `${target} screenshot requested; file not found yet`,
          }
        },
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_recent_log',
    description:
      'Read recent editor diagnostics captured in-memory by EditorAutomation: it records Warning and above from the engine output log into a 4096-line ring buffer, so you can inspect what the editor reported without reading log files. Entries come oldest-first with time, verbosity number (Fatal=1, Error=2, Warning=3), category and message. Use it after a suspicious or failed operation. This tool reaches EditorAutomation through its generic CallFunction dispatcher — the calling convention every tool in this plugin uses.',
    parameters: {
      maxLines: { type: 'number', description: 'Maximum entries to return (default 100, max 2000).' },
      minVerbosity: {
        type: 'string',
        enum: ['fatal', 'error', 'warning'],
        description: 'Only lines at or above this severity; default warning.',
      },
      categoryFilter: { type: 'string', description: 'Case-insensitive log category substring, e.g. "LogSavePackage". Omit for all.' },
      clear: { type: 'boolean', description: 'Clear the captured buffer after reading; default false.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        const entries = value.entries as Array<{ time: string; verbosity: number; category: string; message: string }>
        const names: Record<number, string> = { 1: 'Fatal', 2: 'Error', 3: 'Warning' }
        const lines = entries.map(entry => `${entry.time} ${names[entry.verbosity] ?? `V${entry.verbosity}`}[${entry.category}] ${entry.message}`)
        const footer = `${value.count} entr${value.count === 1 ? 'y' : 'ies'}${value.truncated === true ? ' (truncated)' : ''}, ${value.totalRecorded} captured since start`
        return [{ type: 'text', text: lines.length === 0 ? `No matching log entries. ${footer}` : `${lines.join('\n')}\n${footer}` }]
      },
    },
    async execute(args, exec) {
      const requestedLines = typeof args.maxLines === 'number' && Number.isFinite(args.maxLines) ? args.maxLines : 100
      const maxLines = Math.max(1, Math.min(2000, requestedLines))
      const verbosityNumbers: Record<string, number> = { fatal: 1, error: 2, warning: 3 }
      const minVerbosity = verbosityNumbers[String(args.minVerbosity ?? 'warning').toLowerCase()] ?? 3
      const categoryFilter = typeof args.categoryFilter === 'string' ? args.categoryFilter : ''
      const clear = args.clear === true
      return await audited(
        deps,
        exec,
        { tool: 'unreal_get_recent_log', params: { maxLines, minVerbosity, categoryFilter, clear } },
        async () => {
          const parametersJson = JSON.stringify({
            MaxLines: maxLines,
            MinVerbosity: minVerbosity,
            CategoryFilter: categoryFilter,
            bClear: clear,
          })
          const returned = await deps.client.call(
            'CallFunction',
            {
              ObjectPath: '/Script/EditorAutomation.Default__EditorAutomationCoreLibrary',
              FunctionName: 'GetRecentLog',
              ParametersJson: parametersJson,
              bGenerateTransaction: false,
            },
            exec.signal,
          )
          const kitResult = assertKitResult<KitCallFunctionResult>('CallFunction', returned)
          const parsed = parseNestedJson(kitResult.ReturnValueJson, 'ReturnValueJson').value as
            | {
                Entries?: Array<{ Time?: string; Verbosity?: string; Category?: string; Message?: string }>
                TotalRecorded?: string
                bTruncated?: string | boolean
              }
            | null
          const rawEntries = parsed !== null && Array.isArray(parsed.Entries) ? parsed.Entries : []
          const entries = rawEntries.map(entry => ({
            time: String(entry.Time ?? ''),
            verbosity: Number(entry.Verbosity ?? 0),
            category: String(entry.Category ?? ''),
            message: String(entry.Message ?? ''),
          }))
          const truncated = parsed !== null && (parsed.bTruncated === 'true' || parsed.bTruncated === true)
          return {
            value: {
              entries,
              count: entries.length,
              truncated,
              totalRecorded: Number(parsed?.TotalRecorded ?? 0),
              functionName: 'GetRecentLog',
            },
            resultSummary: `${entries.length} log entries read`,
          }
        },
      )
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_set_tool_groups',
    description: 'Enable or disable optional EditorAutomation tool groups for this agent. Call with groups=[umg], enabled=true before UMG work; UMG tools stay invisible while disabled.',
    parameters: {
      groups: { type: 'array', required: true, description: 'Tool groups to change.', items: { type: 'string', enum: ['umg', 'umg_editor'] } },
      enabled: { type: 'boolean', required: true, description: 'true enables, false disables.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const groups = Array.isArray(args.groups) ? args.groups.map(group => String(group)) : []
      const enabled = args.enabled === true
      const current = groupsFor(exec.agent?.id === undefined ? undefined : String(exec.agent.id))
      for (const group of groups) {
        if (enabled) current.add(group)
        else current.delete(group)
      }
      const text = `${enabled ? 'enabled' : 'disabled'}: ${groups.join(', ')}`
      return { value: { groups, enabled, text }, resultSummary: text }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_widget_roots',
    description: 'List PIE UMG root widget ObjectPaths. Requires the umg group.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(_args, exec) {
      return await audited(deps, exec, { tool: 'unreal_get_widget_roots', params: {} }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umg, 'GetWidgetRoots', {})
        const roots = Array.isArray(result.payload) ? result.payload.map(String) : []
        return { value: { roots, count: roots.length }, resultSummary: roots.length + ' UMG roots' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_get_widget_blueprint_path',
    description: 'Get the WidgetBlueprint asset path for one UMG widget. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UWidget UObject path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      return await audited(deps, exec, { tool: 'unreal_get_widget_blueprint_path', params: { objectPath } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umg, 'GetWidgetBlueprintPath', { Widget: objectPath })
        const blueprintPath = typeof result.payload === 'string' ? result.payload : ''
        return { value: { objectPath, blueprintPath }, resultSummary: 'Widget blueprint path read' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_get_widget_class_path',
    description: 'Get the UClass path for one UMG widget. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UWidget UObject path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      return await audited(deps, exec, { tool: 'unreal_get_widget_class_path', params: { objectPath } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umg, 'GetWidgetClassPath', { Widget: objectPath })
        const classPath = typeof result.payload === 'string' ? result.payload : ''
        return { value: { objectPath, classPath }, resultSummary: 'Widget class path read' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_get_widget_tree_diff',
    description: 'Read the PIE UMG tree diff for one root. First call is the full tree, later calls are deltas. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UWidget UObject path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      return await audited(deps, exec, { tool: 'unreal_get_widget_tree_diff', params: { objectPath } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umg, 'GetWidgetTreeDiff', { RootWidget: objectPath })
        return { value: { tree: result.payload }, resultSummary: 'Widget tree diff read' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_reset_widget_tree_diff_cache',
    description: 'Reset the cached widget tree diff for one root. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UWidget UObject path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      return await audited(deps, exec, { tool: 'unreal_reset_widget_tree_diff_cache', params: { objectPath } }, async () => {
        await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umg, 'ResetWidgetTreeCache', { RootWidget: objectPath })
        return { value: { success: true, objectPath }, resultSummary: 'Widget tree cache reset' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_get_widget_geometry',
    description: 'Read one PIE UMG widget geometry. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UWidget UObject path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      return await audited(deps, exec, { tool: 'unreal_get_widget_geometry', params: { objectPath } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umg, 'GetWidgetGeometry', { Widget: objectPath })
        return { value: { objectPath, geometry: result.payload }, resultSummary: 'Widget geometry read' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  // ----- Widget input (synthetic Slate events; EditorAutomation Input library) -----

  ctx.tools.register(defineTool({
    name: 'unreal_widget_click',
    description:
      'Click one UMG widget at a normalized point inside it (0..1, default centered) through Slate\'s own event pipeline. Supports mouse button, single/double click and agnostic Ctrl/Alt/Shift/Cmd modifiers. The widget must already be drawn (its cached geometry exists); use unreal_get_widget_geometry to confirm. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UWidget UObject path.' },
      button: { type: 'string', description: 'Mouse button FKey name; default LeftMouseButton.' },
      clickType: { type: 'string', enum: ['single', 'double'], description: 'single (default) or double click.' },
      relativeX: { type: 'number', description: 'Normalized X inside the widget (0..1); default 0.5.' },
      relativeY: { type: 'number', description: 'Normalized Y inside the widget (0..1); default 0.5.' },
      control: { type: 'boolean', description: 'Hold Ctrl during the click.' },
      alt: { type: 'boolean', description: 'Hold Alt during the click.' },
      shift: { type: 'boolean', description: 'Hold Shift during the click.' },
      command: { type: 'boolean', description: 'Hold Cmd during the click.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `clicked ${String(value.objectPath)} at (${String(value.relativeX)}, ${String(value.relativeY)})` }],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      const button = typeof args.button === 'string' && args.button !== '' ? args.button : 'LeftMouseButton'
      const clickType = args.clickType === 'double' ? 'double' : 'single'
      const relativeX = typeof args.relativeX === 'number' ? args.relativeX : 0.5
      const relativeY = typeof args.relativeY === 'number' ? args.relativeY : 0.5
      return await audited(deps, exec, { tool: 'unreal_widget_click', params: { objectPath, button, clickType, relativeX, relativeY } }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.input, 'SendClick', {
          Widget: objectPath,
          Options: clickOptionsJson(button, clickType, relativeX, relativeY, modifierKeysJson(args)),
        }, objectPath)
        return { value: { objectPath, button, clickType, relativeX, relativeY }, resultSummary: `clicked ${objectPath}` }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_focus_widget',
    description: 'Move keyboard focus to one UMG widget and bring its window to the front, so later unreal_send_key_with_modifiers / unreal_send_text reach it. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UWidget UObject path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `focused ${String(value.objectPath)}` }],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      return await audited(deps, exec, { tool: 'unreal_focus_widget', params: { objectPath } }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.input, 'Focus', { Widget: objectPath }, objectPath)
        return { value: { objectPath }, resultSummary: `focused ${objectPath}` }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_send_key_with_modifiers',
    description:
      'Send one key press (down + up) to the focused Slate widget with explicit Ctrl/Alt/Shift/Cmd modifiers, e.g. Ctrl+S or Shift+Tab. Focus a widget first with unreal_focus_widget, or the PIE viewport with unreal_focus_pie. Requires the umg group.',
    parameters: {
      keyName: { type: 'string', required: true, description: 'FKey name, e.g. S, Tab, Space, Enter.' },
      control: { type: 'boolean', description: 'Hold Ctrl.' },
      alt: { type: 'boolean', description: 'Hold Alt.' },
      shift: { type: 'boolean', description: 'Hold Shift.' },
      command: { type: 'boolean', description: 'Hold Cmd.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `${value.keyName} sent` }],
    },
    async execute(args, exec) {
      const keyName = requiredString(args.keyName, 'keyName')
      const modifiers = modifierKeysJson(args)
      return await audited(deps, exec, { tool: 'unreal_send_key_with_modifiers', params: { keyName } }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.input, 'SendKey', {
          KeyName: keyName,
          Modifiers: modifiers ?? {},
        }, keyName)
        return { value: { keyName, modifiers: modifiers ?? {} }, resultSummary: `key ${keyName} sent` }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_send_text',
    description: 'Send a string as character events to the focused widget (focus it first with unreal_focus_widget or unreal_focus_pie). Requires the umg group.',
    parameters: {
      text: { type: 'string', required: true, description: 'Text to type.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `sent ${String(value.text).length} characters` }],
    },
    async execute(args, exec) {
      const text = requiredString(args.text, 'text')
      return await audited(deps, exec, { tool: 'unreal_send_text', params: { text } }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.input, 'SendText', { Text: text }, 'the focused widget')
        return { value: { text, characters: text.length }, resultSummary: `${text.length} characters sent` }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_widget_mouse_move',
    description: 'Move the synthetic mouse pointer over one UMG widget at a normalized point (0..1) with optional modifiers. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UWidget UObject path.' },
      relativeX: { type: 'number', description: 'Normalized X inside the widget (0..1); default 0.5.' },
      relativeY: { type: 'number', description: 'Normalized Y inside the widget (0..1); default 0.5.' },
      control: { type: 'boolean', description: 'Hold Ctrl.' },
      alt: { type: 'boolean', description: 'Hold Alt.' },
      shift: { type: 'boolean', description: 'Hold Shift.' },
      command: { type: 'boolean', description: 'Hold Cmd.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `moved over ${String(value.objectPath)}` }],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      const relativeX = typeof args.relativeX === 'number' ? args.relativeX : 0.5
      const relativeY = typeof args.relativeY === 'number' ? args.relativeY : 0.5
      return await audited(deps, exec, { tool: 'unreal_widget_mouse_move', params: { objectPath, relativeX, relativeY } }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.input, 'SendMouseMove', {
          Widget: objectPath,
          RelativePosition: { X: String(relativeX), Y: String(relativeY) },
          ModifierKeys: modifierKeysJson(args) ?? {},
        }, objectPath)
        return { value: { objectPath, relativeX, relativeY }, resultSummary: `moved over ${objectPath}` }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_widget_mouse_wheel',
    description: 'Send one mouse-wheel event at the current pointer position over one UMG widget (positive = scroll up). Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UWidget UObject path.' },
      delta: { type: 'number', required: true, description: 'Wheel delta, e.g. 1 or -1.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `wheel ${String(value.delta)} over ${String(value.objectPath)}` }],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      if (typeof args.delta !== 'number' || !Number.isFinite(args.delta)) {
        throw new KitError('editorautomation/invalid_argument', 'delta must be a finite number.', { functionName: 'SendMouseWheel' })
      }
      const delta = args.delta
      return await audited(deps, exec, { tool: 'unreal_widget_mouse_wheel', params: { objectPath, delta } }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.input, 'SendMouseWheel', {
          Widget: objectPath,
          Delta: delta,
        }, objectPath)
        return { value: { objectPath, delta }, resultSummary: `wheel ${delta}` }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  // ----- ListView (virtualized rows) and off-screen widget capture -------------

  ctx.tools.register(defineTool({
    name: 'unreal_get_list_view_info',
    description: 'Read the items held by a UMG UListView: item index, item object path and item class. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UListView widget UObject path.' },
      maxItems: { type: 'number', description: 'Keep at most this many items; 0 (default) means all.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        const items = Array.isArray(value.items) ? (value.items as Array<Record<string, JsonValue>>) : []
        const lines = items.map(item => `${String(item['index'])}: ${String(item['item'])} (${String(item['itemClass'])})`)
        return [{ type: 'text', text: `${String(value.itemCount)} items\n${lines.join('\n')}` }]
      },
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      const maxItems = typeof args.maxItems === 'number' ? args.maxItems : 0
      return await audited(deps, exec, { tool: 'unreal_get_list_view_info', params: { objectPath, maxItems } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umg, 'GetListViewInfo', {
          Widget: objectPath,
          MaxItems: maxItems,
        })
        const success = structBool(result.payload, 'bSuccess')
        if (!success) {
          throw new KitError('editorautomation/GetListViewInfoFailed', `GetListViewInfo could not read ${objectPath}.`, {
            functionName: 'GetListViewInfo',
            hint: 'Call unreal_get_recent_log for the engine log reason.',
          })
        }
        const itemsValue = result.payload === null || typeof result.payload !== 'object' || Array.isArray(result.payload)
          ? []
          : (result.payload as Record<string, JsonValue>)['Items'] ?? []
        const items = payloadStructArray(itemsValue).map(item => ({
          index: structNumber(item, 'Index'),
          item: structString(item, 'Item'),
          itemClass: structString(item, 'ItemClass'),
        }))
        return {
          value: { objectPath, itemCount: structNumber(result.payload, 'ItemCount'), items, count: items.length },
          resultSummary: `${items.length} items`,
        }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_get_list_entry_info',
    description:
      'Read the row widget of one UListView item. List rows are virtualized: an item off screen reports success=false with no row — call unreal_scroll_to_list_entry to bring it into view first. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UListView widget UObject path.' },
      index: { type: 'number', required: true, description: 'Item index.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.success === true
            ? `item ${String(value.index)} row: ${String(value.entryWidget)}`
            : `item ${String(value.index)} has no row (virtualized out of view)`,
        },
      ],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      if (typeof args.index !== 'number' || !Number.isFinite(args.index)) {
        throw new KitError('editorautomation/invalid_argument', 'index must be a finite number.', { functionName: 'GetListEntryInfo' })
      }
      const index = args.index
      return await audited(deps, exec, { tool: 'unreal_get_list_entry_info', params: { objectPath, index } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umg, 'GetListEntryInfo', {
          Widget: objectPath,
          Index: index,
        })
        const success = structBool(result.payload, 'bSuccess')
        const entry = {
          success,
          index: structNumber(result.payload, 'Index'),
          entryWidget: structString(result.payload, 'EntryWidget'),
          entryWidgetClass: structString(result.payload, 'EntryWidgetClass'),
        }
        return {
          value: { objectPath, ...entry },
          resultSummary: success ? `item ${index} row read` : `item ${index} has no row yet`,
        }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_scroll_to_list_entry',
    description: 'Scroll a UListView so the requested item is on screen and return its row widget (creates the row when it was virtualized). Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UListView widget UObject path.' },
      index: { type: 'number', required: true, description: 'Item index.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [
        {
          type: 'text',
          text: value.success === true
            ? `item ${String(value.index)} row: ${String(value.entryWidget)}`
            : `item ${String(value.index)} row still unavailable`,
        },
      ],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      if (typeof args.index !== 'number' || !Number.isFinite(args.index)) {
        throw new KitError('editorautomation/invalid_argument', 'index must be a finite number.', { functionName: 'ScrollToListEntry' })
      }
      const index = args.index
      return await audited(deps, exec, { tool: 'unreal_scroll_to_list_entry', params: { objectPath, index } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umg, 'ScrollToListEntry', {
          Widget: objectPath,
          Index: index,
        })
        const success = structBool(result.payload, 'bSuccess')
        const value = {
          objectPath,
          success,
          index: structNumber(result.payload, 'Index'),
          entryWidget: structString(result.payload, 'EntryWidget'),
          entryWidgetClass: structString(result.payload, 'EntryWidgetClass'),
        }
        return { value, resultSummary: success ? `scrolled to item ${index}` : `item ${index} row still unavailable` }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_scroll_to_list_entry_and_click',
    description:
      'Scroll a UListView to one item and click its row. A row created by this call has not been drawn yet, so the click is not dispatched in the same call: the tool errors with a retry hint and the next call clicks the now-drawn row. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UListView widget UObject path.' },
      index: { type: 'number', required: true, description: 'Item index.' },
      button: { type: 'string', description: 'Mouse button FKey name; default LeftMouseButton.' },
      clickType: { type: 'string', enum: ['single', 'double'], description: 'single (default) or double click.' },
      relativeX: { type: 'number', description: 'Normalized X inside the row (0..1); default 0.5.' },
      relativeY: { type: 'number', description: 'Normalized Y inside the row (0..1); default 0.5.' },
      control: { type: 'boolean', description: 'Hold Ctrl.' },
      alt: { type: 'boolean', description: 'Hold Alt.' },
      shift: { type: 'boolean', description: 'Hold Shift.' },
      command: { type: 'boolean', description: 'Hold Cmd.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `clicked item ${String(value.index)} row` }],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      if (typeof args.index !== 'number' || !Number.isFinite(args.index)) {
        throw new KitError('editorautomation/invalid_argument', 'index must be a finite number.', { functionName: 'ScrollToListEntryAndSendClick' })
      }
      const index = args.index
      const button = typeof args.button === 'string' && args.button !== '' ? args.button : 'LeftMouseButton'
      const clickType = args.clickType === 'double' ? 'double' : 'single'
      const relativeX = typeof args.relativeX === 'number' ? args.relativeX : 0.5
      const relativeY = typeof args.relativeY === 'number' ? args.relativeY : 0.5
      return await audited(deps, exec, { tool: 'unreal_scroll_to_list_entry_and_click', params: { objectPath, index, button, clickType, relativeX, relativeY } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umg, 'ScrollToListEntryAndSendClick', {
          Widget: objectPath,
          Index: index,
          Options: clickOptionsJson(button, clickType, relativeX, relativeY, modifierKeysJson(args)),
        })
        if (!payloadBool(result.payload)) {
          throw new KitError('editorautomation/ScrollToListEntryAndSendClickFailed', `ScrollToListEntryAndSendClick did not click item ${index} of ${objectPath}.`, {
            functionName: 'ScrollToListEntryAndSendClick',
            hint: 'If the row was just created, call this tool again; otherwise call unreal_get_recent_log for the engine reason.',
          })
        }
        return { value: { objectPath, index, button, clickType }, resultSummary: `clicked item ${index}` }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_capture_widget_screenshot',
    description:
      'Render one UMG widget off-screen into a PNG (UI included, no viewport needed) through FWidgetRenderer at an optional design resolution. Omit filePath and the adapter writes a uniquely named PNG under its own temp screenshot directory. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UWidget UObject path.' },
      filePath: { type: 'string', description: 'Absolute PNG path; omit to let the adapter name a fresh file.' },
      width: { type: 'number', description: 'Render width in pixels; 0 (default) uses the widget\'s current/desired width.' },
      height: { type: 'number', description: 'Render height in pixels; 0 (default) uses the widget\'s current/desired height.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [
        { type: 'text', text: `widget screenshot: ${String(value.filePath)} (${String(value.bytes)} bytes)` },
      ],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      const filePath = typeof args.filePath === 'string' ? args.filePath : ''
      const width = typeof args.width === 'number' ? args.width : 0
      const height = typeof args.height === 'number' ? args.height : 0
      const screenshotPath = filePath === '' ? await newScreenshotPath() : filePath
      let details: CallDetails | undefined
      return await audited(
        deps,
        exec,
        { tool: 'unreal_capture_widget_screenshot', params: { objectPath, filePath: screenshotPath, width, height }, details: async () => details },
        async () => {
          const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umg, 'CaptureWidgetScreenshot', {
            Widget: objectPath,
            OutputPath: screenshotPath,
            Width: width,
            Height: height,
          })
          const resolvedPath = typeof result.payload === 'string' ? result.payload : ''
          if (resolvedPath === '') {
            throw new KitError('editorautomation/CaptureWidgetScreenshotFailed', `CaptureWidgetScreenshot returned no PNG path for ${objectPath}.`, {
              functionName: 'CaptureWidgetScreenshot',
              hint: 'Call unreal_get_recent_log for the engine log reason.',
            })
          }
          let bytes = 0
          try {
            const info = await stat(resolvedPath)
            if (info.isFile()) bytes = info.size
          } catch {
            // The render failed to write; the empty path check above already covers most cases.
          }
          const size = bytes > 0 ? await pngSize(resolvedPath) : undefined
          if (bytes > 0) {
            details = buildScreenshotDetails({
              target: 'widget',
              filePath: resolvedPath,
              bytes,
              ...(size === undefined ? {} : { width: size.width, height: size.height }),
            })
          }
          return {
            value: {
              objectPath,
              filePath: resolvedPath,
              exists: bytes > 0,
              bytes,
              ...(size === undefined ? {} : { width: size.width, height: size.height }),
              errorMessage: '',
            },
            resultSummary: bytes > 0 ? `widget screenshot written (${bytes} bytes)` : 'widget screenshot not written',
          }
        },
      )
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_widget_drag',
    description:
      'Drag from one normalized point to another inside the same UMG widget. The press → moves → release sequence is driven by a ticker across frames; poll unreal_is_mouse_input_pending to know when it finished. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UWidget UObject path.' },
      fromX: { type: 'number', description: 'Drag origin normalized X (0..1); default 0.' },
      fromY: { type: 'number', description: 'Drag origin normalized Y (0..1); default 0.5.' },
      toX: { type: 'number', description: 'Drag target normalized X (0..1); default 1.' },
      toY: { type: 'number', description: 'Drag target normalized Y (0..1); default 0.5.' },
      steps: { type: 'number', description: 'Move steps between press and release; default 10.' },
      durationMs: { type: 'number', description: 'Total drag duration in milliseconds; default 500.' },
      button: { type: 'string', description: 'Mouse button FKey name; default LeftMouseButton.' },
      control: { type: 'boolean', description: 'Hold Ctrl.' },
      alt: { type: 'boolean', description: 'Hold Alt.' },
      shift: { type: 'boolean', description: 'Hold Shift.' },
      command: { type: 'boolean', description: 'Hold Cmd.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [
        { type: 'text', text: `drag started on ${String(value.objectPath)}; poll unreal_is_mouse_input_pending for completion` },
      ],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      const fromX = typeof args.fromX === 'number' ? args.fromX : 0
      const fromY = typeof args.fromY === 'number' ? args.fromY : 0.5
      const toX = typeof args.toX === 'number' ? args.toX : 1
      const toY = typeof args.toY === 'number' ? args.toY : 0.5
      const steps = typeof args.steps === 'number' ? args.steps : 10
      const durationMs = typeof args.durationMs === 'number' ? args.durationMs : 500
      const button = typeof args.button === 'string' && args.button !== '' ? args.button : 'LeftMouseButton'
      return await audited(deps, exec, { tool: 'unreal_widget_drag', params: { objectPath, fromX, fromY, toX, toY, steps, durationMs, button } }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.input, 'SendDrag', {
          Widget: objectPath,
          Options: {
            FromRelativePosition: { X: String(fromX), Y: String(fromY) },
            ToRelativePosition: { X: String(toX), Y: String(toY) },
            Steps: steps,
            DurationMs: String(durationMs),
            Button: button,
            ModifierKeys: modifierKeysJson(args) ?? {},
          },
        }, objectPath)
        return { value: { objectPath, fromX, fromY, toX, toY, steps, durationMs, button }, resultSummary: `drag started on ${objectPath}` }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_is_mouse_input_pending',
    description: 'Whether an asynchronous synthetic mouse input (a drag started by unreal_widget_drag) is still running. Requires the umg group.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: value.pending === true ? 'mouse input pending' : 'no mouse input pending' }],
    },
    async execute(_args, exec) {
      return await audited(deps, exec, { tool: 'unreal_is_mouse_input_pending', params: {} }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.input, 'IsMouseInputPending', {})
        const pending = payloadBool(result.payload)
        return { value: { pending }, resultSummary: pending ? 'pending' : 'idle' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_get_blueprint_info',
    description:
      'Get a Blueprint asset info through EditorAutomation\'s CallFunction dispatcher: asset path, class, parent class, EBlueprintType, EBlueprintStatus, dirty and compile state. An empty assetPath means the asset could not be loaded — call unreal_get_recent_log for the engine reason.',
    parameters: {
      blueprint: { type: 'string', required: true, description: 'Blueprint object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [
        {
          type: 'text',
          text: `${value.blueprint}: EBlueprintType=${value.blueprintType} EBlueprintStatus=${value.status} dirty=${value.dirty} compiling=${value.beingCompiled} parent=${value.parentClass === '' ? '(none)' : value.parentClass}`,
        },
      ],
    },
    async execute(args, exec) {
      const blueprint = requiredString(args.blueprint, 'blueprint')
      return await audited(deps, exec, { tool: 'unreal_get_blueprint_info', params: { blueprint } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.blueprint, 'GetBlueprintInfo', {
          Blueprint: blueprint,
        })
        const assetPath = structString(result.payload, 'AssetPath')
        if (assetPath === '') {
          throw new KitError('editorautomation/GetBlueprintInfoFailed', `GetBlueprintInfo could not load ${blueprint}.`, {
            functionName: 'GetBlueprintInfo',
            hint: 'Call unreal_get_recent_log for the engine log reason.',
          })
        }
        const value = {
          blueprint,
          assetPath,
          assetClass: structString(result.payload, 'AssetClass'),
          parentClass: structString(result.payload, 'ParentClass'),
          generatedClass: structString(result.payload, 'GeneratedClass'),
          blueprintType: structNumber(result.payload, 'BlueprintType'),
          status: structNumber(result.payload, 'Status'),
          dirty: structBool(result.payload, 'bDirty'),
          beingCompiled: structBool(result.payload, 'bBeingCompiled'),
          functionName: 'GetBlueprintInfo',
        }
        return { value, resultSummary: `blueprint status=${value.status} dirty=${value.dirty}` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_blueprint_lua_path',
    description: 'Read the KGUI/blueprint-editor Lua path bound to one Blueprint (properties named LuaPath on the asset or its generated class). Empty means no Lua binding was found.',
    parameters: {
      blueprint: { type: 'string', required: true, description: 'Blueprint object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: value.luaPath === '' ? 'no Lua path' : String(value.luaPath) }],
    },
    async execute(args, exec) {
      const blueprint = requiredString(args.blueprint, 'blueprint')
      return await audited(deps, exec, { tool: 'unreal_get_blueprint_lua_path', params: { blueprint } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.blueprint, 'GetBlueprintLuaPath', { Blueprint: blueprint })
        const luaPath = typeof result.payload === 'string' ? result.payload : ''
        return { value: { blueprint, luaPath }, resultSummary: luaPath === '' ? 'no Lua path' : luaPath }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_set_blueprint_dirty',
    description: 'Set or clear the dirty flag of one Blueprint asset. Does not compile or save. Failures are reported as tool errors; call unreal_get_recent_log for the engine reason.',
    parameters: {
      blueprint: { type: 'string', required: true, description: 'Blueprint object path.' },
      dirty: { type: 'boolean', required: true, description: 'true sets dirty, false clears it.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `${value.blueprint} dirty=${value.dirty}` }],
    },
    async execute(args, exec) {
      const blueprint = requiredString(args.blueprint, 'blueprint')
      const dirty = args.dirty === true
      return await audited(deps, exec, { tool: 'unreal_set_blueprint_dirty', params: { blueprint, dirty } }, async () => {
        await requireEditorAutomationBool(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.blueprint,
          'SetBlueprintDirty',
          { Blueprint: blueprint, bDirty: dirty },
          blueprint,
        )
        return { value: { success: true, blueprint, dirty, functionName: 'SetBlueprintDirty' }, resultSummary: `blueprint dirty=${dirty}` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_compile_blueprint',
    description: 'Compile one Blueprint asset without dialogs; false means it compiled with errors (the engine reason is in the log). Call unreal_get_recent_log after a failure.',
    parameters: {
      blueprint: { type: 'string', required: true, description: 'Blueprint object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `compiled ${value.blueprint}` }],
    },
    async execute(args, exec) {
      const blueprint = requiredString(args.blueprint, 'blueprint')
      return await audited(deps, exec, { tool: 'unreal_compile_blueprint', params: { blueprint } }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.blueprint, 'CompileBlueprint', { Blueprint: blueprint }, blueprint)
        return { value: { success: true, blueprint, functionName: 'CompileBlueprint' }, resultSummary: 'blueprint compiled' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_save_blueprint',
    description: 'Save one Blueprint asset without dialogs. Does not compile first. Saving fails while PIE is running, and can fail on read-only files or source-control checkout; the reason is logged by EditorAutomation.',
    parameters: {
      blueprint: { type: 'string', required: true, description: 'Blueprint object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `saved ${value.blueprint}` }],
    },
    async execute(args, exec) {
      const blueprint = requiredString(args.blueprint, 'blueprint')
      return await audited(deps, exec, { tool: 'unreal_save_blueprint', params: { blueprint } }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.blueprint, 'SaveBlueprint', { Blueprint: blueprint }, blueprint)
        return { value: { success: true, blueprint, functionName: 'SaveBlueprint' }, resultSummary: 'blueprint saved' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_create_blueprint',
    description: 'Create a Blueprint asset at assetPath from parentClass (a class path). BlueprintType is an EBlueprintType value. Failures are reported as tool errors with the engine reason in the log.',
    parameters: {
      assetPath: { type: 'string', required: true, description: 'New asset package path, e.g. /Game/Blueprints/BP_Thing.' },
      parentClass: { type: 'string', required: true, description: 'Parent class path, e.g. /Script/Engine.Actor.' },
      blueprintType: { type: 'number', description: 'EBlueprintType value, default 0.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `created ${value.assetPath}` }],
    },
    async execute(args, exec) {
      const assetPath = requiredString(args.assetPath, 'assetPath')
      const parentClass = requiredString(args.parentClass, 'parentClass')
      const blueprintType = typeof args.blueprintType === 'number' ? args.blueprintType : 0
      return await audited(deps, exec, { tool: 'unreal_create_blueprint', params: { assetPath, parentClass, blueprintType } }, async () => {
        await requireEditorAutomationBool(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.blueprint,
          'CreateBlueprint',
          { AssetPath: assetPath, ParentClass: parentClass, BlueprintType: blueprintType },
          assetPath,
        )
        return { value: { success: true, assetPath, parentClass, blueprintType, functionName: 'CreateBlueprint' }, resultSummary: `created ${assetPath}` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_delete_blueprint',
    description: 'Delete one Blueprint asset without dialogs. Failures are reported as tool errors with the engine reason in the log.',
    parameters: {
      blueprint: { type: 'string', required: true, description: 'Blueprint object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `deleted ${value.blueprint}` }],
    },
    async execute(args, exec) {
      const blueprint = requiredString(args.blueprint, 'blueprint')
      return await audited(deps, exec, { tool: 'unreal_delete_blueprint', params: { blueprint } }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.blueprint, 'DeleteBlueprint', { Blueprint: blueprint }, blueprint)
        return { value: { success: true, blueprint, functionName: 'DeleteBlueprint' }, resultSummary: 'blueprint deleted' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_current_level_info',
    description: 'Read the current editor Level identity and dirty state through the CallFunction dispatcher. An empty levelPath means no editor world is available.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `${value.levelPath} (${value.levelName}) dirty=${value.dirty}` }],
    },
    async execute(_args, exec) {
      return await audited(deps, exec, { tool: 'unreal_get_current_level_info', params: {} }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.level, 'GetCurrentLevelInfo', {})
        const value = {
          levelPath: structString(result.payload, 'LevelPath'),
          levelName: structString(result.payload, 'LevelName'),
          dirty: structBool(result.payload, 'bDirty'),
          functionName: 'GetCurrentLevelInfo',
        }
        if (value.levelPath === '') {
          throw new KitError('editorautomation/GetCurrentLevelInfoFailed', 'GetCurrentLevelInfo found no editor world.', {
            functionName: 'GetCurrentLevelInfo',
            hint: 'Make sure the editor is fully loaded, then retry.',
          })
        }
        return { value, resultSummary: `level ${value.levelName} dirty=${value.dirty}` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_is_current_level_dirty',
    description: 'Whether the current editor Level has unsaved changes.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `level dirty=${value.dirty}` }],
    },
    async execute(_args, exec) {
      return await audited(deps, exec, { tool: 'unreal_is_current_level_dirty', params: {} }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.level, 'IsCurrentLevelDirty', {})
        const dirty = payloadBool(result.payload)
        return { value: { dirty, functionName: 'IsCurrentLevelDirty' }, resultSummary: `level dirty=${dirty}` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_level_script_blueprint',
    description: 'Get the current Level\'s Level Script Blueprint (a ULevelScriptBlueprint object path), or an empty string when the Level has none.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        const path = typeof value.levelScriptBlueprint === 'string' ? value.levelScriptBlueprint : ''
        return [{ type: 'text', text: path === '' ? 'no level script blueprint' : path }]
      },
    },
    async execute(_args, exec) {
      return await audited(deps, exec, { tool: 'unreal_get_level_script_blueprint', params: {} }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.level, 'GetLevelScriptBlueprint', {})
        const levelScriptBlueprint = typeof result.payload === 'string' ? result.payload : ''
        return {
          value: { levelScriptBlueprint, returnedNothing: levelScriptBlueprint === '', functionName: 'GetLevelScriptBlueprint' },
          resultSummary: levelScriptBlueprint === '' ? 'no level script blueprint' : 'level script blueprint read',
        }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_create_level',
    description: 'Create a Level asset; fails when the current Level is dirty or the editor refuses (the reason is logged; call unreal_get_recent_log).',
    parameters: {
      levelPath: { type: 'string', required: true, description: 'New Level package path.' },
      templatePath: { type: 'string', description: 'Optional template Level path.' },
      partitioned: { type: 'boolean', description: 'Create a partitioned world.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `created ${value.levelPath}` }],
    },
    async execute(args, exec) {
      const levelPath = requiredString(args.levelPath, 'levelPath')
      const templatePath = typeof args.templatePath === 'string' ? args.templatePath : ''
      const partitioned = args.partitioned === true
      return await audited(deps, exec, { tool: 'unreal_create_level', params: { levelPath, templatePath, partitioned } }, async () => {
        await requireEditorAutomationBool(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.level,
          'CreateLevel',
          { LevelPath: levelPath, TemplatePath: templatePath, bPartitioned: partitioned },
          levelPath,
        )
        return { value: { success: true, levelPath, templatePath, partitioned, functionName: 'CreateLevel' }, resultSummary: `created ${levelPath}` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_open_level',
    description: 'Open a Level asset in the editor. Fails when the Level cannot be loaded (the reason is logged; call unreal_get_recent_log).',
    parameters: {
      levelPath: { type: 'string', required: true, description: 'Level package path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `opened ${value.levelPath}` }],
    },
    async execute(args, exec) {
      const levelPath = requiredString(args.levelPath, 'levelPath')
      return await audited(deps, exec, { tool: 'unreal_open_level', params: { levelPath } }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.level, 'OpenLevel', { LevelPath: levelPath }, levelPath)
        return { value: { success: true, levelPath, functionName: 'OpenLevel' }, resultSummary: `opened ${levelPath}` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_save_current_level',
    description: 'Save the current Level. Fails while the editor refuses (dirty state, PIE running, source control); the reason is logged by EditorAutomation.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: () => [{ type: 'text', text: 'current level saved' }],
    },
    async execute(_args, exec) {
      return await audited(deps, exec, { tool: 'unreal_save_current_level', params: {} }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.level, 'SaveCurrentLevel', {}, 'the current level')
        return { value: { success: true, functionName: 'SaveCurrentLevel' }, resultSummary: 'current level saved' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_blueprint_graphs',
    description: 'List the editor graphs of a Blueprint asset (event graph, function graphs, …) through the CallFunction dispatcher. Pass a GraphObjectPath to unreal_get_graph_nodes / unreal_add_*_node.',
    parameters: {
      blueprint: { type: 'string', required: true, description: 'Blueprint object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        const graphs = Array.isArray(value.graphs) ? (value.graphs as Array<Record<string, JsonValue>>) : []
        const lines = graphs.map(graph => `${String(graph['graphName'])} (${String(graph['graphClassPath'])})`)
        return [{ type: 'text', text: value.count === 0 ? 'no graphs' : `${String(value.count)} graphs\n${lines.join('\n')}` }]
      },
    },
    async execute(args, exec) {
      const blueprint = requiredString(args.blueprint, 'blueprint')
      return await audited(deps, exec, { tool: 'unreal_get_blueprint_graphs', params: { blueprint } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.graph, 'GetBlueprintGraphs', { Blueprint: blueprint })
        const graphs = payloadStructArray(result.payload).map(graph => ({
          graphName: structString(graph, 'GraphName'),
          graphClassPath: structString(graph, 'GraphClassPath'),
          graphObjectPath: structString(graph, 'GraphObjectPath'),
        }))
        return { value: { blueprint, graphs, count: graphs.length, functionName: 'GetBlueprintGraphs' }, resultSummary: `${graphs.length} graphs` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_graph_nodes',
    description:
      'List the nodes of an editor graph through the CallFunction dispatcher: object path, class, title and position, plus semantic fields — memberName (referenced function/variable/event/component), graphObjectPath (graph the node belongs to), targetClassPath (owner class of the referenced function or delegate), delegateName (component-bound event delegate) and subGraphObjectPath (macro/collapsed sub-graph). Set recursive=true to also include every collapsed sub-graph reachable from this graph.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph object path (from unreal_get_blueprint_graphs).' },
      recursive: { type: 'boolean', description: 'Also list nodes of macro and collapsed sub-graphs; default false.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        const nodes = Array.isArray(value.nodes) ? (value.nodes as Array<Record<string, JsonValue>>) : []
        const lines = nodes.map(node =>
          `${String(node['nodeTitle'])} (${String(node['nodeClassPath'])})${String(node['memberName'] ?? '') === '' ? '' : ` → ${String(node['memberName'])}`}`,
        )
        return [{ type: 'text', text: value.count === 0 ? 'no nodes' : `${String(value.count)} nodes\n${lines.join('\n')}` }]
      },
    },
    async execute(args, exec) {
      const graph = requiredString(args.graph, 'graph')
      const recursive = args.recursive === true
      return await audited(deps, exec, { tool: 'unreal_get_graph_nodes', params: { graph, recursive } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.graph, 'GetGraphNodes', { Graph: graph, bRecursive: recursive })
        const nodes = payloadStructArray(result.payload).map(node => ({
          nodeObjectPath: structString(node, 'NodeObjectPath'),
          nodeClassPath: structString(node, 'NodeClassPath'),
          nodeTitle: structString(node, 'NodeTitle'),
          nodePosX: structNumber(node, 'NodePosX'),
          nodePosY: structNumber(node, 'NodePosY'),
          memberName: structString(node, 'MemberName'),
          graphObjectPath: structString(node, 'GraphObjectPath'),
          targetClassPath: structString(node, 'TargetClassPath'),
          delegateName: structString(node, 'DelegateName'),
          subGraphObjectPath: structString(node, 'SubGraphObjectPath'),
        }))
        return { value: { graph, nodes, count: nodes.length, recursive, functionName: 'GetGraphNodes' }, resultSummary: `${nodes.length} nodes` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_node_pins',
    description:
      'List the pins of an editor graph node through the CallFunction dispatcher: name, direction, Type text, default value, linked flag, LinkedPinIds (pin-id graph edges) plus category (exec/bool/object/struct/...), typeName (concrete struct/object Type), defaultObjectPath (object-reference default) and connections (linked pins as "NodeGuid::PinName").',
    parameters: {
      node: { type: 'string', required: true, description: 'Node object path (from unreal_get_graph_nodes).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        const pins = Array.isArray(value.pins) ? (value.pins as Array<Record<string, JsonValue>>) : []
        const lines = pins.map(pin => `${String(pin['pinName'])} [${String(pin['direction'])}] ${String(pin['pinType'])}`)
        return [{ type: 'text', text: `${String(value.count)} pins\n${lines.join('\n')}` }]
      },
    },
    async execute(args, exec) {
      const node = requiredString(args.node, 'node')
      return await audited(deps, exec, { tool: 'unreal_get_node_pins', params: { node } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.graph, 'GetNodePins', { Node: node })
        const pins = payloadStructArray(result.payload).map(pin => ({
          pinId: structString(pin, 'PinId'),
          pinName: structString(pin, 'PinName'),
          direction: structString(pin, 'Direction'),
          pinType: structString(pin, 'PinType'),
          defaultValue: structString(pin, 'DefaultValue'),
          linked: structBool(pin, 'bLinked'),
          category: structString(pin, 'Category'),
          typeName: structString(pin, 'TypeName'),
          defaultObjectPath: structString(pin, 'DefaultObjectPath'),
          connections: payloadStringArray(pin, 'Connections'),
          linkedPinIds: payloadStringArray(pin, 'LinkedPinIds'),
        }))
        return { value: { node, pins, count: pins.length, functionName: 'GetNodePins' }, resultSummary: `${pins.length} pins` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_add_call_function_node',
    description: 'Add a function-call node to a graph. Returns the new node object path; an empty path (tool error) means the editor refused — call unreal_get_recent_log for the reason.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph object path.' },
      functionOwnerClassPath: { type: 'string', required: true, description: 'Class that owns the function, e.g. /Script/Engine.KismetMathLibrary.' },
      functionName: { type: 'string', required: true, description: 'Function name, e.g. Add_IntInt.' },
      nodePosX: { type: 'number', description: 'Node X position; default 0.' },
      nodePosY: { type: 'number', description: 'Node Y position; default 0.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `added ${value.functionName} node: ${value.nodeObjectPath}` }],
    },
    async execute(args, exec) {
      const graph = requiredString(args.graph, 'graph')
      const functionOwnerClassPath = requiredString(args.functionOwnerClassPath, 'functionOwnerClassPath')
      const functionName = requiredString(args.functionName, 'functionName')
      const nodePosX = typeof args.nodePosX === 'number' ? args.nodePosX : 0
      const nodePosY = typeof args.nodePosY === 'number' ? args.nodePosY : 0
      return await audited(deps, exec, { tool: 'unreal_add_call_function_node', params: { graph, functionOwnerClassPath, functionName, nodePosX, nodePosY } }, async () => {
        const nodeObjectPath = await requireEditorAutomationString(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.graph,
          'AddCallFunctionNode',
          { Graph: graph, FunctionOwnerClassPath: functionOwnerClassPath, FunctionName: functionName, NodePosX: nodePosX, NodePosY: nodePosY },
          `${functionOwnerClassPath}.${functionName}`,
        )
        return { value: { nodeObjectPath, functionName, functionOwnerClassPath }, resultSummary: `node added` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_add_event_node',
    description: 'Add an event node to a graph (e.g. ReceiveBeginPlay / ReceiveTick). Returns the new node object path; an empty path (tool error) means the editor refused.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph object path.' },
      eventName: { type: 'string', required: true, description: 'Event function name, e.g. ReceiveBeginPlay.' },
      nodePosX: { type: 'number', description: 'Node X position; default 0.' },
      nodePosY: { type: 'number', description: 'Node Y position; default 0.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `added event ${value.eventName}: ${value.nodeObjectPath}` }],
    },
    async execute(args, exec) {
      const graph = requiredString(args.graph, 'graph')
      const eventName = requiredString(args.eventName, 'eventName')
      const nodePosX = typeof args.nodePosX === 'number' ? args.nodePosX : 0
      const nodePosY = typeof args.nodePosY === 'number' ? args.nodePosY : 0
      return await audited(deps, exec, { tool: 'unreal_add_event_node', params: { graph, eventName, nodePosX, nodePosY } }, async () => {
        const nodeObjectPath = await requireEditorAutomationString(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.graph,
          'AddEventNode',
          { Graph: graph, EventName: eventName, NodePosX: nodePosX, NodePosY: nodePosY },
          eventName,
        )
        return { value: { nodeObjectPath, eventName, functionName: 'AddEventNode' }, resultSummary: `event node added` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_add_component_bound_event_node',
    description: 'Add a component-bound event node (for example a widget Button OnClicked) to a graph. WidgetName must be a component/widget variable of the owning Blueprint (bIsVariable=true, compiled). Returns the new node object path.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph object path.' },
      widgetName: { type: 'string', required: true, description: 'Component/widget variable name, e.g. Button_0.' },
      delegateName: { type: 'string', required: true, description: 'Delegate name, e.g. OnClicked.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `added ${value.widgetName}.${value.delegateName}: ${value.nodeObjectPath}` }],
    },
    async execute(args, exec) {
      const graph = requiredString(args.graph, 'graph')
      const widgetName = requiredString(args.widgetName, 'widgetName')
      const delegateName = requiredString(args.delegateName, 'delegateName')
      return await audited(deps, exec, { tool: 'unreal_add_component_bound_event_node', params: { graph, widgetName, delegateName } }, async () => {
        const nodeObjectPath = await requireEditorAutomationString(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.graph,
          'AddComponentBoundEventNode',
          { Graph: graph, WidgetName: widgetName, DelegateName: delegateName },
          `${widgetName}.${delegateName}`,
        )
        return { value: { nodeObjectPath, widgetName, delegateName, functionName: 'AddComponentBoundEventNode' }, resultSummary: 'component event node added' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_add_branch_node',
    description: 'Add a Branch (if/then/else) node to a graph. Pins: condition (bool input), execute (exec input), true/false (exec outputs). Returns the new node object path.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph object path.' },
      nodePosX: { type: 'number', description: 'Node X position; default 0.' },
      nodePosY: { type: 'number', description: 'Node Y position; default 0.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `added branch node: ${value.nodeObjectPath}` }],
    },
    async execute(args, exec) {
      const graph = requiredString(args.graph, 'graph')
      const nodePosX = typeof args.nodePosX === 'number' ? args.nodePosX : 0
      const nodePosY = typeof args.nodePosY === 'number' ? args.nodePosY : 0
      return await audited(deps, exec, { tool: 'unreal_add_branch_node', params: { graph, nodePosX, nodePosY } }, async () => {
        const nodeObjectPath = await requireEditorAutomationString(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.graph,
          'AddBranchNode',
          { Graph: graph, NodePosX: nodePosX, NodePosY: nodePosY },
          'the graph',
        )
        return { value: { nodeObjectPath, functionName: 'AddBranchNode' }, resultSummary: 'branch node added' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_add_variable_get_node',
    description: 'Add a variable-get node for a Blueprint member (or widget) variable. Returns the new node object path.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph object path.' },
      variableName: { type: 'string', required: true, description: 'Blueprint variable name.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `added Get ${value.variableName}: ${value.nodeObjectPath}` }],
    },
    async execute(args, exec) {
      const graph = requiredString(args.graph, 'graph')
      const variableName = requiredString(args.variableName, 'variableName')
      return await audited(deps, exec, { tool: 'unreal_add_variable_get_node', params: { graph, variableName } }, async () => {
        const nodeObjectPath = await requireEditorAutomationString(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.graph,
          'AddVariableGetNode',
          { Graph: graph, VariableName: variableName },
          variableName,
        )
        return { value: { nodeObjectPath, variableName, functionName: 'AddVariableGetNode' }, resultSummary: 'variable get node added' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_add_variable_set_node',
    description: 'Add a variable-set node for a Blueprint member (or widget) variable. Returns the new node object path.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph object path.' },
      variableName: { type: 'string', required: true, description: 'Blueprint variable name.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `added Set ${value.variableName}: ${value.nodeObjectPath}` }],
    },
    async execute(args, exec) {
      const graph = requiredString(args.graph, 'graph')
      const variableName = requiredString(args.variableName, 'variableName')
      return await audited(deps, exec, { tool: 'unreal_add_variable_set_node', params: { graph, variableName } }, async () => {
        const nodeObjectPath = await requireEditorAutomationString(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.graph,
          'AddVariableSetNode',
          { Graph: graph, VariableName: variableName },
          variableName,
        )
        return { value: { nodeObjectPath, variableName, functionName: 'AddVariableSetNode' }, resultSummary: 'variable set node added' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_add_blueprint_variable',
    description: 'Add one Blueprint member variable. typeString uses the Type grammar primitive kinds (double, float, int32, int64, bool, string, name, byte) or array types such as int32[]. Compile the Blueprint afterwards.',
    parameters: {
      blueprint: { type: 'string', required: true, description: 'Blueprint object path.' },
      variableName: { type: 'string', required: true, description: 'New variable name.' },
      typeString: { type: 'string', required: true, description: 'Type string, e.g. double or int32[].' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `added variable ${value.variableName} (${value.typeString})` }],
    },
    async execute(args, exec) {
      const blueprint = requiredString(args.blueprint, 'blueprint')
      const variableName = requiredString(args.variableName, 'variableName')
      const typeString = requiredString(args.typeString, 'typeString')
      return await audited(deps, exec, { tool: 'unreal_add_blueprint_variable', params: { blueprint, variableName, typeString } }, async () => {
        await requireEditorAutomationBool(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.graph,
          'AddBlueprintVariable',
          { Blueprint: blueprint, VariableName: variableName, TypeString: typeString },
          `${blueprint}.${variableName}`,
        )
        return { value: { success: true, blueprint, variableName, typeString, functionName: 'AddBlueprintVariable' }, resultSummary: `variable ${variableName} added` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_connect_pins',
    description: 'Connect an output pin to an input pin. Returns success; a false result (tool error) means a pin was missing or the schema rejected the connection — unreal_get_node_pins reads the pins, unreal_get_recent_log reads the reason.',
    parameters: {
      fromNode: { type: 'string', required: true, description: 'Source node object path.' },
      fromPinName: { type: 'string', required: true, description: 'Source pin name (output direction).' },
      toNode: { type: 'string', required: true, description: 'Target node object path.' },
      toPinName: { type: 'string', required: true, description: 'Target pin name (input direction).' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `connected ${value.fromPinName} -> ${value.toPinName}` }],
    },
    async execute(args, exec) {
      const fromNode = requiredString(args.fromNode, 'fromNode')
      const fromPinName = requiredString(args.fromPinName, 'fromPinName')
      const toNode = requiredString(args.toNode, 'toNode')
      const toPinName = requiredString(args.toPinName, 'toPinName')
      return await audited(deps, exec, { tool: 'unreal_connect_pins', params: { fromNode, fromPinName, toNode, toPinName } }, async () => {
        await requireEditorAutomationBool(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.graph,
          'ConnectPins',
          { FromNode: fromNode, FromPinName: fromPinName, ToNode: toNode, ToPinName: toPinName },
          `${fromPinName} -> ${toPinName}`,
        )
        return { value: { success: true, fromNode, fromPinName, toNode, toPinName, functionName: 'ConnectPins' }, resultSummary: `${fromPinName} -> ${toPinName}` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_set_pin_default_value',
    description: 'Set one input pin default value (text form: "1.0", "true", "Cube").',
    parameters: {
      node: { type: 'string', required: true, description: 'Node object path.' },
      pinName: { type: 'string', required: true, description: 'Input pin name.' },
      defaultValue: { type: 'string', required: true, description: 'Default value text.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `${value.pinName} = ${value.defaultValue}` }],
    },
    async execute(args, exec) {
      const node = requiredString(args.node, 'node')
      const pinName = requiredString(args.pinName, 'pinName')
      const defaultValue = requiredString(args.defaultValue, 'defaultValue')
      return await audited(deps, exec, { tool: 'unreal_set_pin_default_value', params: { node, pinName, defaultValue } }, async () => {
        await requireEditorAutomationBool(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.graph,
          'SetPinDefaultValue',
          { Node: node, PinName: pinName, DefaultValue: defaultValue },
          `${pinName} = ${defaultValue}`,
        )
        return { value: { success: true, node, pinName, defaultValue, functionName: 'SetPinDefaultValue' }, resultSummary: `${pinName} = ${defaultValue}` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_set_pin_default_object',
    description: 'Set one input object-reference pin default object by object path.',
    parameters: {
      node: { type: 'string', required: true, description: 'Node object path.' },
      pinName: { type: 'string', required: true, description: 'Input pin name.' },
      objectPath: { type: 'string', required: true, description: 'Default object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `${value.pinName} = ${value.objectPath}` }],
    },
    async execute(args, exec) {
      const node = requiredString(args.node, 'node')
      const pinName = requiredString(args.pinName, 'pinName')
      const objectPath = requiredString(args.objectPath, 'objectPath')
      return await audited(deps, exec, { tool: 'unreal_set_pin_default_object', params: { node, pinName, objectPath } }, async () => {
        await requireEditorAutomationBool(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.graph,
          'SetPinDefaultObject',
          { Node: node, PinName: pinName, ObjectPath: objectPath },
          `${pinName} = ${objectPath}`,
        )
        return { value: { success: true, node, pinName, objectPath, functionName: 'SetPinDefaultObject' }, resultSummary: `${pinName} = ${objectPath}` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_set_node_position',
    description: 'Move one graph node to an editor position.',
    parameters: {
      node: { type: 'string', required: true, description: 'Node object path.' },
      nodePosX: { type: 'number', required: true, description: 'X position.' },
      nodePosY: { type: 'number', required: true, description: 'Y position.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `moved node to (${value.nodePosX}, ${value.nodePosY})` }],
    },
    async execute(args, exec) {
      const node = requiredString(args.node, 'node')
      const nodePosX = typeof args.nodePosX === 'number' ? args.nodePosX : 0
      const nodePosY = typeof args.nodePosY === 'number' ? args.nodePosY : 0
      return await audited(deps, exec, { tool: 'unreal_set_node_position', params: { node, nodePosX, nodePosY } }, async () => {
        await requireEditorAutomationBool(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.graph,
          'SetNodePosition',
          { Node: node, NodePosX: nodePosX, NodePosY: nodePosY },
          node,
        )
        return { value: { success: true, node, nodePosX, nodePosY, functionName: 'SetNodePosition' }, resultSummary: `moved to (${nodePosX}, ${nodePosY})` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_remove_graph_node',
    description: 'Remove one node from its graph.',
    parameters: {
      node: { type: 'string', required: true, description: 'Node object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `removed ${value.node}` }],
    },
    async execute(args, exec) {
      const node = requiredString(args.node, 'node')
      return await audited(deps, exec, { tool: 'unreal_remove_graph_node', params: { node } }, async () => {
        await requireEditorAutomationBool(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.graph, 'RemoveGraphNode', { Node: node }, node)
        return { value: { success: true, node, functionName: 'RemoveGraphNode' }, resultSummary: 'node removed' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_remove_graph_nodes_by_class',
    description: 'Remove every node of one class from a graph (for example all K2Node_CallFunction nodes). Returns the number of removed nodes.',
    parameters: {
      graph: { type: 'string', required: true, description: 'Graph object path.' },
      nodeClassPath: { type: 'string', required: true, description: 'UEdGraphNode subclass path, e.g. /Script/BlueprintGraph.K2Node_CallFunction.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `removed ${value.removed} nodes` }],
    },
    async execute(args, exec) {
      const graph = requiredString(args.graph, 'graph')
      const nodeClassPath = requiredString(args.nodeClassPath, 'nodeClassPath')
      return await audited(deps, exec, { tool: 'unreal_remove_graph_nodes_by_class', params: { graph, nodeClassPath } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.graph, 'RemoveGraphNodesByClass', {
          Graph: graph,
          NodeClassPath: nodeClassPath,
        })
        const removed = typeof result.payload === 'string' ? Number(result.payload) : structNumber(result.payload, '')
        return { value: { removed: Number.isFinite(removed) ? removed : 0, graph, nodeClassPath, functionName: 'RemoveGraphNodesByClass' }, resultSummary: `removed ${removed} nodes` }
      })
    },
  }))
  ctx.tools.register(defineTool({
    name: 'unreal_list_assets',
    description: 'List assets under a content directory, optionally recursive and class-filtered.',
    parameters: {
      directoryPath: { type: 'string', required: true, description: 'Content directory, e.g. /Game/UI.' },
      recursive: { type: 'boolean', description: 'Recurse into subdirectories.' },
      classPath: { type: 'string', description: 'Optional asset class path filter.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const directoryPath = requiredString(args.directoryPath, 'directoryPath')
      const recursive = args.recursive === true
      const classPath = typeof args.classPath === 'string' ? args.classPath : ''
      return await audited(deps, exec, { tool: 'unreal_list_assets', params: { directoryPath: directoryPath, recursive: recursive, classPath: classPath } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.asset, 'ListAssets', { DirectoryPath: directoryPath, bRecursive: recursive, ClassPath: classPath })
        return { value: { result: result.payload }, resultSummary: 'Assets listed' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_list_folders',
    description: 'List child folders under a content directory.',
    parameters: {
      directoryPath: { type: 'string', required: true, description: 'Content directory.' },
      recursive: { type: 'boolean', description: 'Recurse into subdirectories.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const directoryPath = requiredString(args.directoryPath, 'directoryPath')
      const recursive = args.recursive === true
      return await audited(deps, exec, { tool: 'unreal_list_folders', params: { directoryPath: directoryPath, recursive: recursive } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.asset, 'ListFolders', { DirectoryPath: directoryPath, bRecursive: recursive })
        return { value: { result: result.payload }, resultSummary: 'Folders listed' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_get_asset_info',
    description: 'Get one asset registry entry: object path, package path, name and class.',
    parameters: {
      assetPath: { type: 'string', required: true, description: 'Asset object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const assetPath = requiredString(args.assetPath, 'assetPath')
      return await audited(deps, exec, { tool: 'unreal_get_asset_info', params: { assetPath: assetPath } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.asset, 'GetAssetInfo', { AssetPath: assetPath })
        return { value: { result: result.payload }, resultSummary: 'Asset info read' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_does_asset_exist',
    description: 'Whether one asset exists in the asset registry.',
    parameters: {
      assetPath: { type: 'string', required: true, description: 'Asset object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const assetPath = requiredString(args.assetPath, 'assetPath')
      return await audited(deps, exec, { tool: 'unreal_does_asset_exist', params: { assetPath: assetPath } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.asset, 'DoesAssetExist', { AssetPath: assetPath })
        return { value: { result: result.payload }, resultSummary: 'Asset existence checked' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_load_asset',
    description: 'Load one asset and hold a strong reference in the asset cache.',
    parameters: {
      assetPath: { type: 'string', required: true, description: 'Asset object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const assetPath = requiredString(args.assetPath, 'assetPath')
      return await audited(deps, exec, { tool: 'unreal_load_asset', params: { assetPath: assetPath } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.asset, 'LoadAsset', { AssetPath: assetPath })
        return { value: { result: result.payload }, resultSummary: 'Asset loaded' }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_unload_asset',
    description: 'Release the asset cache strong reference. Does not force GC.',
    parameters: {
      assetPath: { type: 'string', required: true, description: 'Asset object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const assetPath = requiredString(args.assetPath, 'assetPath')
      return await audited(deps, exec, { tool: 'unreal_unload_asset', params: { assetPath: assetPath } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.asset, 'UnloadAsset', { AssetPath: assetPath })
        return { value: { result: result.payload }, resultSummary: 'Asset unloaded' }
      })
    },
  }))

    ctx.tools.register(defineTool({
    name: 'unreal_get_dirty_assets',
    description:
      'List every loaded asset package with unsaved changes (maps and content; transient packages are skipped). Call this before closing the editor or restarting the host, show the list to the user and ask whether to save; unreal_save_dirty_assets then saves without any dialog.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        const dirty = Array.isArray(value.dirty) ? (value.dirty as Array<Record<string, JsonValue>>) : []
        if (dirty.length === 0) return [{ type: 'text', text: 'no dirty assets' }]
        const lines = dirty.map(entry => {
          const paths = Array.isArray(entry['assetPaths']) ? (entry['assetPaths'] as JsonValue[]).map(String) : []
          const detail = paths.length === 0 ? '' : ` → ${paths.join(', ')}`
          return `${String(entry['packageName'])}${entry['isMap'] === true ? ' (map)' : ''}${detail}`
        })
        return [{ type: 'text', text: `${String(value.count)} dirty packages\n${lines.join('\n')}` }]
      },
    },
    async execute(_args, exec) {
      return await audited(deps, exec, { tool: 'unreal_get_dirty_assets', params: {} }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.asset, 'GetDirtyAssets', {})
        const dirty = payloadStructArray(result.payload).map(entry => ({
          packageName: structString(entry, 'PackageName'),
          assetPaths: payloadStringArray(entry, 'AssetPaths'),
          isMap: structBool(entry, 'bIsMap'),
        }))
        return { value: { dirty, count: dirty.length }, resultSummary: `${dirty.length} dirty packages` }
      })
    },
  }))

  ctx.tools.register(defineTool({
    name: 'unreal_save_dirty_assets',
    description:
      'Silently save unsaved asset packages (no save dialog). Pass assets (asset or package paths) to save specific ones, or omit it to save every currently dirty package. Call this only after the user confirmed saving.',
    parameters: {
      assets: {
        type: 'json',
        description: 'Optional JSON array of asset/package paths; omit to save every dirty package.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [
        {
          type: 'text',
          text: Array.isArray(value.remainingDirty) && value.remainingDirty.length === 0
            ? 'dirty assets saved'
            : `saved; still dirty: ${(value.remainingDirty as JsonValue[]).map(String).join(', ')}`,
        },
      ],
    },
    async execute(args, exec) {
      const raw = args.assets
      if (raw !== undefined && !Array.isArray(raw)) {
        throw new KitError('editorautomation/invalid_argument', 'assets must be a JSON array of asset/package paths.', {
          functionName: 'SaveAssets',
        })
      }
      const requested = raw === undefined ? [] : raw.map(String)
      return await audited(deps, exec, { tool: 'unreal_save_dirty_assets', params: { assets: requested } }, async () => {
        await requireEditorAutomationBool(
          deps,
          exec.signal,
          EDITOR_AUTOMATION_LIBRARIES.asset,
          'SaveAssets',
          { AssetOrPackagePaths: requested, bOnlyDirty: true },
          requested.length === 0 ? 'the dirty assets' : requested.join(', '),
        )
        const after = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.asset, 'GetDirtyAssets', {})
        const remainingDirty = payloadStructArray(after.payload).map(entry => structString(entry, 'PackageName'))
        return {
          value: { requested, saved: true, remainingDirty },
          resultSummary: remainingDirty.length === 0 ? 'dirty assets saved' : `${remainingDirty.length} packages still dirty`,
        }
      })
    },
  }))
ctx.tools.register(defineTool({
    name: 'unreal_create_widget_blueprint',
    description: 'Create a WidgetBlueprint asset at AssetPath. ParentClassPath defaults to UUserWidget.',
    parameters: {
      assetPath: { type: 'string', required: true, description: 'New WidgetBlueprint package path.' },
      parentClassPath: { type: 'string', description: 'Optional UUserWidget parent class path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const assetPath = requiredString(args.assetPath, 'assetPath')
      const parentClassPath = typeof args.parentClassPath === 'string' ? args.parentClassPath : ''
      return await audited(deps, exec, { tool: 'unreal_create_widget_blueprint', params: { assetPath: assetPath, parentClassPath: parentClassPath } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'CreateWidgetBlueprint', { AssetPath: assetPath, ParentClassPath: parentClassPath })
        const objectPath = typeof result.payload === 'string' ? result.payload : ''
        if (objectPath === '') {
          throw new KitError('editorautomation/CreateWidgetBlueprintFailed', 'The operation returned no object path.', {
            functionName: 'CreateWidgetBlueprint',
            hint: 'Call unreal_get_recent_log for the engine log reason.',
          })
        }
        return { value: { objectPath }, resultSummary: 'widget blueprint created' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg_editor') })

  ctx.tools.register(defineTool({
    name: 'unreal_add_root_widget',
    description: 'Add a root widget to an empty WidgetBlueprint.',
    parameters: {
      widgetBlueprintPath: { type: 'string', required: true, description: 'WidgetBlueprint asset path.' },
      widgetClassPath: { type: 'string', required: true, description: 'Root widget class path.' },
      widgetName: { type: 'string', required: true, description: 'Unique widget name.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const widgetBlueprintPath = requiredString(args.widgetBlueprintPath, 'widgetBlueprintPath')
      const widgetClassPath = requiredString(args.widgetClassPath, 'widgetClassPath')
      const widgetName = requiredString(args.widgetName, 'widgetName')
      return await audited(deps, exec, { tool: 'unreal_add_root_widget', params: { widgetBlueprintPath: widgetBlueprintPath, widgetClassPath: widgetClassPath, widgetName: widgetName } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'AddRootWidget', { WidgetBlueprintPath: widgetBlueprintPath, WidgetClassPath: widgetClassPath, WidgetName: widgetName })
        const objectPath = typeof result.payload === 'string' ? result.payload : ''
        if (objectPath === '') {
          throw new KitError('editorautomation/AddRootWidgetFailed', 'The operation returned no object path.', {
            functionName: 'AddRootWidget',
            hint: 'Call unreal_get_recent_log for the engine log reason.',
          })
        }
        return { value: { objectPath }, resultSummary: 'root widget added' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg_editor') })

  ctx.tools.register(defineTool({
    name: 'unreal_get_umg_widget_tree',
    description: 'List template UWidget object paths in a WidgetBlueprint. Nested UserWidgets are leaves.',
    parameters: {
      widgetBlueprintPath: { type: 'string', required: true, description: 'WidgetBlueprint asset path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const widgetBlueprintPath = requiredString(args.widgetBlueprintPath, 'widgetBlueprintPath')
      return await audited(deps, exec, { tool: 'unreal_get_umg_widget_tree', params: { widgetBlueprintPath: widgetBlueprintPath } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'GetWidgetTree', { WidgetBlueprintPath: widgetBlueprintPath })
        return { value: { result: result.payload }, resultSummary: 'widget tree read' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg_editor') })

  ctx.tools.register(defineTool({
    name: 'unreal_get_umg_widget_parent',
    description: 'Get the parent widget of a template UWidget.',
    parameters: {
      widget: { type: 'string', required: true, description: 'Template UWidget object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const widget = requiredString(args.widget, 'widget')
      return await audited(deps, exec, { tool: 'unreal_get_umg_widget_parent', params: { widget: widget } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'GetWidgetParent', { Widget: widget })
        return { value: { result: result.payload }, resultSummary: 'widget parent read' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg_editor') })

  ctx.tools.register(defineTool({
    name: 'unreal_get_umg_widget_children',
    description: 'Get the direct children of a template UWidget.',
    parameters: {
      widget: { type: 'string', required: true, description: 'Template UWidget object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const widget = requiredString(args.widget, 'widget')
      return await audited(deps, exec, { tool: 'unreal_get_umg_widget_children', params: { widget: widget } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'GetWidgetChildren', { Widget: widget })
        return { value: { result: result.payload }, resultSummary: 'widget children read' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg_editor') })

  ctx.tools.register(defineTool({
    name: 'unreal_is_widget_variable',
    description: 'Whether a template widget is exposed as a variable of one Widget Blueprint (its name exists on the generated class). Requires the umg_editor group.',
    parameters: {
      widget: { type: 'string', required: true, description: 'Template UWidget object path.' },
      blueprint: { type: 'string', required: true, description: 'WidgetBlueprint asset object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `${String(value.widget)} variable=${String(value.isVariable)}` }],
    },
    async execute(args, exec) {
      const widget = requiredString(args.widget, 'widget')
      const blueprint = requiredString(args.blueprint, 'blueprint')
      return await audited(deps, exec, { tool: 'unreal_is_widget_variable', params: { widget, blueprint } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'IsWidgetVariable', {
          Widget: widget,
          WidgetBlueprint: blueprint,
        })
        const isVariable = payloadBool(result.payload)
        return { value: { widget, blueprint, isVariable }, resultSummary: `variable=${isVariable}` }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg_editor') })

  ctx.tools.register(defineTool({
    name: 'unreal_get_user_widget_root',
    description: 'Get the root widget of the UserWidget that owns one widget (walking up outers), e.g. to go from a nested child back to its user-widget root. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UWidget UObject path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: `root: ${String(value.rootWidget)}` }],
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      return await audited(deps, exec, { tool: 'unreal_get_user_widget_root', params: { objectPath } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'GetUserWidgetRoot', { Widget: objectPath })
        const rootWidget = typeof result.payload === 'string' ? result.payload : ''
        return { value: { objectPath, rootWidget }, resultSummary: rootWidget === '' ? 'root not found' : 'root read' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_get_widget_text_active_states',
    description:
      'Collect every UTextBlock inside one widget subtree with its current text and visual state: object path, text, ESlateVisibility display name, enabled and visible flags. Requires the umg group.',
    parameters: {
      objectPath: { type: 'string', required: true, description: 'UWidget UObject path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => {
        const states = Array.isArray(value.states) ? (value.states as Array<Record<string, JsonValue>>) : []
        const lines = states.map(state => `${String(state['text'])} [${String(state['visibility'])}] enabled=${String(state['isEnabled'])} visible=${String(state['isVisible'])}`)
        return [{ type: 'text', text: states.length === 0 ? 'no text widgets' : `${states.length} text widgets\n${lines.join('\n')}` }]
      },
    },
    async execute(args, exec) {
      const objectPath = requiredString(args.objectPath, 'objectPath')
      return await audited(deps, exec, { tool: 'unreal_get_widget_text_active_states', params: { objectPath } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'GetWidgetTextActiveStates', { Widget: objectPath })
        const states = payloadStructArray(result.payload).map(state => ({
          widgetPath: structString(state, 'WidgetPath'),
          text: structString(state, 'Text'),
          visibility: structString(state, 'Visibility'),
          isEnabled: structBool(state, 'bIsEnabled'),
          isVisible: structBool(state, 'bIsVisible'),
        }))
        return { value: { objectPath, states, count: states.length }, resultSummary: `${states.length} text widgets` }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg') })

  ctx.tools.register(defineTool({
    name: 'unreal_get_umg_widget_slot',
    description: 'Get the UPanelSlot object path of a template UWidget.',
    parameters: {
      widget: { type: 'string', required: true, description: 'Template UWidget object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const widget = requiredString(args.widget, 'widget')
      return await audited(deps, exec, { tool: 'unreal_get_umg_widget_slot', params: { widget: widget } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'GetWidgetSlot', { Widget: widget })
        return { value: { result: result.payload }, resultSummary: 'widget slot read' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg_editor') })

  ctx.tools.register(defineTool({
    name: 'unreal_add_umg_widget',
    description: 'Add a widget under a template parent. ChildIndex < 0 appends.',
    parameters: {
      parent: { type: 'string', required: true, description: 'Parent widget object path.' },
      widgetClassPath: { type: 'string', required: true, description: 'Widget class path.' },
      widgetName: { type: 'string', description: 'Optional unique widget name.' },
      childIndex: { type: 'number', description: 'Insert index; -1 appends.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const parent = requiredString(args.parent, 'parent')
      const widgetClassPath = requiredString(args.widgetClassPath, 'widgetClassPath')
      const widgetName = typeof args.widgetName === 'string' ? args.widgetName : ''
      const childIndex = typeof args.childIndex === 'number' ? args.childIndex : -1
      return await audited(deps, exec, { tool: 'unreal_add_umg_widget', params: { parent: parent, widgetClassPath: widgetClassPath, widgetName: widgetName, childIndex: childIndex } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'AddWidget', { Parent: parent, WidgetClassPath: widgetClassPath, WidgetName: widgetName, ChildIndex: childIndex })
        const objectPath = typeof result.payload === 'string' ? result.payload : ''
        if (objectPath === '') {
          throw new KitError('editorautomation/AddWidgetFailed', 'The operation returned no object path.', {
            functionName: 'AddWidget',
            hint: 'Call unreal_get_recent_log for the engine log reason.',
          })
        }
        return { value: { objectPath }, resultSummary: 'widget added' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg_editor') })

  ctx.tools.register(defineTool({
    name: 'unreal_remove_umg_widget',
    description: 'Remove one template widget from its WidgetBlueprint.',
    parameters: {
      widget: { type: 'string', required: true, description: 'Template UWidget object path.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const widget = requiredString(args.widget, 'widget')
      return await audited(deps, exec, { tool: 'unreal_remove_umg_widget', params: { widget: widget } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'RemoveWidget', { Widget: widget })
        if (!payloadBool(result.payload)) {
          throw new KitError('editorautomation/RemoveWidgetFailed', 'The operation reported failure.', {
            functionName: 'RemoveWidget',
            hint: 'Call unreal_get_recent_log for the engine log reason.',
          })
        }
        return { value: { success: true }, resultSummary: 'widget removed' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg_editor') })

  ctx.tools.register(defineTool({
    name: 'unreal_rename_umg_widget',
    description: 'Rename one template widget and return its new object path.',
    parameters: {
      widget: { type: 'string', required: true, description: 'Template UWidget object path.' },
      newName: { type: 'string', required: true, description: 'New unique widget name.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const widget = requiredString(args.widget, 'widget')
      const newName = requiredString(args.newName, 'newName')
      return await audited(deps, exec, { tool: 'unreal_rename_umg_widget', params: { widget: widget, newName: newName } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'RenameWidget', { Widget: widget, NewName: newName })
        const objectPath = typeof result.payload === 'string' ? result.payload : ''
        if (objectPath === '') {
          throw new KitError('editorautomation/RenameWidgetFailed', 'The operation returned no object path.', {
            functionName: 'RenameWidget',
            hint: 'Call unreal_get_recent_log for the engine log reason.',
          })
        }
        return { value: { objectPath }, resultSummary: 'widget renamed' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg_editor') })

  ctx.tools.register(defineTool({
    name: 'unreal_reparent_umg_widget',
    description: 'Move a template widget under another parent. ChildIndex < 0 appends.',
    parameters: {
      widget: { type: 'string', required: true, description: 'Template UWidget object path.' },
      newParent: { type: 'string', required: true, description: 'New parent widget object path.' },
      childIndex: { type: 'number', description: 'Insert index; -1 appends.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const widget = requiredString(args.widget, 'widget')
      const newParent = requiredString(args.newParent, 'newParent')
      const childIndex = typeof args.childIndex === 'number' ? args.childIndex : -1
      return await audited(deps, exec, { tool: 'unreal_reparent_umg_widget', params: { widget: widget, newParent: newParent, childIndex: childIndex } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'ReparentWidget', { Widget: widget, NewParent: newParent, ChildIndex: childIndex })
        if (!payloadBool(result.payload)) {
          throw new KitError('editorautomation/ReparentWidgetFailed', 'The operation reported failure.', {
            functionName: 'ReparentWidget',
            hint: 'Call unreal_get_recent_log for the engine log reason.',
          })
        }
        return { value: { success: true }, resultSummary: 'widget reparented' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg_editor') })

  ctx.tools.register(defineTool({
    name: 'unreal_set_umg_widget_property',
    description: 'Set one template UWidget property from nested JSON. Marks the Blueprint dirty.',
    parameters: {
      widget: { type: 'string', required: true, description: 'Template UWidget object path.' },
      propertyPath: { type: 'string', required: true, description: 'Property path.' },
      valueJson: { type: 'string', required: true, description: 'Nested JSON value text.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const widget = requiredString(args.widget, 'widget')
      const propertyPath = requiredString(args.propertyPath, 'propertyPath')
      const valueJson = requiredString(args.valueJson, 'valueJson')
      return await audited(deps, exec, { tool: 'unreal_set_umg_widget_property', params: { widget: widget, propertyPath: propertyPath, valueJson: valueJson } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'SetWidgetProperty', { Widget: widget, PropertyPath: propertyPath, ValueJson: valueJson })
        if (!payloadBool(result.payload)) {
          throw new KitError('editorautomation/SetWidgetPropertyFailed', 'The operation reported failure.', {
            functionName: 'SetWidgetProperty',
            hint: 'Call unreal_get_recent_log for the engine log reason.',
          })
        }
        return { value: { success: true }, resultSummary: 'widget property set' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg_editor') })

  ctx.tools.register(defineTool({
    name: 'unreal_set_umg_widget_slot_property',
    description: 'Set one template UPanelSlot property from nested JSON. Marks the Blueprint dirty.',
    parameters: {
      slot: { type: 'string', required: true, description: 'UPanelSlot object path.' },
      propertyPath: { type: 'string', required: true, description: 'Property path.' },
      valueJson: { type: 'string', required: true, description: 'Nested JSON value text.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: {} },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      const slot = requiredString(args.slot, 'slot')
      const propertyPath = requiredString(args.propertyPath, 'propertyPath')
      const valueJson = requiredString(args.valueJson, 'valueJson')
      return await audited(deps, exec, { tool: 'unreal_set_umg_widget_slot_property', params: { slot: slot, propertyPath: propertyPath, valueJson: valueJson } }, async () => {
        const result = await invokeEditorAutomation(deps, exec.signal, EDITOR_AUTOMATION_LIBRARIES.umgEditor, 'SetWidgetSlotProperty', { Slot: slot, PropertyPath: propertyPath, ValueJson: valueJson })
        if (!payloadBool(result.payload)) {
          throw new KitError('editorautomation/SetWidgetSlotPropertyFailed', 'The operation reported failure.', {
            functionName: 'SetWidgetSlotProperty',
            hint: 'Call unreal_get_recent_log for the engine log reason.',
          })
        }
        return { value: { success: true }, resultSummary: 'widget slot property set' }
      })
    },
  }), { when: ({ agent }) => groupsFor(agent?.id === undefined ? undefined : String(agent.id)).has('umg_editor') })

}


// ---------------------------------------------------------------------------
// EditorAutomation invocation through the generic CallFunction dispatcher
// ---------------------------------------------------------------------------

/** EditorAutomation library CDO paths, as addressed by Remote Control. */
const EDITOR_AUTOMATION_LIBRARIES = {
  core: '/Script/EditorAutomation.Default__EditorAutomationCoreLibrary',
  input: '/Script/EditorAutomation.Default__EditorAutomationInputLibrary',
  blueprint: '/Script/EditorAutomation.Default__EditorAutomationBlueprintLibrary',
  graph: '/Script/EditorAutomation.Default__EditorAutomationGraphLibrary',
  level: '/Script/EditorAutomation.Default__EditorAutomationLevelLibrary',
  asset: '/Script/EditorAutomation.Default__EditorAutomationAssetLibrary',
  umg: '/Script/EditorAutomation.Default__EditorAutomationUMGLibrary',
  umgEditor: '/Script/EditorAutomation.Default__EditorAutomationUMGEditorLibrary',
} as const

/** Nested-JSON payload of one EditorAutomation call plus its raw text and Type. */
interface EditorAutomationCallResult {
  /** Parsed ReturnValueJson; null when the function returns nothing. */
  readonly payload: JsonValue
  readonly returnValueJson: string
  readonly returnType: string
  readonly returnedNothing: boolean
}

/**
 * Call one EditorAutomation library function through its generic `CallFunction` dispatcher.
 *
 * This is the single calling convention of the plugin: instead of addressing each library
 * function as its own Remote Control entry point, the tool serializes the parameters and lets
 * EditorAutomation's dispatcher invoke the function, so call-level failures (unknown object/function,
 * bad parameter JSON) come back in one uniform result and return values arrive as nested JSON.
 *
 * @param deps - tool dependencies (the EditorAutomation client).
 * @param signal - caller cancellation.
 * @param library - EditorAutomation library CDO path, e.g. `/Script/EditorAutomation.Default__EditorAutomationLevelLibrary`.
 * @param functionName - the BlueprintCallable function to invoke.
 * @param parameters - parameters keyed by C++ parameter name, in the nested-JSON conventions.
 * @returns the parsed payload plus the raw result text and canonical return Type.
 */
async function invokeEditorAutomation(
  deps: ToolDeps,
  signal: AbortSignal | undefined,
  library: string,
  functionName: string,
  parameters: Record<string, unknown>,
): Promise<EditorAutomationCallResult> {
  const returned = await deps.client.call(
    'CallFunction',
    {
      ObjectPath: library,
      FunctionName: functionName,
      ParametersJson: JSON.stringify(parameters),
      bGenerateTransaction: false,
    },
    signal,
  )
  const kitResult = assertKitResult<KitCallFunctionResult>('CallFunction', returned)
  const returnValueJson = kitResult.ReturnValueJson ?? ''
  const payload = parseNestedJson(returnValueJson, `CallFunction(${functionName}).ReturnValueJson`).value
  return {
    payload,
    returnValueJson,
    returnType: kitResult.ReturnType ?? '',
    returnedNothing: returnValueJson.trim() === '',
  }
}

/**
 * Invoke a bool-returning EditorAutomation function and raise a tool error when it reports false.
 *
 * EditorAutomation logs the reason for the failure (visible through `unreal_get_recent_log`), which is
 * why the hint points there instead of inventing a per-function error enum.
 */
async function requireEditorAutomationBool(
  deps: ToolDeps,
  signal: AbortSignal | undefined,
  library: string,
  functionName: string,
  parameters: Record<string, unknown>,
  subject: string,
): Promise<void> {
  const result = await invokeEditorAutomation(deps, signal, library, functionName, parameters)
  if (!payloadBool(result.payload)) {
    throw new KitError(`editorautomation/${functionName}Failed`, `${functionName} reported failure for ${subject}.`, {
      functionName,
      hint: 'Call unreal_get_recent_log for the engine log reason.',
    })
  }
}

/** Whether a nested-JSON boolean payload means true (scalars arrive as strings). */
function payloadBool(payload: JsonValue): boolean {
  return payload === true || payload === 'true'
}

/** Read a string member of a nested-JSON struct payload. */
function structString(payload: JsonValue, key: string): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return ''
  const value = (payload as Record<string, JsonValue>)[key]
  return typeof value === 'string' ? value : ''
}

/** Read a number member of a nested-JSON struct payload (scalars arrive as strings). */
function structNumber(payload: JsonValue, key: string): number {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return 0
  const value = (payload as Record<string, JsonValue>)[key]
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Read a boolean member of a nested-JSON struct payload. */
function structBool(payload: JsonValue, key: string): boolean {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  const value = (payload as Record<string, JsonValue>)[key]
  return value === true || value === 'true'
}

/** Read a nested-JSON array of struct objects; anything else is an empty array. */
function payloadStructArray(payload: JsonValue): JsonValue[] {
  return Array.isArray(payload) ? payload : []
}

/** Read a nested-JSON array of strings from a struct payload member. */
function payloadStringArray(payload: JsonValue, key: string): string[] {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return []
  const value = (payload as Record<string, JsonValue>)[key]
  return Array.isArray(value) ? value.map(String) : []
}

/**
 * Build the Engine's FEditorAutomationModifierKeys object from the agnostic Ctrl/Alt/Shift/Cmd
 * tool arguments. Absent arguments stay absent so the C++ defaults decide.
 */
function modifierKeysJson(args: Record<string, unknown>): Record<string, string> | undefined {
  const keys: Record<string, string> = {}
  const candidates: ReadonlyArray<readonly [string, string]> = [
    ['control', 'bControl'],
    ['alt', 'bAlt'],
    ['shift', 'bShift'],
    ['command', 'bCommand'],
  ]
  for (const [argument, field] of candidates) {
    const value = args[argument]
    if (typeof value === 'boolean') keys[field] = value ? 'true' : 'false'
  }
  return Object.keys(keys).length === 0 ? undefined : keys
}

/** Build FEditorAutomationSendClickOptions for the Input library (nested-JSON scalars are strings). */
function clickOptionsJson(
  button: string,
  clickType: string,
  relativeX: number,
  relativeY: number,
  modifiers: Record<string, string> | undefined,
): Record<string, unknown> {
  return {
    Button: button,
    ClickType: clickType === 'double' ? 1 : 0,
    RelativePosition: { X: String(relativeX), Y: String(relativeY) },
    ...(modifiers === undefined ? {} : { ModifierKeys: modifiers }),
  }
}

/** Invoke a string-returning EditorAutomation function and raise when it reports an empty result. */
async function requireEditorAutomationString(
  deps: ToolDeps,
  signal: AbortSignal | undefined,
  library: string,
  functionName: string,
  parameters: Record<string, unknown>,
  subject: string,
): Promise<string> {
  const result = await invokeEditorAutomation(deps, signal, library, functionName, parameters)
  const value = typeof result.payload === 'string' ? result.payload : ''
  if (value === '') {
    throw new KitError(`editorautomation/${functionName}Failed`, `${functionName} returned no result for ${subject}.`, {
      functionName,
      hint: 'Call unreal_get_recent_log for the engine log reason.',
    })
  }
  return value
}
