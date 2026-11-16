/**
 * The EditorAutomation wire contract, mirrored from
 * `C:\PROJECTS\UnrealEngine\Game\Plugins\EditorAutomation\Source\EditorAutomation\Public\EditorAutomationLibrary.h`.
 *
 * Every call reaches the plugin's class default object through Remote Control's
 * `PUT /remote/object/call`; the response is `{"ReturnValue": ...}`. The
 * structs below name the serialized fields exactly as the engine emits them
 * (Remote Control serializes USTRUCT members by their C++ names, PascalCase).
 *
 * Numeric enums are the C++ enum values — Remote Control never emits a display
 * name for a plain (non-UENUM) enum. The {@link KIT_ERROR_CODES} table is the
 * single place those numbers become names.
 *
 * @module dsh-unreal/kit/types
 */

/** The RC-facing class default object of `UEditorAutomationCoreLibrary`. */
export const EDITOR_AUTOMATION_CDO = '/Script/EditorAutomation.Default__EditorAutomationCoreLibrary'

/** RC-facing CDO paths of the EditorAutomation libraries; every tool reaches them through CallFunction. */
export const EDITOR_AUTOMATION_LIBRARIES = {
  core: EDITOR_AUTOMATION_CDO,
  blueprint: '/Script/EditorAutomation.Default__EditorAutomationBlueprintLibrary',
  graph: '/Script/EditorAutomation.Default__EditorAutomationGraphLibrary',
  level: '/Script/EditorAutomation.Default__EditorAutomationLevelLibrary',
  asset: '/Script/EditorAutomation.Default__EditorAutomationAssetLibrary',
  umg: '/Script/EditorAutomation.Default__EditorAutomationUMGLibrary',
  umgEditor: '/Script/EditorAutomation.Default__EditorAutomationUMGEditorLibrary',
} as const

/** Remote Control's object-call route. */
export const OBJECT_CALL_ROUTE = '/remote/object/call'

/** The EditorAutomation API version this adapter was written against (README/header slice). */
export const SUPPORTED_KIT_VERSION = '1.0.0-first-slice'

/** A localizable FText reference from EditorAutomation. */
export interface KitTextRef {
  Namespace?: string
  Key?: string
  SourceString?: string
  SourceHash?: number
  TableId?: string
  NativeText?: string
}

/** One `FEditorAutomationPropertyInfo`. */
export interface KitPropertyInfo {
  /** Property name. */
  Name?: string
  /** Canonical Type string, e.g. `double` or `struct(/Script/CoreUObject.Vector)`. */
  Type?: string
  /** Full FText reference. */
  DisplayName?: KitTextRef
}

/** One `FEditorAutomationParameterInfo`. */
export interface KitParameterInfo {
  /** Parameter name as the UFunction declares it. */
  Name?: string
  /** Canonical Type string. */
  Type?: string
  /** `EEditorAutomationParameterDirection` as an integer: 0 input, 1 output, 2 input/output. */
  Direction?: number
  /** UE display name of the parameter. */
  DisplayNameText?: KitTextRef
}

/** One `FEditorAutomationFunctionInfo`. */
export interface KitFunctionInfo {
  /** UFunction name. */
  Name?: string
  /** Full FText reference. */
  DisplayName?: KitTextRef
  /** Whether the function is BlueprintCallable. */
  bBlueprintCallable?: boolean
  /** Whether the function is BlueprintPure. */
  bBlueprintPure?: boolean
  /** Whether the function is static. */
  bStatic?: boolean
  /** Parameters, in declaration order. */
  Parameters?: KitParameterInfo[]
  /** Canonical Type string of the return value; empty when it returns nothing. */
  ReturnType?: string
}

/** One `FEditorAutomationEnumEntry`. */
export interface KitEnumEntry {
  /** Canonical C++ entry name, e.g. `QueryAndPhysics`. */
  Name?: string
  /** Full FText reference. */
  DisplayName?: KitTextRef
  /** Numeric value. */
  Value?: number
}

/** The `Info` member of `FEditorAutomationGetEnumInfoResult`. */
export interface KitEnumInfo {
  /** The resolved enum object path, e.g. `/Script/Engine.ECollisionEnabled`. */
  Enum?: string
  /** Every entry. */
  Entries?: KitEnumEntry[]
}

/** The `Info` member of `FEditorAutomationGetStructInfoResult`. */
export interface KitStructInfo {
  /** The resolved struct path, e.g. `/Script/CoreUObject.Vector`. */
  Struct?: string
  /** Every member. */
  Properties?: KitPropertyInfo[]
}

