/**
 * The browser's view of the host's call-history channel.
 *
 * Everything here is declared locally rather than imported from a client
 * package: the plugin ships host and client halves as one package, and the
 * record shapes mirror `src/records.ts` (the source of truth) field for field.
 *
 * The wire is untrusted: every field is checked before it is rendered and
 * malformed records are dropped rather than thrown on. Defaults are chosen so a
 * payload missing a field degrades to something readable instead of blanking
 * the panel.
 *
 * @module dsh-unreal/client/wire
 */

/** Channel the host half mounts and this half calls. Mirrors `src/rpc.ts`. */
export const UNREAL_CHANNEL = '/dsh-unreal'

/**
 * The one host call this half makes, structurally.
 *
 * Typed as returning `unknown` on purpose: the caller is
 * `connection.rpc`, which is untyped at this seam anyway, and narrowing the
 * reply here is what keeps a version drift from becoming a blank panel.
 */
export interface RpcCaller {
  /** Call one endpoint on the plugin's channel. */
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
}

/** One session's share of the history, as the panel's header shows it. */
export interface SessionGroupView {
  /** The session id. */
  readonly sessionId: string
  /** Records recorded for that session. */
  readonly count: number
  /** Epoch milliseconds of the newest record in the group. */
  readonly lastTime: number
}

/** One named member type, for the Details tree's field labels. */
export interface DetailMemberTypeView {
  /** Member name. */
  readonly name: string
  /** Canonical Type string, when known. */
  readonly type?: string | undefined
  /** UE display name text for this member, when the schema reported one. */
  readonly displayNameText?: unknown
  /** Nested members of a struct-typed member, for deeper expansion. */
  readonly members?: readonly DetailMemberTypeView[] | undefined
}

/** One row of an enriched Details section. */
export interface DetailFieldView {
  /** Field name: a parameter name, a property path, `ReturnValue`, … */
  readonly name: string
  /** Full FText identity for a localized label. */
  readonly displayName?: unknown
  /** UE display name text for this label. */
  readonly displayNameText?: unknown
  /** Canonical Type string, when the schema was resolvable. */
  readonly type?: string | undefined
  /** `input`, `output`, `input-output` or `return`. */
  readonly direction?: string | undefined
  /** The value in the Engine's decoded JSON form. */
  readonly value?: unknown
  /** A display label for an enum's numeric value. */
  readonly enumLabel?: string | undefined
  /** Full FText identity for the enum display name. */
  readonly enumLabelRef?: unknown
  /** The enum entry's code name. */
  readonly enumName?: string | undefined
  /** Raw JSON text when the value did not parse. */
  readonly raw?: string | undefined
  /** Immediate member types, so the tree can label nested fields. */
  readonly members?: readonly DetailMemberTypeView[] | undefined
  /** True when the parameter was omitted and the Engine default applies. */
  readonly omitted?: boolean | undefined
  /** A short human note about the field. */
  readonly note?: string | undefined
}

/** One section of an enriched Details view. */
export interface DetailSectionView {
  /** What the section shows. */
  readonly kind: string
  /** Rows, for the table-shaped kinds. */
  readonly fields?: readonly DetailFieldView[] | undefined
  /** The pre-write field, for `change`. */
  readonly before?: DetailFieldView | undefined
  /** The post-write field, for `change`. */
  readonly after?: DetailFieldView | undefined
  /** A note shown with the section. */
  readonly note?: string | undefined
}

/** The enriched Details persisted on one record. */
export interface DetailView {
  /** Schema version. */
  readonly v: number
  /** Sections in display order. */
  readonly sections: readonly DetailSectionView[]
  /** True when a budget forced part of the details out. */
  readonly truncated?: boolean | undefined
}

/** One recorded call, as the panel renders it. */
/** The primary Remote Control call one record wraps, as the Raw data view shows it. */
export interface RcCallView {
  /** Library class default object the call targeted. */
  readonly objectPath: string
  /** UFunction name. */
  readonly functionName: string
  /** The request parameters, as nested-JSON text. */
  readonly parametersJson: string
  /** The out parameters, as nested-JSON text. */
  readonly outParametersJson: string
  /** The return value, as nested-JSON text. */
  readonly returnValueJson?: string | undefined
  /** Canonical return Type. */
  readonly returnType?: string | undefined
  /** The Engine's failure text, when this logical call failed. */
  readonly errorMessage?: string | undefined
}

