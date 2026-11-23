/** Unit tests for the generated-code fold model. */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildCodeFolds } from '../src/client/typescript-folds.ts'

const CODE = [
  'class WBP_Test_C extends UUserWidget {',
  '  // #region properties',
  '  A: number',
  '  B: string',
  '  // #endregion',
  '',
  '  // #region methods',
  '  BeginPlay() {',
  '    this.A = 1;',
  '  }',
  '',
  '  Btn_OnClicked() {',
  '    if (this.A > 0) {',
  '      this.A = 0;',
  '    }',
  '  }',
  '  // #endregion',
  '}',
]

describe('buildCodeFolds', () => {
  it('folds the properties region by default and counts its fields', () => {
    const folds = buildCodeFolds(CODE)
    const properties = folds.find(fold => fold.kind === 'properties')
    assert.ok(properties !== undefined)
    assert.equal(properties.startLine, 1)
    assert.equal(properties.endLine, 4)
    assert.equal(properties.count, 2)
    assert.equal(properties.defaultCollapsed, true)
  })

  it('folds each function body by default, including nested braces', () => {
    const folds = buildCodeFolds(CODE)
    const functions = folds.filter(fold => fold.kind === 'function')
    assert.deepEqual(functions.map(fold => fold.startLine), [7, 11])
    assert.equal(functions[1]?.endLine, 15)
    assert.ok(functions.every(fold => fold.defaultCollapsed))
  })

  it('folds the methods region as well so the card starts as a compact outline', () => {
    const folds = buildCodeFolds(CODE)
    const methods = folds.find(fold => fold.kind === 'methods')
    assert.ok(methods !== undefined)
    assert.equal(methods.defaultCollapsed, true)
    assert.equal(methods.count, 2)
  })
})
