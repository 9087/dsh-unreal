/** Unit tests for the DSH-side Blueprint -> TypeScript converter. */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { convertBlueprintToTypeScript } from '../src/graph-typescript.ts'
import type {
  BlueprintGraphStructure,
  GraphStructureFunction,
  GraphStructureNode,
  GraphStructurePin,
} from '../src/graph-typescript.ts'

function pin(overrides: Partial<GraphStructurePin> & Pick<GraphStructurePin, 'name' | 'direction'>): GraphStructurePin {
  return {
    pinId: overrides.name,
    direction: overrides.direction,
    name: overrides.name,
    category: 'exec',
    cppType: 'unknown',
    containerType: 0,
    typeName: 'None',
    defaultValue: '',
    defaultObjectPath: '',
    linked: false,
    reference: false,
    enum: false,
    connections: [],
    linkedPinIds: [],
    ...overrides,
  }
}

function node(overrides: Partial<GraphStructureNode> & Pick<GraphStructureNode, 'guid' | 'className' | 'title'>): GraphStructureNode {
  return {
    guid: overrides.guid,
    objectPath: `/Game/Test:${overrides.guid}`,
    classPath: `/Script/BlueprintGraph.${overrides.className}`,
    className: overrides.className,
    title: overrides.title,
    comment: '',
    posX: 0,
    posY: 0,
    graphObjectPath: '/Game/Test:EventGraph',
    enabled: true,
    pins: [],
    ...overrides,
  }
}

function functionMetadata(name: string, ownerCppName: string, parameters: GraphStructureFunction['parameters']): GraphStructureFunction {
  return { name, ownerClassPath: '/Script/Engine.KismetSystemLibrary', ownerCppName, static: true, parameters }
}

