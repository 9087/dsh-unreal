/**
 * Tests for the header's editor-identity formatter: `PID 76644 · UE 5.5.0-0+UE5 · Game`,
 * with every part optional and omitted independently.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { editorIdentityLabel } from '../src/client/format.ts'

describe('editorIdentityLabel', () => {
  it('joins process id, engine version and project with the separator', () => {
    assert.equal(
      editorIdentityLabel({ processId: 76644, engineVersion: '5.5.0-0+UE5', projectName: 'Game' }),
      'PID 76644 \u00b7 UE 5.5.0-0+UE5 \u00b7 Game',
    )
  })

  it('omits any part the editor did not report, in order', () => {
    assert.equal(editorIdentityLabel({ processId: 7 }), 'PID 7')
    assert.equal(editorIdentityLabel({ engineVersion: '5.5.0-0+UE5' }), 'UE 5.5.0-0+UE5')
    assert.equal(editorIdentityLabel({ projectName: 'Game' }), 'Game')
    assert.equal(
      editorIdentityLabel({ processId: 7, projectName: 'Game' }),
      'PID 7 \u00b7 Game',
    )
  })

  it('has nothing to show for a null identity or only unusable parts', () => {
    assert.equal(editorIdentityLabel(null), undefined)
    assert.equal(editorIdentityLabel(undefined), undefined)
    assert.equal(editorIdentityLabel({}), undefined)
    assert.equal(editorIdentityLabel({ processId: Number.NaN }), undefined)
    assert.equal(editorIdentityLabel({ engineVersion: '   ', projectName: '' }), undefined)
    assert.equal(editorIdentityLabel({ processId: Number.POSITIVE_INFINITY }), undefined)
  })
})
