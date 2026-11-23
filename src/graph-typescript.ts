/**
 * Render a Blueprint graph structure (produced by GetBlueprintGraphStructure)
 * to the compact TypeScript-like pseudocode shown by the conversion card.
 *
 * This is the DSH-side converter: the editor plugin only supplies the structured
 * graph model, so formatting and node semantics can be changed here without a
 * C++ rebuild.
 *
 * @module dsh-unreal/graph-typescript
 */

/** One pin of the editor graph model. */
export interface GraphStructurePin {
  readonly pinId: string
  readonly name: string
  readonly direction: 'input' | 'output'
  readonly category: string
  readonly cppType: string
  readonly containerType: number
  readonly typeName: string
  readonly defaultValue: string
  readonly defaultObjectPath: string
  readonly linked: boolean
  readonly reference: boolean
  readonly enum: boolean
  readonly enumName?: string
  readonly connections: readonly string[]
  readonly linkedPinIds: readonly string[]
}

/** One function signature parameter in the editor graph model. */
export interface GraphStructureFunctionParameter {
  readonly name: string
  readonly cppType: string
  readonly out: boolean
  readonly return: boolean
  readonly declaredDefault: string
}

/** Function metadata attached to a call node. */
export interface GraphStructureFunction {
  readonly name: string
  readonly ownerClassPath: string
  readonly ownerCppName: string
  readonly static: boolean
  readonly parameters: readonly GraphStructureFunctionParameter[]
}

/** One node of the editor graph model. */
export interface GraphStructureNode {
  readonly guid: string
  readonly objectPath: string
  readonly classPath: string
  readonly className: string
  readonly classHierarchy?: readonly string[]
  readonly title: string
  readonly comment: string
  readonly posX: number
  readonly posY: number
  readonly graphObjectPath: string
  readonly enabled: boolean
  readonly memberName?: string
  readonly componentName?: string
  readonly delegateName?: string
  readonly variableName?: string
  readonly localScope?: boolean
  readonly delegatePropertyName?: string
  readonly delegateFunctionName?: string
  readonly macroGraphName?: string
  readonly macroGraphPath?: string
  readonly subGraphObjectPath?: string
  readonly subGraph?: GraphStructureSubGraph
  readonly timelineName?: string
  readonly structTypePath?: string
  readonly structTypeName?: string
  readonly castTargetPath?: string
  readonly castTargetCppName?: string
  readonly function?: GraphStructureFunction
  readonly pins: readonly GraphStructurePin[]
}

/** A collapsed graph attached to one composite node. */
export interface GraphStructureSubGraph {
  readonly name: string
  readonly objectPath: string
  readonly nodes: readonly GraphStructureNode[]
}

/** One graph of the editor graph model. */
export interface GraphStructureGraph {
  readonly name: string
  readonly objectPath: string
  readonly kind: 'ubergraph' | 'function'
  readonly nodes: readonly GraphStructureNode[]
}

/** One Blueprint member variable. */
export interface GraphStructureVariable {
  readonly name: string
  readonly category: string
  readonly cppType: string
  readonly containerType: number
  readonly typeName: string
}

/** The full structure returned by GetBlueprintGraphStructure. */
export interface BlueprintGraphStructure {
  readonly blueprintPath: string
  readonly blueprintName: string
  readonly className: string
  readonly parentClassName: string
  readonly variables: readonly GraphStructureVariable[]
  readonly graphs: readonly GraphStructureGraph[]
  readonly skippedGraphs: readonly string[]
}

const MAX_LINES = 4000
const MAX_EXPR_DEPTH = 40
const INDENT = '  '

function quote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')}"`
}

function zeroLike(value: string): boolean {
  const trimmed = value.trim()
  return trimmed === '' || trimmed === '0' || trimmed === '0.0' || trimmed === 'false' || trimmed === 'None'
}

function numeric(value: string): boolean {
  return value.trim() !== '' && Number.isFinite(Number(value))
}

