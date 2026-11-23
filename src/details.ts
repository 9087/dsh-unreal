/**
 * Typed call enrichment: the structured "Details" a history row shows.
 *
 * A raw `ValueJson`/`ParametersJson` payload is readable to a model but not to
 * the person reviewing the editor: they need the parameter **names**, each
 * value's **Type**, whether it is input or output, the return Type, and —for a
 * write —the old and new value side by side. This module builds that shape and
 * stores it on the durable record, so the panel can render a Details layout
 * without asking the editor anything at render time.
 *
 * The schema comes from {@link ReflectionService}, which is the cached path: a
 * `GetFunctionInfo` a tool call just answered is reused here, and a shape
 * fetched for one call is reused by the next. Every lookup is **best-effort** — * a signature that cannot be resolved leaves the field values untyped rather
 * than failing the call that produced the record.
 *
 * Everything is bounded: nested values are depth/size limited, and the final
 * structure is shrunk to a character budget (oldest sections dropped, marked
 * `truncated`) so one giant struct cannot bloat the history store.
 *
 * @module dsh-unreal/details
 */

import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import type { RcCallSnapshot } from './audit-capture.ts'

import type {
  FunctionView,
  ReflectionService,
} from './kit/reflection.ts'
import { classTypeFromObjectPath } from './kit/type-derive.ts'

/** One named member type, for the Details tree's field labels. */
export interface DetailMemberType {
  /** Member name (C++ name for a struct member, index for an array). */
  readonly name: string
  /** Canonical Type string, when known. */
  readonly type?: string | undefined
  /** UE display name text for this member, when the schema reported one. */
  readonly displayNameText?: JsonValue | undefined
  /** Nested members of a struct-typed member (or of a container element), for deeper expansion. */
  readonly members?: DetailMemberType[] | undefined
}

/** One row of a Details section. */
export interface DetailField {
  /** Field name: a parameter name, a property path, `ReturnValue`, —*/
  readonly name: string
  /** Full FText identity for a localized label. */
  readonly displayName?: JsonValue | undefined
  /** UE display name text for this label. */
  readonly displayNameText?: JsonValue | undefined
  /** Canonical Type string, when the schema was resolvable. */
  readonly type?: string | undefined
  /** `input`, `output`, `input-output` or `return`. */
  readonly direction?: string | undefined
  /** The value in the Engine's decoded JSON form (scalars as strings). */
  readonly value?: JsonValue | undefined
  /** A display label for an enum's numeric value, when the enum was cached. */
  readonly enumLabel?: string | undefined
  /** Full FText identity for the enum's display name. */
  readonly enumLabelRef?: JsonValue | undefined
  /** The enum entry's code name. */
  readonly enumName?: string | undefined
  /** Raw JSON text when the value did not parse. */
  readonly raw?: string | undefined
  /** Immediate member types, so the Details tree can label nested fields. */
  members?: DetailMemberType[] | undefined
  /** True when the parameter was omitted and the Engine default applies. */
  readonly omitted?: boolean | undefined
  /** A short human note about the field. */
  readonly note?: string | undefined
}


/** What one section of a Details view is. */
export type DetailSectionKind =
  | 'inputs'
  | 'outputs'
  | 'returns'
  | 'change'
  | 'value'
  | 'type'
  | 'screenshot'
  | 'calls'

/** One section of a Details view. */
export interface DetailSection {
  /** What the section shows; the panel titles it from this. */
  readonly kind: DetailSectionKind
  /** Rows, for the table-shaped kinds. */
  fields?: DetailField[] | undefined
  /** The pre-write field, for `change`. */
  readonly before?: DetailField | undefined
  /** The post-write field, for `change`. */
  readonly after?: DetailField | undefined
  /** A note shown with the section (e.g. why a type is missing). */
  readonly note?: string | undefined
}

/** The enriched details persisted on one history record. */
export interface CallDetails {
  /** Schema version; `1` is the shape above. */
  readonly v: 1
  /** Sections in display order. */
  sections: DetailSection[]
  /** True when a budget forced part of the details out. */
  readonly truncated?: boolean | undefined
}

