/**
 * The action-first title of one history card.
 *
 * A history row is an action log, so the first thing it must say is what was
 * done and to what: 「读取 Cube_1.RelativeLocation」, `Call Cube_1.GetDisplayName`.
 * The title is composed from the record's own fields (never from a persisted
 * sentence), so it re-renders correctly in either language and stays valid for
 * records written by older builds.
 *
 * Short names are the point: a reader sees `Cube_1`, not
 * `/Game/Maps/Demo.Demo:PersistentLevel.Cube_1`, and `Vector`, not
 * `struct(/Script/CoreUObject.Vector)`. The full identities live in the card's
 * Raw data disclosure.
 *
 * @module dsh-unreal/client/card-title
 */

import type { MsgKey } from './locales.ts'
import { humanizeToolName, typeLeaf } from './format.ts'
import type { OperationView } from './wire.ts'

/** The template values a title may need. */
interface TitleValues {
  /** Type/function/property leaf name. */
  readonly name?: string | undefined
  /** `Cube_1.RelativeLocation`-shaped target. */
  readonly target?: string | undefined
}

/** A message lookup, as a panel render supplies it. */
type Tr = (key: MsgKey) => string

/** Prefix of a class default object's name. */
const CDO_PREFIX = 'Default__'

/**
 * The tools whose records legitimately carry no `details`: their body is the
 * info payload itself. Mirrors `INFO_TOOLS` in `details-view.tsx`; kept here
 * (a plain module) so the legacy rule is unit-testable without a DOM/JSX loader.
 */
const INFO_TOOL_NAMES = new Set([
  'unreal_get_enum_info',
  'unreal_get_struct_info',
  'unreal_get_class_info',
  'unreal_get_function_info',
  'unreal_get_object_class',
  'unreal_get_property_type',
  'unreal_get_editor_info',
])

/**
 * Whether a record was written before typed Details existed.
 *
 * The record's schema generation is the reliable signal: new records stamp
 * `recordVersion`, so an absent one marks an old row. The remaining guards keep
 * a record that legitimately has no Details (ping, info tools) from being
 * labelled legacy, and a transport failure is not a legacy record either — it
 * explains itself through its own error line.
 *
 * @param operation - the recorded call.
 * @returns true when the card should carry the legacy note in Raw data.
 */
export function isLegacyRecord(operation: OperationView): boolean {
  if (operation.recordVersion !== undefined) return false
  if (operation.details !== undefined) return false
  if (operation.tool === 'unreal_ping' || INFO_TOOL_NAMES.has(operation.tool)) return false
  return operation.ok || operation.errorCode?.startsWith('editorautomation/') === true
}

/**
 * The short object name of a full object path.
 *
 * - `/Game/Maps/Demo.Demo:PersistentLevel.Cube_1` → `Cube_1`
 * - `/Script/Engine.Default__StaticMeshComponent` → `StaticMeshComponent`
 * - `/Game/Props/BP_Cube.BP_Cube_C` → `BP_Cube_C`
 *
 * @param objectPath - full object path.
 * @returns the short name, or `undefined` when there is no path.
 */
export function shortObjectName(objectPath: string | undefined): string | undefined {
  if (objectPath === undefined) return undefined
  const path = objectPath.trim()
  if (path === '') return undefined
  // A level path's meaningful part starts after the map/level prefix
  // (`...Map.Map:PersistentLevel.Cube_1`).
  const afterLevel = path.includes(':') ? path.slice(path.lastIndexOf(':') + 1) : path
  const cut = Math.max(afterLevel.lastIndexOf('.'), afterLevel.lastIndexOf('/'))
  let leaf = afterLevel.slice(cut + 1)
  if (leaf.startsWith(CDO_PREFIX)) leaf = leaf.slice(CDO_PREFIX.length)
  return leaf === '' ? undefined : leaf
}

/**
 * A `Object.Member`-shaped target, or just the object when there is no member.
 *
 * @param objectPath - full object path.
 * @param member - property path or function name.
 * @returns the shortened target, or `undefined` when there is neither part.
 */
export function shortTarget(objectPath: string | undefined, member: string | undefined): string | undefined {
  const object = shortObjectName(objectPath)
  if (object === undefined) return member === undefined || member === '' ? undefined : member
  return member === undefined || member === '' ? object : `${object}.${member}`
}

/** Replace `{name}`/`{target}` placeholders in one template. */
function fill(template: string, values: TitleValues): string {
  return template
    .split('{name}').join(values.name ?? '')
    .split('{target}').join(values.target ?? '')
}


/** The Type leaf of a reflection record, from the record or its params. */
function typeName(operation: OperationView): string | undefined {
  const fromType = typeLeaf(operation.targetType)
  if (fromType !== undefined) return fromType
  const params = operation.params
  if (params !== null && typeof params === 'object' && !Array.isArray(params)) {
    const raw = (params as Record<string, unknown>)['type']
    if (typeof raw === 'string' && raw.trim() !== '') return typeLeaf(raw)
  }
  return undefined
}

