/**
 * Tool-specific card customizations.
 *
 * A customization is a client-side render function keyed by tool name. It composes
 * the shared Details building blocks (`RcCallDetails`, `CallsDetails`,
 * `DefaultDetailsView`, `KeyValueRows`) into whatever the tool's card should show;
 * it never changes the Details view itself, and Raw data is always untouched.
 *
 * `CustomCardBody` is the one shared wrapper every customization runs in: it puts
 * the custom content first and, when the record failed, the same short failure line
 * the Details view uses below it.
 *
 * @module dsh-unreal/client/card-customizations
 */

import type { ReactNode } from 'react'

import css from './panel.module.css'
import { FailureNotice } from './card-failure.tsx'
import { CallsDetails, DefaultDetailsView, KeyValueRows, ListCard, PropertyChangeSection, PropertyValueSection, RcCallDetails, ScreenshotSection } from './details-view.tsx'
import type { Tr } from './details-view.tsx'
import { typeLeaf } from './format.ts'
import { TypeScriptCodeBlock } from './typescript-code.tsx'
import { typeLabel } from './type-label.ts'
import type { OperationView, RpcCaller } from './wire.ts'

/** The render context one customization receives. */
export interface CardRenderContext {
  /** The record the card is for. */
  readonly operation: OperationView
  /** Message lookup for this seat's language. */
  readonly tr: Tr
  /** Channel caller, for content that still needs host data (images, signatures). */
  readonly caller?: RpcCaller | undefined
  /** The shared building blocks a customization composes. */
  readonly components: {
    readonly DefaultDetailsView: typeof DefaultDetailsView
    readonly RcCallDetails: typeof RcCallDetails
    readonly CallsDetails: typeof CallsDetails
    readonly KeyValueRows: typeof KeyValueRows
  }
}

/** One tool's custom card. */
export interface CardCustomization {
  /** Optional record predicate; when it says no, the card has no custom view. */
  readonly match?: ((operation: OperationView) => boolean) | undefined
  /** The custom body. Return `undefined` to show only the shared failure line. */
  readonly render: (context: CardRenderContext) => ReactNode
}

/** Tool name → customizations, first matching entry wins. */
const registry = new Map<string, readonly CardCustomization[]>()

/**
 * Register one tool's custom card.
 *
 * @param tool - wire tool name, e.g. `unreal_ping`.
 * @param customization - its renderer (and optional predicate).
 * @returns an unregister function, for tests and hot reload.
 */
export function registerCardCustomization(tool: string, customization: CardCustomization): () => void {
  const current = registry.get(tool) ?? []
  registry.set(tool, [...current, customization])
  return () => {
    const remaining = (registry.get(tool) ?? []).filter(candidate => candidate !== customization)
    if (remaining.length === 0) registry.delete(tool)
    else registry.set(tool, remaining)
  }
}

/**
 * The customization a record should use, if any.
 *
 * @param operation - the recorded call.
 * @returns the matching customization, or `undefined` when the card has no custom view.
 */
export function resolveCardCustomization(operation: OperationView): CardCustomization | undefined {
  return (registry.get(operation.tool) ?? []).find(candidate =>
    candidate.match === undefined || candidate.match(operation))
}

/**
 * One parsed object from the record's nested-JSON text.
 *
 * @param text - JSON text stored on the record.
 * @returns the object, or `undefined` when it is absent/unreadable.
 */
function parseRecord(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined || text.trim() === '') return undefined
  try {
    const value = JSON.parse(text) as unknown
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

/** The editor identity a ping record reported: from the GetEditorInfo call, else its result. */
export function pingIdentity(operation: OperationView): { readonly processId?: string; readonly projectDir?: string } | undefined {
  const call = operation.rcCalls?.find(candidate => candidate.functionName === 'GetEditorInfo')
  const outInfo = parseRecord(call?.outParametersJson)?.['OutInfo']
  const fromCall = outInfo !== null && typeof outInfo === 'object' && !Array.isArray(outInfo)
    ? outInfo as Record<string, unknown>
    : undefined
  const result = operation.result !== null && typeof operation.result === 'object' && !Array.isArray(operation.result)
    ? operation.result as Record<string, unknown>
    : undefined
  const processId = fromCall?.['ProcessId'] ?? result?.['processId']
  const projectDir = fromCall?.['ProjectDir'] ?? result?.['projectDir']
  const id = typeof processId === 'string' || typeof processId === 'number' ? String(processId) : undefined
  const dir = typeof projectDir === 'string' && projectDir !== '' ? projectDir : undefined
  if (id === undefined && dir === undefined) return undefined
  return {
    ...(id === undefined ? {} : { processId: id }),
    ...(dir === undefined ? {} : { projectDir: dir }),
  }
}

registerCardCustomization('unreal_ping', {
  render: ({ operation, tr }) => {
    const identity = pingIdentity(operation)
    if (identity === undefined) {
      return operation.ok ? <div className={css.detailNote}>{tr('custom.noEditorIdentity')}</div> : undefined
    }
    return (
      <KeyValueRows rows={[
        ...(identity.projectDir === undefined ? [] : [{ label: tr('info.projectDir'), value: identity.projectDir }]),
        ...(identity.processId === undefined ? [] : [{ label: tr('info.processId'), value: identity.processId }]),
      ]} />
    )
  },
})

/** Fill `{name}` placeholders in one localized template. */
function fillTemplate(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => values[key] ?? '')
}