/**
 * The Details of a successful screenshot: one preview section whose field names
 * the PNG the card should render. The bytes are not embedded in the record —
 * the panel asks the host for them by record id, so history stays small while
 * the preview still shows the captured picture.
 *
 * @param input - the capture's target, path, size and optional dimensions.
 * @returns the Details view.
 */
export function buildScreenshotDetails(input: {
  readonly target: string
  readonly filePath: string
  readonly bytes: number
  readonly width?: number | undefined
  readonly height?: number | undefined
}): CallDetails {
  const dimensions = input.width !== undefined && input.height !== undefined
    ? `${input.width}×${input.height}, `
    : ''
  return {
    v: 1,
    sections: [{
      kind: 'screenshot',
      fields: [{ name: 'image', type: 'image/png', raw: input.filePath }],
      note: `${input.target}, ${dimensions}${input.bytes} bytes`,
    }],
  }
}

/** One batched call, as its nested card renders it. */
export interface BatchCallDetailsEntry {
  /** Zero-based position in the batch. */
  readonly index: number
  /** Full object path the call targeted. */
  readonly objectPath: string
  /** The UFunction name. */
  readonly functionName: string
  /** Whether this entry succeeded. */
  readonly ok: boolean
  /** The entry's call parameters as nested JSON text. */
  readonly parametersJson: string
  /** Nested-JSON return value (already bounded by the caller). */
  readonly returnValueJson: string
  /** Nested-JSON out parameters. */
  readonly outParametersJson: string
  /** Canonical return Type. */
  readonly returnType: string
  /** The Engine's failure text for a failed entry. */
  readonly errorMessage: string
}

/**
 * The Details of one batch call: per-call entries whose nested cards render the
 * same typed sections a single CallFunction card uses (display names, Types and
 * decoded values included).
 *
 * @param deps - reflection service, budget and cancellation.
 * @param entries - the per-call outcomes in request order.
 * @returns the Details view.
 */
export async function buildBatchCallDetails(
  deps: DetailsDeps,
  entries: readonly BatchCallDetailsEntry[],
): Promise<CallDetails> {
  const fields: DetailField[] = []
  for (const entry of entries) {
    const callFields = await buildCallFunctionDetails(deps, {
      objectPath: entry.objectPath,
      functionName: entry.functionName,
      parametersJson: entry.parametersJson,
      result: {
        returnValueJson: entry.returnValueJson,
        outParametersJson: entry.outParametersJson,
        returnType: entry.returnType,
      },
    })
    fields.push({
      name: `#${entry.index}`,
      type: 'call',
      value: {
        index: entry.index,
        objectPath: entry.objectPath,
        functionName: entry.functionName,
        ok: entry.ok,
        returnType: entry.returnType,
        errorMessage: entry.errorMessage,
        sections: callFields?.sections ?? [],
      } as unknown as JsonValue,
      ...(entry.ok ? {} : { note: entry.errorMessage }),
    })
  }
  return { v: 1, sections: [{ kind: 'calls', fields }] }
}
/** Hard limits that keep one record's details bounded. */
export const DETAIL_LIMITS = {
  /** Rows in one section. */
  maxFields: 64,
  /** Member types attached to one field. */
  maxMemberTypes: 32,
  /** Characters kept from one string value. */
  maxStringChars: 400,
  /** Array items kept from one value. */
  maxArrayItems: 32,
  /** Object keys kept from one value. */
  maxObjectKeys: 64,
  /** Recursion depth for value bounding. */
  maxDepth: 4,
  /** Enum entries kept for one value. */
  maxEnumEntries: 400,
} as const

/** What the builders need. */
export interface DetailsDeps {
  /** Cached reflection service for signatures and types. */
  readonly reflection: ReflectionService
  /** Character budget for one record's details. */
  readonly maxChars: number
  /** Caller cancellation, forwarded to reflection loads. */
  readonly signal?: AbortSignal | undefined
}

/** The call result fields the builder reads (the tool's canonical value). */
export interface CallFunctionResultLike {
  readonly returnValueJson?: string | undefined
  readonly outParametersJson?: string | undefined
  readonly returnType?: string | undefined
}

/**
 * Bound one decoded JSON value for storage in a record: depth, item counts and
 * string length limited, so a mesh's vertex array cannot bloat a record.
 *
 * @param value - the decoded value.
 * @param depth - internal recursion depth.
 * @returns a JSON value within the limits, or `undefined` for `undefined`.
 */
