/**
 * Unit tests for the action-first card titles, the short path names they use,
 * and the visible failure line.
 *
 * The exact Chinese strings are asserted here as well as in the browser e2e:
 * the title is the design's whole point, and a dictionary edit must fail a test
 * rather than silently changing the action log's reading.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { actionTitle, failureLine, isLegacyRecord, shortObjectName, shortTarget } from '../src/client/card-title.ts'
import { toolLabel } from '../src/client/format.ts'
import { en, zh } from '../src/client/locales.ts'
import type { MsgKey } from '../src/client/locales.ts'
import type { OperationView } from '../src/client/wire.ts'

/** A translator over one shipped dictionary. */
function translator(language: 'en' | 'zh'): (key: MsgKey) => string {
  const dictionary: Record<string, string> = language === 'en' ? en : zh
  return key => dictionary[key] ?? key
}

/** One operation with the fields a title needs. */
function operation(overrides: Partial<OperationView> & Pick<OperationView, 'tool'>): OperationView {
  return {
    id: 'test-1',
    time: 1_700_000_000_000,
    ok: true,
    ...overrides,
  }
}

const CUBE = '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1'

describe('short path names', () => {
  it('shortens a level instance to its object name', () => {
    assert.equal(shortObjectName(CUBE), 'Cube_1')
    assert.equal(shortObjectName(`${CUBE}.StaticMeshComponent`), 'StaticMeshComponent')
  })

  it('strips the Default__ prefix of a class default object', () => {
    assert.equal(shortObjectName('/Script/Engine.Default__KismetSystemLibrary'), 'KismetSystemLibrary')
    assert.equal(shortObjectName('/Script/Engine.Default__StaticMeshComponent'), 'StaticMeshComponent')
  })

  it('keeps a Blueprint class object name', () => {
    assert.equal(shortObjectName('/Game/Props/BP_Cube.BP_Cube_C'), 'BP_Cube_C')
  })

  it('handles absent and empty paths', () => {
    assert.equal(shortObjectName(undefined), undefined)
    assert.equal(shortObjectName('   '), undefined)
  })

  it('joins an object and a member into the short target', () => {
    assert.equal(shortTarget(CUBE, 'RelativeLocation'), 'Cube_1.RelativeLocation')
    assert.equal(shortTarget(CUBE, 'GetDisplayName'), 'Cube_1.GetDisplayName')
    assert.equal(shortTarget(CUBE, undefined), 'Cube_1')
    assert.equal(shortTarget(undefined, 'RelativeLocation'), 'RelativeLocation')
    assert.equal(shortTarget(undefined, undefined), undefined)
  })
})