registerCardCustomization('unreal_list_assets', {
  render: ({ operation, tr }) => {
    const data = listAssetsData(operation)
    if (data === undefined) return undefined
    const typeName = data.classPath === '' ? '' : typeLeaf(data.classPath) ?? data.classPath
    const templateKey = data.classPath === ''
      ? (data.recursive ? 'custom.listAssets.allRecursive' : 'custom.listAssets.all')
      : (data.recursive ? 'custom.listAssets.typeRecursive' : 'custom.listAssets.type')
    return (
      <div className={css.detailSection}>
        <div className={css.customSentence}>{fillTemplate(tr(templateKey), {
          dir: data.directoryPath,
          type: typeName,
        })}</div>
        {data.assets.length === 0
          ? <div className={css.detailNote}>{tr('custom.listAssets.empty')}</div>
          : (
              <div className={css.customList}>
                {data.assets.map(asset => <span className={css.customListRow} key={asset}>{asset}</span>)}
              </div>
            )}
      </div>
    )
  },
})

/** Every value the List Assets card needs, taken from the RC call first. */
interface ListAssetsData {
  readonly directoryPath: string
  readonly recursive: boolean
  readonly classPath: string
  readonly assets: readonly string[]
}

/** Whether a JSON value is a plain object. */
function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Read one List Assets record from its raw RC call, falling back to the tool payloads.
 *
 * @param operation - the recorded call.
 * @returns the directory, flags, type filter and asset paths; `undefined` when the
 *   record carries no readable parameters.
 */
export function listAssetsData(operation: OperationView): ListAssetsData | undefined {
  const call = operation.rcCalls?.[0]
  const parameters = parseRecord(call?.parametersJson)
    ?? (isRecordValue(operation.params) ? operation.params : undefined)
  if (parameters === undefined) return undefined
  const directoryPath = parameters['DirectoryPath'] ?? parameters['directoryPath'] ?? operation.objectPath
  const recursive = parameters['bRecursive'] === true
    || parameters['bRecursive'] === 'true'
    || parameters['recursive'] === true
  const classPath = parameters['ClassPath'] ?? parameters['classPath']
  const outParameters = parseRecord(call?.outParametersJson)
  const resultRecord = isRecordValue(operation.result) ? operation.result : undefined
  const rawAssets = Array.isArray(outParameters?.['OutAssets'])
    ? outParameters['OutAssets']
    : (Array.isArray(resultRecord?.['result']) ? resultRecord['result'] as unknown[] : [])
  return {
    directoryPath: typeof directoryPath === 'string' ? directoryPath : '',
    recursive,
    classPath: typeof classPath === 'string' ? classPath : '',
    assets: rawAssets.map(asset => typeof asset === 'string' ? asset : JSON.stringify(asset)),
  }
}

/** One decoded log entry. */
interface RecentLogEntry {
  readonly time: string
  readonly verbosity: number
  readonly category: string
  readonly message: string
}

/** Every value the Read Recent Log card needs, taken from the RC call first. */
interface RecentLogData {
  readonly entries: readonly RecentLogEntry[]
  readonly totalRecorded: number
  readonly truncated: boolean
  readonly minVerbosity: number
  readonly categoryFilter: string
}

/**
 * Read one GetRecentLog record from its raw RC call, falling back to the tool payloads.
 *
 * @param operation - the recorded call.
 * @returns the filtered log page; `undefined` when the record carries no readable
 *   parameters.
 */