export function boundDetailValue(value: unknown, depth = 0): JsonValue | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'string') {
    return value.length <= DETAIL_LIMITS.maxStringChars
      ? value
      : `${value.slice(0, DETAIL_LIMITS.maxStringChars)}… (${value.length} chars)`
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (Array.isArray(value)) {
    if (depth >= DETAIL_LIMITS.maxDepth) return `[${value.length} items]`
    return value.slice(0, DETAIL_LIMITS.maxArrayItems).map(item => boundDetailValue(item, depth + 1) ?? null)
  }
  if (typeof value === 'object') {
    if (depth >= DETAIL_LIMITS.maxDepth) return '{…}'
    const record = value as Record<string, unknown>
    const keys = Object.keys(record).slice(0, DETAIL_LIMITS.maxObjectKeys)
    const bounded: Record<string, JsonValue> = {}
    for (const key of keys) {
      const member = boundDetailValue(record[key], depth + 1)
      if (member !== undefined) bounded[key] = member
    }
    return bounded
  }
  return String(value)
}

/** Parse one nested JSON-text payload, keeping the raw text on failure. */
function parsePayload(text: string | undefined): { value: JsonValue | undefined; raw: string | undefined } {
  const raw = (text ?? '').trim()
  if (raw === '') return { value: undefined, raw: undefined }
  try {
    return { value: boundDetailValue(JSON.parse(raw)), raw: undefined }
  } catch {
    return {
      value: undefined,
      raw: raw.length <= DETAIL_LIMITS.maxStringChars ? raw : `${raw.slice(0, DETAIL_LIMITS.maxStringChars)}…`,
    }
  }
}

/** The inner Type string of `struct(...)`, `enum(...)` or `foo(...)`; `undefined` for a scalar. */
export function innerTypeOf(type: string | undefined): { kind: string; inner: string } | undefined {
  if (type === undefined) return undefined
  const open = type.indexOf('(')
  if (open < 0 || !type.endsWith(')')) return undefined
  return { kind: type.slice(0, open), inner: type.slice(open + 1, -1) }
}

/** Index of the first top-level comma in a Type argument list, or -1 when there is none. */
function topLevelComma(inner: string): number {
  let depth = 0
  for (let index = 0; index < inner.length; index += 1) {
    const character = inner[index]
    if (character === '(') depth += 1
    else if (character === ')') depth -= 1
    else if (character === ',' && depth === 0) return index
  }
  return -1
}

/**
 * The innermost struct Type inside `array(...)`, `set(...)` or `map(...)` wrappers.
 *
 * A container's members are the element struct's fields, which is what lets a
 * return value like `array(struct(...))` label each expanded element's fields
 * with their member Type in the Details tree.
 *
 * @param type - a canonical Type string.
 * @returns the `struct(...)` Type, or `undefined` for a scalar or a non-struct container.
 */
export function structTypeOf(type: string | undefined): string | undefined {
  return structElementTypeOf(type)
}

function structElementTypeOf(type: string | undefined): string | undefined {
  if (type === undefined) return undefined
  const parsed = innerTypeOf(type)
  if (parsed === undefined) return undefined
  if (parsed.kind === 'struct') return type
  if (parsed.kind === 'array' || parsed.kind === 'set') return structElementTypeOf(parsed.inner.trim())
  if (parsed.kind === 'map') {
    const split = topLevelComma(parsed.inner)
    return split < 0 ? undefined : structElementTypeOf(parsed.inner.slice(split + 1).trim())
  }
  return undefined
}

/**
 * Describe one struct's members, recursing into struct-typed members so deeper
 * expansion keeps its Type labels (`Info → Entries[0] → Value`).
 *
 * @param deps - reflection service and cancellation.
 * @param structType - a canonical `struct(...)` Type.
 * @param depth - how many more member levels to describe.
 * @returns the members, bounded per level.
 */