/** The `Info` member of `FEditorAutomationGetClassInfoResult`. */
export interface KitClassInfo {
  /** The resolved class path. */
  Class?: string
  /** Every property. */
  Properties?: KitPropertyInfo[]
  /** Every BlueprintCallable function. */
  Functions?: KitFunctionInfo[]
}

/** The `Info` member of `FEditorAutomationGetFunctionInfoResult` — the function itself. */
export type KitGetFunctionInfoPayload = KitFunctionInfo

/** A result struct that only reports success or failure. */
export interface KitErrorFields {
  /** 0 means success; every other value is a per-function failure code. */
  ErrorCode?: number
  /** Engine-supplied failure text. */
  ErrorMessage?: string
  /** Engine-supplied remediation hint (may be empty). */
  Hint?: string
}

/** `FEditorAutomationGetEnumInfoResult`. */
export interface KitGetEnumInfoResult extends KitErrorFields {
  /** Present on success. */
  Info?: KitEnumInfo
}

/** `FEditorAutomationGetStructInfoResult`. */
export interface KitGetStructInfoResult extends KitErrorFields {
  /** Present on success. */
  Info?: KitStructInfo
}

/** `FEditorAutomationGetClassInfoResult`. */
export interface KitGetClassInfoResult extends KitErrorFields {
  /** Present on success. */
  Info?: KitClassInfo
}

/** `FEditorAutomationGetFunctionInfoResult`. */
export interface KitGetFunctionInfoResult extends KitErrorFields {
  /** Present on success. */
  Info?: KitGetFunctionInfoPayload
}

/** `FEditorAutomationGetPropertyTypeResult`. */
export interface KitGetPropertyTypeResult extends KitErrorFields {
  /** Canonical Type string of the property. */
  Type?: string
  /** UE display name of the resolved property. */
  DisplayNameText?: KitTextRef
}

/** `FEditorAutomationGetPropertyValueResult`. */
export interface KitGetPropertyValueResult extends KitErrorFields {
  /** The value as nested JSON text. Scalars are strings; enums are numeric. */
  ValueJson?: string
}

/** `FEditorAutomationSetPropertyValueResult`. */
export interface KitSetPropertyValueResult extends KitErrorFields {
  /** The value before the write, as nested JSON text. */
  OldValueJson?: string
  /** The value after the write, as nested JSON text. */
  NewValueJson?: string
}

/** `FEditorAutomationCallFunctionResult`. */
export interface KitCallFunctionResult extends KitErrorFields {
  /** Return value as nested JSON text; empty when the function returns nothing. */
  ReturnValueJson?: string
  /** Out parameters as a JSON object keyed by parameter name; `{}` when none. */
  OutParametersJson?: string
  /** Canonical Type string of the return value; empty when none. */
  ReturnType?: string
}

/** `FEditorAutomationBatchCallEntry` — one call's outcome inside a `CallFunctions` batch. */
export interface KitBatchCallEntry {
  /** Zero-based position of this call in the request array. */
  Index?: number
  ObjectPath?: string
  FunctionName?: string
  /** `EEditorAutomationCallFunctionErrorCode`; 0 means success. */
  ErrorCode?: number
  ErrorMessage?: string
  Hint?: string
  ReturnValueJson?: string
  OutParametersJson?: string
  ReturnType?: string
}

/**
 * `FEditorAutomationBatchCallResult` — several `CallFunction`s in one round trip.
 *
 * Unlike single calls this struct has no top-level `ErrorCode`: `bSuccess` is
 * true only when the batch ran and every entry succeeded, and each entry
 * reports its own `ErrorCode`/`ErrorMessage`.
 */
export interface KitBatchCallResult {
  bSuccess?: boolean
  /** Batch-level failure (bad JSON, empty array, too many calls); empty when the batch ran. */
  ErrorMessage?: string
  Results?: KitBatchCallEntry[]
}

/**
 * `FEditorAutomationScreenshotResult` — outcome of `CaptureScreenshot`.
 *
 * `bRequested` is true for the game-viewport target: the PNG is written by the
 * engine after the next rendered frame, so the caller must poll `FilePath`.
 * The editor-window target is synchronous and writes the file before returning.
 */
export interface KitScreenshotResult {
  bSuccess?: boolean
  bRequested?: boolean
  FilePath?: string
  ErrorMessage?: string
}

