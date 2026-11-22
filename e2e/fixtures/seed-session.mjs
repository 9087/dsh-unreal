/**
 * Throwaway-boot fixture: publish ONE live session and drive this plugin's real
 * tools against a stand-in Remote Control endpoint, so the browser renders a
 * genuine durable call history — without an Unreal editor, a model, a key or a
 * network.
 *
 * Mounted only in the e2e profile, as a `--patch` overlay insert row whose name
 * is `./seed-session.mjs`: `dsh-app-boot` rewrites a relative inserted name to a
 * `file://` URL beside the patch file, so this needs no package and no build.
 *
 * The stand-in answers the reflection calls the plugin's **enrichment layer**
 * makes as well as the main call, so every history row gets real typed Details:
 * a function signature becomes a Parameters table, a struct value gets member
 * types, an enum value gets its entry label. Two `GetEnumInfo` calls share one
 * answer, which is what lets the spec assert the schema cache prevented a
 * duplicate round trip.
 *
 * Three facts about the host this file depends on:
 *
 * - The plugin's own `DSH_UNREAL_BASE_URL` environment override points the
 *   transport at the stand-in HTTP server started below; the server is bound on
 *   the port the harness exports as `DSH_E2E_RC_PORT`.
 * - `ctx.sessions.create()` publishes a LIVE session. The session id is printed
 *   to stdout, and the test reads it back from the host log — the GUI pins the
 *   same id in localStorage, so the panel is attached to this exact session.
 * - A `turn/start` is the one thing that clears the session list's `blank` flag,
 *   which the client requires before it opens a saved session.
 */

import { createServer } from 'node:http'

/** Cordis plugin name; shows up in the host log. */
export const name = 'e2e-seed-unreal'

/** Host services this plugin needs before `apply` runs. */
export const inject = ['sessions', 'tools']

/** Stable id, so a reload finds and reuses the same session. */
const SESSION_ID = 'e2e-unreal-history'

/** A second session, whose rows must NEVER show up in the first session's panel. */
const OTHER_SESSION_ID = 'e2e-unreal-other-session'

/** The workspace the session runs in; the harness exports it for exactly this. */
const CWD = process.env.DSH_E2E_WORKSPACE ?? process.cwd()

/** The port the stand-in Remote Control endpoint listens on. */
const RC_PORT = Number(process.env.DSH_E2E_RC_PORT ?? '30061')

/** The marker lines the test waits for in the host log. */
export const MARKER = 'DSH_UNREAL_E2E_READY='

/** One text-only tool-result message. */
function toolMessage(callId, text) {
  return {
    id: `msg-${callId}`,
    role: 'tool',
    content: [{ type: 'text', text }],
    source: { kind: 'tool', callId },
    toolCallId: callId,
  }
}

/** The result struct shape every EditorAutomation call shares. */
function ok(extra) {
  return { ErrorCode: 0, ErrorMessage: '', Hint: '', ...extra }
}

/** A deterministic failure result. */
function fail(code, message, hint) {
  return { ErrorCode: code, ErrorMessage: message, Hint: hint ?? '' }
}

/** The enum the fixture describes. */
const ENUM = {
  Enum: '/Script/Engine.ECollisionEnabled',
  Entries: [
    { Name: 'NoCollision', DisplayName: 'No Collision', Value: 0 },
    { Name: 'QueryOnly', DisplayName: 'Query Only', Value: 1 },
    { Name: 'PhysicsOnly', DisplayName: 'Physics Only', Value: 2 },
    { Name: 'QueryAndPhysics', DisplayName: 'Query And Physics', Value: 3 },
  ],
}

/** The class the fixture describes. */
const CLASS = {
  Class: '/Script/Engine.StaticMeshComponent',
  Properties: [
    { Name: 'StaticMesh', Type: 'object(/Script/Engine.StaticMesh)' },
    { Name: 'RelativeLocation', Type: 'struct(/Script/CoreUObject.Vector)' },
    { Name: 'Mobility', Type: 'enum(/Script/Engine.EComponentMobility)' },
  ],
  Functions: [
    {
      Name: 'SetStaticMesh',
      bBlueprintCallable: true,
      bBlueprintPure: false,
      bStatic: false,
      Parameters: [{ Name: 'NewMesh', Type: 'object(/Script/Engine.StaticMesh)', Direction: 0 }],
      ReturnType: '',
    },
    {
      Name: 'GetClosestPointOnCollision',
      bBlueprintCallable: true,
      bBlueprintPure: true,
      bStatic: false,
      Parameters: [
        { Name: 'Point', Type: 'struct(/Script/CoreUObject.Vector)', Direction: 0 },
        { Name: 'OutDistance', Type: 'double', Direction: 1 },
      ],
      ReturnType: 'double',
    },
  ],
}