export function recentLogData(operation: OperationView): RecentLogData | undefined {
  const call = operation.rcCalls?.[0]
  const parameters = parseRecord(call?.parametersJson)
    ?? (isRecordValue(operation.params) ? operation.params : undefined)
  if (parameters === undefined) return undefined
  const minVerbosity = Number(parameters['MinVerbosity'] ?? parameters['minVerbosity'] ?? 3)
  const category = parameters['CategoryFilter'] ?? parameters['categoryFilter']
  const outParameters = parseRecord(call?.outParametersJson)
  const page = isRecordValue(outParameters?.['OutPage'])
    ? outParameters['OutPage'] as Record<string, unknown>
    : undefined
  const resultRecord = isRecordValue(operation.result) ? operation.result : undefined
  const rawEntries = Array.isArray(page?.['Entries'])
    ? page['Entries'] as unknown[]
    : (Array.isArray(resultRecord?.['entries']) ? resultRecord['entries'] as unknown[] : [])
  const entries = rawEntries.map(entry => {
    const record = isRecordValue(entry) ? entry : {}
    return {
      time: String(record['Time'] ?? ''),
      verbosity: Number(record['Verbosity'] ?? 0),
      category: String(record['Category'] ?? ''),
      message: String(record['Message'] ?? ''),
    }
  })
  const rawTotal = page?.['TotalRecorded'] ?? resultRecord?.['totalRecorded']
  const total = Number(rawTotal ?? entries.length)
  return {
    entries,
    totalRecorded: Number.isFinite(total) ? total : entries.length,
    truncated: page?.['bTruncated'] === 'true'
      || page?.['bTruncated'] === true
      || resultRecord?.['truncated'] === true,
    minVerbosity: Number.isFinite(minVerbosity) ? minVerbosity : 3,
    categoryFilter: typeof category === 'string' ? category : '',
  }
}

/** The locale key of one verbosity level's label. */
function logLevelKey(verbosity: number): 'custom.recentLog.level.fatal' | 'custom.recentLog.level.error' | 'custom.recentLog.level.warning' {
  if (verbosity === 1) return 'custom.recentLog.level.fatal'
  if (verbosity === 2) return 'custom.recentLog.level.error'
  return 'custom.recentLog.level.warning'
}

/** The severity colour class of one verbosity level. */
function logLevelClass(verbosity: number): string {
  if (verbosity === 1) return css.logLevelFatal ?? ''
  if (verbosity === 2) return css.logLevelError ?? ''
  if (verbosity === 3) return css.logLevelWarning ?? ''
  return ''
}

registerCardCustomization('unreal_get_recent_log', {
  render: ({ operation, tr }) => {
    if (!operation.ok) return undefined
    const data = recentLogData(operation)
    if (data === undefined) return undefined
    const level = tr(logLevelKey(data.minVerbosity))
    const hasCategory = data.categoryFilter !== ''
    const count = data.entries.length
    const summaryKey = count === 1
      ? (hasCategory ? 'custom.recentLog.summaryOneCategory' : 'custom.recentLog.summaryOne')
      : (hasCategory ? 'custom.recentLog.summaryCategory' : 'custom.recentLog.summary')
    return (
      <div className={css.detailSection}>
        <div className={css.customSentence}>{fillTemplate(tr(summaryKey), {
          count: String(count),
          level,
          category: data.categoryFilter,
        })}</div>
        {count === 0
          ? <div className={css.detailNote}>{tr('custom.recentLog.empty')}</div>
          : (
              <div className={css.logList}>
                {data.entries.map((entry, index) => (
                  <div className={css.logRow} key={`${entry.time}-${String(index)}`}>
                    <span className={css.logTime}>{entry.time}</span>
                    <span className={`${css.logLevel} ${logLevelClass(entry.verbosity)}`.trim()}>
                      {tr(logLevelKey(entry.verbosity))}
                    </span>
                    <span className={css.logCategory}>{entry.category}</span>
                    <span className={css.logMessage}>{entry.message}</span>
                  </div>
                ))}
              </div>
            )}
        {data.totalRecorded > 0 && (
          <div className={css.detailNote}>
            {fillTemplate(tr('custom.recentLog.total'), { total: String(data.totalRecorded) })}
          </div>
        )}
        {data.truncated && <div className={css.detailNote}>{tr('custom.recentLog.truncated')}</div>}
      </div>
    )
  },
})

