/**
 * Test-side adapter for fake transports.
 *
 * Every EditorAutomation library function is reached through the generic `CallFunction`
 * dispatcher, so a fake transport receives
 * `{FunctionName: 'CallFunction', Parameters: {ObjectPath, FunctionName, ParametersJson}}`
 * and answers with a `FEditorAutomationCallFunctionResult` envelope whose
 * `ReturnValueJson` is the operation's `FEditorAutomationResult` and whose
 * `OutParametersJson` holds the operation's data outputs.
 *
 * These helpers let fixtures (written against the old per-function result structs) keep
 * driving the tests: `wrapCallFunctionAnswer` converts a legacy fixture into the current
 * envelope + out-parameter answer, and `innerCall` extracts the inner request.
 */

/** Map one operation to the name of its (single) data out-parameter. */
const OUT_PARAMETER: Readonly<Record<string, string>> = {
  Ping: 'OutValue',
  GetEditorInfo: 'OutInfo',
  CaptureScreenshot: 'OutFilePath',
  IsPIERunning: 'OutRunning',
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
  GetBlueprintLuaPath: 'OutLuaPath',
  GetBlueprintGraphs: 'OutGraphs',
  GetGraphNodes: 'OutNodes',
  GetNodePins: 'OutPins',
  AddCallFunctionNode: 'OutNodeObjectPath',
  AddEventNode: 'OutNodeObjectPath',
  AddComponentBoundEventNode: 'OutNodeObjectPath',
  AddBranchNode: 'OutNodeObjectPath',
  AddVariableGetNode: 'OutNodeObjectPath',
  AddVariableSetNode: 'OutNodeObjectPath',
  RemoveGraphNodesByClass: 'OutRemovedCount',
  GetCurrentLevelInfo: 'OutInfo',
  IsCurrentLevelDirty: 'OutDirty',
  GetLevelScriptBlueprint: 'OutBlueprint',
  ListAssets: 'OutAssets',
  ListFolders: 'OutFolders',
  GetAssetInfo: 'OutInfo',
  DoesAssetExist: 'OutExists',
  LoadAsset: 'OutAsset',
  GetDirtyAssets: 'OutDirtyAssets',
  GetWidgetRoots: 'OutRoots',
  GetWidgetBlueprintPath: 'OutBlueprintPath',
  GetWidgetClassPath: 'OutClassPath',
  GetWidgetTreeDiff: 'OutDiff',
  GetWidgetGeometry: 'OutGeometry',
  GetListViewInfo: 'OutInfo',
  GetListEntryInfo: 'OutEntry',
  ScrollToListEntry: 'OutEntry',
  CaptureWidgetScreenshot: 'OutFilePath',
  CreateWidgetBlueprint: 'OutWidgetBlueprintPath',
  AddRootWidget: 'OutWidgetPath',
  GetWidgetTree: 'OutWidgets',
  GetWidgetParent: 'OutParent',
  GetWidgetChildren: 'OutChildren',
  GetWidgetSlot: 'OutSlot',
  AddWidget: 'OutWidgetPath',
  RenameWidget: 'OutWidgetPath',
  IsWidgetVariable: 'OutIsVariable',
  GetUserWidgetRoot: 'OutRootWidget',
  GetWidgetTextActiveStates: 'OutStates',
  IsMouseInputPending: 'OutPending'
}

/** Parse the inner EditorAutomation function out of a CallFunction request. */
export function innerCall(body: {
  FunctionName?: unknown
  Parameters?: Record<string, unknown>
}): { functionName: string; parameters: Record<string, unknown> } | undefined {
  if (body.FunctionName !== 'CallFunction') return undefined
  const parameters = body.Parameters ?? {}
  const functionName = String(parameters['FunctionName'] ?? '')
  let parsed: Record<string, unknown> = {}
  const parametersJson = parameters['ParametersJson']
  if (typeof parametersJson === 'string' && parametersJson.trim() !== '') {
    try {
      parsed = JSON.parse(parametersJson) as Record<string, unknown>
    } catch {
      parsed = {}
    }
  }
  return { functionName, parameters: parsed }
}

/** Whether a fixture is already a CallFunction result envelope. */
function isDispatcherResult(value: unknown): boolean {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.prototype.hasOwnProperty.call(value, 'ReturnValueJson')
}

/** Strip the old per-function error envelope fields from a payload struct. */
function stripErrorFields(value: Record<string, unknown>): Record<string, unknown> {
  const { ErrorCode, ErrorMessage, Hint, ...rest } = value
  return rest
}

/** Convert one legacy result struct into the data value the new contract returns. */
function dataFor(functionName: string, legacy: Record<string, unknown>): unknown {
  switch (functionName) {
    case 'GetPropertyType':
      return {
        Type: legacy['Type'] ?? '',
        DisplayNameText: legacy['DisplayNameText'] ?? {},
      }
    case 'GetObjectClass':
      return legacy['ClassType'] ?? ''
    case 'GetPropertyValue':
      return legacy['ValueJson'] ?? ''
    case 'SetPropertyValue':
      return {
        OldValueJson: legacy['OldValueJson'] ?? '',
        NewValueJson: legacy['NewValueJson'] ?? '',
        DisplayNameText: legacy['DisplayNameText'],
      }
    case 'CaptureScreenshot':
    case 'CaptureWidgetScreenshot':
      return legacy['FilePath'] ?? legacy['ScreenshotPath'] ?? ''
    case 'IsPIERunning':
    case 'IsCurrentLevelDirty':
    case 'IsWidgetVariable':
    case 'IsMouseInputPending':
    case 'DoesAssetExist':
      return legacy['bSuccess'] !== false
    case 'StartPIE':
    case 'StopPIE':
    case 'FocusPIEViewport':
    case 'SendKeyToPIE':
      return legacy['bSuccess'] !== false
    default:
      return legacy['Info'] ?? stripErrorFields(legacy)
  }
}

/** Wrap a legacy fixture into the CallFunction dispatcher's current result shape. */
export function wrapCallFunctionAnswer(functionName: string, fixture: unknown): unknown {
  if (isDispatcherResult(fixture)) return fixture

  const outName = OUT_PARAMETER[functionName]
  const answer = (success: boolean, data: unknown, errorCode = 0, errorMessage = '', hint = ''): unknown => ({
    ErrorCode: 0,
    ErrorMessage: '',
    Hint: '',
    ReturnType: '',
    ReturnValueJson: JSON.stringify(
      success
        ? { bSuccess: 'true', ErrorCode: '0', ErrorMessage: '', Hint: '' }
        : { bSuccess: 'false', ErrorCode: String(errorCode), ErrorMessage: errorMessage, Hint: hint },
    ),
    OutParametersJson: success && outName !== undefined ? JSON.stringify({ [outName]: data }) : '{}',
  })

  if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)) {
    return answer(true, fixture ?? null)
  }
  const record = fixture as Record<string, unknown>
  const code = typeof record['ErrorCode'] === 'number' ? record['ErrorCode'] : 0
  if (code !== 0) {
    const message = typeof record['ErrorMessage'] === 'string' ? record['ErrorMessage'] : ''
    const hint = typeof record['Hint'] === 'string' ? record['Hint'] : ''
    return answer(false, null, code, message, hint)
  }
  return answer(true, dataFor(functionName, record))
}
