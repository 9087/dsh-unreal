/** Unit tests for the graph card's tiny TypeScript tokenizer. */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { tokenizeTypeScript } from '../src/client/typescript-syntax.ts'

describe('tokenizeTypeScript', () => {
  it('preserves the source exactly while classifying tokens', () => {
    const source = '// note\nclass A extends B {\n  const value = "text" + 42\n  Foo(value)\n}\n'
    const tokens = tokenizeTypeScript(source)
    assert.equal(tokens.map(token => token.text).join(''), source)
    assert.ok(tokens.some(token => token.kind === 'comment' && token.text === '// note'))
    assert.ok(tokens.some(token => token.kind === 'keyword' && token.text === 'class'))
    assert.ok(tokens.some(token => token.kind === 'type' && token.text === 'A'))
    assert.ok(tokens.some(token => token.kind === 'string' && token.text === '"text"'))
    assert.ok(tokens.some(token => token.kind === 'number' && token.text === '42'))
    assert.ok(tokens.some(token => token.kind === 'function' && token.text === 'Foo'))
  })

  it('keeps block comments and escapes intact', () => {
    const source = '/* a\n b */ "q\\"x"'
    const tokens = tokenizeTypeScript(source)
    assert.equal(tokens.map(token => token.text).join(''), source)
    assert.equal(tokens[0]?.kind, 'comment')
    assert.ok(tokens.some(token => token.kind === 'string' && token.text === '"q\\"x"'))
  })
})
