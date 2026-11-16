/**
 * Tool-surface tests: registration, input validation, result mapping, and the
 * durable history row each call produces.
 *
 * The transport is a fake `fetch` (no editor), the store is an in-memory
 * recorder (the real domain is covered in `store.test.ts`), and every tool is
 * driven through the exact `execute` entry point the registry calls.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, it } from 'node:test'

import type { Context } from '@deepseek-ai/cordis'

import { actionTitle } from '../src/client/card-title.ts'
import { en } from '../src/client/locales.ts'
import type { MsgKey } from '../src/client/locales.ts'
import type { ResolvedConfig } from '../src/config.ts'
import { EditorAutomationClient } from '../src/kit/client.ts'
import type { FetchLike } from '../src/kit/client.ts'
import { KitError } from '../src/kit/errors.ts'
import { ReflectionService } from '../src/kit/reflection.ts'
import type { OperationRecord } from '../src/records.ts'
import { SchemaCache } from '../src/schema-cache.ts'
import { innerCall, wrapCallFunctionAnswer } from './support/dispatcher-fixtures.ts'
import type { UnrealStore } from '../src/store.ts'
import { OWNED_TOOLS, registerTools } from '../src/tools.ts'
import type { ToolDeps } from '../src/tools.ts'

/** What one registry call hands a tool body. */
interface Exec {
  callId: string
  signal?: AbortSignal
  agent?: { id: string } | undefined
}

/** The slice of a tool definition this test drives. */
interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  output?: { render: (args: unknown, value: never) => { type: string; text: string }[] } | undefined
  execute(args: unknown, exec: Exec): Promise<unknown>
}

/** In-memory stand-in for the durable store. */
class RecordingStore {
  readonly records: OperationRecord[] = []

  async recordOperation(record: OperationRecord): Promise<void> {
    this.records.push(record)
  }

  operationsMatching(query: { sessionId?: string | undefined } = {}): OperationRecord[] {
    return this.records
      .filter(record => query.sessionId === undefined || record.sessionId === query.sessionId)
      .sort((a, b) => b.time - a.time)
  }

  countMatching(query: { sessionId?: string | undefined } = {}): number {
    return this.operationsMatching(query).length
  }

  get operationCount(): number {
    return this.records.length
  }

  sessionGroups(): { sessionId: string; count: number; lastTime: number }[] {
    return []
  }
}

/** The fake host context `registerTools` needs. */
function fakeHost(tools: Map<string, ToolDef>): Context {
  const host = {
    tools: {
      register(definition: ToolDef): () => void {
        tools.set(definition.name, definition)
        return () => { tools.delete(definition.name) }
      },
    },
    inject(_names: string[], callback: (scope: unknown) => void): void {
      // No systemPrompt service in this host.
      callback({ get: () => undefined, effect: () => {} })
    },
    effect(): void {},
    get(): undefined {
      return undefined
    },
    logger: { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} },
  }
  return host as unknown as Context
}

/** Build one fake transport that answers `{ReturnValue: <value>}` per call. */
function kitFetch(returns: unknown[], bodies: unknown[] = []): FetchLike {
  let index = 0
  return async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { FunctionName: string; Parameters: Record<string, unknown> }
    bodies.push(body)
    const inner = innerCall(body)
    const value = returns[Math.min(index, returns.length - 1)]
    index += 1
    const answer = inner === undefined ? value : wrapCallFunctionAnswer(inner.functionName, value)
    return new Response(JSON.stringify({ ReturnValue: answer }), { status: 200 })
  }
}

/** A resolved config. */
function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    baseUrl: 'http://127.0.0.1:30010',
    requestTimeoutMs: 5_000,
    preflight: false,
    historyLimit: 100,
    maxRetainedOperations: 500,
    snapshotMaxChars: 4000,
    reflectionCacheTtlMs: 60_000,
    reflectionCacheMaxEntries: 100,
    detailsMaxChars: 12_000,
    enrichmentTimeoutMs: 2_000,
    passphrase: undefined,
    ...overrides,
  }
}

/**
 * Build the tool dependencies over one fake transport.
 *
 * The reflection cache is real (the enrichment path uses it), so a sequential
 * fake transport may be asked for reflection calls after the main call; tests
 * that care about those answers use the dedicated details suite instead.
 */
function makeDeps(fetch: FetchLike, store: RecordingStore, overrides: Partial<ResolvedConfig> = {}): ToolDeps {
  const client = new EditorAutomationClient({ baseUrl: '127.0.0.1:30010', requestTimeoutMs: 1000 }, fetch)
  const cache = new SchemaCache({ ttlMs: 60_000, maxEntries: 100, now: () => Date.now() })
  return {
    client,
    reflection: new ReflectionService({ client, cache }),
    store: store as unknown as UnrealStore,
    config: config(overrides),
    now: () => 1,
  }
}