describe('actionTitle (English)', () => {
  const tr = translator('en')

  it('is action-first for every tool', () => {
    assert.equal(actionTitle(operation({ tool: 'unreal_ping' }), tr), 'Check Connectivity')
    assert.equal(
      actionTitle(operation({
        tool: 'unreal_get_enum_info',
        targetType: 'enum(/Script/Engine.ECollisionEnabled)',
      }), tr),
      'Get ECollisionEnabled Enum Info',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_struct_info', targetType: 'struct(/Script/CoreUObject.Vector)' }), tr),
      'Get Vector Struct Info',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_class_info', targetType: 'class(/Script/Engine.StaticMeshComponent)' }), tr),
      'Get StaticMeshComponent Class Info',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_function_info', targetType: 'class(/Script/Engine.StaticMeshComponent)', functionName: 'GetClosestPointOnCollision' }), tr),
      'Get StaticMeshComponent.GetClosestPointOnCollision Function Info',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_property_type', propertyPath: 'RelativeLocation' }), tr),
      'Get Property Type: RelativeLocation',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_property_type', propertyPath: 'bHidden', propertyType: 'bool' }), tr),
      'Get Property Type: bHidden',
    )
    assert.equal(
      actionTitle(operation({
        tool: 'unreal_get_property_type',
        targetType: 'class(/Script/Engine.StaticMeshComponent)',
        propertyPath: 'bHidden',
        propertyType: 'bool',
      }), tr),
      'Get Property Type: StaticMeshComponent.bHidden',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_object_class', objectPath: CUBE }), tr),
      'Get Cube_1 Class Info',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_property_value', objectPath: CUBE, propertyPath: 'RelativeLocation' }), tr),
      'Get RelativeLocation: /Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_set_property_value', objectPath: CUBE, propertyPath: 'RelativeLocation' }), tr),
      'Set RelativeLocation: /Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_call_function', objectPath: CUBE, functionName: 'GetDisplayName' }), tr),
      'Call GetDisplayName: /Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
    )
  })

  it('falls back to the recorded params when the identity fields are absent', () => {
    assert.equal(
      actionTitle(operation({
        tool: 'unreal_get_property_value',
        params: { objectPath: CUBE, propertyPath: 'RelativeLocation.Z' },
      }), tr),
      'Get RelativeLocation.Z: /Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
    )
    assert.equal(
      actionTitle(operation({
        tool: 'unreal_get_function_info',
        params: { type: 'class(/Script/Engine.Actor)', functionName: 'K2_DestroyActor' },
      }), tr),
      'Get Actor.K2_DestroyActor Function Info',
    )
  })

  it('names the deleted Blueprint in a Delete Blueprint title', () => {
    assert.equal(
      actionTitle(operation({ tool: 'unreal_delete_blueprint', params: { blueprint: '/Game/Temp/BP_CustomCardTest' } }), tr),
      'Delete Blueprint: /Game/Temp/BP_CustomCardTest',
    )
    assert.equal(actionTitle(operation({ tool: 'unreal_delete_blueprint' }), tr), 'Delete Blueprint')
  })

  it('names the target in Asset Info and Blueprint Info titles', () => {
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_asset_info', params: { assetPath: '/Game/UI/WBP_Tetris.WBP_Tetris' } }), tr),
      'Get Asset Info: /Game/UI/WBP_Tetris.WBP_Tetris',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_blueprint_info', params: { blueprint: '/Game/UI/WBP_Tetris' } }), tr),
      'Get Blueprint Info: /Game/UI/WBP_Tetris',
    )
  })

  it('names the widget in a widget screenshot title', () => {
    assert.equal(
      actionTitle(operation({ tool: 'unreal_capture_widget_screenshot', params: { objectPath: '/Game/UI/WBP_Tetris.WBP_Tetris_C' } }), tr),
      'Capture Widget Screenshot: /Game/UI/WBP_Tetris.WBP_Tetris_C',
    )
  })

  it('says whether tool groups were enabled or disabled', () => {
    assert.equal(
      actionTitle(operation({ tool: 'unreal_set_tool_groups', params: { groups: ['umg'], enabled: true } }), tr),
      'Enable Tool Groups: UMG',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_set_tool_groups', params: { groups: ['umg', 'umg_editor'], enabled: false } }), tr),
      'Disable Tool Groups: UMG, UMG Editor',
    )
  })

  it('puts the level into the Start PIE title', () => {
    assert.equal(
      actionTitle(operation({ tool: 'unreal_start_pie', params: { levelPath: '/Game/Maps/L_Tetris' } }), tr),
      'Start PIE: /Game/Maps/L_Tetris',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_start_pie', params: { levelPath: '/Game/Maps/L_Tetris', newWindow: true } }), tr),
      'Start PIE: /Game/Maps/L_Tetris (new window)',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_start_pie', params: { levelPath: '', newWindow: false } }), tr),
      'Start PIE: current level',
    )
  })

  it('puts the level into the Open Level title', () => {
    assert.equal(
      actionTitle(operation({ tool: 'unreal_open_level', params: { levelPath: '/Game/Maps/L_Tetris' } }), tr),
      'Open Level: /Game/Maps/L_Tetris',
    )
    assert.equal(actionTitle(operation({ tool: 'unreal_open_level' }), tr), 'Open Level')
  })

  it('titles domain tools through their dictionary labels', () => {
    assert.equal(actionTitle(operation({ tool: 'unreal_screenshot' }), tr), 'Take Screenshot')
    assert.equal(actionTitle(operation({ tool: 'unreal_get_recent_log' }), tr), 'Read Recent Log')
    assert.equal(actionTitle(operation({ tool: 'unreal_compile_blueprint' }), tr), 'Compile Blueprint')
    assert.equal(actionTitle(operation({ tool: 'unreal_connect_pins' }), tr), 'Connect Pins')
    assert.equal(actionTitle(operation({ tool: 'unreal_remove_umg_widget' }), tr), 'Remove Widget')
  })

  it('never blanks a card when the dictionary has no entry', () => {
    const withoutLabels = (key: MsgKey): string => key
    assert.equal(actionTitle(operation({ tool: 'unreal_future_tool' }), withoutLabels), 'Future tool')
    assert.equal(actionTitle(operation({ tool: 'unreal_brand_new_api' }), withoutLabels), 'Brand new api')
    assert.equal(actionTitle(operation({ tool: 'unreal_unknown' }), withoutLabels), 'Unknown')
  })

  it('never blanks a card when the template lookup answers nothing', () => {
    const silent = (): string => undefined as unknown as string
    assert.equal(actionTitle(operation({ tool: 'unreal_get_enum_info' }), silent), 'Get enum info')
    assert.equal(actionTitle(operation({ tool: 'unreal_screenshot' }), silent), 'Screenshot')
  })

  it('normalizes a template that fills to extra whitespace', () => {
    assert.equal(actionTitle(operation({ tool: 'unreal_get_enum_info' }), tr), 'Get Enum Info')
    assert.equal(actionTitle(operation({ tool: 'unreal_get_property_type' }), tr), 'Get Property Type')
  })

  it('gives tool views a fallback label too', () => {
    const silent = (): string => undefined as unknown as string
    assert.equal(toolLabel('unreal_add_event_node', silent), 'Add event node')
    assert.equal(toolLabel('unreal_unknown_tool', tr), 'unreal_unknown_tool')
  })

  it('says how many Remote Control Blueprint functions a batch record called', () => {
    const batch = operation({
      tool: 'unreal_call_functions',
      rcCalls: [
        { objectPath: '/Script/X', functionName: 'Ping', parametersJson: '{}', outParametersJson: '{}' },
        { objectPath: '/Script/X', functionName: 'GetEditorInfo', parametersJson: '{}', outParametersJson: '{}' },
      ],
    })
    assert.equal(actionTitle(batch, tr), 'Call 2 Functions')
    const single = operation({
      tool: 'unreal_call_functions',
      rcCalls: [
        { objectPath: '/Script/X', functionName: 'Ping', parametersJson: '{}', outParametersJson: '{}' },
      ],
    })
    assert.equal(actionTitle(single, tr), 'Call 1 Function')
    assert.equal(actionTitle(operation({ tool: 'unreal_call_functions' }), tr), 'Call 0 Functions')
  })
})

