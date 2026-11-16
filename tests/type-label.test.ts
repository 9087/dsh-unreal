/**
 * Unit tests for the short Type labels the Details tables show, and for the
 * collapsed-row summary guard that keeps raw JSON out of a row.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { pathTail, typeLabel } from '../src/client/type-label.ts'
import { readableSummary } from '../src/client/format.ts'

describe('typeLabel', () => {
  it('shortens struct/class/enum/object Types to kind + leaf name', () => {
    assert.equal(typeLabel('struct(/Script/CoreUObject.Vector)'), 'FVector')
    assert.equal(typeLabel('class(/Script/Engine.StaticMeshComponent)'), 'class StaticMeshComponent')
    assert.equal(typeLabel('enum(/Script/Engine.ECollisionEnabled)'), 'enum ECollisionEnabled')
    assert.equal(typeLabel('object(/Script/Engine.Object)'), 'object Object')
  })

  it('keeps scalars as they are', () => {
    assert.equal(typeLabel('double'), 'double')
    assert.equal(typeLabel('bool'), 'bool')
    assert.equal(typeLabel('string'), 'FString')
    assert.equal(typeLabel('name'), 'FName')
  })

  it('shortens container element types', () => {
    assert.equal(typeLabel('array(struct(/Script/CoreUObject.Vector))'), 'TArray<FVector>')
    assert.equal(typeLabel('set(class(/Script/Engine.Actor))'), 'TSet<Actor>')
    assert.equal(typeLabel('map(struct(/Script/CoreUObject.Vector), double)'), 'TMap<FVector, double>')
  })

  it('handles a Blueprint class path', () => {
    assert.equal(typeLabel('class(/Game/Props/BP_Cube.BP_Cube_C)'), 'class BP_Cube_C')
  })

  it('passes absent and unrecognised Types through honestly', () => {
    assert.equal(typeLabel(undefined), undefined)
    assert.equal(typeLabel('   '), undefined)
    assert.equal(typeLabel('struct(weird'), 'struct(weird')
  })
})

describe('pathTail', () => {
  it('returns the last path/name segment', () => {
    assert.equal(pathTail('/Script/CoreUObject.Vector'), 'Vector')
    assert.equal(pathTail('/Game/Props/BP_Cube.BP_Cube_C'), 'BP_Cube_C')
    assert.equal(pathTail('double'), 'double')
  })
})

describe('readableSummary', () => {
  it('shows humanized and scalar summaries', () => {
    assert.equal(readableSummary('X, Y, Z'), 'X, Y, Z')
    assert.equal(readableSummary('42.0'), '42.0')
    assert.equal(readableSummary('pong'), 'pong')
    assert.equal(readableSummary('10.0 -> 42.0'), '10.0 -> 42.0')
    assert.equal(readableSummary(''), undefined)
    assert.equal(readableSummary(undefined), undefined)
  })

  it('suppresses summaries that are still raw JSON (records from older builds)', () => {
    assert.equal(readableSummary('{"X":"0.0","Y":"0.0","Z":"10.0"}'), undefined)
    assert.equal(readableSummary('[1,2,3]'), undefined)
    assert.equal(readableSummary('  {"truncated": true}'), undefined)
  })
})