/** Await a promise expected to reject with a KitError. */
async function rejection(promise: Promise<unknown>): Promise<KitError> {
  try {
    await promise
  } catch (error: unknown) {
    assert.ok(error instanceof KitError, `expected a KitError, got ${String(error)}`)
    return error
  }
  throw new Error('expected the promise to reject')
}

/** One wire result struct for a reflection call. */
function result(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ErrorCode: 0, ErrorMessage: '', Hint: '', ...overrides }
}

describe('registerTools', () => {
  it('registers exactly the seventy-two EditorAutomation tools', () => {
    const tools = new Map<string, ToolDef>()
    const store = new RecordingStore()
    registerTools(fakeHost(tools), makeDeps(kitFetch([{}]), store))

    assert.deepEqual([...tools.keys()].sort(), [...OWNED_TOOLS].sort())
    assert.equal(tools.size, 72)
    assert.ok(tools.has('unreal_get_editor_info'))
    assert.ok(tools.has('unreal_focus_pie'))
    assert.ok(tools.has('unreal_send_key'))
    assert.ok(tools.has('unreal_call_functions'))
    assert.ok(tools.has('unreal_screenshot'))
    assert.ok(tools.has('unreal_get_recent_log'))
    assert.ok(tools.has('unreal_get_blueprint_graphs'))
    assert.ok(tools.has('unreal_connect_pins'))
    assert.ok(tools.has('unreal_save_current_level'))
    assert.ok(tools.has('unreal_open_level'))
    for (const name of OWNED_TOOLS) assert.ok(tools.has(name), `missing ${name}`)
  })

  it('gives every registered tool a non-empty, human-readable action title', () => {
    const tools = new Map<string, ToolDef>()
    registerTools(fakeHost(tools), makeDeps(kitFetch([{}]), new RecordingStore()))
    const tr = (key: MsgKey): string => en[key] ?? key
    for (const name of tools.keys()) {
      const title = actionTitle({ id: name, time: 0, ok: true, tool: name }, tr)
      assert.notEqual(title.trim(), '', `${name} must have a card title`)
      assert.notEqual(title, name, `${name} must not fall back to its wire name`)
    }
  })

  it('states the nested-JSON encoding conventions in the descriptions that need them', () => {
    const tools = new Map<string, ToolDef>()
    registerTools(fakeHost(tools), makeDeps(kitFetch([{}]), new RecordingStore()))
    const set = tools.get('unreal_set_property_value')!.description
    assert.match(set, /JSON STRING/)
    assert.match(set, /enum values are NUMBERS/)
    assert.match(set, /class\(\/Script\/Engine\.Actor\)/)
    assert.match(tools.get('unreal_call_function')!.description, /parametersJson/)
    assert.match(tools.get('unreal_ping')!.description, /Ping/)
    assert.match(tools.get('unreal_ping')!.description, /GetEditorInfo/)
    assert.match(tools.get('unreal_get_editor_info')!.description, /PID|process id/i)
  })
})