describe('convertBlueprintToTypeScript', () => {
  it('renders one merged class, properties region and method bodies', () => {
    const beginPlay = node({
      guid: 'event',
      className: 'K2Node_Event',
      title: 'Event BeginPlay',
      memberName: 'ReceiveBeginPlay',
      pins: [pin({ name: 'then', direction: 'output', connections: ['print::execute'] })],
    })
    const print = node({
      guid: 'print',
      className: 'K2Node_CallFunction',
      title: 'Print String',
      function: functionMetadata('PrintString', 'UKismetSystemLibrary', [
        { name: 'InString', cppType: 'FString', out: false, return: false, declaredDefault: '' },
      ]),
      pins: [
        pin({ name: 'execute', direction: 'input' }),
        pin({ name: 'InString', direction: 'input', category: 'string', defaultValue: 'Hello' }),
        pin({ name: 'then', direction: 'output' }),
      ],
    })
    const structure: BlueprintGraphStructure = {
      blueprintPath: '/Game/Test.Test',
      blueprintName: 'Test',
      className: 'WBP_Test_C',
      parentClassName: 'UUserWidget',
      variables: [{ name: 'Score', category: 'int', cppType: 'number', containerType: 0, typeName: 'None' }],
      graphs: [{ name: 'EventGraph', objectPath: '/Game/Test:EventGraph', kind: 'ubergraph', nodes: [beginPlay, print] }],
      skippedGraphs: [],
    }
    const code = convertBlueprintToTypeScript(structure)
    assert.match(code, /class WBP_Test_C extends UUserWidget \{/)
    assert.match(code, /\/\/ #region properties\n  Score: number/)
    assert.match(code, /BeginPlay\(\) \{/)
    assert.match(code, /UKismetSystemLibrary\.PrintString\("Hello"\)/)
    assert.equal((code.match(/class WBP_Test_C/g) ?? []).length, 1)
  })

  it('maps a ForEachLoop macro to a for-of loop and its element output', () => {
    const event = node({
      guid: 'event',
      className: 'K2Node_Event',
      title: 'Event BeginPlay',
      memberName: 'ReceiveBeginPlay',
      pins: [pin({ name: 'then', direction: 'output', connections: ['loop::execute'] })],
    })
    const loop = node({
      guid: 'loop',
      className: 'K2Node_MacroInstance',
      title: 'For Each Loop',
      macroGraphName: 'ForEachLoop',
      pins: [
        pin({ name: 'execute', direction: 'input' }),
        pin({ name: 'Array', direction: 'input', category: 'array', cppType: 'number[]' }),
        pin({ name: 'LoopBody', direction: 'output' }),
        pin({ name: 'Completed', direction: 'output' }),
        pin({ name: 'Array Element', direction: 'output', category: 'int', cppType: 'number' }),
        pin({ name: 'Array Index', direction: 'output', category: 'int', cppType: 'number' }),
      ],
    })
    const structure: BlueprintGraphStructure = {
      blueprintPath: '/Game/Test.Test',
      blueprintName: 'Test',
      className: 'WBP_Test_C',
      parentClassName: 'UUserWidget',
      variables: [],
      graphs: [{ name: 'EventGraph', objectPath: '/Game/Test:EventGraph', kind: 'ubergraph', nodes: [event, loop] }],
      skippedGraphs: [],
    }
    const code = convertBlueprintToTypeScript(structure)
    assert.match(code, /for \(const \[index1, item1\] of null\.entries\(\)\) \{/)
  })

  it('inlines a collapsed graph instead of leaving a comment', () => {
    const event = node({
      guid: 'event',
      className: 'K2Node_Event',
      title: 'Event BeginPlay',
      memberName: 'ReceiveBeginPlay',
      pins: [pin({ name: 'then', direction: 'output', connections: ['composite::execute'] })],
    })
    const body = node({
      guid: 'body',
      className: 'K2Node_CallFunction',
      title: 'Print String',
      function: functionMetadata('PrintString', 'UKismetSystemLibrary', [
        { name: 'InString', cppType: 'FString', out: false, return: false, declaredDefault: '' },
      ]),
      pins: [
        pin({ name: 'execute', direction: 'input' }),
        pin({ name: 'InString', direction: 'input', category: 'string', defaultValue: 'Body' }),
        pin({ name: 'then', direction: 'output', connections: ['exit::execute'] }),
      ],
    })
    const entry = node({
      guid: 'entry',
      className: 'K2Node_Tunnel',
      title: 'Inputs',
      pins: [pin({ name: 'then', direction: 'output', connections: ['body::execute'] })],
    })
    const exit = node({
      guid: 'exit',
      className: 'K2Node_Tunnel',
      title: 'Outputs',
      pins: [pin({ name: 'execute', direction: 'input' })],
    })
    const composite = node({
      guid: 'composite',
      className: 'K2Node_Composite',
      title: 'Collapsed Graph',
      pins: [pin({ name: 'execute', direction: 'input' })],
      subGraph: { name: 'MyCollapsed', objectPath: '/Game/Test:MyCollapsed', nodes: [entry, body, exit] },
    })
    const structure: BlueprintGraphStructure = {
      blueprintPath: '/Game/Test.Test',
      blueprintName: 'Test',
      className: 'WBP_Test_C',
      parentClassName: 'UUserWidget',
      variables: [],
      graphs: [{ name: 'EventGraph', objectPath: '/Game/Test:EventGraph', kind: 'ubergraph', nodes: [event, composite] }],
      skippedGraphs: [],
    }
    const code = convertBlueprintToTypeScript(structure)
    assert.match(code, /\/\/ composite: MyCollapsed/)
    assert.match(code, /UKismetSystemLibrary\.PrintString\("Body"\)/)
    assert.doesNotMatch(code, /\/\/ collapsed:/)
  })

  it('renders a timeline without a TODO fallback', () => {
    const event = node({
      guid: 'event',
      className: 'K2Node_Event',
      title: 'Event BeginPlay',
      memberName: 'ReceiveBeginPlay',
      pins: [pin({ name: 'then', direction: 'output', connections: ['timeline::execute'] })],
    })
    const timeline = node({
      guid: 'timeline',
      className: 'K2Node_Timeline',
      title: 'Timeline',
      timelineName: 'MyTimeline',
      pins: [
        pin({ name: 'execute', direction: 'input' }),
        pin({ name: 'Update', direction: 'output' }),
        pin({ name: 'Finished', direction: 'output' }),
      ],
    })
    const structure: BlueprintGraphStructure = {
      blueprintPath: '/Game/Test.Test',
      blueprintName: 'Test',
      className: 'WBP_Test_C',
      parentClassName: 'UUserWidget',
      variables: [],
      graphs: [{ name: 'EventGraph', objectPath: '/Game/Test:EventGraph', kind: 'ubergraph', nodes: [event, timeline] }],
      skippedGraphs: [],
    }
    const code = convertBlueprintToTypeScript(structure)
    assert.match(code, /\/\/ timeline: MyTimeline/)
    assert.doesNotMatch(code, /\/\/ TODO:/)
  })
})