export interface OperationView {
  /** Stable record id. */
  readonly id: string
  /** Epoch milliseconds the call completed. */
  readonly time: number
  /** DSH session the call belonged to. */
  readonly sessionId?: string | undefined
  /** Tool-call id, the correlation key back to the session log. */
  readonly callId?: string | undefined
  /** Wire tool name. */
  readonly tool: string
  /** Whether the call succeeded. */
  readonly ok: boolean
  /** Record schema generation; absent on rows written before typed Details. */
  readonly recordVersion?: number | undefined
  /** Classified failure code, when `ok` is false. */
  readonly errorCode?: string | undefined
  /** Engine/transport failure text. */
  readonly errorMessage?: string | undefined
  /** Engine remediation hint. */
  readonly errorHint?: string | undefined
  /** Wall-clock duration measured by the tool wrapper. */
  readonly durationMs?: number | undefined
  /** Reflection Type string (`class(...)`, `struct(...)`, `enum(...)`). */
  readonly targetType?: string | undefined
  /** Object the call targeted. */
  readonly objectPath?: string | undefined
  /** Property path the call read or wrote. */
  readonly propertyPath?: string | undefined
  /** Function the call invoked. */
  readonly functionName?: string | undefined
  /** Canonical Type string of a property, when resolved. */
  readonly propertyType?: string | undefined
  /** The tool arguments, bounded. */
  readonly params?: unknown
  /** The canonical result value, bounded. */
  readonly result?: unknown
  /** One-line outcome preview. */
  readonly resultSummary?: string | undefined
  /** Typed enrichment for the Details view; absent on old records. */
  readonly details?: DetailView | undefined
  /** The primary RC call this record wrapped, for the Raw data view. */
  readonly rc?: RcCallView | undefined
  /** Every RC call the tool actually made, for the Raw data view. */
  readonly rcCalls?: readonly RcCallView[] | undefined
  /** Whether the call's reflection answer came from the schema cache. */
  readonly cached?: boolean | undefined
}

/** Identity of the editor behind the panel's endpoint, as a snapshot carries it. */
export interface EditorIdentityView {
  /** OS process id of the editor. */
  readonly processId?: number | undefined
  /** Engine version, e.g. `5.5.0-0+UE5`. */
  readonly engineVersion?: string | undefined
  /** Project name (the `.uproject` base name). */
  readonly projectName?: string | undefined
  /** Absolute project directory. */
  readonly projectDir?: string | undefined
  /** Whether the answering process is an editor. */
  readonly isEditor?: boolean | undefined
}

/** One `snapshot` reply, narrowed. */
export interface SnapshotView {
  /** The session the reply is for; `null` when the client named none. */
  readonly sessionId: string | null
  /** Newest-first records for that session only. */
  readonly operations: readonly OperationView[]
  /** Records retained for that session. */
  readonly retained: number
  /** Total records retained across every session. */
  readonly totalRetained: number
  /** Every session with records, counts only. */
  readonly sessions: readonly SessionGroupView[]
  /** The editor the tools talk to. */
  readonly baseUrl: string
  /** Whether a passphrase is configured. */
  readonly passphraseConfigured: boolean
  /** Identity of the editor process; `null` when it could not be read. */
  readonly editor: EditorIdentityView | null
  /** Host time the snapshot was taken. */
  readonly time: number
}

/** A call that either produced a snapshot or failed with a code to show. */
export type SnapshotOutcome =
  | { readonly ok: true; readonly snapshot: SnapshotView }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Upper bound the host also enforces, so the two never disagree silently. */
export const MAX_ROW_LIMIT = 500

/** What one `snapshot` call may ask for. */
export interface SnapshotRequest {
  /** The session whose history to read; without it the host returns no rows. */
  readonly sessionId: string
  /** Maximum operations to return, newest first. */
  readonly limit?: number | undefined
}

/** One reply the host's handler can produce, normalized to the two branches. */
type Reply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string }