function sameDeclaredDefault(pin: GraphStructurePin, declared: string): boolean {
  if (declared === '') return false
  if (numeric(declared) && numeric(pin.defaultValue)) return Math.abs(Number(declared) - Number(pin.defaultValue)) < 0.000001
  if (declared.toLowerCase() === 'true' || declared.toLowerCase() === 'false') return declared.toLowerCase() === pin.defaultValue.toLowerCase()
  return declared === pin.defaultValue
}

function shortObjectName(path: string): string {
  const tail = path.split(/[./]/).filter(part => part !== '').pop() ?? path
  return tail
}

function parseConnection(connection: string): { guid: string; pin: string } | undefined {
  const separator = connection.indexOf('::')
  if (separator < 0) return undefined
  return { guid: connection.slice(0, separator), pin: connection.slice(separator + 2) }
}

function asyncNode(node: GraphStructureNode): boolean {
  return (node.classHierarchy ?? []).some(name => name.includes('Async') || name.includes('Latent'))
}

/** Render one Blueprint graph structure to TypeScript-like pseudocode. */
export class BlueprintTypeScriptConverter {
  private readonly nodes = new Map<string, GraphStructureNode>()
  private readonly lines: string[] = []
  private readonly visited = new Set<string>()
  private readonly overrides = new Map<string, string>()
  private readonly expressionCache = new Map<string, string>()
  private readonly expressionBusy = new Set<string>()
  private readonly compositeContexts: Array<{ exitGuid: string }> = []
  private tempIndex = 0
  private truncated = false

  private readonly structure: BlueprintGraphStructure

  constructor(structure: BlueprintGraphStructure) {
    this.structure = structure
    for (const graph of structure.graphs) this.registerNodes(graph.nodes)
  }

  private registerNodes(nodes: readonly GraphStructureNode[]): void {
    for (const node of nodes) {
      this.nodes.set(node.guid, node)
      if (node.subGraph !== undefined) this.registerNodes(node.subGraph.nodes)
    }
  }

  /** Render the whole Blueprint class. */
  convert(): string {
    this.lines.length = 0
    this.lines.push(`// Blueprint: ${this.structure.blueprintPath}`)
    const graphNames = this.structure.graphs.map(graph => graph.name)
    this.lines.push(`// Graphs: ${graphNames.join(', ')}`)
    if (this.structure.skippedGraphs.length > 0) {
      this.lines.push(`// Skipped (unsupported graph schema): ${this.structure.skippedGraphs.join(', ')}`)
    }
    this.lines.push(`class ${this.structure.className} extends ${this.structure.parentClassName} {`)
    this.appendVariables()
    this.appendMethods()
    this.lines.push('}')
    return this.lines.join('\n')
  }

  private line(text: string, indent: number): void {
    if (this.truncated || this.lines.length >= MAX_LINES) {
      if (!this.truncated) {
        this.truncated = true
        this.lines.push(`${INDENT.repeat(indent)}// ... graph rendering truncated at ${String(MAX_LINES)} lines`)
      }
      return
    }
    this.lines.push(`${INDENT.repeat(indent)}${text}`)
  }

  private appendVariables(): void {
    if (this.structure.variables.length === 0) return
    this.lines.push('  // #region properties')
    for (const variable of this.structure.variables) {
      this.lines.push(`  ${variable.name}: ${this.variableType(variable)}`)
    }
    this.lines.push('  // #endregion')
  }

  private variableType(variable: GraphStructureVariable): string {
    const base = variable.cppType === 'unknown' ? variable.typeName.split(/[./]/).pop() ?? 'unknown' : variable.cppType
    if (variable.containerType === 1) return `${base}[]`
    if (variable.containerType === 2) return `Set<${base}>`
    if (variable.containerType === 3) return `Map<${base}>`
    return base
  }

  private appendMethods(): void {
    let hasMethods = false
    for (const graph of this.structure.graphs) {
      for (const node of graph.nodes) {
        if (this.isEventEntry(node) || node.className === 'K2Node_FunctionEntry') {
          hasMethods = true
          break
        }
      }
      if (hasMethods) break
    }
    if (!hasMethods) {
      this.lines.push('  // no event or function entry nodes in this blueprint')
      return
    }
    this.lines.push('  // #region methods')
    for (const graph of this.structure.graphs) {
      for (const node of graph.nodes) {
        if (this.isEventEntry(node)) this.renderMethod(node, this.eventMethodName(node, graph))
      }
      for (const node of graph.nodes) {
        if (node.className === 'K2Node_FunctionEntry') this.renderMethod(node, graph.name)
      }
    }
    this.lines.push('  // #endregion')
  }