/** The folders of one ListFolders record, taken from the RC call first. */
interface ListFoldersData {
  readonly directoryPath: string
  readonly recursive: boolean
  readonly folders: readonly string[]
}

export function listFoldersData(operation: OperationView): ListFoldersData | undefined {
  const call = operation.rcCalls?.[0]
  const parameters = parseRecord(call?.parametersJson)
    ?? (isRecordValue(operation.params) ? operation.params : undefined)
  if (parameters === undefined) return undefined
  const directoryPath = parameters['DirectoryPath'] ?? parameters['directoryPath']
  const recursive = parameters['bRecursive'] === true
    || parameters['bRecursive'] === 'true'
    || parameters['recursive'] === true
  const outParameters = parseRecord(call?.outParametersJson)
  const resultRecord = isRecordValue(operation.result) ? operation.result : undefined
  const raw = Array.isArray(outParameters?.['OutFolders'])
    ? outParameters['OutFolders']
    : (Array.isArray(resultRecord?.['result']) ? resultRecord['result'] as unknown[] : [])
  return {
    directoryPath: typeof directoryPath === 'string' ? directoryPath : '',
    recursive,
    folders: raw.map(folder => String(folder)),
  }
}

registerCardCustomization('unreal_list_folders', {
  render: ({ operation, tr }) => {
    const data = listFoldersData(operation)
    if (data === undefined) return undefined
    const templateKey = data.recursive ? 'custom.listFolders.allRecursive' : 'custom.listFolders.all'
    return (
      <div className={css.detailSection}>
        <div className={css.customSentence}>{fillTemplate(tr(templateKey), { dir: data.directoryPath })}</div>
        {data.folders.length === 0
          ? <div className={css.detailNote}>{tr('custom.listFolders.empty')}</div>
          : (
              <div className={css.customList}>
                {data.folders.map(folder => <span className={css.customListRow} key={folder}>{folder}</span>)}
              </div>
            )}
      </div>
    )
  },
})

/**
 * The payload object of one record: the RC call's `OutInfo`, a nested `result`, or the
 * tool result itself.
 *
 * @param operation - the recorded call.
 * @returns the object carrying the card's fields, when readable.
 */
function recordPayload(operation: OperationView): Record<string, unknown> | undefined {
  const out = parseRecord(operation.rcCalls?.[0]?.outParametersJson)
  const info = out?.['OutInfo']
  if (isRecordValue(info)) return info
  const result = isRecordValue(operation.result) ? operation.result : undefined
  if (result !== undefined && isRecordValue(result['result'])) return result['result']
  return result
}

function textFrom(record: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key]
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

function boolFrom(record: Record<string, unknown> | undefined, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = record?.[key]
    if (value === true || value === 'true') return true
    if (value === false || value === 'false') return false
  }
  return undefined
}