describe('actionTitle (Chinese, exact strings)', () => {
  const tr = translator('zh')

  it('matches the requested wording', () => {
    assert.equal(actionTitle(operation({ tool: 'unreal_ping' }), tr), '检查连通')
    assert.equal(
      actionTitle(operation({
        tool: 'unreal_get_enum_info',
        targetType: 'enum(/Script/Engine.ECollisionEnabled)',
      }), tr),
      '获取 ECollisionEnabled 的枚举信息',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_struct_info', targetType: 'struct(/Script/CoreUObject.Vector)' }), tr),
      '获取 Vector 的结构信息',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_class_info', targetType: 'class(/Script/Engine.StaticMeshComponent)' }), tr),
      '获取 StaticMeshComponent 的类信息',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_function_info', targetType: 'class(/Script/Engine.StaticMeshComponent)', functionName: 'GetClosestPointOnCollision' }), tr),
      '获取 StaticMeshComponent.GetClosestPointOnCollision 的函数信息',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_property_type', propertyPath: 'RelativeLocation' }), tr),
      '获取属性类型：RelativeLocation',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_property_type', propertyPath: 'bHidden', propertyType: 'bool' }), tr),
      '获取属性类型：bHidden',
    )
    assert.equal(
      actionTitle(operation({
        tool: 'unreal_get_property_type',
        targetType: 'class(/Script/Engine.StaticMeshComponent)',
        propertyPath: 'bHidden',
        propertyType: 'bool',
      }), tr),
      '获取属性类型：StaticMeshComponent.bHidden',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_object_class', objectPath: CUBE }), tr),
      '获取 Cube_1 的类信息',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_get_property_value', objectPath: CUBE, propertyPath: 'RelativeLocation' }), tr),
      '获取 RelativeLocation 属性：/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_set_property_value', objectPath: CUBE, propertyPath: 'RelativeLocation' }), tr),
      '设置 RelativeLocation 属性：/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
    )
    assert.equal(
      actionTitle(operation({ tool: 'unreal_call_function', objectPath: CUBE, functionName: 'GetDisplayName' }), tr),
      '调用 GetDisplayName 函数：/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
    )
  })
})