/** Function signatures the enrichment layer resolves from resolved classes. */
const FUNCTIONS = {
  '/Script/Engine.KismetSystemLibrary|GetDisplayName': {
    Name: 'GetDisplayName',
    bBlueprintCallable: true,
    bBlueprintPure: false,
    bStatic: true,
    Parameters: [{ Name: 'Object', Type: 'object(/Script/Engine.Object)', Direction: 0 }],
    ReturnType: 'string',
  },
  // The same function reached through the level instance's resolved class.
  '/Script/Engine.StaticMeshComponent|GetDisplayName': {
    Name: 'GetDisplayName',
    bBlueprintCallable: true,
    bBlueprintPure: false,
    bStatic: true,
    Parameters: [{ Name: 'Object', Type: 'object(/Script/Engine.Object)', Direction: 0 }],
    ReturnType: 'string',
  },
  '/Script/Engine.Actor|Explode': {
    Name: 'Explode',
    bBlueprintCallable: true,
    bBlueprintPure: false,
    bStatic: false,
    Parameters: [{ Name: 'DamageAmount', Type: 'double', Direction: 0 }],
    ReturnType: '',
  },
}

/** One property's canonical Type, by the Type the enrichment layer derives. */
const PROPERTY_TYPES = {
  'RelativeLocation': 'struct(/Script/CoreUObject.Vector)',
  'RelativeLocation.Z': 'double',
  'bHidden': 'bool',
  'Mobility': 'enum(/Script/Engine.ECollisionEnabled)',
}

/** Struct members the enrichment labels nested values with. */
const STRUCTS = {
  '/Script/CoreUObject.Vector': {
    Struct: '/Script/CoreUObject.Vector',
    Properties: [
      { Name: 'X', Type: 'double' },
      { Name: 'Y', Type: 'double' },
      { Name: 'Z', Type: 'double' },
    ],
  },
}

/** Read `class(...)` out of the Type argument of a reflection call. */
function classPathOf(parameters) {
  return String(parameters.Type ?? '').replace(/^class\((.*)\)$/, '$1')
}

/** The one result each EditorAutomation function answers, keyed by FunctionName. */
function editorKitResult(functionName, parameters) {
  switch (functionName) {
    case 'Ping':
      return 'pong'
    case 'GetEnumInfo':
      if (String(parameters.Type ?? '').includes('Bogus')) {
        return fail(3, 'No enum named that Type exists.', 'Pass a Type like enum(/Script/Engine.ECollisionEnabled).')
      }
      return ok({ Info: ENUM })
    case 'GetStructInfo':
      return ok({ Info: STRUCTS[classPathOf(parameters)] ?? STRUCTS['/Script/CoreUObject.Vector'] })
    case 'GetClassInfo':
      return ok({ Info: CLASS })
    case 'GetFunctionInfo': {
      const key = `${classPathOf(parameters)}|${String(parameters.FunctionName ?? '')}`
      return ok({ Info: FUNCTIONS[key] ?? { Name: String(parameters.FunctionName ?? ''), ReturnType: '' } })
    }
    case 'GetPropertyType':
      return ok({ Type: PROPERTY_TYPES[String(parameters.PropertyPath ?? '')] ?? '' })
    case 'GetObjectClass': {
      // The entry point a level-instance path needs; without it the row would
      // be values-without-types. Every seeded instance answers the same class.
      const objectPath = String(parameters.ObjectPath ?? '')
      if (objectPath.includes(':PersistentLevel.')) {
        return ok({ ClassType: 'class(/Script/Engine.StaticMeshComponent)' })
      }
      return fail(2, `No object at '${objectPath}'.`, 'Pass a live object path.')
    }
    case 'GetPropertyValue':
      // The level-instance reads answer the Vector the panel expands into typed
      // members; another session's read answers a bool.
      return String(parameters.ObjectPath ?? '').includes('PersistentLevel.')
        ? ok({ ValueJson: '{"X":"0.0","Y":"0.0","Z":"10.0"}' })
        : ok({ ValueJson: '"true"' })
    case 'SetPropertyValue':
      return ok({ OldValueJson: '"10.0"', NewValueJson: '"42.0"' })
    case 'CallFunction':
      if (String(parameters.FunctionName ?? '') === 'Explode') {
        return fail(7, 'The function could not be called on this object.', 'Check the object Type and the parameter names.')
      }
      return ok({
        ReturnValueJson: '"StaticMeshComponent"',
        OutParametersJson: '{}',
        ReturnType: 'string',
      })
    default:
      return fail(1, `Unknown EditorAutomation function "${String(functionName)}".`)
  }
}

