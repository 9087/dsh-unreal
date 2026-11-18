/**
 * Cached reflection lookups: the one place this plugin asks EditorAutomation to
 * describe its own shape.
 *
 * Each method maps the Engine's result struct once on load and then serves the
 * mapped view from {@link SchemaCache}. The tools and the record-enrichment
 * layer both go through this service, so a `GetFunctionInfo` a tool answered a
 * moment ago is reused when the call it produced is enriched — and a burst of
 * calls in one model step costs one round trip per distinct key.
 *
 * **Editor errors are not cached.** A miss that fails (a bad Type, an editor
 * that went away) rejects and stores nothing, so a transient failure is retried
 * instead of being remembered. A **transport** failure additionally clears the
 * cache: the editor may have restarted with a different plugin build, and every
 * stored shape is then a guess about a process that no longer exists.
 *
 * @module dsh-unreal/kit/reflection
 */

import type { EditorAutomationClient } from './client.ts'
import { captureRcCall } from '../audit-capture.ts'
import { KitError, isKitError } from './errors.ts'
import { EDITOR_AUTOMATION_LIBRARIES, parameterDirectionName } from './types.ts'
import type { CacheLookup, SchemaCache } from '../schema-cache.ts'

/** One FText identity, as the panel resolves it. */
export interface TextRefView {
  readonly namespace: string
  readonly key: string
  readonly sourceString: string
  readonly sourceHash: number
  readonly tableId: string
  readonly nativeText: string
}

/** One enum entry, as the history/panel layer reads it. */
export interface EnumEntryView {
  /** Canonical C++ name. */
  readonly name: string
  /** Editor display name. */
  readonly displayName: string
  /** Full FText identity. */
  readonly displayNameRef?: TextRefView | undefined
  /** Numeric value. */
  readonly value: number
}

/** A described enum. */
export interface EnumInfoView {
  /** The resolved enum object path. */
  readonly path: string
  /** Every entry, in the Engine's order. */
  readonly entries: readonly EnumEntryView[]
}

/** One member, as the panel reads it. */
export interface MemberView {
  /** Member name (C++ name). */
  readonly name: string
  /** Full FText identity. */
  readonly displayName?: TextRefView | undefined
  /** Canonical Type string; empty when the Engine did not report one. */
  readonly type: string
  /** UE display name of the property. */
  readonly displayNameText?: TextRefView | undefined
}

/** A described struct. */
export interface StructInfoView {
  /** The resolved struct path. */
  readonly path: string
  /** Every member. */
  readonly members: readonly MemberView[]
}

/** One function parameter, with the direction resolved to a name. */
export interface ParameterView {
  /** Parameter name. */
  readonly name: string
  /** UE display name of the parameter. */
  readonly displayNameText?: TextRefView | undefined
  /** Canonical Type string. */
  readonly type: string
  /** `input`, `output` or `input-output`. */
  readonly direction: string
}

/** A described function. */
export interface FunctionView {
  /** UFunction name. */
  readonly name: string
  /** Full FText identity. */
  readonly displayName?: TextRefView | undefined
  /** Whether it is BlueprintCallable. */
  readonly blueprintCallable: boolean
  /** Whether it is BlueprintPure. */
  readonly blueprintPure: boolean
  /** Whether it is static. */
  readonly static: boolean
  /** Parameters in declaration order. */
  readonly parameters: readonly ParameterView[]
  /** Canonical return Type; empty when it returns nothing. */
  readonly returnType: string
  /** Editor tooltip of the function; empty when it has none. */
  readonly tooltip: string
}

/** A described class. */
export interface ClassInfoView {
  /** The resolved class path. */
  readonly path: string
  /** Every property. */
  readonly properties: readonly MemberView[]
  /** Every BlueprintCallable function. */
  readonly functions: readonly FunctionView[]
}