  private renderMethod(entry: GraphStructureNode, name: string): void {
    this.visited.clear()
    this.overrides.clear()
    this.expressionCache.clear()
    this.expressionBusy.clear()
    this.tempIndex = 0
    const params = this.entryParameters(entry).join(', ')
    this.line(`${name}(${params}) {`, 1)
    for (const pin of entry.pins) {
      if (pin.direction === 'output' && pin.category === 'exec') this.renderExecOutput(pin, 2)
    }
    this.line('}', 1)
  }

  private entryParameters(entry: GraphStructureNode): string[] {
    return entry.pins
      .filter(pin => pin.direction === 'output' && pin.category !== 'exec' && pin.category !== 'delegate')
      .map(pin => pin.name)
  }

  private isEventEntry(node: GraphStructureNode): boolean {
    return node.className !== 'K2Node_FunctionEntry'
      && (this.isKindOf(node, 'K2Node_Event')
        || this.isKindOf(node, 'K2Node_CustomEvent')
        || this.isKindOf(node, 'K2Node_ComponentBoundEvent'))
  }

  private eventMethodName(node: GraphStructureNode, graph: GraphStructureGraph): string {
    if (node.className === 'K2Node_ComponentBoundEvent') {
      return `${node.componentName ?? ''}_${node.delegateName ?? ''}`
    }
    const base = node.memberName ?? graph.name
    if (node.className === 'K2Node_CustomEvent') return base
    return base.startsWith('Receive') ? base.slice('Receive'.length) : base
  }

  private isKindOf(node: GraphStructureNode, className: string): boolean {
    return node.className === className || node.classHierarchy?.includes(className) === true
  }

  private findPin(node: GraphStructureNode, name: string, direction: 'input' | 'output'): GraphStructurePin | undefined {
    return node.pins.find(pin => pin.direction === direction && pin.name.toLowerCase() === name.toLowerCase())
  }

  private execOutputs(node: GraphStructureNode): GraphStructurePin[] {
    return node.pins.filter(pin => pin.direction === 'output' && pin.category === 'exec')
  }

  private nonExecInputs(node: GraphStructureNode): GraphStructurePin[] {
    return node.pins.filter(pin => pin.direction === 'input' && pin.category !== 'exec' && pin.category !== 'delegate')
  }

  private targetNodes(pin: GraphStructurePin): GraphStructureNode[] {
    const result: GraphStructureNode[] = []
    for (const connection of pin.connections) {
      const parsed = parseConnection(connection)
      if (parsed === undefined) continue
      const node = this.nodes.get(parsed.guid)
      if (node !== undefined) result.push(node)
    }
    return result
  }

  private renderExecOutput(pin: GraphStructurePin | undefined, indent: number): void {
    if (pin === undefined) return
    for (const node of this.targetNodes(pin)) this.renderExecNode(node, indent)
  }