/** Read one property off an unknown object without trusting its shape. */
function field(source: unknown, key: string): unknown {
  if (source === null || typeof source !== 'object' || Array.isArray(source)) return undefined
  return (source as Record<string, unknown>)[key]
}

/** Read a string, treating the empty string as absent. */
function text(source: unknown, key: string): string | undefined {
  const value = field(source, key)
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read a finite number. */
function num(source: unknown, key: string): number | undefined {
  const value = field(source, key)
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read a boolean, keeping `false` distinct from absent. */
function bool(source: unknown, key: string): boolean | undefined {
  const value = field(source, key)
  return typeof value === 'boolean' ? value : undefined
}

/** Narrow the shared reply envelope, whatever the caller actually returned. */
function envelope(raw: unknown): Reply {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, code: 'malformed', message: 'The host returned a value that is not a reply.' }
  }
  if (field(raw, 'ok') === true) return { ok: true, value: field(raw, 'value') }
  const error = field(raw, 'error')
  return {
    ok: false,
    code: text(error, 'code') ?? 'internal',
    message: text(error, 'message') ?? 'The host reported a failure without a message.',
  }
}

/** Attach a member-type list, keeping only entries the tree can label. */
function narrowMembers(raw: unknown, depth = 3): DetailMemberTypeView[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const members: DetailMemberTypeView[] = []
  for (const entry of raw.slice(0, 64)) {
    const name = text(entry, 'name')
    if (name === undefined) continue
    const nested = depth <= 1 ? undefined : narrowMembers(field(entry, 'members'), depth - 1)
    members.push({
      name,
      type: text(entry, 'type'),
      ...(field(entry, 'displayNameText') === undefined ? {} : { displayNameText: field(entry, 'displayNameText') }),
      ...(nested === undefined ? {} : { members: nested }),
    })
  }
  return members.length === 0 ? undefined : members
}

/** Narrow one Details field; `undefined` when the row is unusable. */
function narrowDetailField(raw: unknown): DetailFieldView | undefined {
  const name = text(raw, 'name')
  if (name === undefined) return undefined
  return {
    name,
    displayName: field(raw, 'displayName'),
    displayNameText: field(raw, 'displayNameText'),
    type: text(raw, 'type'),
    direction: text(raw, 'direction'),
    value: field(raw, 'value'),
    enumLabel: text(raw, 'enumLabel'),
    enumLabelRef: field(raw, 'enumLabelRef'),
    enumName: text(raw, 'enumName'),
    raw: text(raw, 'raw'),
    members: narrowMembers(field(raw, 'members')),
    omitted: bool(raw, 'omitted'),
    note: text(raw, 'note'),
  }
}

/** Narrow one Details section; `undefined` when the section is unreadable. */
function narrowDetailSection(raw: unknown): DetailSectionView | undefined {
  const kind = text(raw, 'kind')
  if (kind === undefined) return undefined
  const rawFields = field(raw, 'fields')
  const fields: DetailFieldView[] = []
  if (Array.isArray(rawFields)) {
    for (const entry of rawFields.slice(0, 128)) {
      const fieldView = narrowDetailField(entry)
      if (fieldView !== undefined) fields.push(fieldView)
    }
  }
  const before = narrowDetailField(field(raw, 'before'))
  const after = narrowDetailField(field(raw, 'after'))
  return {
    kind,
    ...(fields.length === 0 ? {} : { fields }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
    note: text(raw, 'note'),
  }
}

/**
 * Narrow the persisted Details structure.
 *
 * Old records carry no `details`; a malformed one is dropped rather than
 * thrown, so one bad record cannot blank the panel.
 *
 * @param raw - the wire value.
 * @returns the narrowed details, or `undefined`.
 */
export function narrowDetails(raw: unknown): DetailView | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const version = num(raw, 'v')
  const rawSections = field(raw, 'sections')
  if (version === undefined || !Array.isArray(rawSections)) return undefined
  const sections: DetailSectionView[] = []
  for (const entry of rawSections.slice(0, 16)) {
    const section = narrowDetailSection(entry)
    if (section !== undefined) sections.push(section)
  }
  return {
    v: version,
    sections,
    ...(bool(raw, 'truncated') === true ? { truncated: true } : {}),
  }
}
/** Narrow one operation; `undefined` when the row is unusable. */
/** Narrow one primary RC call; `undefined` when absent or unusable. */
function narrowRc(raw: unknown): RcCallView | undefined {
  const objectPath = text(raw, 'objectPath')
  const functionName = text(raw, 'functionName')
  const parametersJson = text(raw, 'parametersJson')
  const outParametersJson = text(raw, 'outParametersJson')
  if (objectPath === undefined || functionName === undefined || parametersJson === undefined || outParametersJson === undefined) {
    return undefined
  }
  return {
    objectPath,
    functionName,
    parametersJson,
    outParametersJson,
    returnValueJson: text(raw, 'returnValueJson'),
    returnType: text(raw, 'returnType'),
    errorMessage: text(raw, 'errorMessage'),
  }
}