async function describeMemberTypes(deps: DetailsDeps, structType: string): Promise<DetailMemberType[]> {
  const struct = await deps.reflection.structInfo(structType, deps.signal)
  return struct.value.members.slice(0, DETAIL_LIMITS.maxMemberTypes).map((member: { readonly name: string; readonly type: string; readonly displayNameText?: unknown }) => ({
    name: member.name,
    ...(member.type === '' ? {} : { type: member.type }),
    ...(member.displayNameText === undefined ? {} : { displayNameText: member.displayNameText as unknown as JsonValue }),
  }))
}

/**
 * Attach member types and, for enums, a display label.
 *
 * @param deps - reflection service and cancellation.
 * @param field - the field so far.
 * @returns the field with `members`/`enumLabel` when they resolved.
 */
async function describeField(deps: DetailsDeps, field: DetailField): Promise<DetailField> {
  const parsed = innerTypeOf(field.type)
  if (parsed === undefined) return field
  try {
    // A direct struct field and a container of structs both expose the element
    // struct's members, so expanded rows can show their member Type too.
    const structType = parsed.kind === 'struct' ? field.type : structElementTypeOf(field.type)
    if (structType !== undefined) {
      const members = await describeMemberTypes(deps, structType)
      return members.length === 0 ? field : { ...field, members }
    }
    if (parsed.kind === 'enum') {
      const numeric = typeof field.value === 'number'
        ? field.value
        : typeof field.value === 'string' && /^-?\d+$/.test(field.value)
          ? Number(field.value)
          : undefined
      if (numeric === undefined) return field
      const enumInfo = await deps.reflection.enumInfo(field.type ?? '', deps.signal)
      const entry = enumInfo.value.entries
        .slice(0, DETAIL_LIMITS.maxEnumEntries)
        .find(candidate => candidate.value === numeric)
      if (entry === undefined) return field
      return {
        ...field,
        enumLabel: entry.displayName === '' ? entry.name : `${entry.name} (${entry.displayName})`,
        ...(entry.displayNameRef === undefined ? {} : { enumLabelRef: entry.displayNameRef as unknown as JsonValue }),
        enumName: entry.name,
      }
    }
  } catch {
    // A shape that cannot be resolved leaves the field value-only; the record
    // must not depend on a second editor round trip succeeding.
  }
  return field
}


/**
 * Build one typed field.
 *
 * @param deps - reflection service and cancellation.
 * @param field - name, value and direction; the Type is optional.
 * @returns the field with bounding and best-effort labels applied.
 */
async function typedField(deps: DetailsDeps, field: DetailField): Promise<DetailField> {
  const bounded: DetailField = {
    ...field,
    ...(field.value === undefined ? {} : { value: boundDetailValue(field.value) }),
  }
  return await describeField(deps, bounded)
}

/**
 * Order the input fields of one call: the signature's parameters first (missing
 * ones marked as omitted), then any provided keys the signature did not know.
 *
 * @param provided - the parsed parameters object.
 * @param signature - the resolved function, when available.
 * @returns one field per input parameter.
 */
function inputFields(provided: Record<string, unknown>, signature: FunctionView | undefined): DetailField[] {
  const fields: DetailField[] = []
  const consumed = new Set<string>()
  for (const parameter of signature?.parameters ?? []) {
    if (parameter.direction === 'output') continue
    const has = Object.prototype.hasOwnProperty.call(provided, parameter.name)
    if (has) consumed.add(parameter.name)
    fields.push({
      name: parameter.name,
      ...(parameter.displayNameText === undefined ? {} : { displayNameText: parameter.displayNameText as unknown as JsonValue }),
      ...(parameter.type === '' ? {} : { type: parameter.type }),
      direction: parameter.direction,
      ...(has ? { value: provided[parameter.name] as JsonValue } : { omitted: true }),
    })
  }
  for (const [name, value] of Object.entries(provided)) {
    if (consumed.has(name)) continue
    fields.push({ name, direction: 'input', value: value as JsonValue })
  }
  return fields.slice(0, DETAIL_LIMITS.maxFields)
}

