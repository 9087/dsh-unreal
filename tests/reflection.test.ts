/**
 * Tests for the cached reflection service: the same key is fetched once, each
 * operation keys on its own arguments, transport failures invalidate the cache,
 * and editor errors are retried rather than remembered.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { EditorAutomationClient } from '../src/kit/client.ts'
import type { FetchLike } from '../src/kit/client.ts'
import { KitError } from '../src/kit/errors.ts'
import { ReflectionService, cacheKey, isTransportFailure, normalizeProcessId } from '../src/kit/reflection.ts'
import { withRcCapture } from '../src/audit-capture.ts'
import type { RcCallSnapshot } from '../src/audit-capture.ts'
import { SchemaCache } from '../src/schema-cache.ts'
import { innerCall, wrapCallFunctionAnswer } from './support/dispatcher-fixtures.ts'

/** One captured request. */
interface Captured {
  readonly functionName: string
  readonly parameters: Record<string, unknown>
}

/** A transport whose answer is chosen per EditorAutomation function. */
function dispatch(
  handlers: Record<string, (parameters: Record<string, unknown>) => unknown>,
  captured: Captured[] = [],
  failWith?: () => Error | undefined,
): FetchLike {
  return async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { FunctionName: string; Parameters: Record<string, unknown> }
    const inner = innerCall(body)
    const injected = failWith?.()
    if (injected !== undefined) throw injected
    if (inner === undefined) {
      captured.push({ functionName: body.FunctionName, parameters: body.Parameters })
      const handler = handlers[body.FunctionName]
      const value = handler === undefined ? {} : handler(body.Parameters)
      return new Response(JSON.stringify({ ReturnValue: value }), { status: 200 })
    }
    captured.push({ functionName: inner.functionName, parameters: inner.parameters })
    const handler = handlers[inner.functionName]
    const legacy = handler === undefined ? {} : handler(inner.parameters)
    return new Response(JSON.stringify({ ReturnValue: wrapCallFunctionAnswer(inner.functionName, legacy) }), { status: 200 })
  }
}

/** One successful result struct. */
function ok(extra: Record<string, unknown>): Record<string, unknown> {
  return { ErrorCode: 0, ErrorMessage: '', Hint: '', ...extra }
}

/** Build a service over a fresh client and cache. */
function service(
  handlers: Record<string, (parameters: Record<string, unknown>) => unknown>,
  options: { captured?: Captured[]; failWith?: () => Error | undefined; ttlMs?: number; now?: () => number } = {},
): { reflection: ReflectionService; cache: SchemaCache; client: EditorAutomationClient; captured: Captured[] } {
  const captured = options.captured ?? []
  const client = new EditorAutomationClient(
    { baseUrl: 'http://127.0.0.1:30010', requestTimeoutMs: 500 },
    dispatch(handlers, captured, options.failWith),
  )
  const cache = new SchemaCache({
    ttlMs: options.ttlMs ?? 60_000,
    maxEntries: 100,
    now: options.now ?? (() => 1_000),
  })
  return { reflection: new ReflectionService({ client, cache }), cache, client, captured }
}

/** The standard enum answer. */
const ENUM = (): unknown => ok({
  Info: {
    Enum: '/Script/Engine.ECollisionEnabled',
    Entries: [
      { Name: 'NoCollision', DisplayName: 'No Collision', Value: 0 },
      { Name: 'QueryAndPhysics', DisplayName: 'Query And Physics', Value: 3 },
    ],
  },
})

/** The standard function answer. */
const FUNCTION = (): unknown => ok({
  Info: {
    Name: 'GetDisplayName',
    bBlueprintCallable: true,
    Parameters: [{ Name: 'Object', Type: 'object(/Script/Engine.Object)', Direction: 0 }],
    ReturnType: 'string',
  },
})