function numberFrom(record: Record<string, unknown> | undefined, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record?.[key]
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** Enum labels for the numeric Blueprint fields the tool returns. */
const BLUEPRINT_TYPE_NAMES = ['Normal', 'Const', 'Macro Library', 'Interface', 'Level Script', 'Function Library']
const BLUEPRINT_STATUS_NAMES = ['Unknown', 'Dirty', 'Error', 'Up To Date', 'Being Created', 'Up To Date With Warnings']

function numberedLabel(value: number, names: readonly string[]): string {
  const name = names[value]
  return name === undefined ? String(value) : `${String(value)} (${name})`
}

registerCardCustomization('unreal_get_asset_info', {
  render: ({ operation, tr }) => {
    if (!operation.ok) return undefined
    const payload = recordPayload(operation)
    if (payload === undefined) return undefined
    const rows = [
      { label: tr('custom.asset.path'), value: textFrom(payload, ['AssetPath', 'ObjectPath']) },
      { label: tr('custom.asset.package'), value: textFrom(payload, ['PackagePath']) },
      { label: tr('custom.asset.name'), value: textFrom(payload, ['AssetName', 'Name']) },
      { label: tr('custom.asset.class'), value: textFrom(payload, ['AssetClass', 'Class']) },
    ].filter((row): row is { readonly label: string; readonly value: string } => row.value !== undefined)
    if (rows.length === 0) return undefined
    return (
      <div className={css.detailSection}>
        <KeyValueRows rows={rows} />
      </div>
    )
  },
})

registerCardCustomization('unreal_get_blueprint_info', {
  render: ({ operation, tr }) => {
    if (!operation.ok) return undefined
    const payload = recordPayload(operation)
    if (payload === undefined) return undefined
    const rows: { readonly label: string; readonly value: string }[] = []
    const assetPath = textFrom(payload, ['assetPath', 'AssetPath'])
    if (assetPath !== undefined) rows.push({ label: tr('custom.blueprint.assetPath'), value: assetPath })
    const parent = textFrom(payload, ['parentClass', 'ParentClass'])
    if (parent !== undefined && parent !== '') rows.push({ label: tr('custom.blueprint.parent'), value: parent })
    const generated = textFrom(payload, ['generatedClass', 'GeneratedClass'])
    if (generated !== undefined && generated !== '') rows.push({ label: tr('custom.blueprint.generated'), value: generated })
    const type = numberFrom(payload, ['blueprintType', 'BlueprintType'])
    if (type !== undefined) rows.push({ label: tr('custom.blueprint.type'), value: numberedLabel(type, BLUEPRINT_TYPE_NAMES) })
    const status = numberFrom(payload, ['status', 'Status'])
    if (status !== undefined) rows.push({ label: tr('custom.blueprint.status'), value: numberedLabel(status, BLUEPRINT_STATUS_NAMES) })
    const dirty = boolFrom(payload, ['dirty', 'bDirty'])
    if (dirty !== undefined) rows.push({ label: tr('custom.blueprint.dirty'), value: dirty ? tr('raw.yes') : tr('raw.no') })
    const compiling = boolFrom(payload, ['beingCompiled', 'bBeingCompiled'])
    if (compiling !== undefined) rows.push({ label: tr('custom.blueprint.compiling'), value: compiling ? tr('raw.yes') : tr('raw.no') })
    if (rows.length === 0) return undefined
    return (
      <div className={css.detailSection}>
        <KeyValueRows rows={rows} />
      </div>
    )
  },
})

registerCardCustomization('unreal_get_editor_info', {
  render: ({ operation, tr }) => {
    if (!operation.ok) return undefined
    const payload = recordPayload(operation)
    if (payload === undefined) return undefined
    const rows: { readonly label: string; readonly value: string }[] = []
    const processId = textFrom(payload, ['processId', 'ProcessId']) ?? String(numberFrom(payload, ['processId', 'ProcessId']) ?? '')
    if (processId !== '') rows.push({ label: tr('info.processId'), value: processId })
    const engine = textFrom(payload, ['engineVersion', 'EngineVersion'])
    if (engine !== undefined) rows.push({ label: tr('info.engineVersion'), value: engine })
    const project = textFrom(payload, ['projectName', 'ProjectName'])
    if (project !== undefined) rows.push({ label: tr('info.projectName'), value: project })
    const dir = textFrom(payload, ['projectDir', 'ProjectDir'])
    if (dir !== undefined) rows.push({ label: tr('info.projectDir'), value: dir })
    const isEditor = boolFrom(payload, ['isEditor', 'bIsEditor'])
    if (isEditor !== undefined) rows.push({ label: tr('info.isEditor'), value: isEditor ? tr('raw.yes') : tr('raw.no') })
    if (rows.length === 0) return undefined
    return (
      <div className={css.detailSection}>
        <KeyValueRows rows={rows} />
      </div>
    )
  },
})

/** A property read, taken from the RC call first. */
interface PropertyReadData {
  readonly valueJson: string
}

/** A property write, taken from the RC call first. */
interface PropertyWriteData {
  readonly oldValueJson: string
  readonly newValueJson: string
  readonly changed: boolean
}

/** Read one GetPropertyValue record's raw value. */
/** The object/property a read or write record targeted. */
function propertyTarget(operation: OperationView): { readonly objectPath: string; readonly propertyPath: string } | undefined {
  const call = operation.rcCalls?.[0]
  const parameters = parseRecord(call?.parametersJson)
    ?? (isRecordValue(operation.params) ? operation.params : undefined)
  const objectPath = parameters?.['ObjectPath'] ?? parameters?.['objectPath'] ?? operation.objectPath
  const propertyPath = parameters?.['PropertyPath'] ?? parameters?.['propertyPath'] ?? operation.propertyPath
  if (typeof objectPath !== 'string' || typeof propertyPath !== 'string') return undefined
  return { objectPath, propertyPath }
}

/** Read one GetPropertyValue record's raw value. */
export function propertyReadData(operation: OperationView): PropertyReadData | undefined {
  const call = operation.rcCalls?.[0]
  const outParameters = parseRecord(call?.outParametersJson)
  const resultRecord = isRecordValue(operation.result) ? operation.result : undefined
  const value = outParameters?.['OutValueJson']
    ?? outParameters?.['ValueJson']
    ?? resultRecord?.['valueJson']
  if (typeof value !== 'string') return undefined
  return { valueJson: value }
}

/** Read one SetPropertyValue record's before/after values. */
export function propertyWriteData(operation: OperationView): PropertyWriteData | undefined {
  const call = operation.rcCalls?.[0]
  const outParameters = parseRecord(call?.outParametersJson)
  const outWrite = isRecordValue(outParameters?.['OutWrite'])
    ? outParameters['OutWrite'] as Record<string, unknown>
    : undefined
  const resultRecord = isRecordValue(operation.result) ? operation.result : undefined
  const oldValue = outWrite?.['OldValueJson']
    ?? outParameters?.['OldValueJson']
    ?? resultRecord?.['oldValueJson']
  const newValue = outWrite?.['NewValueJson']
    ?? outParameters?.['NewValueJson']
    ?? resultRecord?.['newValueJson']
  if (typeof oldValue !== 'string' || typeof newValue !== 'string') return undefined
  return {
    oldValueJson: oldValue,
    newValueJson: newValue,
    changed: resultRecord?.['changed'] === false ? false : oldValue !== newValue,
  }
}

/** The empty-value placeholder used by both property cards. */
registerCardCustomization('unreal_get_property_value', {
  render: ({ operation, tr, caller }) => {
    if (!operation.ok) return undefined
    const target = propertyTarget(operation)
    const data = propertyReadData(operation)
    if (target === undefined || data === undefined) return undefined
    return (
      <PropertyValueSection
        objectPath={target.objectPath}
        propertyPath={target.propertyPath}
        valueJson={data.valueJson}
        label={tr('custom.propertyValue')}
        tr={tr}
        caller={caller}
      />
    )
  },
})

registerCardCustomization('unreal_set_property_value', {
  render: ({ operation, tr, caller }) => {
    if (!operation.ok) return undefined
    const target = propertyTarget(operation)
    const data = propertyWriteData(operation)
    if (target === undefined || data === undefined) return undefined
    return (
      <>
        <PropertyChangeSection
          objectPath={target.objectPath}
          propertyPath={target.propertyPath}
          oldValueJson={data.oldValueJson}
          newValueJson={data.newValueJson}
          oldLabel={tr('custom.propertyOld')}
          newLabel={tr('custom.propertyNew')}
          tr={tr}
          caller={caller}
        />
        {!data.changed && <div className={css.detailNote}>{tr('custom.propertyUnchanged')}</div>}
      </>
    )
  },
})

/** The resolved Type of one GetPropertyType record. */
export function propertyTypeResult(operation: OperationView): string | undefined {
  if (operation.propertyType !== undefined && operation.propertyType !== '') return operation.propertyType
  const call = operation.rcCalls?.[0]
  const out = parseRecord(call?.outParametersJson)
  const info = out?.['OutInfo']
  if (typeof info === 'string' && info !== '') return info
  if (isRecordValue(info)) {
    const type = info['Type']
    if (typeof type === 'string' && type !== '') return type
  }
  const result = isRecordValue(operation.result) ? operation.result : undefined
  const fromResult = result?.['propertyType']
  return typeof fromResult === 'string' && fromResult !== '' ? fromResult : undefined
}

registerCardCustomization('unreal_get_property_type', {
  render: ({ operation, tr }) => {
    if (!operation.ok) return undefined
    const type = propertyTypeResult(operation)
    if (type === undefined) return undefined
    return (
      <KeyValueRows rows={[
        { label: tr('column.type'), value: typeLabel(type) ?? type },
      ]} />
    )
  },
})

registerCardCustomization('unreal_delete_blueprint', {
  // The title already names the deleted asset; a parameter table would only repeat it.
  render: () => undefined,
})

registerCardCustomization('unreal_screenshot', {
  render: ({ operation, tr, caller }) => {
    if (!operation.ok) return undefined
    const result = isRecordValue(operation.result) ? operation.result : undefined
    const target = textFrom(result, ['target']) ?? 'screenshot'
    const exists = result?.['exists'] === true
    const bytes = numberFrom(result, ['bytes'])
    const filePath = textFrom(result, ['filePath'])
    return (
      <>
        {exists
          ? (
              <>
                <KeyValueRows rows={[
                  ...(filePath === undefined ? [] : [{ label: tr('custom.screenshot.path'), value: filePath }]),
                  { label: tr('custom.screenshot.target'), value: target },
                  ...(bytes === undefined
                    ? []
                    : [{ label: tr('custom.screenshot.size'), value: fillTemplate(tr('custom.screenshot.bytes'), { bytes: String(bytes) }) }]),
                ]} />
                <ScreenshotSection recordId={operation.id} caller={caller} tr={tr} />
              </>
            )
          : <div className={css.detailNote}>{fillTemplate(tr('custom.screenshot.missing'), { target })}</div>}
      </>
    )
  },
})

registerCardCustomization('unreal_capture_widget_screenshot', {
  render: ({ operation, tr, caller }) => {
    if (!operation.ok) return undefined
    const result = isRecordValue(operation.result) ? operation.result : undefined
    const params = isRecordValue(operation.params) ? operation.params : undefined
    const exists = result?.['exists'] === true
    const filePath = textFrom(result, ['filePath'])
    const objectPath = textFrom(result, ['objectPath']) ?? textFrom(params, ['objectPath'])
    const bytes = numberFrom(result, ['bytes'])
    const width = numberFrom(result, ['width'])
    const height = numberFrom(result, ['height'])
    const target = objectPath ?? 'widget'
    return (
      <>
        {exists
          ? (
              <>
                <KeyValueRows rows={[
                  ...(filePath === undefined ? [] : [{ label: tr('custom.screenshot.path'), value: filePath }]),
                  ...(bytes === undefined
                    ? []
                    : [{ label: tr('custom.screenshot.size'), value: fillTemplate(tr('custom.screenshot.bytes'), { bytes: String(bytes) }) }]),
                  ...(width === undefined || height === undefined
                    ? []
                    : [{
                        label: tr('custom.screenshot.dimensions'),
                        value: fillTemplate(tr('custom.screenshot.pixels'), { width: String(width), height: String(height) }),
                      }]),
                ]} />
                <ScreenshotSection recordId={operation.id} caller={caller} tr={tr} />
              </>
            )
          : <div className={css.detailNote}>{fillTemplate(tr('custom.screenshot.missing'), { target })}</div>}
      </>
    )
  },
})

/** The live UMG root paths of one GetWidgetRoots record. */
function widgetRootsData(operation: OperationView): readonly string[] | undefined {
  const result = isRecordValue(operation.result) ? operation.result : undefined
  if (Array.isArray(result?.['roots'])) {
    return result['roots'].map(root => String(root))
  }
  const out = parseRecord(operation.rcCalls?.[0]?.outParametersJson)
  if (Array.isArray(out?.['OutRoots'])) {
    return out['OutRoots'].map(root => String(root))
  }
  return undefined
}

registerCardCustomization('unreal_get_widget_roots', {
  render: ({ operation, tr }) => {
    const roots = widgetRootsData(operation)
    if (roots === undefined) return undefined
    return (
      <div className={css.detailSection}>
        <div className={css.customSentence}>{tr('custom.widgetRoots.summary')}</div>
        {roots.length === 0
          ? <div className={css.detailNote}>{tr('custom.widgetRoots.empty')}</div>
          : (
              <div className={css.customList}>
                {roots.map(root => <span className={css.customListRow} key={root}>{root}</span>)}
              </div>
            )}
      </div>
    )
  },
})

registerCardCustomization('unreal_set_tool_groups', {
  // The title says which groups were enabled/disabled; there is no body to add.
  render: () => undefined,
})

registerCardCustomization('unreal_start_pie', {
  // The title carries the level (and the new-window flag); no parameter table is needed.
  render: () => undefined,
})

registerCardCustomization('unreal_open_level', {
  // The title names the opened level; there is nothing else to show.
  render: () => undefined,
})

registerCardCustomization('unreal_convert_graph_to_typescript', {
  render: ({ operation, tr }) => {
    if (!operation.ok) return undefined
    const result = isRecordValue(operation.result) ? operation.result : undefined
    const typescript = typeof result?.['typescript'] === 'string' ? result['typescript'] : ''
    if (typescript === '') return undefined
    const nodes = numberFrom(result, ['nodeCount']) ?? 0
    const lines = numberFrom(result, ['lineCount']) ?? 0
    return (
      <div className={css.detailSection} data-unreal-graph-ts>
        <TypeScriptCodeBlock code={typescript} />
        <div className={css.detailNote}>
          {fillTemplate(tr('custom.renderGraph.meta'), { nodes: String(nodes), lines: String(lines) })}
        </div>
      </div>
    )
  },
})

registerCardCustomization('unreal_get_blueprint_graphs', {
  render: ({ operation, tr }) => {
    if (!operation.ok) return undefined
    const result = isRecordValue(operation.result) ? operation.result : undefined
    if (result === undefined) return undefined
    const blueprint = typeof result['blueprint'] === 'string' ? result['blueprint'] : ''
    const graphs = Array.isArray(result['graphs']) ? result['graphs'] as unknown[] : []
    const rows = graphs.flatMap((entry, index) => {
      if (!isRecordValue(entry)) return []
      const name = String(entry['graphName'] ?? '')
      const classPath = String(entry['graphClassPath'] ?? '')
      return [{
        key: `${String(index)}-${name}`,
        text: classPath === '' ? name : `${name} — ${classPath}`,
      }]
    })
    return (
      <ListCard
        summary={fillTemplate(tr('custom.listGraphs.summary'), { name: blueprint })}
        rows={rows}
        emptyText={tr('custom.listGraphs.empty')}
      />
    )
  },
})

registerCardCustomization('unreal_get_graph_nodes', {
  render: ({ operation, tr }) => {
    if (!operation.ok) return undefined
    const result = isRecordValue(operation.result) ? operation.result : undefined
    if (result === undefined) return undefined
    const graph = typeof result['graph'] === 'string' ? result['graph'] : ''
    const nodes = Array.isArray(result['nodes']) ? result['nodes'] as unknown[] : []
    const rows = nodes.flatMap((entry, index) => {
      if (!isRecordValue(entry)) return []
      const title = String(entry['nodeTitle'] ?? '')
      const classPath = String(entry['nodeClassPath'] ?? '')
      const member = String(entry['memberName'] ?? '')
      return [{
        key: `${String(index)}-${title}`,
        text: `${title}${classPath === '' ? '' : ` — ${classPath}`}${member === '' ? '' : ` → ${member}`}`,
      }]
    })
    return (
      <ListCard
        summary={fillTemplate(tr('custom.graphNodes.summary'), { name: graph })}
        rows={rows}
        emptyText={tr('custom.graphNodes.empty')}
      />
    )
  },
})

registerCardCustomization('unreal_get_dirty_assets', {
  render: ({ operation, tr }) => {
    if (!operation.ok) return undefined
    const result = isRecordValue(operation.result) ? operation.result : undefined
    if (result === undefined) return undefined
    const dirty = Array.isArray(result['dirty']) ? result['dirty'] as unknown[] : []
    const rows = dirty.flatMap((entry, index) => {
      if (!isRecordValue(entry)) return []
      const packageName = String(entry['packageName'] ?? '')
      const paths = Array.isArray(entry['assetPaths']) ? entry['assetPaths'].map(String) : []
      const mapSuffix = entry['isMap'] === true ? tr('custom.dirtyAssets.mapSuffix') : ''
      return [{
        key: `${String(index)}-${packageName}`,
        text: `${packageName}${mapSuffix}${paths.length === 0 ? '' : ` — ${paths.join(', ')}`}`,
      }]
    })
    return (
      <ListCard
        summary={tr('custom.dirtyAssets.summary')}
        rows={rows}
        emptyText={tr('custom.dirtyAssets.empty')}
      />
    )
  },
})

/**
 * The shared wrapper every custom card renders inside.
 *
 * Custom content comes first; on a failed record the shared failure notice follows it,
 * so every customization gets the same error behaviour without writing it again.
 * The Details view shows the same notice after its own content; Raw data stays raw.
 *
 * @param props - the record, translator and the customization's content.
 * @returns the wrapped custom body.
 */
export function CustomCardBody(props: {
  readonly operation: OperationView
  readonly tr: Tr
  readonly children?: ReactNode
}): ReactNode {
  // A customization whose whole content is the title (e.g. Delete Blueprint) renders
  // no body at all: an empty padded strip under the title would be noise.
  if (props.children === undefined && props.operation.ok) return undefined
  return (
    <div className={css.customCard} data-unreal-custom>
      {props.children}
      <FailureNotice operation={props.operation} tr={props.tr} />
    </div>
  )
}
