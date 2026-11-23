/**
 * Fold model for the generated TypeScript card.
 *
 * The renderer emits `// #region properties` / `// #endregion` comments around the
 * fields, and regular function bodies. TypeScript has no native region syntax;
 * these comments are the VS Code folding convention, so the same generated text
 * folds in a normal editor as well as in this card.
 *
 * @module dsh-unreal/client/typescript-folds
 */

/** One foldable span in generated code. */
export interface CodeFold {
  readonly key: string
  readonly kind: 'properties' | 'methods' | 'region' | 'function'
  readonly startLine: number
  readonly endLine: number
  readonly label: string
  readonly count: number
  readonly defaultCollapsed: boolean
}

const REGION_START = /^\s*\/\/\s*#region\b\s*(.*)$/i
const REGION_END = /^\s*\/\/\s*#endregion\b/i
const FUNCTION_HEADER = /^ {2}[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*$/
const CLASS_HEADER = /^\s*class\b/

function regionKind(label: string): 'properties' | 'methods' | 'region' {
  const lower = label.toLowerCase()
  if (lower.includes('properties')) return 'properties'
  if (lower.includes('methods')) return 'methods'
  return 'region'
}

/** Strip strings and comments before counting braces. */
function stripForBraces(line: string): string {
  return line
    .replace(/\/\/.*$/, '')
    .replace(/\/\*.*?\*\//g, '')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, '``')
}

/** Find the line that closes the function opened on startLine. */
function findClosingLine(lines: readonly string[], startLine: number): number {
  let depth = 0
  for (let index = startLine; index < lines.length; index++) {
    const line = stripForBraces(lines[index] ?? '')
    for (const character of line) {
      if (character === '{') depth += 1
      else if (character === '}') depth -= 1
    }
    if (depth <= 0) return index
  }
  return lines.length - 1
}

/**
 * Build the fold ranges of one generated script.
 *
 * @param lines - the generated code split by newline.
 * @returns folds ordered by their first line.
 */
export function buildCodeFolds(lines: readonly string[]): CodeFold[] {
  const folds: CodeFold[] = []
  const regions: CodeFold[] = []
  const stack: Array<{ startLine: number; label: string }> = []

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    const start = REGION_START.exec(line)
    if (start !== null) {
      stack.push({ startLine: index, label: start[1]?.trim() ?? '' })
      continue
    }
    if (REGION_END.test(line) && stack.length > 0) {
      const open = stack.pop() as { startLine: number; label: string }
      const kind = regionKind(open.label)
      regions.push({
        key: `region:${open.startLine}`,
        kind,
        startLine: open.startLine,
        endLine: index,
        label: open.label === '' ? kind : open.label,
        count: 0,
        defaultCollapsed: true,
      })
    }
  }

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? ''
    if (CLASS_HEADER.test(line) || !FUNCTION_HEADER.test(line)) continue
    const endLine = findClosingLine(lines, index)
    folds.push({
      key: `function:${index}`,
      kind: 'function',
      startLine: index,
      endLine,
      label: line.trim(),
      count: Math.max(0, endLine - index - 1),
      defaultCollapsed: true,
    })
  }

  for (const region of regions) {
    const body = lines.slice(region.startLine + 1, region.endLine)
    let count = 0
    if (region.kind === 'properties') {
      count = body.filter(line => line.trim() !== '' && !REGION_END.test(line)).length
    } else if (region.kind === 'methods') {
      count = folds.filter(fold => fold.startLine > region.startLine && fold.startLine < region.endLine).length
    }
    folds.push({ ...region, count })
  }

  return folds.sort((left, right) => left.startLine - right.startLine)
}