/** Narrow the record's RC call list; `undefined` when absent or unusable. */
function narrowRcCalls(raw: unknown): RcCallView[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const calls: RcCallView[] = []
  for (const entry of raw.slice(0, 256)) {
    const call = narrowRc(entry)
    if (call !== undefined) calls.push(call)
  }
  return calls.length === 0 ? undefined : calls
}

function narrowOperation(raw: unknown): OperationView | undefined {
  const id = text(raw, 'id')
  const time = num(raw, 'time')
  const tool = text(raw, 'tool')
  const ok = bool(raw, 'ok')
  if (id === undefined || time === undefined || tool === undefined || ok === undefined) return undefined
  return {
    id,
    time,
    tool,
    ok,
    recordVersion: num(raw, 'recordVersion'),
    sessionId: text(raw, 'sessionId'),
    callId: text(raw, 'callId'),
    errorCode: text(raw, 'errorCode'),
    errorMessage: text(raw, 'errorMessage'),
    errorHint: text(raw, 'errorHint'),
    durationMs: num(raw, 'durationMs'),
    targetType: text(raw, 'targetType'),
    objectPath: text(raw, 'objectPath'),
    propertyPath: text(raw, 'propertyPath'),
    functionName: text(raw, 'functionName'),
    propertyType: text(raw, 'propertyType'),
    params: field(raw, 'params'),
    result: field(raw, 'result'),
    resultSummary: text(raw, 'resultSummary'),
    details: narrowDetails(field(raw, 'details')),
    rc: narrowRc(field(raw, 'rc')),
    rcCalls: narrowRcCalls(field(raw, 'rcCalls')),
    cached: bool(raw, 'cached'),
  }
}

/** Narrow one session group; `undefined` when the row is unusable. */
function narrowSessionGroup(raw: unknown): SessionGroupView | undefined {
  const sessionId = field(raw, 'sessionId')
  const count = num(raw, 'count')
  const lastTime = num(raw, 'lastTime')
  if (typeof sessionId !== 'string' || count === undefined || lastTime === undefined) return undefined
  return { sessionId, count, lastTime }
}

/** Narrow one snapshot's optional editor identity; `null` when absent/empty. */
function narrowEditor(raw: unknown): EditorIdentityView | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const processId = num(raw, 'processId')
  const engineVersion = text(raw, 'engineVersion')
  const projectName = text(raw, 'projectName')
  const projectDir = text(raw, 'projectDir')
  const isEditor = bool(raw, 'isEditor')
  if (
    processId === undefined
    && engineVersion === undefined
    && projectName === undefined
    && projectDir === undefined
    && isEditor === undefined
  ) return null
  return {
    ...(processId === undefined ? {} : { processId }),
    ...(engineVersion === undefined ? {} : { engineVersion }),
    ...(projectName === undefined ? {} : { projectName }),
    ...(projectDir === undefined ? {} : { projectDir }),
    ...(isEditor === undefined ? {} : { isEditor }),
  }
}

