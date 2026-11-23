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

  it('renders a MakeArray container as an array literal', () => {
    const event = node({
      guid: 'event',
      className: 'K2Node_Event',
      title: 'Event BeginPlay',
      memberName: 'ReceiveBeginPlay',
      pins: [pin({ name: 'then', direction: 'output', connections: ['set::execute'] })],
    })
    const make = node({
      guid: 'make',
      className: 'K2Node_MakeArray',
      classHierarchy: ['K2Node_MakeArray', 'K2Node_MakeContainer', 'K2Node'],
      title: 'Make Array',
      pins: [
        pin({ name: '0', direction: 'input', category: 'int', defaultValue: '1' }),
        pin({ name: '1', direction: 'input', category: 'int', defaultValue: '2' }),
        pin({ name: 'Array', direction: 'output', category: 'array', cppType: 'number[]' }),
      ],
    })
    const set = node({
      guid: 'set',
      className: 'K2Node_VariableSet',
      title: 'Set Values',
      variableName: 'Values',
      pins: [
        pin({ name: 'execute', direction: 'input' }),
        pin({ name: 'Values', direction: 'input', connections: ['make::Array'] }),
        pin({ name: 'then', direction: 'output' }),
      ],
    })
    const structure: BlueprintGraphStructure = {
      blueprintPath: '/Game/Test.Test',
      blueprintName: 'Test',
      className: 'WBP_Test_C',
      parentClassName: 'UUserWidget',
      variables: [{ name: 'Values', category: 'int', cppType: 'number', containerType: 1, typeName: 'None' }],
      graphs: [{ name: 'EventGraph', objectPath: '/Game/Test:EventGraph', kind: 'ubergraph', nodes: [event, make, set] }],
      skippedGraphs: [],
    }
    const code = convertBlueprintToTypeScript(structure)
    assert.match(code, /this\.Values = \[1, 2\];/)
  })

  it('renders a DoOnce macro as guarded state instead of a generic label', () => {
    const event = node({
      guid: 'event',
      className: 'K2Node_Event',
      title: 'Event BeginPlay',
      memberName: 'ReceiveBeginPlay',
      pins: [pin({ name: 'then', direction: 'output', connections: ['once12345678::execute'] })],
    })
    const body = node({
      guid: 'body',
      className: 'K2Node_CallFunction',
      title: 'Print String',
      function: functionMetadata('PrintString', 'UKismetSystemLibrary', []),
      pins: [
        pin({ name: 'execute', direction: 'input' }),
        pin({ name: 'then', direction: 'output' }),
      ],
    })
    const once = node({
      guid: 'once12345678',
      className: 'K2Node_MacroInstance',
      title: 'Do Once',
      macroGraphName: 'DoOnce',
      pins: [
        pin({ name: 'execute', direction: 'input' }),
        pin({ name: 'Reset', direction: 'input' }),
        pin({ name: 'Completed', direction: 'output', connections: ['body::execute'] }),
      ],
    })
    const structure: BlueprintGraphStructure = {
      blueprintPath: '/Game/Test.Test',
      blueprintName: 'Test',
      className: 'WBP_Test_C',
      parentClassName: 'UUserWidget',
      variables: [],
      graphs: [{ name: 'EventGraph', objectPath: '/Game/Test:EventGraph', kind: 'ubergraph', nodes: [event, once, body] }],
      skippedGraphs: [],
    }
    const code = convertBlueprintToTypeScript(structure)
    assert.match(code, /\/\/ #region generated state/)
    assert.match(code, /DoOnceFlag_once1234: \{ value: boolean \} = \{ value: false \}/)
    assert.match(code, /const Macros = \{/)
    assert.match(code, /\/\/ #region macros/)
    assert.match(code, /const Macros = \{/)
    assert.match(code, /\/\/ #region macros/)
    assert.match(code, /DoOnce\(state: \{ value: boolean \}, body: \(\) => void\): void \{/)
    assert.match(code, /Macros\.DoOnce\(this\.DoOnceFlag_once1234, \(\) => \{/)
    assert.match(code, /UKismetSystemLibrary\.PrintString\(\)/)
  })

  it('keeps clean macro names inside the Macros object even when the class has the same method', () => {
    const event = node({
      guid: 'event',
      className: 'K2Node_Event',
      title: 'Event BeginPlay',
      memberName: 'ReceiveBeginPlay',
      pins: [pin({ name: 'then', direction: 'output', connections: ['once12345678::execute'] })],
    })
    const once = node({
      guid: 'once12345678',
      className: 'K2Node_MacroInstance',
      title: 'Do Once',
      macroGraphName: 'DoOnce',
      pins: [
        pin({ name: 'execute', direction: 'input' }),
        pin({ name: 'Completed', direction: 'output' }),
      ],
    })
    const functionEntry = node({
      guid: 'fnentry',
      className: 'K2Node_FunctionEntry',
      title: 'Function Entry',
      pins: [],
    })
    const structure: BlueprintGraphStructure = {
      blueprintPath: '/Game/Test.Test',
      blueprintName: 'Test',
      className: 'WBP_Test_C',
      parentClassName: 'UUserWidget',
      variables: [],
      graphs: [
        { name: 'EventGraph', objectPath: '/Game/Test:EventGraph', kind: 'ubergraph', nodes: [event, once] },
        { name: 'DoOnce', objectPath: '/Game/Test:DoOnce', kind: 'function', nodes: [functionEntry] },
      ],
      skippedGraphs: [],
    }
    const code = convertBlueprintToTypeScript(structure)
    assert.match(code, /DoOnce\(\) \{/)
    assert.match(code, /Macros\.DoOnce\(this\.DoOnceFlag_once1234, \(\) => \{/)
  })

  it('marks methods with latent calls as async and awaits them', () => {
    const event = node({
      guid: 'event',
      className: 'K2Node_Event',
      title: 'Event BeginPlay',
      memberName: 'ReceiveBeginPlay',
      pins: [pin({ name: 'then', direction: 'output', connections: ['delay::execute'] })],
    })
    const delay = node({
      guid: 'delay',
      className: 'K2Node_CallFunction',
      title: 'Delay',
      function: {
        ...functionMetadata('Delay', 'UKismetSystemLibrary', [
          { name: 'Duration', cppType: 'float', out: false, return: false, declaredDefault: '0.2' },
        ]),
        latent: true,
      },
      pins: [
        pin({ name: 'execute', direction: 'input' }),
        pin({ name: 'Duration', direction: 'input', category: 'real', defaultValue: '1.0' }),
        pin({ name: 'then', direction: 'output' }),
      ],
    })
    const structure: BlueprintGraphStructure = {
      blueprintPath: '/Game/Test.Test',
      blueprintName: 'Test',
      className: 'WBP_Test_C',
      parentClassName: 'UUserWidget',
      variables: [],
      graphs: [{ name: 'EventGraph', objectPath: '/Game/Test:EventGraph', kind: 'ubergraph', nodes: [event, delay] }],
      skippedGraphs: [],
    }
    const code = convertBlueprintToTypeScript(structure)
    assert.match(code, /async BeginPlay\(\) \{/)
    assert.match(code, /await UKismetSystemLibrary\.Delay\(1\.0\)/)
  })

  it('renders ForLoopWithBreak with a break-aware closure', () => {
    const event = node({
      guid: 'event',
      className: 'K2Node_Event',
      title: 'Event BeginPlay',
      memberName: 'ReceiveBeginPlay',
      pins: [pin({ name: 'then', direction: 'output', connections: ['loop12345678::execute'] })],
    })
    const body = node({
      guid: 'body',
      className: 'K2Node_CallFunction',
      title: 'Print String',
      function: functionMetadata('PrintString', 'UKismetSystemLibrary', []),
      pins: [
        pin({ name: 'execute', direction: 'input' }),
        pin({ name: 'then', direction: 'output' }),
      ],
    })
    const loop = node({
      guid: 'loop12345678',
      className: 'K2Node_MacroInstance',
      title: 'For Loop With Break',
      macroGraphName: 'ForLoopWithBreak',
      pins: [
        pin({ name: 'execute', direction: 'input' }),
        pin({ name: 'FirstIndex', direction: 'input', category: 'int', defaultValue: '0' }),
        pin({ name: 'LastIndex', direction: 'input', category: 'int', defaultValue: '5' }),
        pin({ name: 'Break', direction: 'input' }),
        pin({ name: 'LoopBody', direction: 'output', connections: ['body::execute'] }),
        pin({ name: 'Index', direction: 'output', category: 'int' }),
        pin({ name: 'Completed', direction: 'output' }),
      ],
    })
    const structure: BlueprintGraphStructure = {
      blueprintPath: '/Game/Test.Test',
      blueprintName: 'Test',
      className: 'WBP_Test_C',
      parentClassName: 'UUserWidget',
      variables: [],
      graphs: [{ name: 'EventGraph', objectPath: '/Game/Test:EventGraph', kind: 'ubergraph', nodes: [event, body, loop] }],
      skippedGraphs: [],
    }
    const code = convertBlueprintToTypeScript(structure)
    assert.match(code, /ForLoopWithBreak\(first: number, last: number, breakState: \{ value: boolean \}/)
    assert.match(code, /Macros\.ForLoopWithBreak\(0, 5, this\.BreakFlag_loop1234, \(loop1\) => \{/)
  })

  it('renders Gate, FlipFlop, DoN and ForEachLoopWithBreak through the Macros object', () => {
    const event = node({
      guid: 'event',
      className: 'K2Node_Event',
      title: 'Event BeginPlay',
      memberName: 'ReceiveBeginPlay',
      pins: [pin({
        name: 'then',
        direction: 'output',
        connections: ['gate12345678::Open', 'gate12345678::Close', 'gate12345678::Toggle', 'gate12345678::Enter', 'flip12345678::execute', 'don123456789::execute', 'foreach1234::execute'],
      })],
    })
    const gate = node({
      guid: 'gate12345678',
      className: 'K2Node_MacroInstance',
      title: 'Gate',
      macroGraphName: 'Gate',
      pins: [
        pin({ name: 'Open', direction: 'input' }),
        pin({ name: 'Close', direction: 'input' }),
        pin({ name: 'Toggle', direction: 'input' }),
        pin({ name: 'Enter', direction: 'input' }),
        pin({ name: 'bStartClosed', direction: 'input', category: 'bool', defaultValue: 'false' }),
        pin({ name: 'Exit', direction: 'output' }),
      ],
    })
    const flip = node({
      guid: 'flip12345678',
      className: 'K2Node_MacroInstance',
      title: 'FlipFlop',
      macroGraphName: 'FlipFlop',
      pins: [
        pin({ name: 'execute', direction: 'input' }),
        pin({ name: 'A', direction: 'output' }),
        pin({ name: 'B', direction: 'output' }),
      ],
    })
    const doN = node({
      guid: 'don123456789',
      className: 'K2Node_MacroInstance',
      title: 'Do N',
      macroGraphName: 'Do N',
      pins: [
        pin({ name: 'execute', direction: 'input' }),
        pin({ name: 'n', direction: 'input', category: 'int', defaultValue: '3' }),
        pin({ name: 'Exit', direction: 'output' }),
        pin({ name: 'Counter', direction: 'output', category: 'int' }),
      ],
    })
    const foreach = node({
      guid: 'foreach1234',
      className: 'K2Node_MacroInstance',
      title: 'For Each Loop with Break',
      macroGraphName: 'ForEachLoopWithBreak',
      pins: [
        pin({ name: 'execute', direction: 'input' }),
        pin({ name: 'Array', direction: 'input', category: 'array', cppType: 'number[]' }),
        pin({ name: 'LoopBody', direction: 'output' }),
        pin({ name: 'Completed', direction: 'output' }),
        pin({ name: 'Array Element', direction: 'output', category: 'int' }),
        pin({ name: 'Array Index', direction: 'output', category: 'int' }),
      ],
    })
    const structure: BlueprintGraphStructure = {
      blueprintPath: '/Game/Test.Test',
      blueprintName: 'Test',
      className: 'WBP_Test_C',
      parentClassName: 'UUserWidget',
      variables: [],
      graphs: [{ name: 'EventGraph', objectPath: '/Game/Test:EventGraph', kind: 'ubergraph', nodes: [event, gate, flip, doN, foreach] }],
      skippedGraphs: [],
    }
    const code = convertBlueprintToTypeScript(structure)
    assert.match(code, /Macros\.GateOpen\(this\.GateFlag_gate1234\)/)
    assert.match(code, /Macros\.GateClose\(this\.GateFlag_gate1234\)/)
    assert.match(code, /Macros\.GateToggle\(this\.GateFlag_gate1234\)/)
    assert.match(code, /Macros\.GateEnter\(this\.GateFlag_gate1234, \(\) => \{/)
    assert.match(code, /Macros\.FlipFlop\(this\.FlipFlopFlag_flip1234, \(\) => \{/)
    assert.match(code, /Macros\.DoN\(this\.DoNCount_don12345, 3, \(\) => \{/)
    assert.match(code, /Macros\.ForEachWithBreak\(null, this\.BreakFlag_foreach1, \(item1, index1\) => \{/)
    assert.doesNotMatch(code, /\/\/ TODO:/)
  })
})