describe('tool calls and their history rows', () => {
  let tools: Map<string, ToolDef>
  let store: RecordingStore
  let bodies: unknown[]
  let clock: number

  /** Register the tools over a fresh recorder and transport. */
  function mount(returns: unknown[]): void {
    tools = new Map()
    store = new RecordingStore()
    bodies = []
    clock = 1_000
    const deps = makeDeps(kitFetch(returns, bodies), store)
    // A monotone clock keeps durationMs deterministic across every assertion.
    const withClock: ToolDeps = { ...deps, now: () => (clock += 5) }
    registerTools(fakeHost(tools), withClock)
  }

  /** Call one tool the way the registry does. */
  function invoke(name: string, args: unknown, exec: Partial<Exec> = {}): Promise<unknown> {
    return tools.get(name)!.execute(args, { callId: 'call-1', agent: { id: 'session-a' }, ...exec })
  }

  /** The inner EditorAutomation call of one dispatcher request. */
  function inner(index: number): { functionName: string; parameters: Record<string, unknown> } {
    const parsed = innerCall(bodies[index] as { FunctionName: string; Parameters: Record<string, unknown> })
    assert.ok(parsed !== undefined, `request ${index} is not a CallFunction dispatch`)
    return parsed
  }

  beforeEach(() => {
    mount([{}])
  })

  it('unreal_ping records a successful row with the session, tool and duration', async () => {
    mount(['pong'])
    const value = await invoke('unreal_ping', {})

    assert.deepEqual(value, { pong: true, value: 'pong' })
    assert.equal(store.records.length, 1)
    const row = store.records[0]!
    assert.equal(row.tool, 'unreal_ping')
    assert.equal(row.ok, true)
    assert.equal(row.sessionId, 'session-a')
    assert.equal(row.callId, 'call-1')
    assert.equal(row.durationMs, 5)
    assert.deepEqual(row.params, {})
    assert.deepEqual(row.result, { pong: true, value: 'pong' })
    assert.equal(row.resultSummary, 'pong')
  })

  it('unreal_ping rejects a non-pong answer as a failure row', async () => {
    mount([{ not: 'pong' }])
    const error = await rejection(invoke('unreal_ping', {}))
    assert.equal(error.code, 'rc/bad-response')
    assert.equal(store.records.length, 1)
    assert.equal(store.records[0]!.ok, false)
    assert.equal(store.records[0]!.errorCode, 'rc/bad-response')
  })

  it('unreal_ping carries the editor identity when GetEditorInfo answers', async () => {
    const projectDir = 'C:\\PROJECTS\\UnrealEngine\\Game'
    mount(['pong', result({
      ProcessId: 21844,
      EngineVersion: '5.5.4',
      ProjectName: 'Game',
      ProjectDir: projectDir,
      bIsEditor: true,
    })])

    const value = await invoke('unreal_ping', {}) as Record<string, unknown>

    assert.deepEqual(value, {
      pong: true,
      value: 'pong',
      processId: 21844,
      engineVersion: '5.5.4',
      projectName: 'Game',
      projectDir,
      isEditor: true,
    })
    const row = store.records[0]!
    assert.deepEqual(row.result, value)
    assert.equal(row.resultSummary, 'pong (PID 21844, UE 5.5.4, Game)')
    // The model-facing render is the example the task asked for.
    const rendered = tools.get('unreal_ping')!.output!.render({}, value as never)
    assert.equal(rendered[0]!.text, 'EditorAutomation answered: pong (PID 21844, UE 5.5.4, Game)')
  })

  it('unreal_ping degrades to plain pong when GetEditorInfo is unavailable', async () => {
    mount(['pong', { ErrorCode: 4, ErrorMessage: 'Unknown function.', Hint: '' }])

    const value = await invoke('unreal_ping', {})

    assert.deepEqual(value, { pong: true, value: 'pong' })
    assert.equal(store.records[0]!.ok, true)
    assert.equal(store.records[0]!.resultSummary, 'pong')
    const rendered = tools.get('unreal_ping')!.output!.render({}, value as never)
    assert.equal(rendered[0]!.text, 'EditorAutomation answered: pong')
  })

  it('unreal_get_editor_info normalizes the PID and renders PID/engine/project', async () => {
    const projectDir = 'C:\\PROJECTS\\UnrealEngine\\Game'
    mount([result({
      ProcessId: '21844',
      EngineVersion: '5.5.4',
      ProjectName: 'Game',
      ProjectDir: projectDir,
      bIsEditor: true,
    })])

    const value = await invoke('unreal_get_editor_info', {}) as Record<string, unknown>

    assert.equal(value['processId'], 21844)
    assert.equal(value['engineVersion'], '5.5.4')
    assert.equal(value['projectName'], 'Game')
    assert.equal(value['projectDir'], projectDir)
    assert.equal(value['isEditor'], true)
    const text = String(value['text'])
    assert.match(text, /PID 21844/)
    assert.match(text, /UE 5\.5\.4/)
    assert.match(text, /Game/)
    assert.equal(store.records[0]!.tool, 'unreal_get_editor_info')
    assert.equal(store.records[0]!.ok, true)
    assert.equal(store.records[0]!.resultSummary, text)
    const rendered = tools.get('unreal_get_editor_info')!.output!.render({}, value as never)
    assert.equal(rendered[0]!.text, text)
  })

  it('unreal_get_editor_info degrades an Engine error to an empty identity', async () => {
    mount([result({ ErrorCode: 1, ErrorMessage: 'Not in an editor.' })])

    const value = await invoke('unreal_get_editor_info', {}) as Record<string, unknown>

    assert.equal(value['processId'], undefined)
    assert.equal(store.records[0]!.ok, true)
  })

  it('unreal_get_enum_info maps entries and records the target Type', async () => {
    mount([result({
      Info: {
        Enum: '/Script/Engine.ECollisionEnabled',
        Entries: [
          { Name: 'NoCollision', DisplayName: 'No Collision', Value: 0 },
          { Name: 'QueryAndPhysics', DisplayName: 'Query And Physics', Value: 3 },
        ],
      },
    })])

    const value = await invoke('unreal_get_enum_info', { type: 'enum(/Script/Engine.ECollisionEnabled)' }) as Record<string, unknown>

    assert.equal(value['count'], 2)
    assert.deepEqual((value['rows'] as unknown[])[1], {
      name: 'QueryAndPhysics',
      displayName: 'Query And Physics',
      value: 3,
    })
    assert.match(String(value['text']), /3 = QueryAndPhysics/)
    assert.deepEqual(inner(0), {
      functionName: 'GetEnumInfo',
      parameters: { Type: 'enum(/Script/Engine.ECollisionEnabled)' },
    })
    const row = store.records[0]!
    assert.equal(row.targetType, 'enum(/Script/Engine.ECollisionEnabled)')
    assert.equal(row.sessionId, 'session-a')
  })

  it('maps an engine ErrorCode to editorautomation/<name> and records the failure', async () => {
    mount([result({ ErrorCode: 3, ErrorMessage: 'No enum named that.', Hint: 'Pass enum(/Script/...).' })])

    const error = await rejection(invoke('unreal_get_enum_info', { type: 'enum(/Script/Bogus)' }))

    assert.equal(error.code, 'editorautomation/GetEnumInfoFailed')
    assert.match(error.message, /returned nothing for enum\(/)
    assert.match(error.message, /Hint: Call unreal_get_recent_log/)
    const row = store.records[0]!
    assert.equal(row.ok, false)
    assert.equal(row.errorCode, 'editorautomation/GetEnumInfoFailed')
    // The target is recorded even though the call failed.
    assert.equal(row.targetType, 'enum(/Script/Bogus)')
  })

  it('validates inputs before touching the editor', async () => {
    const error = await rejection(invoke('unreal_get_enum_info', { type: '   ' }))
    assert.equal(error.code, 'editorautomation/invalid-argument')
    assert.equal(bodies.length, 0)
    assert.equal(store.records[0]!.ok, false)
    assert.equal(store.records[0]!.errorCode, 'editorautomation/invalid-argument')
  })

  it('unreal_get_class_info maps properties, functions and parameter directions', async () => {
    mount([result({
      Info: {
        Class: '/Script/Engine.StaticMeshComponent',
        Properties: [{ Name: 'RelativeLocation', Type: 'struct(/Script/CoreUObject.Vector)' }],
        Functions: [{
          Name: 'GetClosestPointOnCollision',
          bBlueprintCallable: true,
          bBlueprintPure: true,
          bStatic: false,
          Parameters: [
            { Name: 'Point', Type: 'struct(/Script/CoreUObject.Vector)', Direction: 0 },
            { Name: 'OutDistance', Type: 'double', Direction: 1 },
          ],
          ReturnType: 'double',
        }],
      },
    })])

    const value = await invoke('unreal_get_class_info', { type: 'class(/Script/Engine.StaticMeshComponent)' }) as {
      propertyCount: number
      functionCount: number
      functions: { name: string; parameters: { name: string; direction: string }[]; returnType: string }[]
      text: string
    }

    assert.equal(value.propertyCount, 1)
    assert.equal(value.functionCount, 1)
    assert.equal(value.functions[0]!.name, 'GetClosestPointOnCollision')
    assert.deepEqual(value.functions[0]!.parameters.map(parameter => [parameter.name, parameter.direction]), [
      ['Point', 'input'],
      ['OutDistance', 'output'],
    ])
    assert.equal(value.functions[0]!.returnType, 'double')
    assert.match(value.text, /GetClosestPointOnCollision\(Point: struct\(\/Script\/CoreUObject\.Vector\), output OutDistance: double\) -> double/)
    assert.equal(store.records[0]!.targetType, 'class(/Script/Engine.StaticMeshComponent)')
  })

  it('unreal_get_function_info returns parameters and the return Type', async () => {
    mount([result({
      Info: {
        Name: 'SetStaticMesh',
        bBlueprintCallable: true,
        Parameters: [{ Name: 'NewMesh', Type: 'object(/Script/Engine.StaticMesh)', Direction: 0 }],
        ReturnType: '',
      },
    })])

    const value = await invoke('unreal_get_function_info', {
      type: 'class(/Script/Engine.StaticMeshComponent)',
      functionName: 'SetStaticMesh',
    }) as { parameters: unknown[]; returnType: string }

    assert.equal(value.parameters.length, 1)
    assert.equal(value.returnType, '')
    const row = store.records[0]!
    assert.equal(row.functionName, 'SetStaticMesh')
    assert.equal(row.targetType, 'class(/Script/Engine.StaticMeshComponent)')
  })

  it('unreal_get_property_type mirrors the result struct Type', async () => {
    mount([result({ Type: 'struct(/Script/CoreUObject.Vector)' })])

    const value = await invoke('unreal_get_property_type', {
      type: 'class(/Script/Engine.SceneComponent)',
      propertyPath: 'RelativeLocation',
    }) as { propertyType: string }

    assert.equal(value.propertyType, 'struct(/Script/CoreUObject.Vector)')
    const row = store.records[0]!
    assert.equal(row.propertyPath, 'RelativeLocation')
    assert.equal(row.propertyType, 'struct(/Script/CoreUObject.Vector)')
  })

  it('unreal_get_object_class mirrors the result struct and records the resolved class', async () => {
    mount([result({ ClassType: 'class(/Script/Engine.StaticMeshComponent)' })])

    const value = await invoke('unreal_get_object_class', {
      objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
    }) as { objectPath: string; classType: string; cached: boolean }

    assert.equal(value.classType, 'class(/Script/Engine.StaticMeshComponent)')
    assert.equal(value.cached, false)
    assert.deepEqual(inner(0), {
      functionName: 'GetObjectClass',
      parameters: { ObjectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1' },
    })
    const row = store.records[0]!
    assert.equal(row.tool, 'unreal_get_object_class')
    assert.equal(row.objectPath, '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1')
    assert.equal(row.targetType, 'class(/Script/Engine.StaticMeshComponent)')
    // Row summaries use a short Type label, not the canonical string.
    assert.equal(row.resultSummary, 'class StaticMeshComponent')
  })

  it('unreal_get_object_class reports an unknown object as editorautomation/GetObjectClassFailed', async () => {
    mount([result({ ErrorCode: 2, ErrorMessage: 'No object.', Hint: 'Use a loaded selection.' })])
    const error = await rejection(invoke('unreal_get_object_class', { objectPath: '/Game/Missing.Missing' }))
    assert.equal(error.code, 'editorautomation/GetObjectClassFailed')
    const row = store.records[0]!
    assert.equal(row.ok, false)
    assert.equal(row.errorCode, 'editorautomation/GetObjectClassFailed')
    assert.equal(row.objectPath, '/Game/Missing.Missing')
  })

  it('unreal_get_property_value returns both the raw text and the parsed value', async () => {
    mount([result({ ValueJson: '{"X":"1.0","Y":"2.0","Z":"3.0"}' })])

    const value = await invoke('unreal_get_property_value', {
      objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      propertyPath: 'RelativeLocation',
    }) as { valueJson: string; value: unknown }

    assert.equal(value.valueJson, '{"X":"1.0","Y":"2.0","Z":"3.0"}')
    assert.deepEqual(value.value, { X: '1.0', Y: '2.0', Z: '3.0' })
    assert.equal(store.records[0]!.objectPath, '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1')
    assert.equal(store.records[0]!.propertyPath, 'RelativeLocation')
    // A collapsed-row summary must not be the raw ValueJson blob.
    assert.equal(store.records[0]!.resultSummary, 'X, Y, Z')
    assert.ok(!String(store.records[0]!.resultSummary).trimStart().startsWith('{'))
  })

  it('unreal_get_property_value reports unparsable ValueJson instead of throwing', async () => {
    mount([result({ ValueJson: 'not json' })])

    const value = await invoke('unreal_get_property_value', {
      objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      propertyPath: 'RelativeLocation',
    }) as { value: unknown; parseError?: string }

    assert.equal(value.value, 'not json')
    assert.match(value.parseError ?? '', /not valid JSON/)
  })

  it('unreal_set_property_value serializes a structured value and records before/after', async () => {
    mount([result({ OldValueJson: '"0.0"', NewValueJson: '"42.0"' })])

    const value = await invoke('unreal_set_property_value', {
      objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      propertyPath: 'RelativeLocation.Z',
      value: '42.0',
    }) as { changed: boolean; oldValue: unknown; newValue: unknown }

    assert.equal(value.changed, true)
    assert.equal(value.oldValue, '0.0')
    assert.equal(value.newValue, '42.0')
    assert.deepEqual(inner(0).parameters, {
      ObjectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      PropertyPath: 'RelativeLocation.Z',
      ValueJson: '"42.0"',
      bGenerateTransaction: false,
    })
    assert.deepEqual(store.records[0]!.params, {
      objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      propertyPath: 'RelativeLocation.Z',
      value: '42.0',
    })
  })

  it('unreal_set_property_value refuses two spellings of the same value', async () => {
    const error = await rejection(invoke('unreal_set_property_value', {
      objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      propertyPath: 'RelativeLocation.Z',
      value: '42.0',
      valueJson: '"42.0"',
    }))
    assert.equal(error.code, 'editorautomation/invalid-argument')
    assert.equal(bodies.length, 0)
  })

  it('unreal_set_property_value passes raw valueJson through verbatim', async () => {
    mount([result({ OldValueJson: '"{}"', NewValueJson: '{"X":"1"}' })])

    await invoke('unreal_set_property_value', {
      objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      propertyPath: 'RelativeLocation',
      valueJson: '{"X":"1"}',
      generateTransaction: true,
    })

    assert.deepEqual(inner(0).parameters, {
      ObjectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      PropertyPath: 'RelativeLocation',
      ValueJson: '{"X":"1"}',
      bGenerateTransaction: true,
    })
  })

  it('unreal_call_function sends {}, parses the return value and out parameters', async () => {
    mount([result({
      ReturnValueJson: '"Hello"',
      OutParametersJson: '{"OutCount":"3"}',
      ReturnType: 'string',
    })])

    const value = await invoke('unreal_call_function', {
      objectPath: '/Script/Engine.Default__KismetSystemLibrary',
      functionName: 'GetDisplayName',
    }) as { returnValue: unknown; outParameters: unknown; returnType: string; returnedNothing: boolean }

    assert.equal(value.returnValue, 'Hello')
    assert.deepEqual(value.outParameters, { OutCount: '3' })
    assert.equal(value.returnType, 'string')
    assert.equal(value.returnedNothing, false)
    assert.deepEqual((bodies[0] as { Parameters: unknown }).Parameters, {
      ObjectPath: '/Script/Engine.Default__KismetSystemLibrary',
      FunctionName: 'GetDisplayName',
      ParametersJson: '{}',
      bGenerateTransaction: false,
    })
    assert.equal(store.records[0]!.functionName, 'GetDisplayName')
  })

  it('unreal_call_function treats an empty return value as success and nothing returned', async () => {
    mount([result({ ReturnValueJson: '', OutParametersJson: '{}', ReturnType: '' })])

    const value = await invoke('unreal_call_function', {
      objectPath: '/Script/Engine.Default__Actor',
      functionName: 'K2_DestroyActor',
    }) as { returnedNothing: boolean }

    assert.equal(value.returnedNothing, true)
    assert.equal(store.records[0]!.ok, true)
  })

  it('unreal_call_function serializes structured parameters to text', async () => {
    mount([result({ ReturnValueJson: 'true', OutParametersJson: '{}', ReturnType: 'bool' })])

    await invoke('unreal_call_function', {
      objectPath: '/Script/Engine.Default__Actor',
      functionName: 'SetActorHiddenInGame',
      parameters: { bNewHidden: 'true' },
    })

    assert.equal(
      (bodies[0] as { Parameters: { ParametersJson: string } }).Parameters.ParametersJson,
      '{"bNewHidden":"true"}',
    )
  })

  it('unreal_call_functions sends one batch and parses per-call results', async () => {
    mount([{
      bSuccess: true,
      ErrorMessage: '',
      Results: [
        {
          Index: 0,
          ObjectPath: '/Script/EditorAutomation.Default__EditorAutomationCoreLibrary',
          FunctionName: 'Ping',
          ErrorCode: 0,
          ErrorMessage: '',
          Hint: '',
          ReturnValueJson: '"pong"',
          OutParametersJson: '{}',
          ReturnType: 'string',
        },
        {
          Index: 1,
          ObjectPath: '/Script/EditorAutomation.Default__EditorAutomationCoreLibrary',
          FunctionName: 'GetEditorInfo',
          ErrorCode: 3,
          ErrorMessage: 'Function was not found.',
          Hint: 'Pass a UFunction name.',
          ReturnValueJson: '',
          OutParametersJson: '{}',
          ReturnType: '',
        },
      ],
    }])

    const value = await invoke('unreal_call_functions', {
      calls: [
        { objectPath: '/Script/EditorAutomation.Default__EditorAutomationCoreLibrary', functionName: 'Ping' },
        {
          objectPath: '/Script/EditorAutomation.Default__EditorAutomationCoreLibrary',
          functionName: 'GetEditorInfo',
          parameters: { Foo: '1' },
          generateTransaction: true,
        },
      ],
    }) as {
      results: Array<{ ok: boolean; returnValue: unknown; errorCode: number; errorMessage: string }>
      failed: number
      calls: Array<{ parametersJson: string }>
    }

    assert.equal(
      (bodies[0] as { Parameters: { CallsJson: string } }).Parameters.CallsJson,
      '[{"objectPath":"/Script/EditorAutomation.Default__EditorAutomationCoreLibrary","functionName":"Ping","parametersJson":"{}","generateTransaction":false},' +
        '{"objectPath":"/Script/EditorAutomation.Default__EditorAutomationCoreLibrary","functionName":"GetEditorInfo","parametersJson":"{\\"Foo\\":\\"1\\"}","generateTransaction":true}]',
    )
    assert.equal(value.results[0]!.ok, true)
    assert.equal(value.results[0]!.returnValue, 'pong')
    assert.equal(value.results[1]!.ok, false)
    assert.equal(value.results[1]!.errorCode, 3)
    assert.equal(value.failed, 1)
    assert.equal(store.records[0]!.ok, true)
  })

  it('unreal_call_functions raises a batch-level failure as a tool error', async () => {
    mount([{ bSuccess: false, ErrorMessage: 'CallsJson is an empty array.', Results: [] }])

    const error = await rejection(invoke('unreal_call_functions', {
      calls: [{ objectPath: '/Script/Engine.Default__Actor', functionName: 'K2_DestroyActor' }],
    }))

    assert.equal(error.code, 'editorautomation/CallFunctionsFailed')
    assert.match(error.message, /empty array/)
    assert.equal(store.records[0]!.ok, false)
  })

  it('unreal_screenshot waits for the game-viewport PNG and reports its size', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-unreal-shot-'))
    const filePath = join(directory, 'shot.png')
    await writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    mount([{ bSuccess: true, bRequested: true, FilePath: filePath, ErrorMessage: '' }])

    const value = await invoke('unreal_screenshot', { target: 'game' }) as {
      exists: boolean
      bytes: number
      requested: boolean
      filePath: string
    }

    assert.equal(value.exists, true)
    assert.equal(value.bytes, 4)
    assert.equal(value.requested, true)
    assert.equal(value.filePath, filePath)
    const sent = inner(0).parameters
    assert.equal(sent['Target'], 0)
    assert.equal(sent['bShowUI'], true)
    const sentPath = String(sent['FilePath'])
    assert.ok(sentPath.endsWith('.png'), `expected a generated PNG path, got ${sentPath}`)
    assert.match(sentPath, /dsh-unreal[\\/]screenshots/, `expected the adapter temp directory, got ${sentPath}`)
    // The record keeps the same path and a preview section the card renders from the host.
    assert.equal(store.records[0]!.result && (store.records[0]!.result as Record<string, unknown>)['filePath'], filePath)
    assert.equal(store.records[0]!.details?.sections[0]?.kind, 'screenshot')
    await rm(directory, { recursive: true, force: true })
  })

  it('unreal_screenshot sends the editor-window target and raises Engine failures', async () => {
    mount([{ bSuccess: false, bRequested: false, FilePath: '', ErrorMessage: 'No active editor window to capture.' }])

    const error = await rejection(invoke('unreal_screenshot', { target: 'editor', filePath: 'C:/tmp/x.png', showUI: false }))

    assert.equal(error.code, 'editorautomation/CaptureScreenshotFailed')
    assert.match(error.message, /no PNG path/)
    assert.deepEqual(inner(0).parameters, {
      FilePath: 'C:/tmp/x.png',
      Target: 1,
      bShowUI: false,
    })
  })

  it('unreal_get_recent_log reaches EditorAutomation through the CallFunction dispatcher', async () => {
    mount([result({
      ReturnValueJson: '{"Entries":[{"Time":"12:00:00","Verbosity":"2","Category":"LogPython","Message":"boom"}],"TotalRecorded":"5","bTruncated":"false"}',
      OutParametersJson: '{}',
      ReturnType: 'struct(/Script/EditorAutomation.EditorAutomationLogPage)',
    })])

    const value = await invoke('unreal_get_recent_log', { maxLines: 50, minVerbosity: 'error', categoryFilter: 'LogPython' }) as {
      entries: Array<{ time: string; verbosity: number; category: string; message: string }>
      count: number
      truncated: boolean
      totalRecorded: number
    }

    assert.deepEqual(value.entries, [{ time: '12:00:00', verbosity: 2, category: 'LogPython', message: 'boom' }])
    assert.equal(value.count, 1)
    assert.equal(value.truncated, false)
    assert.equal(value.totalRecorded, 5)
    const sent = (bodies[0] as { Parameters: { FunctionName: string; ParametersJson: string } }).Parameters
    assert.equal(sent.FunctionName, 'GetRecentLog')
    assert.deepEqual(JSON.parse(sent.ParametersJson), {
      MaxLines: 50,
      MinVerbosity: 2,
      CategoryFilter: 'LogPython',
      bClear: false,
    })
  })

  it('unreal_save_blueprint routes through CallFunction and raises the logged failure', async () => {
    mount([result({ ReturnValueJson: '"false"', OutParametersJson: '{}', ReturnType: 'bool' })])

    const error = await rejection(invoke('unreal_save_blueprint', { blueprint: '/Game/UI/WBP_Test.WBP_Test' }))

    assert.equal(error.code, 'editorautomation/SaveBlueprintFailed')
    assert.match(error.message, /could not be saved|reported failure|WBP_Test/)
    const sent = (bodies[0] as { Parameters: { ObjectPath: string; FunctionName: string; ParametersJson: string } }).Parameters
    assert.equal(sent.ObjectPath, '/Script/EditorAutomation.Default__EditorAutomationBlueprintLibrary')
    assert.equal(sent.FunctionName, 'SaveBlueprint')
    assert.deepEqual(JSON.parse(sent.ParametersJson), { Blueprint: '/Game/UI/WBP_Test.WBP_Test' })
  })

  it('unreal_get_blueprint_info decodes the nested-JSON blueprint struct', async () => {
    mount([result({
      ReturnValueJson:
        '{"AssetPath":"/Game/UI/WBP_Test.WBP_Test","AssetClass":"/Script/UMGEditor.WidgetBlueprint",' +
        '"ParentClass":"","GeneratedClass":null,"BlueprintType":"0","Status":"3","bDirty":"true","bBeingCompiled":"false"}',
      OutParametersJson: '{}',
      ReturnType: 'struct(/Script/EditorAutomation.EditorAutomationBlueprintInfo)',
    })])

    const value = await invoke('unreal_get_blueprint_info', { blueprint: '/Game/UI/WBP_Test.WBP_Test' }) as {
      assetPath: string
      assetClass: string
      parentClass: string
      generatedClass: string
      blueprintType: number
      status: number
      dirty: boolean
      beingCompiled: boolean
    }

    assert.equal(value.assetPath, '/Game/UI/WBP_Test.WBP_Test')
    assert.equal(value.assetClass, '/Script/UMGEditor.WidgetBlueprint')
    assert.equal(value.parentClass, '')
    assert.equal(value.generatedClass, '')
    assert.equal(value.blueprintType, 0)
    assert.equal(value.status, 3)
    assert.equal(value.dirty, true)
    assert.equal(value.beingCompiled, false)
  })

  it('unreal_get_current_level_info decodes the nested-JSON level struct', async () => {
    mount([result({
      ReturnValueJson: '{"LevelPath":"/Game/Maps/L_Snake","LevelName":"L_Snake","bDirty":"true"}',
      OutParametersJson: '{}',
      ReturnType: 'struct(/Script/EditorAutomation.EditorAutomationLevelInfo)',
    })])

    const value = await invoke('unreal_get_current_level_info', {}) as {
      levelPath: string
      levelName: string
      dirty: boolean
    }

    assert.equal(value.levelPath, '/Game/Maps/L_Snake')
    assert.equal(value.levelName, 'L_Snake')
    assert.equal(value.dirty, true)
    const sent = (bodies[0] as { Parameters: { ObjectPath: string; FunctionName: string } }).Parameters
    assert.equal(sent.ObjectPath, '/Script/EditorAutomation.Default__EditorAutomationLevelLibrary')
    assert.equal(sent.FunctionName, 'GetCurrentLevelInfo')
  })

  it('unreal_save_current_level succeeds when the dispatcher reports true', async () => {
    mount([result({ ReturnValueJson: '"true"', OutParametersJson: '{}', ReturnType: 'bool' })])

    const value = await invoke('unreal_save_current_level', {}) as { success: boolean }

    assert.equal(value.success, true)
    const sent = (bodies[0] as { Parameters: { FunctionName: string } }).Parameters
    assert.equal(sent.FunctionName, 'SaveCurrentLevel')
  })

  it('unreal_add_branch_node returns the new node path through CallFunction', async () => {
    mount([result({
      ReturnValueJson: '"/Game/UI/WBP_Test.WBP_Test:EventGraph.K2Node_IfThenElse_0"',
      OutParametersJson: '{}',
      ReturnType: 'string',
    })])

    const value = await invoke('unreal_add_branch_node', { graph: '/Game/UI/WBP_Test.WBP_Test:EventGraph', nodePosX: 10, nodePosY: 20 }) as {
      nodeObjectPath: string
    }

    assert.equal(value.nodeObjectPath, '/Game/UI/WBP_Test.WBP_Test:EventGraph.K2Node_IfThenElse_0')
    const sent = (bodies[0] as { Parameters: { ObjectPath: string; FunctionName: string; ParametersJson: string } }).Parameters
    assert.equal(sent.ObjectPath, '/Script/EditorAutomation.Default__EditorAutomationGraphLibrary')
    assert.equal(sent.FunctionName, 'AddBranchNode')
    assert.deepEqual(JSON.parse(sent.ParametersJson), { Graph: '/Game/UI/WBP_Test.WBP_Test:EventGraph', NodePosX: 10, NodePosY: 20 })
  })

  it('unreal_connect_pins raises the logged failure when the schema rejects the link', async () => {
    mount([result({ ReturnValueJson: '"false"', OutParametersJson: '{}', ReturnType: 'bool' })])

    const error = await rejection(invoke('unreal_connect_pins', {
      fromNode: '/Game/N_From',
      fromPinName: 'then',
      toNode: '/Game/N_To',
      toPinName: 'execute',
    }))

    assert.equal(error.code, 'editorautomation/ConnectPinsFailed')
    assert.match(error.message, /ConnectPins reported failure/)
  })

  it('unreal_get_blueprint_graphs decodes the graph array through CallFunction', async () => {
    mount([result({
      ReturnValueJson:
        '[{"GraphName":"EventGraph","GraphClassPath":"/Script/Engine.EdGraph","GraphObjectPath":"/Game/UI/WBP_Test.WBP_Test:EventGraph"}]',
      OutParametersJson: '{}',
      ReturnType: 'array(struct(/Script/EditorAutomation.EditorAutomationBlueprintGraphInfo))',
    })])

    const value = await invoke('unreal_get_blueprint_graphs', { blueprint: '/Game/UI/WBP_Test.WBP_Test' }) as {
      graphs: Array<{ graphName: string; graphClassPath: string; graphObjectPath: string }>
      count: number
    }

    assert.equal(value.count, 1)
    assert.deepEqual(value.graphs[0], {
      graphName: 'EventGraph',
      graphClassPath: '/Script/Engine.EdGraph',
      graphObjectPath: '/Game/UI/WBP_Test.WBP_Test:EventGraph',
    })
  })

  it('records no session id when the call is not agent-scoped', async () => {
    mount(['pong'])
    await invoke('unreal_ping', {}, { callId: '', agent: undefined })

    assert.equal(store.records[0]!.sessionId, undefined)
    assert.equal(store.records[0]!.callId, undefined)
    assert.match(store.records[0]!.id, /^\d+-[0-9a-f-]{36}$/)
  })
})