/**
 * The single data out-parameter each EditorAutomation function returns.
 *
 * The adapter reaches every function through the `CallFunction` dispatcher, whose
 * answer carries the data out-parameters separately from the result envelope. This
 * stand-in still writes its fixtures as the old per-function result structs, so the
 * wrapper below moves `Info`/`ValueJson`/… into the matching out-parameter.
 */
const OUT_PARAMETER = {
  Ping: 'OutValue',
  GetEditorInfo: 'OutInfo',
  GetEnumInfo: 'OutInfo',
  GetStructInfo: 'OutInfo',
  GetClassInfo: 'OutInfo',
  GetFunctionInfo: 'OutInfo',
  GetPropertyType: 'OutInfo',
  GetObjectClass: 'OutClassType',
  GetPropertyValue: 'OutValueJson',
  SetPropertyValue: 'OutWrite',
  GetRecentLog: 'OutPage',
  GetBlueprintInfo: 'OutInfo',
  CaptureScreenshot: 'OutFilePath',
  ListAssets: 'OutAssets',
}

/** The data value an old result struct contributes to the dispatcher answer. */
function dispatcherData(functionName, legacy) {
  switch (functionName) {
    case 'GetPropertyType':
      return { Type: legacy.Type ?? '', DisplayNameText: legacy.DisplayNameText ?? {} }
    case 'GetObjectClass':
      return legacy.ClassType ?? ''
    case 'GetPropertyValue':
      return legacy.ValueJson ?? ''
    case 'SetPropertyValue':
      return {
        OldValueJson: legacy.OldValueJson ?? '',
        NewValueJson: legacy.NewValueJson ?? '',
        DisplayNameText: legacy.DisplayNameText,
      }
    case 'CaptureScreenshot':
      return legacy.FilePath ?? ''
    case 'ListAssets':
      return legacy.Assets ?? []
    default:
      return legacy.Info ?? stripErrorFields(legacy)
  }
}

/** A legacy result struct without its old error-envelope fields. */
function stripErrorFields(legacy) {
  const { ErrorCode, ErrorMessage, Hint, ...rest } = legacy
  return rest
}

/**
 * Wrap one legacy per-function result into a `CallFunction` dispatcher answer.
 *
 * @param functionName - the inner EditorAutomation function.
 * @param parameters - the parsed inner parameters.
 * @returns the dispatcher result struct.
 */
function dispatcherAnswer(functionName, parameters) {
  const legacy = editorKitResult(functionName, parameters)
  const outName = OUT_PARAMETER[functionName]
  const answer = (success, data, code = 0, message = '', hint = '') => ({
    ErrorCode: 0,
    ErrorMessage: '',
    Hint: '',
    ReturnType: '',
    ReturnValueJson: JSON.stringify(
      success
        ? { bSuccess: 'true', ErrorCode: '0', ErrorMessage: '', Hint: '' }
        : { bSuccess: 'false', ErrorCode: String(code), ErrorMessage: message, Hint: hint },
    ),
    OutParametersJson: success && outName !== undefined ? JSON.stringify({ [outName]: data }) : '{}',
  })
  if (legacy === null || typeof legacy !== 'object' || Array.isArray(legacy)) {
    return answer(true, legacy ?? null)
  }
  const code = typeof legacy.ErrorCode === 'number' ? legacy.ErrorCode : 0
  if (code !== 0) {
    return answer(false, null, code, String(legacy.ErrorMessage ?? ''), String(legacy.Hint ?? ''))
  }
  return answer(true, dispatcherData(functionName, legacy))
}

/** Requests the stand-in endpoint answered, for the marker line. */
const served = []

/**
 * Start the stand-in Remote Control endpoint.
 *
 * @returns the listening server.
 */