/** A field from the record's params object, when it is a string. */
function paramText(operation: OperationView, key: string): string | undefined {
  const params = operation.params
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return undefined
  const value = (params as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/**
 * Compose the action-first, localized title of one record.
 *
 * @param operation - the recorded call.
 * @param tr - message lookup.
 * @returns the title; a record with nothing usable falls back to the tool name.
 */
/** Compose the title from the record; may throw or come back blank on a missing template. */
function composeActionTitle(operation: OperationView, tr: Tr): string {
  switch (operation.tool) {
    case 'unreal_ping':
      return tr('card.ping')
    case 'unreal_get_editor_info':
      return tr('card.editorInfo')
    case 'unreal_get_enum_info':
      return fill(tr('card.enumInfo'), { name: typeName(operation) ?? '' })
    case 'unreal_get_struct_info':
      return fill(tr('card.structInfo'), { name: typeName(operation) ?? '' })
    case 'unreal_get_class_info':
      return fill(tr('card.classInfo'), { name: typeName(operation) ?? '' })
    case 'unreal_get_function_info': {
      const owner = typeName(operation)
      const functionName = operation.functionName ?? paramText(operation, 'functionName') ?? ''
      return fill(tr('card.functionInfo'), {
        name: owner === undefined || functionName === '' ? functionName : `${owner}.${functionName}`,
      })
    }
    case 'unreal_get_property_type':
      return fill(tr('card.propertyType'), {
        name: operation.propertyPath ?? paramText(operation, 'propertyPath') ?? '',
      })
    case 'unreal_get_object_class':
      return fill(tr('card.objectClass'), {
        name: shortObjectName(operation.objectPath ?? paramText(operation, 'objectPath')) ?? '',
      })
    case 'unreal_get_property_value':
      return fill(tr('card.read'), {
        target:
          shortTarget(
            operation.objectPath ?? paramText(operation, 'objectPath'),
            operation.propertyPath ?? paramText(operation, 'propertyPath'),
          ) ?? '',
      })
    case 'unreal_set_property_value':
      return fill(tr('card.write'), {
        target:
          shortTarget(
            operation.objectPath ?? paramText(operation, 'objectPath'),
            operation.propertyPath ?? paramText(operation, 'propertyPath'),
          ) ?? '',
      })
    case 'unreal_call_function':
      return fill(tr('card.call'), {
        target:
          shortTarget(
            operation.objectPath ?? paramText(operation, 'objectPath'),
            operation.functionName ?? paramText(operation, 'functionName'),
          ) ?? '',
      })
    case 'unreal_start_pie':
      return tr('card.startPie')
    case 'unreal_stop_pie':
      return tr('card.stopPie')
    case 'unreal_is_pie_running':
      return tr('card.pieRunning')
    case 'unreal_set_tool_groups':
      return tr('card.toolGroups')
    case 'unreal_get_widget_roots':
      return tr('card.widgetRoots')
    case 'unreal_get_widget_blueprint_path':
      return fill(tr('card.widgetBlueprintPath'), {
        name: shortObjectName(operation.objectPath ?? paramText(operation, 'objectPath')) ?? '',
      })
    case 'unreal_get_widget_class_path':
      return fill(tr('card.widgetClassPath'), {
        name: shortObjectName(operation.objectPath ?? paramText(operation, 'objectPath')) ?? '',
      })
    case 'unreal_get_widget_tree_diff':
      return fill(tr('card.widgetTreeDiff'), {
        name: shortObjectName(operation.objectPath ?? paramText(operation, 'objectPath')) ?? '',
      })
    case 'unreal_reset_widget_tree_diff_cache':
      return fill(tr('card.widgetResetTreeCache'), {
        name: shortObjectName(operation.objectPath ?? paramText(operation, 'objectPath')) ?? '',
      })
    case 'unreal_get_widget_geometry':
      return fill(tr('card.widgetGeometry'), {
        name: shortObjectName(operation.objectPath ?? paramText(operation, 'objectPath')) ?? '',
      })
    default: {
      // Every tool gets a title: the dictionary label when there is one, and a
      // humanized wire name otherwise (a missing entry must not blank the card).
      const key = `tool.${operation.tool.replace(/^unreal_/, '')}` as MsgKey
      try {
        const label = tr(key)
        if (typeof label === 'string' && label.trim() !== '' && label !== key) return label
      } catch {
        // A missing dictionary entry falls back to the humanized wire name below.
      }
      return humanizeToolName(operation.tool)
    }
  }
}

/**
 * Compose the action-first, localized title of one record.
 *
 * This never returns an empty string: a missing template, a template that fills
 * to whitespace, or a dictionary that answers nothing all fall back to the
 * humanized tool name, because a card without a title is unreadable.
 *
 * @param operation - the recorded call.
 * @param tr - message lookup.
 * @returns a non-empty title.
 */
export function actionTitle(operation: OperationView, tr: Tr): string {
  let title: string | undefined
  try {
    title = composeActionTitle(operation, tr)
  } catch {
    title = undefined
  }
  const normalized = typeof title === 'string' ? title.replace(/\s+/g, ' ').trim() : ''
  return normalized === '' ? humanizeToolName(operation.tool) : normalized
}

/**
 * The short, visible error line of a failed card.
 *
 * The engine/transport message is what helps a reader; the code and hint are
 * Raw data material.
 *
 * @param operation - the recorded call.
 * @param tr - message lookup, for the fallback label.
 * @returns the line, or `undefined` for a successful call.
 */
export function failureLine(operation: OperationView, tr: Tr): string | undefined {
  if (operation.ok) return undefined
  const message = operation.errorMessage?.trim()
  if (message !== undefined && message !== '') {
    // Records written by older builds carry the adapter's diagnostic prefix in
    // the message; the visible line is a sentence, the code lives in Raw data.
    const cleaned = message.replace(/^ErrorCode -?\d+ \([^)]+\):\s*/, '')
    return cleaned.length > 220 ? `${cleaned.slice(0, 220)}…` : cleaned
  }
  return tr('row.failed')
}