/** Narrow a whole snapshot, defaulting any field that is missing or unusable. */
function narrowSnapshot(raw: unknown): SnapshotView | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const rawOperations = field(raw, 'operations')
  if (!Array.isArray(rawOperations)) return undefined
  const operations: OperationView[] = []
  for (const entry of rawOperations) {
    const operation = narrowOperation(entry)
    if (operation !== undefined) operations.push(operation)
  }
  const rawSessions = field(raw, 'sessions')
  const sessions: SessionGroupView[] = []
  if (Array.isArray(rawSessions)) {
    for (const entry of rawSessions) {
      const group = narrowSessionGroup(entry)
      if (group !== undefined) sessions.push(group)
    }
  }
  const sessionId = field(raw, 'sessionId')
  return {
    sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
    operations,
    retained: num(raw, 'retained') ?? operations.length,
    totalRetained: num(raw, 'totalRetained') ?? operations.length,
    sessions,
    baseUrl: text(raw, 'baseUrl') ?? '',
    passphraseConfigured: bool(raw, 'passphraseConfigured') ?? false,
    editor: narrowEditor(field(raw, 'editor')),
    time: num(raw, 'time') ?? Date.now(),
  }
}

/**
 * Make one call on the plugin's channel, turning both a thrown transport fault
 * and a malformed reply into the same failure branch the panel renders.
 *
 * @param caller - the host rpc caller.
 * @param endpoint - endpoint name on the plugin's channel.
 * @param payload - request payload.
 * @param signal - cancellation.
 * @returns the narrowed reply.
 */