async function startStandIn() {
  const server = createServer((request, response) => {
    if (request.method !== 'PUT' || request.url !== '/remote/object/call') {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"errorMessage":"not found"}')
      return
    }
    const chunks = []
    request.on('data', chunk => chunks.push(chunk))
    request.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end('{"errorMessage":"bad body"}')
        return
      }
      const functionName = String(body.FunctionName ?? '')
      const parameters = body.Parameters ?? {}
      served.push({ functionName, parameters })
      let answer
      if (functionName === 'CallFunction') {
        const innerFunctionName = String(parameters.FunctionName ?? '')
        let innerParameters = {}
        const parametersJson = parameters.ParametersJson
        if (typeof parametersJson === 'string' && parametersJson.trim() !== '') {
          try {
            innerParameters = JSON.parse(parametersJson)
          } catch {
            innerParameters = {}
          }
        }
        answer = dispatcherAnswer(innerFunctionName, innerParameters)
      } else {
        answer = editorKitResult(functionName, parameters)
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ReturnValue: answer }))
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(RC_PORT, '127.0.0.1', resolve)
  })
  return server
}

/** Wait until the tool registry carries one tool name. */
async function toolNamed(ctx, toolName) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    const tools = ctx.get('tools')
    const tool = tools?.get(toolName)
    if (tool !== undefined) return tool
    await new Promise(resolve => { setTimeout(resolve, 200) })
  }
  return undefined
}

/** The level instance the fixture reads, writes and calls through. */
const CUBE_PATH = '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1'

/** The calls the fixture drives, in execution order. */
const CALLS = [
  { callId: 'e2e-ping', tool: 'unreal_ping', args: {}, expect: 'ok' },
  {
    callId: 'e2e-enum',
    tool: 'unreal_get_enum_info',
    args: { type: 'enum(/Script/Engine.ECollisionEnabled)' },
    expect: 'ok',
  },
  {
    // The SAME Type again: served from the schema cache, so the stand-in sees
    // one GetEnumInfo request for these two calls.
    callId: 'e2e-enum-cache',
    tool: 'unreal_get_enum_info',
    args: { type: 'enum(/Script/Engine.ECollisionEnabled)' },
    expect: 'ok',
  },
  {
    callId: 'e2e-class',
    tool: 'unreal_get_class_info',
    args: { type: 'class(/Script/Engine.StaticMeshComponent)' },
    expect: 'ok',
  },
  {
    callId: 'e2e-proptype',
    tool: 'unreal_get_property_type',
    args: { type: 'class(/Script/Engine.SceneComponent)', propertyPath: 'RelativeLocation' },
    expect: 'ok',
  },
  {
    // A read on a level instance: typed only because GetObjectClass resolves
    // the class, then GetPropertyType/GetStructInfo come from the cache.
    callId: 'e2e-read',
    tool: 'unreal_get_property_value',
    args: { objectPath: CUBE_PATH, propertyPath: 'RelativeLocation' },
    expect: 'ok',
  },
  {
    callId: 'e2e-write',
    tool: 'unreal_set_property_value',
    args: {
      objectPath: CUBE_PATH,
      propertyPath: 'RelativeLocation.Z',
      valueJson: '"42.0"',
      generateTransaction: true,
    },
    expect: 'ok',
  },
  {
    // The new EditorAutomation entry point, called AFTER the read/write enrichment
    // warmed the object→class cache — so this row reports a cache hit, which is
    // the browser-visible half of the cache assertion.
    callId: 'e2e-object-class',
    tool: 'unreal_get_object_class',
    args: { objectPath: CUBE_PATH },
    expect: 'ok',
  },
  {
    callId: 'e2e-call',
    tool: 'unreal_call_function',
    args: {
      objectPath: '/Script/Engine.Default__KismetSystemLibrary',
      functionName: 'GetDisplayName',
      parameters: { Object: '/Script/Engine.Default__StaticMeshComponent' },
    },
    expect: 'ok',
  },
  {
    // A call on a level instance: signature typed via GetObjectClass, proving
    // the object-class path feeds the same Parameters/Returns tables.
    callId: 'e2e-call-instance',
    tool: 'unreal_call_function',
    args: { objectPath: CUBE_PATH, functionName: 'GetDisplayName', parameters: { Object: CUBE_PATH } },
    expect: 'ok',
  },
  {
    callId: 'e2e-call-failed',
    tool: 'unreal_call_function',
    args: { objectPath: '/Script/Engine.Default__Actor', functionName: 'Explode', parameters: { DamageAmount: '25.0' } },
    expect: 'editorkit/call-failed',
  },
  {
    callId: 'e2e-enum-failed',
    tool: 'unreal_get_enum_info',
    args: { type: 'enum(/Script/Engine.Bogus)' },
    expect: 'editorkit/enum-not-found',
  },
]