/** The one-liner `GetFunctionInfo` answers. */
export interface FunctionInfoView {
  /** The function's path (its name when the Engine reported one). */
  readonly path: string
  /** The function itself. */
  readonly function: FunctionView
}

/** A resolved property Type. */
export interface PropertyTypeView {
  /** Canonical Type string. */
  readonly type: string
  /** UE display name of the property. */
  readonly displayNameText?: TextRefView | undefined
}

/** The class of one live object. */
export interface ObjectClassView {
  /** Canonical `class(...)` Type; empty when the Engine answered none. */
  readonly classType: string
}

/** Identity of the editor process that answered. */
export interface EditorInfoView {
  /** OS process id, normalized to a number; absent when the Engine sent none. */
  readonly processId?: number | undefined
  /** Engine version, e.g. `5.5.4`. */
  readonly engineVersion?: string | undefined
  /** Project name (the `.uproject` base name). */
  readonly projectName?: string | undefined
  /** Absolute project directory. */
  readonly projectDir?: string | undefined
  /** Whether the answering process is an editor. */
  readonly isEditor?: boolean | undefined
}

/**
 * Normalize a wire `ProcessId` to a number.
 *
 * Remote Control's `FJsonObjectConverter` serializes an `int64` as a JSON
 * number, but a hand-written or re-serialized payload can carry a decimal
 * string; both are accepted, and anything else degrades to “no PID” rather than
 * a NaN in the card.
 *
 * @param value - the raw `ProcessId` member.
 * @returns a positive integer, or `undefined`.
 */
export function normalizeProcessId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const pid = Math.trunc(value)
    return pid > 0 ? pid : undefined
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!/^\d+$/.test(trimmed)) return undefined
    const pid = Number(trimmed)
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined
  }
  return undefined
}

/** Cache keys. One namespace per EditorAutomation operation, then its arguments. */
export const cacheKey = {
  /** Key for `GetEnumInfo`. */
  enum: (type: string) => `GetEnumInfo|${type}`,
  /** Key for `GetStructInfo`. */
  struct: (type: string) => `GetStructInfo|${type}`,
  /** Key for `GetClassInfo`. */
  class: (type: string) => `GetClassInfo|${type}`,
  /** Key for `GetFunctionInfo`. */
  function: (type: string, functionName: string) => `GetFunctionInfo|${type}|${functionName}`,
  /** Key for `GetPropertyType`. */
  propertyType: (type: string, propertyPath: string) => `GetPropertyType|${type}|${propertyPath}`,
  /** Key for `GetObjectClass`. */
  objectClass: (objectPath: string) => `GetObjectClass|${objectPath}`,
} as const

/** Dependencies of the reflection service. */
export interface ReflectionServiceDeps {
  /** HTTP client for one editor. */
  readonly client: EditorAutomationClient
  /** The shared schema cache. */
  readonly cache: SchemaCache
  /** Optional debug sink, so hit/miss is visible without a test hook. */
  readonly log?: ((line: string) => void) | undefined
}

/** Raise a tool error for an empty result; the Engine logged the reason (readable through GetRecentLog). */
function emptyResult(functionName: string, target: string): never {
  throw new KitError(`editorautomation/${functionName}Failed`, `${functionName} returned nothing for ${target}.`, {
    functionName,
    hint: 'Call unreal_get_recent_log for the engine log reason.',
  })
}

/** Map one nested-JSON FText reference into the panel view. */
function mapTextRefPayload(payload: unknown): TextRefView | undefined {
  const namespace = structString(payload, 'Namespace')
  const key = structString(payload, 'Key')
  const nativeText = structString(payload, 'NativeText')
  if (namespace === '' && key === '' && nativeText === '') return undefined
  const sourceHash = structNumber(payload, 'SourceHash') ?? 0
  return {
    namespace,
    key,
    sourceString: structString(payload, 'SourceString'),
    sourceHash,
    tableId: structString(payload, 'TableId'),
    nativeText,
  }
}

