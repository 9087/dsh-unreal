/**
 * Tests for typed call enrichment: the Details a history row persists.
 *
 * The reflection answers are served through the real cached service over a
 * function-dispatching fake transport, so the same code path that runs in the
 * host is exercised here.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DETAIL_LIMITS,
  boundDetailValue,
  boundDetails,
  buildCallFunctionDetails,
  buildDefaultCallDetails,
  buildRcCallDetails,
  buildPropertyValueDetails,
  buildPropertyWriteDetails,
  mergeCallDetails,
} from '../src/details.ts'
import { EditorAutomationClient } from '../src/kit/client.ts'
import type { FetchLike } from '../src/kit/client.ts'
import { ReflectionService } from '../src/kit/reflection.ts'
import { classTypeFromObjectPath } from '../src/kit/type-derive.ts'
import { SchemaCache } from '../src/schema-cache.ts'
import { innerCall, wrapCallFunctionAnswer } from './support/dispatcher-fixtures.ts'

/** One captured request. */
interface Captured {
  readonly functionName: string
  readonly parameters: Record<string, unknown>
}

/** A transport that answers by EditorAutomation function name (through the CallFunction dispatcher). */
function dispatch(handlers: Record<string, (parameters: Record<string, unknown>) => unknown>, captured: Captured[] = []): FetchLike {
  return async (_url, init) => {
    const body = JSON.parse(String(init.body)) as { FunctionName: string; Parameters: Record<string, unknown> }
    const inner = innerCall(body)
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

/**
 * The handlers one call enrichment needs.
 *
 * `GetObjectClass` answers a level-instance path with the class the schema
 * lookups then accept; a test can override a handler to model an editor build
 * that has no such entry point.
 */
function editor(overrides: Record<string, (parameters: Record<string, unknown>) => unknown> = {}): Record<string, (parameters: Record<string, unknown>) => unknown> {
  return {
    GetObjectClass: (parameters) => {
      const objectPath = String(parameters['ObjectPath'] ?? '')
      if (objectPath.includes(':PersistentLevel.')) {
        return ok({ ClassType: 'class(/Script/Engine.StaticMeshComponent)' })
      }
      return { ErrorCode: 2, ErrorMessage: 'No object at that path.', Hint: '' }
    },
    GetFunctionInfo: (parameters) => {
      const functionName = String(parameters['FunctionName'] ?? '')
      if (functionName === 'GetDisplayName') {
        return ok({
          Info: {
            Name: 'GetDisplayName',
            bBlueprintCallable: true,
            Parameters: [{ Name: 'Object', Type: 'object(/Script/Engine.Object)', Direction: 0 }],
            ReturnType: 'string',
          },
        })
      }
      return ok({
        Info: {
          Name: 'GetClosestPointOnCollision',
          bBlueprintCallable: true,
          Parameters: [
            { Name: 'Point', Type: 'struct(/Script/CoreUObject.Vector)', Direction: 0 },
            { Name: 'OutDistance', Type: 'double', Direction: 1 },
          ],
          ReturnType: 'double',
        },
      })
    },
    GetStructInfo: () => ok({
      Info: {
        Struct: '/Script/CoreUObject.Vector',
        Properties: [
          { Name: 'X', Type: 'double' },
          { Name: 'Y', Type: 'double' },
          { Name: 'Z', Type: 'double' },
        ],
      },
    }),
    GetEnumInfo: () => ok({
      Info: {
        Enum: '/Script/Engine.ECollisionEnabled',
        Entries: [
          { Name: 'NoCollision', DisplayName: 'No Collision', Value: 0 },
          { Name: 'QueryAndPhysics', DisplayName: 'Query And Physics', Value: 3 },
        ],
      },
    }),
    GetPropertyType: (parameters) => {
      const path = String(parameters['PropertyPath'] ?? '')
      if (path === 'RelativeLocation') return ok({ Type: 'struct(/Script/CoreUObject.Vector)' })
      if (path === 'Mobility') return ok({ Type: 'enum(/Script/Engine.ECollisionEnabled)' })
      return ok({ Type: 'double' })
    },
    ...overrides,
  }
}

/** Build the enrichment dependencies over a fresh cache and fake transport. */
function deps(options: {
  maxChars?: number
  captured?: Captured[]
  overrides?: Record<string, (parameters: Record<string, unknown>) => unknown>
} = {}): {
  reflection: ReflectionService
  maxChars: number
  captured: Captured[]
} {
  const captured = options.captured ?? []
  const client = new EditorAutomationClient(
    { baseUrl: 'http://127.0.0.1:30010', requestTimeoutMs: 500 },
    dispatch(editor(options.overrides), captured),
  )
  const cache = new SchemaCache({ ttlMs: 60_000, maxEntries: 100, now: () => 1_000 })
  return {
    reflection: new ReflectionService({ client, cache }),
    maxChars: options.maxChars ?? 12_000,
    captured,
  }
}

describe('classTypeFromObjectPath', () => {
  it('derives a class from a class default object path', () => {
    assert.equal(
      classTypeFromObjectPath('/Script/Engine.Default__StaticMeshComponent'),
      'class(/Script/Engine.StaticMeshComponent)',
    )
    assert.equal(
      classTypeFromObjectPath('/Script/Engine.Default__KismetSystemLibrary'),
      'class(/Script/Engine.KismetSystemLibrary)',
    )
  })

  it('derives a class from a Blueprint generated class object', () => {
    assert.equal(
      classTypeFromObjectPath('/Game/Props/BP_Cube.Default__BP_Cube_C'),
      'class(/Game/Props/BP_Cube.BP_Cube_C)',
    )
    assert.equal(classTypeFromObjectPath('/Game/Props/BP_Cube.BP_Cube_C'), 'class(/Game/Props/BP_Cube.BP_Cube_C)')
  })

  it('treats an engine class object path as its own class', () => {
    assert.equal(classTypeFromObjectPath('/Script/Engine.Actor'), 'class(/Script/Engine.Actor)')
  })

  it('refuses level-instance and subobject paths, which name no class', () => {
    assert.equal(classTypeFromObjectPath('/Game/Maps/Demo.Demo:PersistentLevel.Cube_1'), undefined)
    assert.equal(classTypeFromObjectPath('/Game/Maps/Demo.Demo:PersistentLevel.Cube_1.SomeComponent'), undefined)
    assert.equal(classTypeFromObjectPath('   '), undefined)
  })
})

describe('buildCallFunctionDetails', () => {
  it('builds typed parameters, a typed return and typed out parameters', async () => {
    const details = await buildCallFunctionDetails(deps(), {
      objectPath: '/Script/Engine.Default__KismetSystemLibrary',
      functionName: 'GetDisplayName',
      parametersJson: '{"Object":"/Script/Engine.Default__Actor"}',
      result: {
        returnValueJson: '"Actor"',
        outParametersJson: '{}',
        returnType: 'string',
      },
    })

    assert.ok(details !== undefined)
    const inputs = details.sections.find(section => section.kind === 'inputs')
    assert.ok(inputs?.fields !== undefined)
    assert.equal(inputs.fields[0]?.name, 'Target')
    assert.equal(inputs.fields[0]?.value, '/Script/Engine.Default__KismetSystemLibrary')
    assert.equal(inputs.fields[0]?.type, 'object(/Script/Engine.KismetSystemLibrary)')
    assert.deepEqual(inputs.fields.find(field => field.name === 'Object'), {
      name: 'Object',
      type: 'object(/Script/Engine.Object)',
      direction: 'input',
      value: '/Script/Engine.Default__Actor',
    })
    const returns = details.sections.find(section => section.kind === 'returns')
    assert.equal(returns?.fields?.[0]?.name, 'ReturnValue')
    assert.equal(returns?.fields?.[0]?.type, 'string')
    assert.equal(returns?.fields?.[0]?.direction, 'return')
    assert.equal(returns?.fields?.[0]?.value, 'Actor')
  })

  it('marks an omitted parameter as defaulted and keeps an unknown extra input', async () => {
    const details = await buildCallFunctionDetails(deps(), {
      objectPath: '/Script/Engine.Default__KismetSystemLibrary',
      functionName: 'GetDisplayName',
      parametersJson: '{"SomethingElse":"1"}',
    })
    const inputs = details?.sections.find(section => section.kind === 'inputs')
    const object = inputs?.fields?.find(field => field.name === 'Object')
    assert.equal(object?.omitted, true)
    const extra = inputs?.fields?.find(field => field.name === 'SomethingElse')
    assert.equal(extra?.value, '1')
    assert.equal(extra?.direction, 'input')
  })

  it('types out parameters from the function signature', async () => {
    const details = await buildCallFunctionDetails(deps(), {
      objectPath: '/Script/Engine.Default__StaticMeshComponent',
      functionName: 'GetClosestPointOnCollision',
      parametersJson: '{"Point":{"X":"0","Y":"0","Z":"0"}}',
      result: {
        returnValueJson: '"true"',
        outParametersJson: '{"OutDistance":"12.5"}',
        returnType: 'bool',
      },
    })
    const outputs = details?.sections.find(section => section.kind === 'outputs')
    assert.deepEqual(outputs?.fields?.[0], {
      name: 'OutDistance',
      type: 'double',
      direction: 'output',
      value: '12.5',
    })
    // The struct-typed input carries its member types for the Details tree.
    const inputs = details?.sections.find(section => section.kind === 'inputs')
    const point = inputs?.fields?.find(field => field.name === 'Point')
    assert.deepEqual(point?.members?.map(member => member.name), ['X', 'Y', 'Z'])
  })

  it('types the members of an array-of-struct return value', async () => {
    const details = await buildCallFunctionDetails(deps({
      overrides: {
        GetFunctionInfo: () => ok({
          Info: {
            Name: 'GetBlueprintGraphs',
            bBlueprintCallable: true,
            Parameters: [],
            ReturnType: 'array(struct(/Script/EditorAutomation.EditorAutomationBlueprintGraphInfo))',
          },
        }),
        GetStructInfo: () => ok({
          Info: {
            Struct: '/Script/EditorAutomation.EditorAutomationBlueprintGraphInfo',
            Properties: [
              { Name: 'GraphName', Type: 'FString' },
              { Name: 'GraphClassPath', Type: 'FString' },
              { Name: 'GraphObjectPath', Type: 'FString' },
            ],
          },
        }),
      },
    }), {
      objectPath: '/Script/EditorAutomation.Default__EditorAutomationGraphLibrary',
      functionName: 'GetBlueprintGraphs',
      parametersJson: '{}',
      result: {
        returnValueJson: '[{"GraphName":"EventGraph","GraphClassPath":"/Script/Engine.EdGraph"}]',
        outParametersJson: '{}',
        returnType: 'array(struct(/Script/EditorAutomation.EditorAutomationBlueprintGraphInfo))',
      },
    })

    const returns = details?.sections.find(section => section.kind === 'returns')
    const field = returns?.fields?.[0]
    assert.equal(field?.type, 'array(struct(/Script/EditorAutomation.EditorAutomationBlueprintGraphInfo))')
    // The element struct's members ride along so each expanded [0] field can show its Type.
    assert.deepEqual(field?.members?.map(member => [member.name, member.type]), [
      ['GraphName', 'FString'],
      ['GraphClassPath', 'FString'],
      ['GraphObjectPath', 'FString'],
    ])
  })

  it('builds inputs only when the call itself failed', async () => {
    const details = await buildCallFunctionDetails(deps(), {
      objectPath: '/Script/Engine.Default__Actor',
      functionName: 'GetDisplayName',
      parametersJson: '{"Object":"/Script/Engine.Default__Actor"}',
    })
    assert.ok(details !== undefined)
    assert.deepEqual(details.sections.map(section => section.kind), ['inputs'])
  })

  it('reports invalid parameter text in a section note', async () => {
    const details = await buildCallFunctionDetails(deps(), {
      objectPath: '/Script/Engine.Default__KismetSystemLibrary',
      functionName: 'GetDisplayName',
      parametersJson: 'not json',
    })
    const inputs = details?.sections.find(section => section.kind === 'inputs')
    assert.match(String(inputs?.note), /not valid JSON/)
    assert.deepEqual(inputs?.fields, [])
  })

  it('builds Inputs and Outputs from a recorded RC request and the signature', async () => {
    const details = await buildDefaultCallDetails(deps({
      overrides: {
        GetObjectClass: () => ok({ ClassType: 'class(/Script/EditorAutomation.EditorAutomationCoreLibrary)' }),
        GetFunctionInfo: () => ok({
          Info: {
            Name: 'CaptureScreenshot',
            bBlueprintCallable: true,
            bStatic: true,
            Parameters: [
              { Name: 'FilePath', Type: 'string', Direction: 0, DisplayNameText: { NativeText: 'File Path' } },
              {
                Name: 'Target',
                Type: 'enum(/Script/EditorAutomation.EEditorAutomationScreenshotTarget)',
                Direction: 0,
                DisplayNameText: { NativeText: 'Target' },
              },
              { Name: 'bShowUI', Type: 'bool', Direction: 0, DisplayNameText: { NativeText: 'Show UI' } },
              { Name: 'OutFilePath', Type: 'string', Direction: 1, DisplayNameText: { NativeText: 'File Path' } },
            ],
            ReturnType: 'struct(/Script/EditorAutomation.EditorAutomationResult)',
          },
        }),
      },
    }), [{
      objectPath: '/Script/EditorAutomation.Default__EditorAutomationCoreLibrary',
      functionName: 'CaptureScreenshot',
      parametersJson: '{"FilePath":"C:/x.png","Target":"1","bShowUI":"true"}',
      outParametersJson: '{"OutFilePath":"C:/x.png"}',
    }])

    assert.deepEqual(details?.sections.map(section => section.kind), ['inputs', 'outputs'])
    const inputs = details?.sections.find(section => section.kind === 'inputs')?.fields ?? []
    assert.deepEqual(inputs.map(field => field.name), ['FilePath', 'Target', 'bShowUI'])
    assert.deepEqual(inputs.map(field => field.type), [
      'string',
      'enum(/Script/EditorAutomation.EEditorAutomationScreenshotTarget)',
      'bool',
    ])
    assert.deepEqual(inputs.map(field => field.value), ['C:/x.png', '1', 'true'])
    assert.deepEqual(inputs.map(field => (field.displayNameText as { nativeText?: string } | undefined)?.nativeText), [
      'File Path',
      'Target',
      'Show UI',
    ])
    const outputs = details?.sections.find(section => section.kind === 'outputs')?.fields ?? []
    assert.deepEqual(outputs.map(field => field.name), ['OutFilePath'])
    assert.equal(outputs[0]?.type, 'string')
    assert.equal(outputs[0]?.direction, 'output')
    assert.equal(outputs[0]?.value, 'C:/x.png')
    assert.equal((outputs[0]?.displayNameText as { nativeText?: string } | undefined)?.nativeText, 'File Path')
  })
  it('keeps the truncated flag when a large out parameter is dropped by the budget', async () => {
    const properties = Array.from({ length: 40 }, (_, index) => ({
      Name: `Property${String(index)}`,
      Type: 'string',
      DisplayNameText: { NativeText: `Property ${String(index)}` },
      Description: 'x'.repeat(300),
    }))
    const details = await buildDefaultCallDetails(deps({
      maxChars: 4000,
      overrides: {
        GetFunctionInfo: () => ok({
          Info: {
            Name: 'GetClassInfo',
            bBlueprintCallable: true,
            bStatic: true,
            Parameters: [
              { Name: 'Type', Type: 'string', Direction: 0, DisplayNameText: { NativeText: 'Type' } },
              { Name: 'OutInfo', Type: 'struct(/Script/EditorAutomation.EditorAutomationClassInfo)', Direction: 1 },
            ],
            ReturnType: 'struct(/Script/EditorAutomation.EditorAutomationResult)',
          },
        }),
        GetStructInfo: () => ok({
          Info: {
            Struct: '/Script/EditorAutomation.EditorAutomationClassInfo',
            Properties: [{ Name: 'Class', Type: 'string' }],
          },
        }),
      },
    }), [{
      objectPath: '/Script/EditorAutomation.Default__EditorAutomationCoreLibrary',
      functionName: 'GetClassInfo',
      parametersJson: '{"Type":"class(/Script/Engine.Actor)"}',
      outParametersJson: JSON.stringify({ OutInfo: { Class: '/Script/Engine.Actor', Properties: properties } }),
    }])

    // The outputs section does not fit the budget; the card must still say the
    // Details are partial instead of silently looking complete.
    assert.equal(details?.truncated, true)
    assert.deepEqual(details?.sections.map(section => section.kind), ['inputs'])
  })
})

describe('property enrichment', () => {
  it('types a struct value and labels its members from the struct cache', async () => {
    const captured: Captured[] = []
    const details = await buildPropertyValueDetails(deps({ captured }), {
      objectPath: '/Script/Engine.Default__StaticMeshComponent',
      propertyPath: 'RelativeLocation',
      valueJson: '{"X":"0.0","Y":"0.0","Z":"10.0"}',
    })
    const field = details?.sections.find(section => section.kind === 'value')?.fields?.[0]
    assert.equal(field?.type, 'struct(/Script/CoreUObject.Vector)')
    assert.deepEqual(field?.members?.map(member => [member.name, member.type]), [
      ['X', 'double'],
      ['Y', 'double'],
      ['Z', 'double'],
    ])
    const self = details?.sections.find(section => section.kind === 'inputs')?.fields?.[0]
    assert.equal(self?.name, 'Target')
    assert.equal(self?.type, 'object(/Script/Engine.StaticMeshComponent)')
    assert.equal(self?.value, '/Script/Engine.Default__StaticMeshComponent')
    // One property type lookup + one struct lookup, both through the cache.
    assert.deepEqual(captured.map(request => request.functionName), ['GetPropertyType', 'GetStructInfo'])
  })

  it('labels a numeric enum value with its entry name', async () => {
    const details = await buildPropertyValueDetails(deps(), {
      objectPath: '/Script/Engine.Default__StaticMeshComponent',
      propertyPath: 'Mobility',
      valueJson: '3',
    })
    const field = details?.sections.find(section => section.kind === 'value')?.fields?.[0]
    assert.equal(field?.type, 'enum(/Script/Engine.ECollisionEnabled)')
    assert.equal(field?.enumLabel, 'QueryAndPhysics (Query And Physics)')
  })

  it('records a write as typed before → after fields', async () => {
    const details = await buildPropertyWriteDetails(deps(), {
      objectPath: '/Script/Engine.Default__StaticMeshComponent',
      propertyPath: 'RelativeLocation.Z',
      oldValueJson: '"10.0"',
      newValueJson: '"42.0"',
    })
    const section = details?.sections.find(candidate => candidate.kind === 'change')
    assert.equal(section?.before?.type, 'double')
    assert.equal(section?.before?.value, '10.0')
    assert.equal(section?.after?.value, '42.0')
    const self = details?.sections.find(candidate => candidate.kind === 'inputs')?.fields?.[0]
    assert.equal(self?.name, 'Target')
    assert.equal(self?.type, 'object(/Script/Engine.StaticMeshComponent)')
  })

  it('types a level-instance path through the cached GetObjectClass lookup', async () => {
    const captured: Captured[] = []
    const details = await buildPropertyValueDetails(deps({ captured }), {
      objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      propertyPath: 'RelativeLocation',
      valueJson: '{"X":"0.0","Y":"0.0","Z":"10.0"}',
    })
    const field = details?.sections.find(section => section.kind === 'value')?.fields?.[0]
    assert.equal(field?.type, 'struct(/Script/CoreUObject.Vector)')
    assert.deepEqual(field?.members?.map(member => member.type), ['double', 'double', 'double'])
    // The class came from the object-class cache, then the property schema.
    assert.deepEqual(captured.map(request => request.functionName), [
      'GetObjectClass',
      'GetPropertyType',
      'GetStructInfo',
    ])
    assert.deepEqual(captured[0]?.parameters, { ObjectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1' })
  })

  it('reuses the object-class cache for a second call on the same instance', async () => {
    const captured: Captured[] = []
    const shared = deps({ captured })
    await buildPropertyValueDetails(shared, {
      objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      propertyPath: 'RelativeLocation.Z',
      valueJson: '"10.0"',
    })
    await buildPropertyValueDetails(shared, {
      objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      propertyPath: 'RelativeLocation.Z',
      valueJson: '"42.0"',
    })
    assert.equal(captured.filter(request => request.functionName === 'GetObjectClass').length, 1)
  })

  it('degrades gracefully when the editor has no GetObjectClass (old build)', async () => {
    const details = await buildPropertyValueDetails(
      deps({
        overrides: {
          GetObjectClass: () => ({ ErrorCode: 1, ErrorMessage: 'Unknown function.', Hint: '' }),
        },
      }),
      {
        objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
        propertyPath: 'RelativeLocation',
        valueJson: '{"X":"0.0"}',
      },
    )
    const field = details?.sections.find(section => section.kind === 'value')?.fields?.[0]
    assert.equal(field?.type, undefined)
    assert.deepEqual(field?.value, { X: '0.0' })
  })
})

describe('level-instance call enrichment', () => {
  it('types a level-instance call_function through GetObjectClass + the signature cache', async () => {
    const captured: Captured[] = []
    const details = await buildCallFunctionDetails(deps({ captured }), {
      objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      functionName: 'GetDisplayName',
      parametersJson: '{"Object":"/Game/Maps/Demo.Demo:PersistentLevel.Cube_1"}',
      result: { returnValueJson: '"Cube_1"', outParametersJson: '{}', returnType: 'string' },
    })
    const inputs = details?.sections.find(section => section.kind === 'inputs')
    assert.equal(inputs?.fields?.[0]?.name, 'Target')
    assert.equal(inputs?.fields?.[0]?.value, '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1')
    assert.deepEqual(inputs?.fields?.find(field => field.name === 'Object'), {
      name: 'Object',
      type: 'object(/Script/Engine.Object)',
      direction: 'input',
      value: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
    })
    const returns = details?.sections.find(section => section.kind === 'returns')
    assert.equal(returns?.fields?.[0]?.type, 'string')
    // GetObjectClass resolved the class, then the signature came through the cache.
    assert.deepEqual(captured.map(request => request.functionName).slice(0, 2), ['GetObjectClass', 'GetFunctionInfo'])
    assert.deepEqual(captured[1]?.parameters, {
      Type: 'class(/Script/Engine.StaticMeshComponent)',
      FunctionName: 'GetDisplayName',
    })
  })
})

describe('buildRcCallDetails', () => {
  const coreLibrary = '/Script/EditorAutomation.Default__EditorAutomationCoreLibrary'
  const signature = (parameters: Record<string, unknown>) => ok({
    Info: {
      Name: String(parameters['FunctionName'] ?? ''),
      bBlueprintCallable: true,
      Parameters: [],
      ReturnType: 'string',
    },
  })

  it('renders one RC call as a single-call card', async () => {
    const details = await buildRcCallDetails(deps({ overrides: { GetFunctionInfo: signature } }), [{
      objectPath: coreLibrary,
      functionName: 'Ping',
      parametersJson: '{}',
      outParametersJson: '{"OutValue":"pong"}',
      returnValueJson: '{"bSuccess":"true"}',
      returnType: 'struct(/Script/EditorAutomation.EditorAutomationResult)',
    }])
    assert.deepEqual(details?.sections.map(section => section.kind), ['inputs', 'returns', 'outputs'])
    const outputs = details?.sections.find(section => section.kind === 'outputs')?.fields ?? []
    assert.deepEqual(outputs.map(field => field.name), ['OutValue'])
  })

  it('renders several RC calls as the calls list, one sub-card per call', async () => {
    const details = await buildRcCallDetails(deps({ overrides: { GetFunctionInfo: signature } }), [
      {
        objectPath: coreLibrary,
        functionName: 'Ping',
        parametersJson: '{}',
        outParametersJson: '{"OutValue":"pong"}',
        returnValueJson: '{"bSuccess":"true"}',
      },
      {
        objectPath: coreLibrary,
        functionName: 'GetEditorInfo',
        parametersJson: '{}',
        outParametersJson: '{"OutInfo":{"ProcessId":"1"}}',
        returnValueJson: '{"bSuccess":"true"}',
      },
    ])
    assert.deepEqual(details?.sections.map(section => section.kind), ['calls'])
    const fields = details?.sections[0]?.fields ?? []
    assert.equal(fields.length, 2)
    assert.deepEqual(fields.map(field => field.name), ['#0', '#1'])
    const second = fields[1]?.value as { functionName?: string } | undefined
    assert.equal(second?.functionName, 'GetEditorInfo')
  })
})

describe('mergeCallDetails', () => {
  it('adds the reflected Inputs/Outputs around a bespoke section', () => {
    const custom = {
      v: 1 as const,
      sections: [{ kind: 'screenshot' as const, fields: [{ name: 'image', type: 'image/png' }] }],
    }
    const defaults = {
      v: 1 as const,
      sections: [
        { kind: 'inputs' as const, fields: [{ name: 'FilePath', type: 'string', displayNameText: { nativeText: 'File Path' } }] },
        { kind: 'outputs' as const, fields: [{ name: 'OutFilePath', type: 'string' }] },
      ],
    }
    const merged = mergeCallDetails(custom, defaults)
    assert.deepEqual(merged?.sections.map(section => section.kind), ['inputs', 'screenshot', 'outputs'])
    assert.equal(merged?.sections[0]?.fields?.[0]?.name, 'FilePath')
    assert.deepEqual(merged?.sections[0]?.fields?.[0]?.displayNameText, { nativeText: 'File Path' })
  })

  it('keeps a bespoke Inputs section instead of duplicating the reflected one', () => {
    const custom = {
      v: 1 as const,
      sections: [{ kind: 'inputs' as const, fields: [{ name: 'Target' }] }],
    }
    const defaults = {
      v: 1 as const,
      sections: [{ kind: 'inputs' as const, fields: [{ name: 'ObjectPath' }] }],
    }
    assert.deepEqual(mergeCallDetails(custom, defaults)?.sections.map(section => section.kind), ['inputs'])
  })
})

describe('bounding', () => {
  it('bounds strings, arrays, objects and depth', () => {
    const long = 'x'.repeat(DETAIL_LIMITS.maxStringChars + 20)
    const boundedLong = String(boundDetailValue(long))
    assert.ok(boundedLong.endsWith(`(${String(DETAIL_LIMITS.maxStringChars + 20)} chars)`))
    assert.ok(boundedLong.length < long.length)
    const array = boundDetailValue(Array.from({ length: 50 }, (_, index) => index))
    assert.equal((array as unknown[]).length, DETAIL_LIMITS.maxArrayItems)
    const record = boundDetailValue(Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`k${String(index)}`, index])))
    assert.equal(Object.keys(record as Record<string, unknown>).length, DETAIL_LIMITS.maxObjectKeys)
  })

  it('shrinks a large Details structure and marks it truncated', () => {
    const wide = {
      v: 1 as const,
      sections: [
        { kind: 'inputs' as const, fields: Array.from({ length: 20 }, (_, index) => ({ name: `p${String(index)}`, type: 'double', value: '1' })) },
        { kind: 'outputs' as const, fields: Array.from({ length: 20 }, (_, index) => ({ name: `o${String(index)}`, value: 'x'.repeat(300) })) },
      ],
    }
    const bounded = boundDetails(wide, 600)
    assert.equal(bounded.truncated, true)
    assert.ok(JSON.stringify(bounded).length <= 600)
  })
})