/** The call recorded under the OTHER session — it must stay out of this panel. */
const OTHER_CALL = {
  callId: 'e2e-other',
  tool: 'unreal_get_property_value',
  args: {
    objectPath: '/Game/E2E/OtherSessionOnly.OtherSessionOnly:PersistentLevel.HiddenCube',
    propertyPath: 'bHidden',
  },
}

/** One process-wide flag: `apply` can run again on a reload, the seed must not. */
let started = false

/** One message's readable text. */
function outcomeText(value, failure) {
  if (failure !== undefined) return `${failure.code}: ${failure.message}`
  return JSON.stringify(value)
}

/**
 * Publish the session, drive the real tools, and print the marker lines.
 *
 * @param ctx - the host context.
 */
export function apply(ctx) {
  if (started) return
  started = true
  void run(ctx)
}

/**
 * The fixture's body, off the plugin's own synchronous boot path.
 *
 * @param ctx - the host context.
 */
async function run(ctx) {
  const log = message => { process.stdout.write(`${message}\n`) }
  const server = await startStandIn()
  log(`DSH_UNREAL_E2E_STANDIN=http://127.0.0.1:${RC_PORT}`)

  if (ctx.sessions.get(SESSION_ID) === undefined) {
    const session = ctx.sessions.create(SESSION_ID, { meta: { cwd: CWD } })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', {
      id: 'msg-user-1',
      role: 'user',
      content: [{ type: 'text', text: 'Inspect the cube component and raise it to Z=42.' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' })

    const results = []
    for (const call of CALLS) {
      const tool = await toolNamed(ctx, call.tool)
      if (tool === undefined) {
        results.push({ callId: call.callId, ok: false, code: 'missing-tool' })
        continue
      }
      session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: call.callId,
        name: call.tool,
        arguments: JSON.stringify(call.args),
      })
      try {
        const value = await tool.execute(call.args, {
          callId: call.callId,
          signal: new AbortController().signal,
          agent: { id: SESSION_ID },
        })
        results.push({ callId: call.callId, ok: true, code: '' })
        session.append('tool/result', {
          turn: 1,
          step: 1,
          message: toolMessage(call.callId, outcomeText(value, undefined)),
        }, { surfaceOp: 'append' })
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'error'
        results.push({ callId: call.callId, ok: false, code })
        session.append('tool/result', {
          turn: 1,
          step: 1,
          message: toolMessage(call.callId, outcomeText(undefined, { code, message: String(error?.message ?? error) })),
        }, { surfaceOp: 'append' })
      }
    }

    // A row under a DIFFERENT session, so the current-session filter has
    // something real to leave out.
    const otherTool = await toolNamed(ctx, OTHER_CALL.tool)
    if (otherTool !== undefined) {
      try {
        await otherTool.execute(OTHER_CALL.args, {
          callId: OTHER_CALL.callId,
          signal: new AbortController().signal,
          agent: { id: OTHER_SESSION_ID },
        })
        results.push({ callId: OTHER_CALL.callId, ok: true, code: 'other-session' })
      } catch (error) {
        results.push({ callId: OTHER_CALL.callId, ok: false, code: String(error?.code ?? error) })
      }
    }

    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Request counts per EditorAutomation function: the schema-cache assertions read
    // these (two enum tool calls, one GetEnumInfo request).
    const counts = {}
    for (const request of served) {
      counts[request.functionName] = (counts[request.functionName] ?? 0) + 1
    }

    log(`${MARKER}${SESSION_ID}`)
    log(`DSH_UNREAL_E2E_RESULTS=${JSON.stringify(results)}`)
    log(`DSH_UNREAL_E2E_SERVED=${JSON.stringify(counts)}`)
  }

  // The server must outlive the seed: the GUI can trigger a re-read at any
  // time, and a closed endpoint would turn a passing panel into a failing row.
  process.once('exit', () => { server.close() })
}