/**
 * Resolve the class Type of one object, for typing a call.
 *
 * Two sources, cheapest first:
 *
 * 1. Unreal's naming conventions — a class default object, a Blueprint class
 *    path, or an engine class object names its own class (no round trip).
 * 2. The cached `GetObjectClass` lookup — the only way a **level-instance**
 *    path (`/Game/Maps/X.X:PersistentLevel.Cube_1`) becomes typed.
 *
 * Both are best-effort: an editor/stand-in without `GetObjectClass` answers
 * with an error, and this returns `undefined` so the row degrades to
 * values-without-types rather than failing the call.
 *
 * @param deps - reflection service and cancellation.
 * @param objectPath - the object the call touched.
 * @returns the canonical `class(...)` Type, or `undefined`.
 */
export async function resolveClassType(deps: DetailsDeps, objectPath: string): Promise<string | undefined> {
  const derived = classTypeFromObjectPath(objectPath)
  if (derived !== undefined) return derived
  try {
    const lookup = await deps.reflection.objectClass(objectPath, deps.signal)
    const classType = lookup.value.classType.trim()
    return classType === '' ? undefined : classType
  } catch {
    return undefined
  }
}

/**
 * Build the Details for one `unreal_call_function` record.
 *
 * @param deps - reflection service, budget and cancellation.
 * @param input - the call's target, raw parameters text and its result (absent on failure).
 * @returns the details, or `undefined` when there is nothing worth persisting.
 */
