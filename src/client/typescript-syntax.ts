/**
 * A tiny TypeScript tokenizer for the generated graph card.
 *
 * It is intentionally not a parser: the card only needs to colour comments, strings,
 * numbers, keywords, type names and call names. Every other character falls through
 * as plain text, so malformed pseudocode can never throw here.
 *
 * @module dsh-unreal/client/typescript-syntax
 */

/** One colour class a token maps to. */
export type TypeScriptTokenKind = 'plain' | 'comment' | 'string' | 'number' | 'keyword' | 'type' | 'function'

/** One lexical token of the rendered pseudocode. */
export interface TypeScriptToken {
  readonly kind: TypeScriptTokenKind
  readonly text: string
}

const KEYWORDS = new Set([
  'as', 'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue',
  'default', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from',
  'function', 'if', 'implements', 'import', 'in', 'instanceof', 'interface', 'let',
  'new', 'null', 'of', 'private', 'protected', 'public', 'return', 'static', 'switch',
  'this', 'throw', 'true', 'try', 'type', 'typeof', 'var', 'void', 'while',
])

const NUMBER = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/
const IDENTIFIER = /^[A-Za-z_$][\w$]*/

/**
 * Split one TypeScript snippet into colour tokens.
 *
 * @param source - the generated pseudocode.
 * @returns the tokens in source order; every character is preserved exactly.
 */
export function tokenizeTypeScript(source: string): TypeScriptToken[] {
  const tokens: TypeScriptToken[] = []
  const push = (kind: TypeScriptTokenKind, text: string): void => {
    if (text === '') return
    const last = tokens[tokens.length - 1]
    if (last !== undefined && last.kind === kind && kind === 'plain') {
      tokens[tokens.length - 1] = { kind, text: last.text + text }
      return
    }
    tokens.push({ kind, text })
  }

  let index = 0
  while (index < source.length) {
    const character = source[index] as string
    const next = source[index + 1]

    if (character === '/' && next === '/') {
      const end = source.indexOf('\n', index)
      const stop = end < 0 ? source.length : end
      push('comment', source.slice(index, stop))
      index = stop
      continue
    }
    if (character === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2)
      const stop = end < 0 ? source.length : end + 2
      push('comment', source.slice(index, stop))
      index = stop
      continue
    }
    if (character === '"' || character === '\'' || character === '`') {
      const quote = character
      let cursor = index + 1
      while (cursor < source.length) {
        if (source[cursor] === '\\') {
          cursor += 2
          continue
        }
        if (source[cursor] === quote) {
          cursor += 1
          break
        }
        cursor += 1
      }
      push('string', source.slice(index, cursor))
      index = cursor
      continue
    }
    if (character >= '0' && character <= '9') {
      const match = NUMBER.exec(source.slice(index))
      if (match !== null) {
        push('number', match[0])
        index += match[0].length
        continue
      }
    }
    if (/[A-Za-z_$]/.test(character)) {
      const match = IDENTIFIER.exec(source.slice(index))
      if (match !== null) {
        const word = match[0]
        const after = source.slice(index + word.length).match(/^\s*(.)/)?.[1]
        if (KEYWORDS.has(word)) push('keyword', word)
        else if (after === '(') push('function', word)
        else if (/^[A-Z]/.test(word)) push('type', word)
        else push('plain', word)
        index += word.length
        continue
      }
    }
    push('plain', character)
    index += 1
  }
  return tokens
}