/** Read one member of a nested-JSON struct payload. */
function structField(payload: unknown, key: string): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  return (payload as Record<string, unknown>)[key]
}

/** Read a string member of a nested-JSON struct payload. */
function structString(payload: unknown, key: string, fallback = ''): string {
  const value = structField(payload, key)
  return typeof value === 'string' ? value : fallback
}

/** Read a boolean member of a nested-JSON struct payload (scalars arrive as strings). */
function structBool(payload: unknown, key: string): boolean {
  const value = structField(payload, key)
  return value === true || value === 'true'
}

/** Read a numeric member of a nested-JSON struct payload (scalars arrive as strings). */
function structNumber(payload: unknown, key: string): number | undefined {
  const value = structField(payload, key)
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Read an array member of a nested-JSON struct payload. */
function structArray(payload: unknown, key: string): unknown[] {
  const value = structField(payload, key)
  return Array.isArray(value) ? value : []
}

/** Map the Engine's function payload into the canonical view. */
function mapFunctionPayload(payload: unknown): FunctionView {
  return {
    name: structString(payload, 'Name'),
    blueprintCallable: structBool(payload, 'bBlueprintCallable'),
    blueprintPure: structBool(payload, 'bBlueprintPure'),
    static: structBool(payload, 'bStatic'),
    parameters: structArray(payload, 'Parameters').map(parameter => ({
      name: structString(parameter, 'Name'),
      ...(mapTextRefPayload(structField(parameter, 'DisplayNameText')) === undefined
        ? {}
        : { displayNameText: mapTextRefPayload(structField(parameter, 'DisplayNameText')) }),
      type: structString(parameter, 'Type'),
      direction: parameterDirectionName(structNumber(parameter, 'Direction') ?? 0),
    })),
    returnType: structString(payload, 'ReturnType'),
    tooltip: structString(payload, 'ToolTip'),
  }
}

/** Map one property row of a nested-JSON struct payload into the canonical view. */
function mapPropertyPayload(property: unknown): MemberView {
  const displayNameText = mapTextRefPayload(structField(property, 'DisplayNameText'))
  return {
    name: structString(property, 'Name'),
    type: structString(property, 'Type'),
    ...(displayNameText === undefined ? {} : { displayNameText }),
  }
}

/**
 * Cached reflection lookups for one editor.
 *
 * Stateless apart from the cache and client; one instance serves every tool
 * call and the enrichment of every record.
 */
/** Read one operation's data out of its FEditorAutomationResult envelope; throws on failure. */
function invokeOut(
  result: { readonly payload: unknown; readonly outParameters: unknown },
  functionName: string,
  outParameterName: string,
): unknown {
  const envelope = result.payload
  if (envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope)) {
    const record = envelope as Record<string, unknown>
    const successValue = record['bSuccess']
    const success = successValue === true || successValue === 'true'
    if (successValue !== undefined && !success) {
      const message = typeof record['ErrorMessage'] === 'string' ? record['ErrorMessage'] : ''
      const hint = typeof record['Hint'] === 'string' ? record['Hint'] : ''
      throw new KitError(
        `editorautomation/${functionName}Failed`,
        message === '' ? `${functionName} failed.` : message,
        { functionName, ...(hint === '' ? {} : { hint }) },
      )
    }
  }
  const outParameters = result.outParameters
  if (outParameters !== null && typeof outParameters === 'object' && !Array.isArray(outParameters)) {
    return (outParameters as Record<string, unknown>)[outParameterName] ?? null
  }
  return result.payload
}
export class ReflectionService {
  private readonly client: EditorAutomationClient

  private readonly cache: SchemaCache

  private readonly log: ((line: string) => void) | undefined

  /**
   * @param deps - client, cache and optional log sink.
   */
  constructor(deps: ReflectionServiceDeps) {
    this.client = deps.client
    this.cache = deps.cache
    this.log = deps.log  }