async function call(
  caller: RpcCaller,
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
): Promise<Reply> {
  try {
    return envelope(await caller.call(UNREAL_CHANNEL, endpoint, payload, signal))
  } catch (error: unknown) {
    if (signal.aborted) return { ok: false, code: 'cancelled', message: 'The request was cancelled.' }
    return {
      ok: false,
      code: 'transport',
      message: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Resolve display-name keys for the UI's current culture.
 */
export async function localizeTexts(
  _caller: RpcCaller,
  keys: readonly string[],
  _culture: string,
  _signal: AbortSignal,
): Promise<readonly string[]> {
  // Localization is disabled for now: the plugin is English-only.
  return keys.map(() => '')
}

/**
 * Clear one session's retained history.
 *
 * @param caller - the host rpc caller.
 * @param sessionId - the session whose rows should be removed.
 * @param signal - cancellation.
 * @returns the number cleared, or the failure.
 */
export async function clearHistory(
  caller: RpcCaller,
  sessionId: string,
  signal: AbortSignal,
): Promise<{ ok: true; cleared: number } | { ok: false; code: string; message: string }> {
  const reply = await call(caller, 'clear', { sessionId }, signal)
  if (!reply.ok) return { ok: false, code: reply.code, message: reply.message }
  const value = reply.value
  const cleared = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)['cleared']
    : undefined
  return { ok: true, cleared: typeof cleared === 'number' ? cleared : 0 }
}

/**
 * Read the panel's snapshot.
 *
 * @param caller - the host rpc caller.
 * @param request - the session and the row cap.
 * @param signal - cancellation.
 * @returns the snapshot, or the failure to show in its place.
 */
/**
 * Read one recorded screenshot's bytes as a data URL.
 *
 * The durable record keeps only the file path; the host reads the bytes on
 * demand and only for files it named under its temp screenshot root.
 *
 * @param caller - the plugin channel caller.
 * @param id - the record id.
 * @param signal - caller cancellation.
 * @returns the PNG data URL, or `undefined` when the file is gone.
 */
export async function fetchScreenshot(
  caller: RpcCaller,
  id: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const reply = await call(caller, 'screenshot', { id }, signal)
  if (!reply.ok) return undefined
  return text(reply.value, 'dataUrl')
}
/**
 * Fetch one Type's member schema on demand.
 *
 * The Details tree calls this when the reader expands a nested struct: the record
 * carries the top-level shape only, so deeper member Types come from the host's
 * reflection cache instead of being packed into every record.
 *
 * @param caller - the host rpc caller.
 * @param type - the canonical Type to describe (`struct(...)` or a container of one).
 * @param signal - caller cancellation.
 * @returns the members, or `undefined` when the Type has none / the call failed.
 */
export async function fetchMembers(
  caller: RpcCaller,
  type: string,
  signal: AbortSignal,
): Promise<readonly DetailMemberTypeView[] | undefined> {
  const reply = await call(caller, 'members', { type }, signal)
  if (!reply.ok) return undefined
  const members = narrowMembers(field(reply.value, 'members'))
  return members
}

/** One property's reflected schema, for client-built value cards. */
export interface PropertyTypeView {
  /** Canonical Type string; empty when the host could not resolve it. */
  readonly type: string
  /** UE display-name text, when the schema reported one. */
  readonly displayNameText?: unknown
}

/**
 * Fetch one property's reflected schema on demand.
 *
 * The record stores only the raw value text, so a value card asks for the property's
 * Type and DisplayName when it renders instead of relying on stored derived Details.
 *
 * @param caller - the host rpc caller.
 * @param objectPath - the object whose property was read or written.
 * @param propertyPath - the dotted property path.
 * @param signal - caller cancellation.
 * @returns the schema, or `undefined` when it cannot be resolved.
 */
/** One property-schema lookup's outcome, carrying the host's reason on failure. */
export interface PropertyTypeLookup {
  /** The schema, when the host resolved it. */
  readonly view?: PropertyTypeView | undefined
  /** The host's (or transport's) failure message, when it did not. */
  readonly error?: string | undefined
}

export async function fetchPropertyType(
  caller: RpcCaller,
  objectPath: string,
  propertyPath: string,
  signal: AbortSignal,
): Promise<PropertyTypeLookup> {
  const reply = await call(caller, 'propertyType', { objectPath, propertyPath }, signal)
  if (!reply.ok) return { error: reply.message }
  const display = field(reply.value, 'displayNameText')
  return {
    view: {
      type: text(reply.value, 'type') ?? '',
      ...(display === undefined ? {} : { displayNameText: display }),
    },
  }
}

/** One parameter of a reflected function signature, as the host reports it. */
export interface SignatureParameterView {
  /** Parameter name: the key in the call's parameters JSON. */
  readonly name: string
  /** Canonical Type string. */
  readonly type: string
  /** `input`, `output` or `input-output`. */
  readonly direction: string
  /** UE display name text, when the schema reported one. */
  readonly displayNameText?: unknown
}

/** One reflected function signature, for cards that predate typed Details. */
export interface SignatureView {
  /** Canonical return Type; empty when the function returns nothing. */
  readonly returnType: string
  /** Parameters in declaration order. */
  readonly parameters: readonly SignatureParameterView[]
}

/**
 * Fetch one function signature on demand.
 *
 * @param caller - the host rpc caller.
 * @param objectPath - the object whose class owns the function.
 * @param functionName - the UFunction name.
 * @param signal - caller cancellation.
 * @returns the signature, or `undefined` when it cannot be resolved.
 */
export async function fetchSignature(
  caller: RpcCaller,
  objectPath: string,
  functionName: string,
  signal: AbortSignal,
): Promise<SignatureView | undefined> {
  const reply = await call(caller, 'signature', { objectPath, functionName }, signal)
  if (!reply.ok) return undefined
  const rawParameters = field(reply.value, 'parameters')
  if (!Array.isArray(rawParameters)) return undefined
  const parameters: SignatureParameterView[] = []
  for (const entry of rawParameters.slice(0, 256)) {
    const name = text(entry, 'name')
    const type = text(entry, 'type')
    const direction = text(entry, 'direction')
    if (name === undefined || type === undefined || direction === undefined) continue
    parameters.push({
      name,
      type,
      direction,
      ...(field(entry, 'displayNameText') === undefined ? {} : { displayNameText: field(entry, 'displayNameText') }),
    })
  }
  return { returnType: text(reply.value, 'returnType') ?? '', parameters }
}

export async function fetchSnapshot(
  caller: RpcCaller,
  request: SnapshotRequest,
  signal: AbortSignal,
): Promise<SnapshotOutcome> {
  const reply = await call(caller, 'snapshot', request, signal)
  if (!reply.ok) return { ok: false, code: reply.code, message: reply.message }
  const snapshot = narrowSnapshot(reply.value)
  if (snapshot === undefined) {
    return { ok: false, code: 'malformed', message: 'The host returned a snapshot the panel cannot read.' }
  }
  return { ok: true, snapshot }
}