/**
 * `FEditorAutomationGetObjectClassResult` — the class of one live object, as a
 * canonical `class(...)` Type.
 *
 * This entry point lets a harness type a level-instance path
 * (`/Game/Maps/X.X:PersistentLevel.Cube_1`), whose name does not identify its
 * class. The ClassType is exactly what `GetClassInfo`/`GetFunctionInfo`/
 * `GetPropertyType` accept.
 */
export interface KitGetObjectClassResult extends KitErrorFields {
  /** Canonical `class(...)` Type of the object; empty on failure. */
  ClassType?: string
}

/**
 * `FEditorAutomationGetEditorInfoResult` — identity of the editor process that
 * answered, so a harness can name the exact editor behind a Remote Control
 * endpoint (and a person can find it in a task manager).
 *
 * `ProcessId` is an `int64` on the wire; this client normalizes it to a number
 * (a JSON string is accepted too) rather than assuming a serialization.
 */
export interface KitGetEditorInfoResult extends KitErrorFields {
  /** OS process id of the editor; may arrive as a number or a decimal string. */
  ProcessId?: number | string
  /** Engine version, e.g. `5.5.4`. */
  EngineVersion?: string
  /** Project name (the `.uproject` base name). */
  ProjectName?: string
  /** Absolute project directory. */
  ProjectDir?: string
  /** Whether the answering process is an editor (false for a cooked game). */
  bIsEditor?: boolean
}

/**
 * Failure codes per EditorAutomation function, transcribed from the header's
 * `EEditorAutomation<Function>ErrorCode` enums. Index 0 is always success.
 */
export const KIT_ERROR_CODES: Readonly<Record<string, readonly string[]>> = {
  Ping: [],
  GetEnumInfo: ['none', 'invalid-argument', 'invalid-type', 'enum-not-found'],
  GetStructInfo: ['none', 'invalid-argument', 'invalid-type', 'struct-not-found'],
  GetClassInfo: ['none', 'invalid-argument', 'invalid-type', 'class-not-found'],
  GetFunctionInfo: ['none', 'invalid-argument', 'invalid-type', 'class-not-found', 'function-not-found'],
  GetPropertyType: [
    'none',
    'invalid-argument',
    'invalid-type',
    'class-not-found',
    'property-not-found',
    'unsupported-property',
  ],
  GetPropertyValue: [
    'none',
    'invalid-argument',
    'object-not-found',
    'property-not-found',
    'unsupported-property',
    'serialization-failed',
  ],
  SetPropertyValue: [
    'none',
    'invalid-argument',
    'object-not-found',
    'property-not-found',
    'invalid-json',
    'unsupported-property',
    'serialization-failed',
    'write-failed',
  ],
  CallFunction: [
    'none',
    'invalid-argument',
    'object-not-found',
    'function-not-found',
    'invalid-json',
    'parameter-error',
    'serialization-failed',
    'call-failed',
  ],
  // The GetObjectClass enum is declared by the EditorAutomation task adding the
  // entry point; unknown numbers degrade to `error-<n>` (see kitErrorCodeName),
  // so an enum that differs here costs a label, never a failed call.
  GetObjectClass: ['none', 'invalid-argument', 'object-not-found'],
  // The landed header returns FEditorAutomationEditorInfo directly (no ErrorCode), and
  // assertKitResult treats an absent code as success; this entry only names a
  // code if a build ever wraps the struct. Unknown numbers degrade like the rest.
  GetEditorInfo: ['none'],
}

/**
 * The symbolic name of one EditorAutomation failure code.
 *
 * @param functionName - the EditorAutomation function that failed.
 * @param code - the numeric `ErrorCode` it returned.
 * @returns the kebab-case code name, or `error-<n>` for a value this build does
 * not know.
 */
export function kitErrorCodeName(functionName: string, code: number): string {
  return KIT_ERROR_CODES[functionName]?.[code] ?? `error-${code}`
}

/** The direction names of `EEditorAutomationParameterDirection`. */
export const PARAMETER_DIRECTION_NAMES: readonly string[] = ['input', 'output', 'input-output']

/**
 * The name of one parameter direction.
 *
 * @param direction - the numeric direction.
 * @returns the name, or `direction-<n>` for an unknown value.
 */
export function parameterDirectionName(direction: number): string {
  return PARAMETER_DIRECTION_NAMES[direction] ?? `direction-${direction}`
}
