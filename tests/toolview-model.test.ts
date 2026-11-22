/**
 * Unit tests for the transcript tool-view model: argument reading at every call
 * stage, the synthetic record the running card is drawn from, its action title,
 * and the fallback result text.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { en, zh } from '../src/client/locales.ts'
import type { MsgKey } from '../src/client/locales.ts'
import {
  argsDetails,
  isSettledBlock,
  operationFromBlock,
  parseArgumentText,
  readToolArgs,
  resultTextOf,
  runningTitle,
} from '../src/client/toolview-model.ts'
import type { PartialArgsLike, ToolBlockLike } from '../src/client/toolview-model.ts'

/** A translator over one shipped dictionary. */
function translator(language: 'en' | 'zh'): (key: MsgKey) => string {
  const dictionary: Record<string, string> = language === 'en' ? en : zh
  return key => dictionary[key] ?? key
}

const CUBE = '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1'

/** A sealed argument reader over a plain object, like PartialArguments. */
function reader(args: Record<string, unknown>): PartialArgsLike {
  return {
    keys: () => Object.keys(args),
    has: key => Object.hasOwn(args, key),
    text: key => typeof args[key] === 'string' ? args[key] : undefined,
    value: key => args[key],
  }
}

/** A started (running) block. */
function startedBlock(args: Record<string, unknown>): ToolBlockLike {
  return {
    phase: 'start',
    kind: 'tool-call',
    callId: 'call-1',
    name: 'unreal_get_property_value',
    time: 1_700_000_000_000,
    args: reader(args),
    argsRaw: JSON.stringify(args),
  }
}

describe('parseArgumentText', () => {
  it('parses complete JSON and tolerates truncated prefixes', () => {
    assert.deepEqual(parseArgumentText('{"a":1}'), { a: 1 })
    assert.deepEqual(parseArgumentText('{"a":1,"b":"x'), { a: 1 })
    assert.deepEqual(parseArgumentText(''), {})
    assert.deepEqual(parseArgumentText('[1,2]'), {})
  })
})

describe('readToolArgs', () => {
  it('reads every present field from the lazy reader', () => {
    const args = readToolArgs(startedBlock({ objectPath: CUBE, propertyPath: 'RelativeLocation', generateTransaction: true }))
    assert.deepEqual(args, { objectPath: CUBE, propertyPath: 'RelativeLocation', generateTransaction: true })
  })

  it('falls back to argsRaw and then to the paired call head', () => {
    const fromRaw = readToolArgs({ phase: 'start', argsRaw: '{"type":"enum(/Script/Engine.ECollisionEnabled)"}' })
    assert.deepEqual(fromRaw, { type: 'enum(/Script/Engine.ECollisionEnabled)' })
    const fromCall = readToolArgs({ phase: 'result', call: { argsRaw: `{"objectPath":"${CUBE}"}` } })
    assert.deepEqual(fromCall, { objectPath: CUBE })
  })

  it('is empty when nothing has arrived', () => {
    assert.deepEqual(readToolArgs(undefined), {})
    assert.deepEqual(readToolArgs({ phase: 'preparing' }), {})
  })

  it('bounds long argument strings', () => {
    const args = readToolArgs(startedBlock({ valueJson: 'x'.repeat(2_000) }))
    assert.equal(typeof args.valueJson, 'string')
    assert.ok((args.valueJson as string).length <= 801)
  })
})

describe('operationFromBlock', () => {
  it('builds the action identity from the arrived arguments', () => {
    const operation = operationFromBlock(startedBlock({ objectPath: CUBE, propertyPath: 'RelativeLocation' }))
    assert.equal(operation.tool, 'unreal_get_property_value')
    assert.equal(operation.objectPath, CUBE)
    assert.equal(operation.propertyPath, 'RelativeLocation')
    assert.equal(operation.ok, true)
    assert.equal(operation.time, 1_700_000_000_000)
  })

  it('uses the seat tool name and marks a failed result', () => {
    const operation = operationFromBlock({ phase: 'result', callId: 'c2', isError: true }, 'unreal_ping')
    assert.equal(operation.tool, 'unreal_ping')
    assert.equal(operation.id, 'c2')
    assert.equal(operation.ok, false)
  })
})

describe('runningTitle', () => {
  const enTr = translator('en')
  const zhTr = translator('zh')

  it('is the full action title once the target arguments arrived', () => {
    const operation = operationFromBlock(startedBlock({ objectPath: CUBE, propertyPath: 'RelativeLocation' }))
    assert.equal(runningTitle(operation, enTr), 'Get RelativeLocation: /Game/Maps/Demo.Demo:PersistentLevel.Cube_1')
    assert.equal(runningTitle(operation, zhTr), '获取 RelativeLocation 属性：/Game/Maps/Demo.Demo:PersistentLevel.Cube_1')
  })

  it('falls back to the tool label while a target is still missing', () => {
    const preparing = operationFromBlock({ phase: 'preparing', callId: 'c3', name: 'unreal_get_enum_info' })
    assert.equal(runningTitle(preparing, enTr), enTr('tool.get_enum_info'))
    assert.equal(runningTitle(preparing, zhTr), zhTr('tool.get_enum_info'))
    // The object arrived but the member has not.
    const partial = operationFromBlock(startedBlock({ objectPath: CUBE }))
    assert.equal(runningTitle(partial, enTr), enTr('tool.get_property_value'))
  })
})

describe('argsDetails', () => {
  it('renders the available arguments as an inputs table', () => {
    const operation = operationFromBlock(startedBlock({ objectPath: CUBE, propertyPath: 'RelativeLocation' }))
    const details = argsDetails(operation)
    assert.ok(details !== undefined)
    assert.equal(details.sections.length, 1)
    const section = details.sections[0]
    assert.ok(section !== undefined && section.kind === 'inputs')
    const fields = section.fields ?? []
    assert.equal(fields.length, 2)
    assert.equal(fields[0]?.name, 'objectPath')
  })

  it('is absent when no argument has arrived', () => {
    assert.equal(argsDetails(operationFromBlock({ phase: 'preparing' })), undefined)
  })
})

describe('resultTextOf / isSettledBlock', () => {
  it('joins text content and clips it', () => {
    const block: ToolBlockLike = {
      phase: 'result',
      content: [{ type: 'text', text: 'first' }, { type: 'text', text: 'second' }],
    }
    assert.equal(resultTextOf(block), 'first\nsecond')
    assert.equal(resultTextOf({ phase: 'result', content: [{ type: 'text', text: 'y'.repeat(3_000) }] })?.length, 1_201)
    assert.equal(resultTextOf({ phase: 'result' }), undefined)
  })

  it('classifies running and settled blocks', () => {
    assert.equal(isSettledBlock({ phase: 'preparing' }), false)
    assert.equal(isSettledBlock({ phase: 'start' }), false)
    assert.equal(isSettledBlock({ phase: 'result' }), true)
    assert.equal(isSettledBlock({ kind: 'tool-result' }), true)
    assert.equal(isSettledBlock(undefined), false)
  })
})