describe('ReflectionService caching', () => {
  it('fetches one enum Type once and serves the second lookup from cache', async () => {
    const captured: Captured[] = []
    const { reflection, cache } = service({ GetEnumInfo: ENUM }, { captured })

    const first = await reflection.enumInfo('enum(/Script/Engine.ECollisionEnabled)')
    const second = await reflection.enumInfo('enum(/Script/Engine.ECollisionEnabled)')

    assert.equal(captured.length, 1)
    assert.equal(first.cached, false)
    assert.equal(second.cached, true)
    assert.deepEqual(second.value.entries.map(entry => entry.name), ['NoCollision', 'QueryAndPhysics'])
    assert.equal(cache.stats().hits, 1)
  })

  it('replays the original RC call when the cached answer is reused', async () => {
    const captured: Captured[] = []
    const { reflection } = service({ GetEnumInfo: ENUM }, { captured })
    const calls: RcCallSnapshot[] = []

    await withRcCapture(calls, async () => {
      await reflection.enumInfo('enum(/Script/Engine.ECollisionEnabled)')
      const afterMiss = calls.length
      await reflection.enumInfo('enum(/Script/Engine.ECollisionEnabled)')
      // The cache hit made no request, but the tool logically made the call: the same
      // request/answer is replayed so its card keeps the reflected Inputs/Outputs.
      assert.equal(calls.length, afterMiss + 1)
      assert.equal(calls.at(-1)?.functionName, 'GetEnumInfo')
      assert.deepEqual(JSON.parse(calls.at(-1)?.parametersJson ?? '{}'), { Type: 'enum(/Script/Engine.ECollisionEnabled)' })
      assert.match(calls.at(-1)?.outParametersJson ?? '', /ECollisionEnabled/)
    })
    assert.equal(captured.length, 1)
  })

  it('keys each operation on its own arguments', async () => {
    const captured: Captured[] = []
    const { reflection } = service(
      {
        GetEnumInfo: ENUM,
        GetFunctionInfo: FUNCTION,
        GetStructInfo: () => ok({ Info: { Struct: '/Script/CoreUObject.Vector', Properties: [{ Name: 'X', Type: 'double' }] } }),
        GetPropertyType: (parameters) => ok({ Type: parameters['PropertyPath'] === 'RelativeLocation' ? 'struct(/Script/CoreUObject.Vector)' : 'double' }),
      },
      { captured },
    )

    await reflection.enumInfo('enum(/Script/Engine.ECollisionEnabled)')
    await reflection.enumInfo('enum(/Script/Engine.EComponentMobility)')
    await reflection.functionInfo('class(/Script/Engine.KismetSystemLibrary)', 'GetDisplayName')
    await reflection.functionInfo('class(/Script/Engine.KismetSystemLibrary)', 'GetDisplayName')
    await reflection.structInfo('struct(/Script/CoreUObject.Vector)')
    await reflection.propertyType('class(/Script/Engine.StaticMeshComponent)', 'RelativeLocation')
    await reflection.propertyType('class(/Script/Engine.StaticMeshComponent)', 'RelativeLocation')
    await reflection.propertyType('class(/Script/Engine.StaticMeshComponent)', 'RelativeLocation.X')

    const byFunction = (name: string): number => captured.filter(request => request.functionName === name).length
    assert.equal(byFunction('GetEnumInfo'), 2)
    assert.equal(byFunction('GetFunctionInfo'), 1)
    assert.equal(byFunction('GetStructInfo'), 1)
    assert.equal(byFunction('GetPropertyType'), 2)
  })

  it('maps the result structs to the canonical views', async () => {
    const { reflection } = service({ GetEnumInfo: ENUM, GetFunctionInfo: FUNCTION })
    const enumInfo = await reflection.enumInfo('enum(/Script/Engine.ECollisionEnabled)')
    assert.equal(enumInfo.value.path, '/Script/Engine.ECollisionEnabled')
    assert.deepEqual(enumInfo.value.entries[1], {
      name: 'QueryAndPhysics',
      displayName: 'Query And Physics',
      value: 3,
    })
    const info = await reflection.functionInfo('class(/Script/Engine.KismetSystemLibrary)', 'GetDisplayName')
    assert.deepEqual(info.value.function.parameters, [
      { name: 'Object', type: 'object(/Script/Engine.Object)', direction: 'input' },
    ])
    assert.equal(info.value.function.returnType, 'string')
  })

  it('shares one load between concurrent misses', async () => {
    const captured: Captured[] = []
    const { reflection } = service({ GetEnumInfo: ENUM }, { captured })
    const [a, b] = await Promise.all([
      reflection.enumInfo('enum(/Script/Engine.ECollisionEnabled)'),
      reflection.enumInfo('enum(/Script/Engine.ECollisionEnabled)'),
    ])
    assert.equal(captured.length, 1)
    assert.deepEqual([a.source, b.source].sort(), ['fetched', 'single-flight'])
  })

  it('honours the TTL', async () => {
    let now = 1_000
    const captured: Captured[] = []
    const { reflection } = service({ GetEnumInfo: ENUM }, { captured, now: () => now })
    await reflection.enumInfo('enum(/Script/Engine.ECollisionEnabled)')
    now += 60_000
    const expired = await reflection.enumInfo('enum(/Script/Engine.ECollisionEnabled)')
    assert.equal(captured.length, 2)
    assert.equal(expired.cached, false)
  })
})