  /**
   * Invoke one RC function and record the request for the tool card's default Details.
   *
   * Reflection lookups made inside a tool body are the actual RC calls that tool made,
   * so they must appear as that record's Inputs/Outputs; lookups outside a tool call
   * (panel polling, record enrichment) record nothing.
   *
   * @param library - library class default object path.
   * @param functionName - UFunction name.
   * @param parameters - the request parameters.
   * @param signal - caller cancellation.
   * @returns the parsed invoke result.
   */
  private async invokeRecorded(
    library: string,
    functionName: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Awaited<ReturnType<EditorAutomationClient['invoke']>>> {
    const result = await this.client.invoke(library, functionName, parameters, signal)
    captureRcCall({
      objectPath: library,
      functionName,
      parametersJson: JSON.stringify(parameters),
      outParametersJson: result.outParametersJson,
      returnValueJson: result.raw,
      returnType: result.returnType,
    })
    return result
  }

  /** Resolve display-name keys for one culture through the plugin's localization API. */
  async localizedTexts(keys: readonly string[], culture: string, signal?: AbortSignal): Promise<readonly string[]> {
    if (keys.length === 0 || culture === '') return keys.map(() => '')
    try {
      const returned = await this.client.call('GetLocalizedTexts', { Keys: keys, Culture: culture }, signal)
      if (!Array.isArray(returned) || returned.length !== keys.length) return keys.map(() => '')
      return returned.map(value => typeof value === 'string' ? value : '')
    } catch {
      return keys.map(() => '')
    }
  }

  /** The cache's counters, for diagnostics and tests. */
  stats(): ReturnType<SchemaCache['stats']> {    return this.cache.stats()
  }

  /**
   * Drop every cached shape. The explicit invalidation path; transport errors
   * call it too (see {@link callThroughCache}).
   *
   * @returns how many entries were held.
   */
  invalidate(): number {
    return this.cache.clear()
  }

  /**
   * Describe one enum through the cache.
   *
   * @param type - canonical enum Type.
   * @param signal - caller cancellation.
   * @returns the view and where it came from.
   */
  async enumInfo(type: string, signal?: AbortSignal): Promise<CacheLookup<EnumInfoView>> {
    return await this.callThroughCache(cacheKey.enum(type), cacheKey.enum(type), async () => {
      const invokeResult = await this.invokeRecorded(EDITOR_AUTOMATION_LIBRARIES.core, 'GetEnumInfo', { Type: type }, signal)
      const payload = invokeOut(invokeResult, 'GetEnumInfo', 'OutInfo')
      const enumPath = structString(payload, 'Enum')
      if (enumPath === '') emptyResult('GetEnumInfo', type)
      return {
        path: enumPath,
        entries: structArray(payload, 'Entries').map(entry => ({
          name: structString(entry, 'Name'),
          displayName: structString(entry, 'DisplayName'),
          value: structNumber(entry, 'Value') ?? 0,
        })),
      } satisfies EnumInfoView
    })
  }

  /**
   * Describe one struct through the cache.
   *
   * @param type - canonical struct Type.
   * @param signal - caller cancellation.
   * @returns the view and where it came from.
   */
  async structInfo(type: string, signal?: AbortSignal): Promise<CacheLookup<StructInfoView>> {
    return await this.callThroughCache(cacheKey.struct(type), cacheKey.struct(type), async () => {
      const invokeResult = await this.invokeRecorded(EDITOR_AUTOMATION_LIBRARIES.core, 'GetStructInfo', { Type: type }, signal)
      const payload = invokeOut(invokeResult, 'GetStructInfo', 'OutInfo')
      const structPath = structString(payload, 'Struct')
      if (structPath === '') emptyResult('GetStructInfo', type)
      return {
        path: structPath,
        members: structArray(payload, 'Properties').map(mapPropertyPayload),
      } satisfies StructInfoView
    })
  }

  /**
   * Describe one class through the cache.
   *
   * @param type - canonical class/object Type.
   * @param signal - caller cancellation.
   * @returns the view and where it came from.
   */
  async classInfo(type: string, signal?: AbortSignal): Promise<CacheLookup<ClassInfoView>> {
    return await this.callThroughCache(cacheKey.class(type), cacheKey.class(type), async () => {
      const invokeResult = await this.invokeRecorded(EDITOR_AUTOMATION_LIBRARIES.core, 'GetClassInfo', { Type: type }, signal)
      const payload = invokeOut(invokeResult, 'GetClassInfo', 'OutInfo')
      const classPath = structString(payload, 'Class')
      if (classPath === '') emptyResult('GetClassInfo', type)
      return {
        path: classPath,
        properties: structArray(payload, 'Properties').map(mapPropertyPayload),
        functions: structArray(payload, 'Functions').map(mapFunctionPayload),
      } satisfies ClassInfoView
    })
  }

  /**
   * Describe one function of a class through the cache.
   *
   * @param type - canonical class/object Type.
   * @param functionName - UFunction name.
   * @param signal - caller cancellation.
   * @returns the view and where it came from.
   */
  async functionInfo(type: string, functionName: string, signal?: AbortSignal): Promise<CacheLookup<FunctionInfoView>> {
    return await this.callThroughCache(
      cacheKey.function(type, functionName),
      cacheKey.function(type, functionName),
      async () => {
        const invokeResult = await this.invokeRecorded(
          EDITOR_AUTOMATION_LIBRARIES.core,
          'GetFunctionInfo',
          { Type: type, FunctionName: functionName },
          signal,
        )
        const payload = invokeOut(invokeResult, 'GetFunctionInfo', 'OutInfo')
        if (structString(payload, 'Name') === '') emptyResult('GetFunctionInfo', `${type}.${functionName}`)
        return {
          path: structString(payload, 'Name'),
          function: mapFunctionPayload(payload),
        } satisfies FunctionInfoView
      },
    )
  }

  /**
   * Resolve one property's canonical Type through the cache.
   *
   * @param type - canonical class/object Type.
   * @param propertyPath - dotted property path.
   * @param signal - caller cancellation.
   * @returns the view and where it came from.
   */
  async propertyType(type: string, propertyPath: string, signal?: AbortSignal): Promise<CacheLookup<PropertyTypeView>> {
    return await this.callThroughCache(
      cacheKey.propertyType(type, propertyPath),
      cacheKey.propertyType(type, propertyPath),
      async () => {
        const invokeResult = await this.invokeRecorded(
          EDITOR_AUTOMATION_LIBRARIES.core,
          'GetPropertyType',
          { Type: type, PropertyPath: propertyPath },
          signal,
        )
        const payload = invokeOut(invokeResult, 'GetPropertyType', 'OutInfo')
        if (typeof payload !== 'string' || payload === '') {
          // Newer builds return { Type, DisplayNameText }; a bare string is the older shape.
          const propertyType = typeof payload === 'string' ? payload : structString(payload, 'Type')
          if (propertyType === '') emptyResult('GetPropertyType', `${type}.${propertyPath}`)
          const displayNameText = typeof payload === 'string'
            ? undefined
            : mapTextRefPayload(structField(payload, 'DisplayNameText'))
          return {
            type: propertyType,
            ...(displayNameText === undefined ? {} : { displayNameText }),
          } satisfies PropertyTypeView
        }
        return { type: payload } satisfies PropertyTypeView
      },
    )
  }

  /**
   * Resolve the class of one live object through the cache.
   *
   * This is the entry point that types a **level-instance** path: the object's
   * name does not identify its class, so the panel/enrichment layer cannot
   * derive it. An Engine/stand-in build without `GetObjectClass` answers with
   * an error and this rejects; callers treat that as "no class known".
   *
   * @param objectPath - full object path.
   * @param signal - caller cancellation.
   * @returns the canonical class Type and where it came from.
   */
  async objectClass(objectPath: string, signal?: AbortSignal): Promise<CacheLookup<ObjectClassView>> {
    return await this.callThroughCache(
      cacheKey.objectClass(objectPath),
      cacheKey.objectClass(objectPath),
      async () => {
        const invokeResult = await this.invokeRecorded(EDITOR_AUTOMATION_LIBRARIES.core, 'GetObjectClass', { ObjectPath: objectPath }, signal)
        const payload = invokeOut(invokeResult, 'GetObjectClass', 'OutClassType')
        if (typeof payload !== 'string' || payload === '') emptyResult('GetObjectClass', objectPath)
        return { classType: payload } satisfies ObjectClassView
      },
    )
  }

  /**
   * Describe the editor process: PID, engine version, project.
   *
   * Deliberately **not cached**: it is two cheap scalar reads, and the whole
   * point of the PID is to name the process that answered *now* — a cached PID
   * across an editor restart would be exactly the stale identity this exists to
   * avoid.
   *
   * @param signal - caller cancellation.
   * @returns the normalized identity view.
   * @throws {KitError} an EditorAutomation error or a classified transport failure.
   */
  async getEditorInfo(signal?: AbortSignal): Promise<EditorInfoView> {
    const invokeResult = await this.invokeRecorded(EDITOR_AUTOMATION_LIBRARIES.core, 'GetEditorInfo', {}, signal)
    const payload = invokeOut(invokeResult, 'GetEditorInfo', 'OutInfo')
    const processId = normalizeProcessId(structField(payload, 'ProcessId'))
    const engineVersion = structString(payload, 'EngineVersion')
    const projectName = structString(payload, 'ProjectName')
    const projectDir = structString(payload, 'ProjectDir')
    return {
      ...(processId === undefined ? {} : { processId }),
      ...(engineVersion.trim() === '' ? {} : { engineVersion: engineVersion.trim() }),
      ...(projectName.trim() === '' ? {} : { projectName: projectName.trim() }),
      ...(projectDir.trim() === '' ? {} : { projectDir: projectDir.trim() }),
      ...(structField(payload, 'bIsEditor') === undefined ? {} : { isEditor: structBool(payload, 'bIsEditor') }),
    }
  }

  /**
   * Load one key through the cache, with the transport-error invalidation rule.
   *
   * @param key - cache key.
   * @param label - the key, for the debug line.
   * @param load - the miss path.
   * @returns the view and where it came from.
   */
  private async callThroughCache<T>(
    key: string,
    label: string,
    load: () => Promise<T>,
  ): Promise<CacheLookup<T>> {
    try {
      const lookup = await this.cache.getOrLoad(key, load)
      this.log?.(
        `dsh-unreal: reflection ${lookup.source} ${label}` +
        `${lookup.cached ? ` (age ${lookup.ageMs}ms)` : ''}`,
      )
      return lookup
    } catch (error: unknown) {
      // A transport failure means the editor may be a different process now
      // (restarted, rebuilt); every cached shape is suspect.
      if (isKitError(error) && isTransportFailure(error)) {
        const dropped = this.cache.clear()
        this.log?.(`dsh-unreal: reflection cleared ${dropped} entries after ${error.code}`)
      }
      throw error
    }
  }
}

/**
 * Whether a failure says the editor itself is gone, rather than that the call
 * was answered with an error.
 *
 * @param error - the classified failure.
 * @returns true for the transport codes that invalidate cached shapes.
 */
export function isTransportFailure(error: KitError): boolean {
  return error.code === 'rc/unreachable'
    || error.code === 'rc/timeout'
    || error.code === 'rc/cancelled'
    || error.code === 'rc/unauthorized'
    || error.code === 'rc/server-error'
}