  private renderExecNode(node: GraphStructureNode, indent: number): void {
    if (this.compositeContexts.some(context => context.exitGuid === node.guid)) return
    if (this.visited.has(node.guid)) return
    this.visited.add(node.guid)
    if (node.comment.trim() !== '') this.line(`// ${node.comment.replaceAll('\n', ' ')}`, indent)
    const className = node.className

    if (this.isKindOf(node, 'K2Node_ExecutionSequence')) {
      for (const pin of this.execOutputs(node)) this.renderExecOutput(pin, indent)
      return
    }
    if (this.isKindOf(node, 'K2Node_IfThenElse')) {
      const condition = this.exprForPin(this.findPin(node, 'Condition', 'input'), 0)
      this.line(`if (${condition}) {`, indent)
      this.renderExecOutput(this.findPin(node, 'then', 'output'), indent + 1)
      this.line('} else {', indent)
      this.renderExecOutput(this.findPin(node, 'else', 'output'), indent + 1)
      this.line('}', indent)
      return
    }
    if (this.isKindOf(node, 'K2Node_Switch')) {
      this.renderSwitch(node, indent)
      return
    }
    if (this.isKindOf(node, 'K2Node_CallFunction')) {
      const call = this.callExpression(node)
      const returnPin = node.pins.find(pin => pin.direction === 'output' && pin.category !== 'exec')
      if (returnPin !== undefined && returnPin.connections.length > 0) {
        const variable = `T${++this.tempIndex}`
        this.line(`const ${variable} = ${call};`, indent)
        this.overrides.set(`${node.guid}::${returnPin.name}`, variable)
      } else {
        this.line(`${call};`, indent)
      }
      for (const pin of this.execOutputs(node)) this.renderExecOutput(pin, indent)
      return
    }
    if (this.isKindOf(node, 'K2Node_VariableSet')) {
      const name = node.variableName ?? 'unknown'
      const value = this.exprForPin(this.findPin(node, name, 'input'), 0)
      this.line(`${node.localScope === true ? '' : 'this.'}${name} = ${value};`, indent)
      for (const pin of this.execOutputs(node)) this.renderExecOutput(pin, indent)
      return
    }
    if (this.isKindOf(node, 'K2Node_FunctionResult')) {
      const input = this.nonExecInputs(node).find(pin => pin.connections.length > 0)
      if (input !== undefined) this.line(`return ${this.exprForPin(input, 0)};`, indent)
      return
    }
    if (this.isKindOf(node, 'K2Node_Knot')) {
      for (const pin of this.execOutputs(node)) this.renderExecOutput(pin, indent)
      return
    }
    if (this.isKindOf(node, 'K2Node_MacroInstance')) {
      this.renderMacro(node, indent)
      return
    }
    if (this.isKindOf(node, 'K2Node_Composite')) {
      this.renderComposite(node, indent)
      return
    }
    if (this.isKindOf(node, 'K2Node_Timeline')) {
      this.renderTimeline(node, indent)
      return
    }
    if (asyncNode(node)) {
      this.line(`// async: ${node.title}`, indent)
      for (const pin of this.execOutputs(node)) {
        if (pin.connections.length === 0) continue
        this.line(`// ${pin.name}:`, indent)
        this.renderExecOutput(pin, indent + 1)
      }
      return
    }
    if (this.isDelegateNode(node) || this.isConstructNode(node)) {
      if (this.isDelegateNode(node)) this.renderDelegate(node, indent)
      else this.renderConstruct(node, indent)
      return
    }
    this.line(`// TODO: ${node.title} (${className})`, indent)
    for (const pin of this.execOutputs(node)) this.renderExecOutput(pin, indent)
  }

  private renderSwitch(node: GraphStructureNode, indent: number): void {
    const selection = node.pins.find(pin => pin.direction === 'input' && pin.category !== 'exec')
    this.line(`switch (${this.exprForPin(selection, 0)}) {`, indent)
    let defaultPin: GraphStructurePin | undefined
    for (const pin of this.execOutputs(node)) {
      if (pin.name.toLowerCase() === 'default' || pin.name.toLowerCase() === 'defaultpin') {
        defaultPin = pin
        continue
      }
      const value = ['string', 'name', 'text'].includes(this.pinCategory(pin)) ? quote(pin.name) : pin.name
      this.line(`case ${value}: {`, indent + 1)
      this.renderExecOutput(pin, indent + 2)
      this.line('break;', indent + 2)
      this.line('}', indent + 1)
    }
    if (defaultPin !== undefined) {
      this.line('default: {', indent + 1)
      this.renderExecOutput(defaultPin, indent + 2)
      this.line('}', indent + 1)
    }
    this.line('}', indent)
  }

  private isDelegateNode(node: GraphStructureNode): boolean {
    return ['AddDelegate', 'RemoveDelegate', 'ClearDelegate', 'CallDelegate', 'AssignDelegate', 'DelegateSet']
      .some(name => node.className.includes(name))
  }

  private isConstructNode(node: GraphStructureNode): boolean {
    return node.className.includes('CreateWidget') || node.className.includes('SpawnActor')
  }