describe('ReflectionService failure handling', () => {
  it('does not cache an EditorAutomation error, so a retry asks again', async () => {
    const captured: Captured[] = []
    let failures = 1
    const answers = {
      GetEnumInfo: () => failures-- > 0
        ? { ErrorCode: 3, ErrorMessage: 'No enum.', Hint: 'Pass a Type.' }
        : ENUM(),
    }
    const { reflection } = service(answers, { captured })

    await assert.rejects(reflection.enumInfo('enum(/Script/Bogus)'), (error: unknown) => {
      assert.ok(error instanceof KitError)
      assert.equal(error.code, 'editorautomation/GetEnumInfoFailed')
      return true
    })
    const retried = await reflection.enumInfo('enum(/Script/Bogus)')
    assert.equal(retried.value.entries.length, 2)
    assert.equal(captured.length, 2)
  })

  it('clears the cache after a transport failure', async () => {
    const captured: Captured[] = []
    let fail = false
    const { reflection, cache } = service(
      { GetEnumInfo: ENUM, GetStructInfo: () => { throw new TypeError('fetch failed') } },
      { captured, failWith: () => (fail ? new TypeError('fetch failed') : undefined) },
    )

    await reflection.enumInfo('enum(/Script/Engine.ECollisionEnabled)')
    assert.equal(cache.size, 1)

    // The next lookup misses the transport: the editor is presumed gone, so
    // every cached shape is suspect.
    fail = true
    await assert.rejects(
      reflection.structInfo('struct(/Script/CoreUObject.Vector)'),
      (error: unknown) => {
        assert.ok(error instanceof KitError)
        assert.equal(error.code, 'rc/unreachable')
        assert.equal(isTransportFailure(error), true)
        return true
      },
    )
    assert.equal(cache.size, 0)

    fail = false
    const refetched = await reflection.enumInfo('enum(/Script/Engine.ECollisionEnabled)')
    assert.equal(refetched.cached, false)
    assert.equal(captured.filter(request => request.functionName === 'GetEnumInfo').length, 2)
  })

  it('leaves the cache alone for an editor-answer error', async () => {
    const { reflection, cache } = service({
      GetEnumInfo: () => ({ ErrorCode: 3, ErrorMessage: 'No enum.' }),
      GetStructInfo: () => ok({ Info: { Struct: '/Script/CoreUObject.Vector', Properties: [] } }),
    })
    await reflection.structInfo('struct(/Script/CoreUObject.Vector)')
    assert.equal(cache.size, 1)
    await assert.rejects(reflection.enumInfo('enum(/Script/Bogus)'), /No enum\./)
    assert.equal(cache.size, 1)
  })
})

