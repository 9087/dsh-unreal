/**
 * Test-side adapter for fake transports.
 *
 * The plugin now reaches every EditorAutomation library function through the generic
 * `CallFunction` dispatcher, so a fake transport receives
 * `{FunctionName: 'CallFunction', Parameters: {ObjectPath, FunctionName, ParametersJson}}`
 * and must answer with a `FEditorAutomationCallFunctionResult` envelope whose
 * `ReturnValueJson` holds the function's nested-JSON payload.
 *
 * These helpers let the existing fixtures (written against the old per-function
 * result structs) keep driving the tests: `wrapCallFunctionAnswer` converts a
 * legacy result struct into the dispatcher envelope, and `innerCall` extracts the
 * inner function name/parameters from a dispatcher request.
 */

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

/** Convert one legacy result struct into the native payload the new contract returns. */
function payloadFor(functionName: string, legacy: Record<string, unknown>): unknown {
  switch (functionName) {
    case 'GetPropertyType':
      // The function returns FEditorAutomationPropertyTypeInfo; older fixtures only carry Type.
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
        bSuccess: true,
        OldValueJson: legacy['OldValueJson'] ?? '',
        NewValueJson: legacy['NewValueJson'] ?? '',
        DisplayNameText: legacy['DisplayNameText'],
      }
    case 'CaptureScreenshot':
      return legacy['FilePath'] ?? ''
    case 'StartPIE':
    case 'StopPIE':
    case 'FocusPIEViewport':
    case 'SendKeyToPIE':
      return legacy['bSuccess'] !== false
    default:
      return legacy['Info'] ?? stripErrorFields(legacy)
  }
}

/** Wrap a legacy fixture into the CallFunction dispatcher's result envelope. */
export function wrapCallFunctionAnswer(functionName: string, fixture: unknown): unknown {
  if (isDispatcherResult(fixture)) return fixture
  if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)) {
    return {
      ErrorCode: 0,
      ErrorMessage: '',
      Hint: '',
      ReturnValueJson: JSON.stringify(fixture ?? null),
      OutParametersJson: '{}',
      ReturnType: '',
    }
  }
  const record = fixture as Record<string, unknown>
  // The native contract reports failure by returning an empty value and logging the reason,
  // so a legacy error fixture maps to an empty payload rather than a dispatcher error.
  const code = typeof record['ErrorCode'] === 'number' ? record['ErrorCode'] : 0
  if (code !== 0) {
    return {
      ErrorCode: 0,
      ErrorMessage: '',
      Hint: '',
      ReturnValueJson: '{}',
      OutParametersJson: '{}',
      ReturnType: '',
    }
  }
  return {
    ErrorCode: 0,
    ErrorMessage: '',
    Hint: '',
    ReturnValueJson: JSON.stringify(payloadFor(functionName, record)),
    OutParametersJson: '{}',
    ReturnType: '',
  }
}