  private renderDelegate(node: GraphStructureNode, indent: number): void {
    const targetPin = this.findPin(node, 'self', 'input')
    const target = targetPin === undefined || targetPin.connections.length === 0 ? 'this' : this.exprForPin(targetPin, 0)
    const property = node.delegatePropertyName ?? 'Delegate'
    const access = `${target}.${property}`
    const delegatePin = node.pins.find(pin => pin.direction === 'input' && pin.category === 'delegate')
    if (node.className.includes('AddDelegate')) this.line(`${access}.Add(${this.exprForPin(delegatePin, 0)});`, indent)
    else if (node.className.includes('RemoveDelegate')) this.line(`${access}.Remove(${this.exprForPin(delegatePin, 0)});`, indent)
    else if (node.className.includes('ClearDelegate')) this.line(`${access}.Clear();`, indent)
    else if (node.className.includes('CallDelegate')) {
      const args = this.nonExecInputs(node).filter(pin => pin !== delegatePin && pin.name !== 'self').map(pin => this.exprForPin(pin, 0))
      this.line(`${access}.Broadcast(${args.join(', ')});`, indent)
    } else {
      const value = this.nonExecInputs(node).find(pin => pin !== delegatePin && pin.name !== 'self')
      this.line(`${access} = ${this.exprForPin(value, 0)};`, indent)
    }
    for (const pin of this.execOutputs(node)) this.renderExecOutput(pin, indent)
  }

  private renderConstruct(node: GraphStructureNode, indent: number): void {
    const expression = this.constructExpression(node)
    const result = node.pins.find(pin => pin.direction === 'output' && pin.category !== 'exec')
    if (result !== undefined && result.connections.length > 0) {
      const variable = `T${++this.tempIndex}`
      this.line(`const ${variable} = ${expression};`, indent)
      this.overrides.set(`${node.guid}::${result.name}`, variable)
    } else {
      this.line(`${expression};`, indent)
    }
    for (const pin of this.execOutputs(node)) this.renderExecOutput(pin, indent)
  }

  private constructExpression(node: GraphStructureNode): string {
    const classPin = this.findPin(node, 'Class', 'input')
    const classExpr = classPin !== undefined && classPin.defaultObjectPath !== ''
      ? shortObjectName(classPin.defaultObjectPath)
      : (node.className.includes('SpawnActor') ? 'AActor' : 'UUserWidget')
    if (node.className.includes('SpawnActor')) {
      const transform = this.findPin(node, 'Transform', 'input')
      const args = transform !== undefined && transform.connections.length > 0 ? [classExpr, this.exprForPin(transform, 0)] : [classExpr]
      return `SpawnActor(${args.join(', ')})`
    }
    const outer = this.findPin(node, 'Outer', 'input') ?? this.findPin(node, 'self', 'input')
    return `CreateWidget(${classExpr}, ${outer === undefined || outer.connections.length === 0 ? 'this' : this.exprForPin(outer, 0)})`
  }

  private exprForPin(pin: GraphStructurePin | undefined, depth: number): string {
    if (pin === undefined || depth > MAX_EXPR_DEPTH) return 'null'
    if (pin.connections.length === 0) return this.literalForPin(pin)
    const parts: string[] = []
    for (const connection of pin.connections) {
      const parsed = parseConnection(connection)
      if (parsed === undefined) continue
      const node = this.nodes.get(parsed.guid)
      if (node === undefined) continue
      const sourcePin = this.findPin(node, parsed.pin, 'output')
      if (sourcePin === undefined) continue
      parts.push(this.nodeExpression(node, sourcePin, depth + 1))
    }
    if (parts.length === 0) return 'null'
    return parts.length === 1 ? (parts[0] ?? 'null') : `(${parts.join(' ?? ')})`
  }

  private nodeExpression(node: GraphStructureNode, output: GraphStructurePin, depth: number): string {
    const override = this.overrides.get(`${node.guid}::${output.name}`)
    if (override !== undefined) return override
    const cacheKey = `${node.guid}::${output.name}`
    const cached = this.expressionCache.get(cacheKey)
    if (cached !== undefined) return cached
    if (this.expressionBusy.has(cacheKey)) return 'null'
    this.expressionBusy.add(cacheKey)
    const result = this.computeNodeExpression(node, output, depth)
    this.expressionBusy.delete(cacheKey)
    this.expressionCache.set(cacheKey, result)
    return result
  }