describe('isLegacyRecord', () => {
  const details = { v: 1 as const, sections: [] }

  it('marks a pre-Details call record legacy', () => {
    assert.equal(isLegacyRecord(operation({ tool: 'unreal_get_property_value' })), true)
    assert.equal(
      isLegacyRecord(operation({ tool: 'unreal_set_property_value', ok: false, errorCode: 'editorautomation/write-failed' })),
      true,
    )
  })

  it('does not mark a current record legacy, even without details', () => {
    assert.equal(isLegacyRecord(operation({ tool: 'unreal_get_property_value', recordVersion: 2 })), false)
    assert.equal(isLegacyRecord(operation({ tool: 'unreal_call_function', recordVersion: 2 })), false)
  })

  it('never marks ping or info tools legacy', () => {
    assert.equal(isLegacyRecord(operation({ tool: 'unreal_ping' })), false)
    assert.equal(isLegacyRecord(operation({ tool: 'unreal_get_enum_info' })), false)
    assert.equal(isLegacyRecord(operation({ tool: 'unreal_get_object_class' })), false)
  })

  it('does not mark an enriched record or a transport failure legacy', () => {
    assert.equal(isLegacyRecord(operation({ tool: 'unreal_get_property_value', details })), false)
    assert.equal(
      isLegacyRecord(operation({ tool: 'unreal_get_property_value', ok: false, errorCode: 'rc/unreachable' })),
      false,
    )
  })
})

describe('failureLine', () => {
  const tr = translator('en')

  it('is absent for a successful call', () => {
    assert.equal(failureLine(operation({ tool: 'unreal_ping' }), tr), undefined)
  })

  it('shows the short engine/transport message', () => {
    assert.equal(
      failureLine(operation({ tool: 'unreal_get_enum_info', ok: false, errorCode: 'editorautomation/enum-not-found', errorMessage: 'No enum named that Type exists.' }), tr),
      'No enum named that Type exists.',
    )
  })

  it('strips the adapter diagnostic prefix older records carry', () => {
    assert.equal(
      failureLine(operation({
        tool: 'unreal_get_enum_info',
        ok: false,
        errorCode: 'editorautomation/enum-not-found',
        errorMessage: 'ErrorCode 3 (enum-not-found): No enum named that Type exists.',
      }), tr),
      'No enum named that Type exists.',
    )
  })

  it('truncates a long message and falls back to the failure label', () => {
    const long = 'x'.repeat(400)
    const line = failureLine(operation({ tool: 'unreal_get_enum_info', ok: false, errorMessage: long }), tr)
    assert.ok(line !== undefined && line.length <= 221 && line.endsWith('…'))
    assert.equal(failureLine(operation({ tool: 'unreal_get_enum_info', ok: false }), tr), 'failed')
  })
})