describe('object-class cache', () => {
  const CLASS = (parameters: Record<string, unknown>): unknown => ok({
    ClassType: String(parameters['ObjectPath'] ?? '').includes('Cube')
      ? 'class(/Script/Engine.StaticMeshComponent)'
      : 'class(/Script/Engine.Actor)',
  })

  it('resolves one object path once and caches the ClassType', async () => {
    const captured: Captured[] = []
    const { reflection, cache } = service({ GetObjectClass: CLASS }, { captured })

    const first = await reflection.objectClass('/Game/Maps/Demo.Demo:PersistentLevel.Cube_1')
    const second = await reflection.objectClass('/Game/Maps/Demo.Demo:PersistentLevel.Cube_1')

    assert.equal(captured.length, 1)
    assert.equal(captured[0]?.functionName, 'GetObjectClass')
    assert.deepEqual(captured[0]?.parameters, { ObjectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1' })
    assert.equal(first.value.classType, 'class(/Script/Engine.StaticMeshComponent)')
    assert.equal(first.cached, false)
    assert.equal(second.cached, true)
    assert.equal(cache.stats().hits, 1)
  })

  it('keys the cache by object path', async () => {
    const captured: Captured[] = []
    const { reflection } = service({ GetObjectClass: CLASS }, { captured })
    const cube = await reflection.objectClass('/Game/Maps/Demo.Demo:PersistentLevel.Cube_1')
    const other = await reflection.objectClass('/Game/Maps/Demo.Demo:PersistentLevel.Other_2')
    assert.equal(captured.length, 2)
    assert.equal(cube.value.classType, 'class(/Script/Engine.StaticMeshComponent)')
    assert.equal(other.value.classType, 'class(/Script/Engine.Actor)')
  })

  it('shares one object-class load between concurrent misses', async () => {
    const captured: Captured[] = []
    const { reflection } = service({ GetObjectClass: CLASS }, { captured })
    const [a, b] = await Promise.all([
      reflection.objectClass('/Game/Maps/Demo.Demo:PersistentLevel.Cube_1'),
      reflection.objectClass('/Game/Maps/Demo.Demo:PersistentLevel.Cube_1'),
    ])
    assert.equal(captured.length, 1)
    assert.deepEqual([a.source, b.source].sort(), ['fetched', 'single-flight'])
  })

  it('drops object-class entries after a transport failure', async () => {
    let fail = false
    const { reflection, cache } = service(
      { GetObjectClass: CLASS, GetEnumInfo: ENUM },
      { failWith: () => (fail ? new TypeError('fetch failed') : undefined) },
    )
    await reflection.objectClass('/Game/Maps/Demo.Demo:PersistentLevel.Cube_1')
    assert.equal(cache.size, 1)
    fail = true
    await assert.rejects(reflection.enumInfo('enum(/Script/Engine.ECollisionEnabled)'), (error: unknown) => {
      assert.ok(error instanceof KitError)
      assert.equal(error.code, 'rc/unreachable')
      return true
    })
    assert.equal(cache.size, 0)
  })

  it('does not cache an Engine error for an unknown object', async () => {
    const captured: Captured[] = []
    let objectGone = true
    const { reflection } = service({
      GetObjectClass: () => (objectGone
        ? { ErrorCode: 2, ErrorMessage: 'No object.', Hint: '' }
        : ok({ ClassType: 'class(/Script/Engine.Actor)' })),
    }, { captured })
    await assert.rejects(reflection.objectClass('/Game/Bad.Path'), /No object\./)
    objectGone = false
    const resolved = await reflection.objectClass('/Game/Bad.Path')
    assert.equal(resolved.value.classType, 'class(/Script/Engine.Actor)')
    assert.equal(captured.length, 2)
  })
})

describe('getEditorInfo', () => {
  it('normalizes a string ProcessId and maps every identity field', async () => {
    const captured: Captured[] = []
    const { reflection } = service({
      GetEditorInfo: () => ok({
        ProcessId: '21844',
        EngineVersion: '5.5.4',
        ProjectName: 'Game',
        ProjectDir: 'C:\\PROJECTS\\UnrealEngine\\Game',
        bIsEditor: true,
      }),
    }, { captured })

    const info = await reflection.getEditorInfo()

    assert.deepEqual(info, {
      processId: 21844,
      engineVersion: '5.5.4',
      projectName: 'Game',
      projectDir: 'C:\\PROJECTS\\UnrealEngine\\Game',
      isEditor: true,
    })
    assert.deepEqual(captured[0], { functionName: 'GetEditorInfo', parameters: {} })
  })

  it('is not cached: the identity names the process that answers now', async () => {
    let calls = 0
    const { reflection } = service({
      GetEditorInfo: () => {
        calls += 1
        return ok({ ProcessId: 100 + calls })
      },
    })
    await reflection.getEditorInfo()
    const second = await reflection.getEditorInfo()
    assert.equal(calls, 2)
    assert.equal(second.processId, 102)
  })

  it('degrades fields the Engine did not report, keeping a usable PID', async () => {
    assert.equal(normalizeProcessId('21844'), 21844)
    assert.equal(normalizeProcessId(21844), 21844)
    assert.equal(normalizeProcessId(' 21844 '), 21844)
    assert.equal(normalizeProcessId(0), undefined)
    assert.equal(normalizeProcessId('-1'), undefined)
    assert.equal(normalizeProcessId('abc'), undefined)
    assert.equal(normalizeProcessId(undefined), undefined)

    const { reflection } = service({ GetEditorInfo: () => ok({ ProcessId: 0 }) })
    assert.deepEqual(await reflection.getEditorInfo(), {})
  })

  it('surfaces an Engine error rather than hiding it', async () => {
    const { reflection } = service({
      GetEditorInfo: () => ({ ErrorCode: 1, ErrorMessage: 'Not in an editor.', Hint: '' }),
    })
    await assert.rejects(reflection.getEditorInfo(), /Not in an editor\./)
  })
})

describe('cache keys', () => {
  it('include every argument that changes the answer', () => {
    assert.notEqual(cacheKey.function('A', 'F'), cacheKey.function('A', 'G'))
    assert.notEqual(cacheKey.function('A', 'F'), cacheKey.function('B', 'F'))
    assert.notEqual(cacheKey.propertyType('A', 'X'), cacheKey.propertyType('A', 'Y'))
    assert.equal(cacheKey.enum('enum(A)'), 'GetEnumInfo|enum(A)')
  })
})