  private computeNodeExpression(node: GraphStructureNode, output: GraphStructurePin, depth: number): string {
    if (this.isKindOf(node, 'K2Node_VariableGet') || this.isKindOf(node, 'K2Node_VariableSet')) {
      return `${node.localScope === true ? '' : 'this.'}${node.variableName ?? 'unknown'}`
    }
    if (this.isKindOf(node, 'K2Node_Knot')) {
      return this.exprForPin(this.findPin(node, 'InputPin', 'input'), depth + 1)
    }
    if (this.isKindOf(node, 'K2Node_CallFunction')) return this.callExpression(node)
    if (this.isKindOf(node, 'K2Node_Select')) {
      const condition = this.exprForPin(this.findPin(node, 'Index', 'input'), depth + 1)
      const yes = this.exprForPin(this.findPin(node, 'Option 0', 'input'), depth + 1)
      const no = this.exprForPin(this.findPin(node, 'Option 1', 'input'), depth + 1)
      return `(${condition} ? ${yes} : ${no})`
    }
    if (this.isKindOf(node, 'K2Node_DynamicCast')) {
      return `Cast(${this.exprForPin(this.findPin(node, 'Object', 'input'), depth + 1)}, ${node.castTargetCppName ?? 'UObject'})`
    }
    if (this.isKindOf(node, 'K2Node_GetArrayItem')) {
      return `(${this.exprForPin(this.findPin(node, 'Array', 'input'), depth + 1)})[${this.exprForPin(this.findPin(node, 'Dimension 1', 'input'), depth + 1)}]`
    }
    if (this.isKindOf(node, 'K2Node_MakeStruct')) {
      const fields = this.nonExecInputs(node).map(pin => `${pin.name}: ${this.exprForPin(pin, depth + 1)}`)
      return `${node.structTypeName ?? 'Struct'} { ${fields.join(', ')} }`
    }
    if (this.isKindOf(node, 'K2Node_BreakStruct') || this.isKindOf(node, 'K2Node_StructMemberGet')) {
      const struct = this.nonExecInputs(node)[0]
      return `(${this.exprForPin(struct, depth + 1)}).${output.name}`
    }
    if (this.isKindOf(node, 'K2Node_CreateDelegate')) {
      return `CreateDelegate(this, ${node.delegateFunctionName ?? 'null'})`
    }
    if (this.isKindOf(node, 'K2Node_EnumLiteral')) {
      return this.literalForPin(output)
    }
    if (this.isKindOf(node, 'K2Node_Self')) return 'this'
    if (this.isKindOf(node, 'K2Node_Literal')) return output.defaultObjectPath !== '' ? `Object(${quote(output.defaultObjectPath)})` : this.literalForPin(output)
    if (this.isConstructNode(node)) return this.constructExpression(node)
    if (this.isKindOf(node, 'K2Node_Event') || node.className === 'K2Node_FunctionEntry') {
      return output.name
    }
    if (this.isKindOf(node, 'K2Node_MacroInstance') && node.macroGraphName !== undefined) {
      const args = this.nonExecInputs(node).map(pin => this.exprForPin(pin, depth + 1))
      return `${node.macroGraphName}(${args.join(', ')})`
    }
    return `/* TODO: ${node.title} */ null`
  }

  private literalForPin(pin: GraphStructurePin): string {
    const category = pin.category
    if (category === 'exec' || category === 'delegate') return ''
    if (category === 'bool') return pin.defaultValue.toLowerCase() === 'true' ? 'true' : 'false'
    if (['int', 'int64', 'byte', 'real', 'float', 'double'].includes(category)) {
      if (pin.enum) {
        const entry = pin.defaultValue.replace(/^.*::/, '')
        return `${pin.enumName ?? shortObjectName(pin.typeName)}.${entry === '' ? '0' : entry}`
      }
      return pin.defaultValue === '' ? '0' : pin.defaultValue
    }
    if (['string', 'name', 'text'].includes(category)) return quote(pin.defaultValue)
    if (pin.defaultObjectPath !== '') {
      return category === 'class' ? `Class(${quote(pin.defaultObjectPath)})` : `Object(${quote(pin.defaultObjectPath)})`
    }
    if (pin.defaultValue !== '') return `"${pin.defaultValue.replaceAll('"', '\\"')}"`
    return 'null'
  }