export async function buildCallFunctionDetails(
  deps: DetailsDeps,
  input: {
    readonly objectPath: string
    readonly functionName: string
    readonly parametersJson: string
    readonly result?: CallFunctionResultLike | undefined
  },
): Promise<CallDetails | undefined> {
  const parsedParameters = parsePayload(input.parametersJson)
  const invalidParameters = parsedParameters.raw !== undefined
  const provided = parsedParameters.value !== null && typeof parsedParameters.value === 'object' && !Array.isArray(parsedParameters.value)
    ? parsedParameters.value as Record<string, unknown>
    : {}

  // The function signature comes from the object's class: derived from the
  // path when possible, resolved through cached GetObjectClass otherwise (a
  // level instance). Invalid parameter text needs no signature either.
  const classType = invalidParameters ? undefined : await resolveClassType(deps, input.objectPath)
  let signature: FunctionView | undefined
  if (classType !== undefined) {
    try {
      signature = (await deps.reflection.functionInfo(classType, input.functionName, deps.signal)).value.function
    } catch {
      signature = undefined
    }
  }

  const sections: DetailSection[] = []
  const inputs = inputFields(provided, signature)
  if (signature !== undefined && !signature.static && classType !== undefined) {
    inputs.unshift({
      name: 'Target',
      type: classType.replace(/^class\(/, 'object('),
      direction: 'input',
      value: input.objectPath,
    })
  }
  if (invalidParameters) {
    sections.push({
      kind: 'inputs',
      fields: [],
      note: 'The parameters were not valid JSON; the raw text is under Advanced.',
    })
  } else if (inputs.length > 0) {
    sections.push({ kind: 'inputs', fields: await Promise.all(inputs.map(field => typedField(deps, field))) })
  }

  if (input.result !== undefined) {
    const returnPayload = parsePayload(input.result.returnValueJson)
    const returnType = input.result.returnType !== undefined && input.result.returnType !== ''
      ? input.result.returnType
      : signature?.returnType ?? ''
    if (returnPayload.value !== undefined || returnPayload.raw !== undefined) {
      sections.push({
        kind: 'returns',
        fields: [await typedField(deps, {
          name: 'ReturnValue',
          direction: 'return',
          ...(returnType === '' ? {} : { type: returnType }),
          ...(returnPayload.value === undefined ? {} : { value: returnPayload.value }),
          ...(returnPayload.raw === undefined ? {} : { raw: returnPayload.raw }),
        })],
      })
    }

    const outPayload = parsePayload(input.result.outParametersJson)
    if (outPayload.value !== null && typeof outPayload.value === 'object' && !Array.isArray(outPayload.value)) {
      const outRecord = outPayload.value as Record<string, unknown>
      const outParameters = signature?.parameters.filter(parameter => parameter.direction !== 'input') ?? []
      const fields: DetailField[] = Object.entries(outRecord).map(([name, value]) => {
        const parameter = outParameters.find(candidate => candidate.name === name)
        return {
          name,
          direction: parameter?.direction ?? 'output',
          ...(parameter === undefined || parameter.type === '' ? {} : { type: parameter.type }),
          ...(parameter?.displayNameText === undefined ? {} : { displayNameText: parameter.displayNameText as unknown as JsonValue }),
          value: value as JsonValue,
        }
      })
      if (fields.length > 0) {
        sections.push({
          kind: 'outputs',
          fields: await Promise.all(fields.slice(0, DETAIL_LIMITS.maxFields).map(field => typedField(deps, field))),
        })
      }
    }
  }

  if (sections.length === 0) return undefined
  return boundDetails({ v: 1, sections }, deps.maxChars)
}

/**
 * Build the default Details for one tool call from the Remote Control requests it made.
 *
 * Most tools wrap exactly one reflected function; this turns the recorded request and
 * out parameters into the same Inputs/Outputs sections a `CallFunction` card shows —
 * including each parameter's reflected Type and DisplayNameText — without the tool
 * having to write a details builder of its own. A tool that made several calls has its
 * sections merged by kind.
 *
 * @param deps - reflection service, budget and cancellation.
 * @param calls - the RC requests the tool body made.
 * @returns the details, or `undefined` when none of the calls resolved a signature.
 */
export async function buildDefaultCallDetails(
  deps: DetailsDeps,
  calls: readonly RcCallSnapshot[],
): Promise<CallDetails | undefined> {
  const inputs: DetailField[] = []
  const outputs: DetailField[] = []
  const other: DetailSection[] = []
  let truncated = false
  for (const call of calls) {
    const details = await buildCallFunctionDetails(deps, {
      objectPath: call.objectPath,
      functionName: call.functionName,
      parametersJson: call.parametersJson,
      result: { returnValueJson: '', outParametersJson: call.outParametersJson, returnType: '' },
    })
    if (details === undefined) continue
    // A section dropped inside one call's budget stays dropped, but the card must
    // still say the Details are partial.
    if (details.truncated === true) truncated = true
    for (const section of details.sections) {
      if (section.kind === 'inputs') inputs.push(...(section.fields ?? []))
      else if (section.kind === 'outputs') outputs.push(...(section.fields ?? []))
      else other.push(section)
    }
  }
  const sections: DetailSection[] = []
  if (inputs.length > 0) sections.push({ kind: 'inputs', fields: inputs.slice(0, DETAIL_LIMITS.maxFields) })
  sections.push(...other)
  if (outputs.length > 0) sections.push({ kind: 'outputs', fields: outputs.slice(0, DETAIL_LIMITS.maxFields) })
  if (sections.length === 0) return undefined
  return boundDetails({ v: 1, sections, ...(truncated ? { truncated: true } : {}) }, deps.maxChars)
}

/**
 * Build a card's Details from the RC calls its tool body actually made.
 *
 * The shape follows the call count: one call renders as a normal single-call card
 * (that function's Inputs/Outputs/Returns); several calls render as the `calls`
 * list, one nested sub-card per call. No tool-specific shape is involved.
 *
 * @param deps - reflection service, budget and cancellation.
 * @param calls - the captured RC requests, in order.
 * @returns the Details, or `undefined` when the tool made no call.
 */
export async function buildRcCallDetails(
  deps: DetailsDeps,
  calls: readonly RcCallSnapshot[],
  options?: { readonly forceBatch?: boolean | undefined },
): Promise<CallDetails | undefined> {
  if (calls.length === 0) return undefined
  if (calls.length === 1 && options?.forceBatch !== true) {
    const call = calls[0]!
    return await buildCallFunctionDetails(deps, {
      objectPath: call.objectPath,
      functionName: call.functionName,
      parametersJson: call.parametersJson,
      result: {
        returnValueJson: call.returnValueJson ?? '',
        outParametersJson: call.outParametersJson,
        returnType: call.returnType ?? '',
      },
    })
  }
  const entries: BatchCallDetailsEntry[] = calls.map((call, index) => ({
    index,
    objectPath: call.objectPath,
    functionName: call.functionName,
    ok: call.errorMessage === undefined,
    parametersJson: call.parametersJson,
    returnValueJson: call.returnValueJson ?? '',
    outParametersJson: call.outParametersJson,
    returnType: call.returnType ?? '',
    errorMessage: call.errorMessage ?? '',
  }))
  return boundDetails(await buildBatchCallDetails(deps, entries), deps.maxChars)
}

/**
 * Combine a tool's own Details sections with the default ones derived from the RC
 * call the tool made.
 *
 * A bespoke builder usually contributes what only that tool knows (a screenshot
 * preview, a property's before/after); the reflected Inputs/Outputs are still the
 * card's primary data, so their sections are added when the tool did not build
 * one of the same kind. An existing section wins: a builder that already shaped
 * the call's inputs (e.g. `unreal_call_function`'s target signature) keeps them.
 *
 * @param custom - the tool's own Details, when it has a builder.
 * @param defaults - the reflected call Details, when the tool made an RC call.
 * @returns the merged Details, or whichever side exists.
 */
export function mergeCallDetails(
  custom: CallDetails | undefined,
  defaults: CallDetails | undefined,
): CallDetails | undefined {
  if (custom === undefined) return defaults
  if (defaults === undefined) return custom
  const kinds = new Set(custom.sections.map(section => section.kind))
  const inputs = defaults.sections.filter(section => section.kind === 'inputs')
  const outputs = defaults.sections.filter(section => section.kind === 'outputs')
  const rest = defaults.sections.filter(section => section.kind !== 'inputs' && section.kind !== 'outputs' && !kinds.has(section.kind))
  const sections: DetailSection[] = [
    ...(kinds.has('inputs') ? [] : inputs),
    ...custom.sections,
    ...(kinds.has('outputs') ? [] : outputs),
    // A builder with no sections of its own leaves room for every default section.
    ...(custom.sections.length === 0 ? rest : []),
  ]
  return {
    ...custom,
    sections,
    ...(defaults.truncated === true ? { truncated: true } : {}),
  }
}

/**
 * The target object of a property access, shown as the `Self` input.
 *
 * @param deps - reflection service, budget and cancellation.
 * @param objectPath - the object whose property is touched.
 * @returns one Inputs section carrying `Self`.
 */
async function selfSection(deps: DetailsDeps, objectPath: string): Promise<DetailSection> {
  const classType = await resolveClassType(deps, objectPath)
  const field = await typedField(deps, {
    name: 'Target',
    ...(classType === undefined ? {} : { type: classType.replace(/^class\(/, 'object(') }),
    direction: 'input',
    value: objectPath,
  })
  return { kind: 'inputs', fields: [field] }
}

/**
 * Build the Details for one `unreal_get_property_value` record.
 *
 * @param deps - reflection service, budget and cancellation.
 * @param input - the read's object path, property path and raw `ValueJson`.
 * @returns the details, or `undefined` when the value did not parse.
 */
export async function buildPropertyValueDetails(
  deps: DetailsDeps,
  input: { readonly objectPath: string; readonly propertyPath: string; readonly valueJson: string },
): Promise<CallDetails | undefined> {
  const payload = parsePayload(input.valueJson)
  const resolved = await resolvePropertyType(deps, input.objectPath, input.propertyPath)
  const type = resolved?.type
  const field = await typedField(deps, {
    name: input.propertyPath,
    ...(resolved?.displayNameText === undefined ? {} : { displayNameText: resolved.displayNameText as unknown as JsonValue }),
    ...(type === undefined ? {} : { type }),
    ...(payload.value === undefined ? {} : { value: payload.value }),
    ...(payload.raw === undefined ? {} : { raw: payload.raw }),
  })
  const section: DetailSection = { kind: 'value', fields: [field] }
  return boundDetails({ v: 1, sections: [await selfSection(deps, input.objectPath), section] }, deps.maxChars)
}

/**
 * Build the Details for one `unreal_set_property_value` record.
 *
 * @param deps - reflection service, budget and cancellation.
 * @param input - the write's object path, property path and both side snapshots.
 * @returns the details, or `undefined` when neither side parsed.
 */
export async function buildPropertyWriteDetails(
  deps: DetailsDeps,
  input: {
    readonly objectPath: string
    readonly propertyPath: string
    readonly oldValueJson: string
    readonly newValueJson: string
  },
): Promise<CallDetails | undefined> {
  const oldPayload = parsePayload(input.oldValueJson)
  const newPayload = parsePayload(input.newValueJson)
  const resolved = await resolvePropertyType(deps, input.objectPath, input.propertyPath)
  const type = resolved?.type
  if (type === undefined && resolved?.displayNameText === undefined && oldPayload.value === undefined && newPayload.value === undefined) return undefined
  const before = await typedField(deps, {
    name: 'before',
    ...(resolved?.displayNameText === undefined ? {} : { displayNameText: resolved.displayNameText as unknown as JsonValue }),
    ...(type === undefined ? {} : { type }),
    ...(oldPayload.value === undefined ? {} : { value: oldPayload.value }),
    ...(oldPayload.raw === undefined ? {} : { raw: oldPayload.raw }),
  })
  const after = await typedField(deps, {
    name: 'after',
    ...(resolved?.displayNameText === undefined ? {} : { displayNameText: resolved.displayNameText as unknown as JsonValue }),
    ...(type === undefined ? {} : { type }),
    ...(newPayload.value === undefined ? {} : { value: newPayload.value }),
    ...(newPayload.raw === undefined ? {} : { raw: newPayload.raw }),
  })
  return boundDetails(
    { v: 1, sections: [await selfSection(deps, input.objectPath), { kind: 'change', before, after }] },
    deps.maxChars,
  )
}

/**
 * Resolve one property's Type, best-effort.
 *
 * @param deps - reflection service and cancellation.
 * @param objectPath - the object whose property was touched.
 * @param propertyPath - the dotted property path.
 * @returns the canonical Type, or `undefined` when it cannot be resolved.
 */
async function resolvePropertyType(
  deps: DetailsDeps,
  objectPath: string,
  propertyPath: string,
): Promise<import('./kit/reflection.ts').PropertyTypeView | undefined> {
  const classType = await resolveClassType(deps, objectPath)
  if (classType === undefined) return undefined
  try {
    const resolved = await deps.reflection.propertyType(classType, propertyPath, deps.signal)
    return resolved.value.type === '' && resolved.value.displayNameText === undefined ? undefined : resolved.value
  } catch {
    return undefined
  }
}

/**
 * Shrink a Details structure until its serialized form fits the budget.
 *
 * The tail sections go first (outputs, then returns), then member-type labels;
 * a structure that still does not fit is returned empty and marked truncated.
 *
 * @param details - the details to bound.
 * @param maxChars - serialized-character budget.
 * @returns the bounded details.
 */
export function boundDetails(details: CallDetails, maxChars: number): CallDetails {
  const size = (candidate: CallDetails): number => {
    try {
      return JSON.stringify(candidate).length
    } catch {
      return Number.POSITIVE_INFINITY
    }
  }
  if (size(details) <= maxChars) return details

  // Stage 1: drop member labels (the tree still renders, just without types).
  const withoutMembers: CallDetails = {
    v: 1,
    sections: details.sections.map(section => ({
      ...section,
      ...(section.fields === undefined
        ? {}
        : { fields: section.fields.map(field => stripMembers(field)) }),
      ...(section.before === undefined ? {} : { before: stripMembers(section.before) }),
      ...(section.after === undefined ? {} : { after: stripMembers(section.after) }),
    })),
  }
  if (size(withoutMembers) <= maxChars) return withoutMembers

  // Stage 2: drop sections from the tail until it fits.
  const sections = [...withoutMembers.sections]
  while (sections.length > 1 && size({ v: 1, sections, truncated: true }) > maxChars) sections.pop()
  if (size({ v: 1, sections, truncated: true }) <= maxChars) {
    return { v: 1, sections, truncated: true }
  }

  // Stage 3: one section, then fields from its tail, and finally nothing.
  const last: DetailSection[] = sections.slice(0, 1)
  for (;;) {
    const candidate: CallDetails = { v: 1, sections: last, truncated: true }
    if (size(candidate) <= maxChars) return candidate
    const first = last[0]
    const fields = first?.fields
    if (first === undefined || fields === undefined || fields.length <= 1) {
      return { v: 1, sections: [], truncated: true }
    }
    last[0] = { ...first, fields: fields.slice(0, -1) }
  }
}

/** Remove one field's member labels and any oversized raw text. */
function stripMembers(field: DetailField): DetailField {
  const { members: _members, ...rest } = field
  return rest
}