  private pinCategory(pin: GraphStructurePin): string { return pin.category }

  private callExpression(node: GraphStructureNode): string {
    const fn = node.function
    if (fn === undefined) return `/* TODO: ${node.title} */ null`
    const args: { pin: GraphStructurePin; value: string; isDefault: boolean; isOmittable: boolean }[] = []
    for (const parameter of fn.parameters) {
      if (parameter.return) continue
      const pin = this.findPin(node, parameter.name, 'input')
      if (pin === undefined) continue
      const isDeclaredDefault = pin.connections.length === 0 && sameDeclaredDefault(pin, parameter.declaredDefault)
      const isOmittable = pin.connections.length === 0 && (isDeclaredDefault || zeroLike(pin.defaultValue))
      args.push({ pin, value: this.exprForPin(pin, 0), isDefault: isDeclaredDefault, isOmittable })
    }
    const operator = this.mathOperator(fn.name, this.ownerCppName(fn), args)
    if (operator !== undefined) return `(${args[0]?.value ?? 'null'} ${operator} ${args[1]?.value ?? 'null'})`

    let last = args.length - 1
    while (last >= 0 && args[last]?.isOmittable === true) last -= 1
    const values = args.slice(0, last + 1).map((arg, index) => {
      if (index < last && arg.isDefault) return `${arg.value} /* default */`
      if (index === last && arg.isDefault) return `${arg.value} /* default */`
      return arg.value
    })
    let receiver = 'this'
    if (fn.static) receiver = this.ownerCppName(fn)
    else {
      const selfPin = this.findPin(node, 'self', 'input') ?? this.findPin(node, 'Target', 'input')
      if (selfPin !== undefined && selfPin.connections.length > 0) receiver = this.exprForPin(selfPin, 0)
    }
    return `${receiver}.${fn.name}(${values.join(', ')})`
  }

  private ownerCppName(fn: GraphStructureFunction): string {
    if (fn.ownerCppName !== undefined && fn.ownerCppName !== '') return fn.ownerCppName
    const owner = shortObjectName(fn.ownerClassPath)
    return fn.ownerClassPath.startsWith('/Script/') ? `U${owner}` : owner
  }

  private mathOperator(name: string, owner: string, args: readonly { pin: GraphStructurePin }[]): string | undefined {
    if (owner !== 'UKismetMathLibrary' || args.length !== 2) return undefined
    if (name.startsWith('Add_')) return '+'
    if (name.startsWith('Subtract_')) return '-'
    if (name.startsWith('Multiply_')) return '*'
    if (name.startsWith('Divide_')) return '/'
    if (name.startsWith('Percent_')) return '%'
    return undefined
  }

  private renderComposite(node: GraphStructureNode, indent: number): void {
    const subGraph = node.subGraph
    if (subGraph === undefined) {
      this.line(`// collapsed: ${node.title}`, indent)
      for (const pin of this.execOutputs(node)) this.renderExecOutput(pin, indent)
      return
    }
    const entry = subGraph.nodes.find(candidate => this.isKindOf(candidate, 'K2Node_Tunnel')
      && candidate.pins.some(pin => pin.direction === 'output' && pin.category === 'exec'))
    const exit = subGraph.nodes.find(candidate => this.isKindOf(candidate, 'K2Node_Tunnel')
      && candidate.pins.some(pin => pin.direction === 'input' && pin.category === 'exec'))
    if (entry === undefined || exit === undefined) {
      this.line(`// collapsed: ${node.title}`, indent)
      for (const pin of this.execOutputs(node)) this.renderExecOutput(pin, indent)
      return
    }

    for (const input of this.nonExecInputs(node)) {
      const tunnelPin = this.findPin(entry, input.name, 'output')
      if (tunnelPin !== undefined) this.overrides.set(`${entry.guid}::${tunnelPin.name}`, this.exprForPin(input, 0))
    }
    for (const tunnelPin of this.nonExecInputs(exit)) {
      const output = this.findPin(node, tunnelPin.name, 'output')
      if (output !== undefined) this.overrides.set(`${node.guid}::${output.name}`, this.exprForPin(tunnelPin, 0))
    }

    this.line(`// composite: ${subGraph.name}`, indent)
    this.line('{', indent)
    this.compositeContexts.push({ exitGuid: exit.guid })
    for (const pin of entry.pins) {
      if (pin.direction === 'output' && pin.category === 'exec') this.renderExecOutput(pin, indent + 1)
    }
    this.compositeContexts.pop()
    this.line('}', indent)
    for (const pin of this.execOutputs(node)) this.renderExecOutput(pin, indent)
  }

  private renderTimeline(node: GraphStructureNode, indent: number): void {
    const name = node.timelineName ?? node.title
    this.line(`// timeline: ${name}`, indent)
    for (const pin of node.pins) {
      if (pin.direction !== 'output' || pin.category === 'exec') continue
      this.overrides.set(`${node.guid}::${pin.name}`, `this.${name}.${pin.name}`)
    }
    for (const pin of this.execOutputs(node)) {
      if (pin.connections.length === 0) continue
      this.line(`// ${pin.name}:`, indent + 1)
      this.renderExecOutput(pin, indent + 2)
    }
  }

  private renderMacro(node: GraphStructureNode, indent: number): void {
    const name = node.macroGraphName ?? node.title
    const body = this.findPin(node, 'LoopBody', 'output')
    const completed = this.findPin(node, 'Completed', 'output')
    if (name.includes('ForEachLoop')) {
      const array = this.exprForPin(this.findPin(node, 'Array', 'input'), 0)
      const id = ++this.tempIndex
      const item = `item${String(id)}`
      const index = `index${String(id)}`
      const elementPin = this.findPin(node, 'Array Element', 'output')
      const indexPin = this.findPin(node, 'Array Index', 'output')
      if (elementPin !== undefined) this.overrides.set(`${node.guid}::${elementPin.name}`, item)
      if (indexPin !== undefined) this.overrides.set(`${node.guid}::${indexPin.name}`, index)
      const iterable = name.includes('Reverse') ? `[...${array}].reverse()` : array
      this.line(`for (const [${index}, ${item}] of ${iterable}.entries()) {`, indent)
      this.renderExecOutput(body, indent + 1)
      this.line('}', indent)
      this.renderExecOutput(completed, indent)
      return
    }
    if (name.includes('WhileLoop')) {
      this.line(`while (${this.exprForPin(this.findPin(node, 'Condition', 'input'), 0)}) {`, indent)
      this.renderExecOutput(body, indent + 1)
      this.line('}', indent)
      this.renderExecOutput(completed, indent)
      return
    }
    if (name.includes('ForLoop')) {
      const id = ++this.tempIndex
      const index = `loop${String(id)}`
      this.line(`for (let ${index} = ${this.exprForPin(this.findPin(node, 'FirstIndex', 'input'), 0)}; ${index} <= ${this.exprForPin(this.findPin(node, 'LastIndex', 'input'), 0)}; ${index}++) {`, indent)
      const indexPin = this.findPin(node, 'Index', 'output')
      if (indexPin !== undefined) this.overrides.set(`${node.guid}::${indexPin.name}`, index)
      this.renderExecOutput(body, indent + 1)
      this.line('}', indent)
      this.renderExecOutput(completed, indent)
      return
    }
    this.line(`// macro: ${name}`, indent)
    for (const pin of this.execOutputs(node)) {
      if (pin.connections.length === 0) continue
      this.line(`// ${pin.name}:`, indent)
      this.renderExecOutput(pin, indent + 1)
    }
  }
}

/**
 * Render a Blueprint graph structure to the card's TypeScript-like text.
 *
 * @param structure - the JSON model returned by GetBlueprintGraphStructure.
 * @returns the rendered class text.
 */
export function convertBlueprintToTypeScript(structure: BlueprintGraphStructure): string {
  return new BlueprintTypeScriptConverter(structure).convert()
}
