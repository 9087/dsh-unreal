/**
 * The foldable, virtualized TypeScript code block used by the graph-conversion card.
 *
 * The generated text uses `// #region` comments (the VS Code folding convention;
 * TypeScript has no native region syntax) for the properties and methods sections.
 * Functions fold on their braces. Both sections and every function start collapsed,
 * so a large graph opens as a compact outline.
 *
 * Rows are rendered through a small fixed-height virtual list: expanding a huge
 * function never creates one DOM node per source line.
 *
 * @module dsh-unreal/client/typescript-code
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import css from './panel.module.css'
import { buildCodeFolds } from './typescript-folds.ts'
import type { CodeFold } from './typescript-folds.ts'
import { tokenizeTypeScript } from './typescript-syntax.ts'
import type { TypeScriptTokenKind } from './typescript-syntax.ts'

const CLASS_OF: Partial<Record<TypeScriptTokenKind, string | undefined>> = {
  comment: css.tsComment,
  string: css.tsString,
  number: css.tsNumber,
  keyword: css.tsKeyword,
  type: css.tsType,
  function: css.tsFunction,
}

/** Fixed row height used by the virtual list and the CSS. */
const ROW_HEIGHT = 18
/** Extra rows rendered above and below the viewport to avoid scroll flashes. */
const OVERSCAN = 8

/** One line in the rendered outline. */
interface RenderRow {
  readonly key: string
  readonly sourceLine: number
  readonly text: string
  readonly fold?: CodeFold
  readonly open: boolean
  readonly meta: string
}

/** A drawn chevron: a larger opening than a plain `>` text glyph. */
function FoldChevron(props: { readonly open: boolean }): ReactNode {
  return (
    <svg
      className={css.codeChevron}
      style={props.open ? { transform: 'rotate(90deg)' } : undefined}
      viewBox="0 0 12 14"
      width="8"
      height="10"
      aria-hidden="true"
    >
      <path
        d="M3 2 L9 7 L3 12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** One syntax-highlighted line. */
function HighlightedLine(props: { readonly text: string }): ReactNode {
  const tokens = useMemo(() => tokenizeTypeScript(props.text), [props.text])
  return (
    <>
      {tokens.map((token, index) => {
        const className = CLASS_OF[token.kind]
        return className === undefined
          ? token.text
          : <span key={index} className={className}>{token.text}</span>
      })}
    </>
  )
}

/** One virtualized row: line number gutter, fold arrow gutter, code text. */
function CodeRow(props: {
  readonly row: RenderRow
  readonly top: number
  readonly lineNumberWidth: string
  readonly onToggle: (key: string) => void
}): ReactNode {
  const fold = props.row.fold
  const style = { top: props.top, height: ROW_HEIGHT, lineHeight: `${String(ROW_HEIGHT)}px` }
  const content = (
    <>
      <span className={css.codeLineNo} style={{ width: props.lineNumberWidth }}>
        {props.row.sourceLine}
      </span>
      <span className={css.codeGutter}>
        {fold === undefined ? null : <FoldChevron open={props.row.open} />}
      </span>
      <span className={css.codeText}><HighlightedLine text={props.row.text} /></span>
      {props.row.meta === '' ? null : <span className={css.codeFoldMeta}>{props.row.meta}</span>}
    </>
  )
  if (fold === undefined) {
    return <div className={css.codeRow} style={style}>{content}</div>
  }
  return (
    <button
      type="button"
      className={`${css.codeRow} ${css.codeFoldRow}`}
      style={style}
      onClick={() => props.onToggle(fold.key)}
      aria-expanded={props.row.open}
    >
      {content}
    </button>
  )
}

/**
 * One foldable, virtualized TypeScript block.
 *
 * @param props - the generated code.
 * @returns the rendered code browser.
 */
export function TypeScriptCodeBlock(props: { readonly code: string }): ReactNode {
  const lines = useMemo(() => props.code.split('\n'), [props.code])
  const folds = useMemo(() => buildCodeFolds(lines), [lines])
  const foldByStart = useMemo(() => new Map(folds.map(fold => [fold.startLine, fold])), [folds])
  const defaultCollapsed = useMemo(
    () => new Set(folds.filter(fold => fold.defaultCollapsed).map(fold => fold.key)),
    [folds],
  )
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set(defaultCollapsed))
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(480)
  const scrollRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setCollapsed(new Set(defaultCollapsed))
  }, [defaultCollapsed])

  useEffect(() => {
    setScrollTop(0)
    if (scrollRef.current !== null) scrollRef.current.scrollTop = 0
  }, [props.code])

  useEffect(() => {
    const element = scrollRef.current
    if (element === null) return undefined
    const update = (): void => {
      setViewportHeight(element.clientHeight > 0 ? element.clientHeight : 480)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return undefined
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => { observer.disconnect() }
  }, [])

  const toggle = (key: string): void => {
    setCollapsed(previous => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const rows = useMemo<RenderRow[]>(() => {
    const result: RenderRow[] = []
    for (let index = 0; index < lines.length;) {
      const line = lines[index] ?? ''
      const fold = foldByStart.get(index)
      if (fold !== undefined) {
        const open = !collapsed.has(fold.key)
        const meta = fold.kind === 'properties'
          ? `${String(fold.count)} fields`
          : fold.kind === 'methods'
            ? `${String(fold.count)} functions`
            : fold.kind === 'function'
              ? (open ? '' : `${String(fold.count)} lines`)
              : `${String(fold.count)} lines`
        result.push({
          key: `fold-${fold.key}`,
          sourceLine: index + 1,
          text: line,
          fold,
          open,
          meta,
        })
        index = open ? index + 1 : fold.endLine + 1
        continue
      }
      result.push({
        key: `line-${String(index)}`,
        sourceLine: index + 1,
        text: line,
        open: false,
        meta: '',
      })
      index += 1
    }
    return result
  }, [lines, foldByStart, collapsed])

  const lineNumberWidth = `${String(lines.length).length + 1}ch`
  const firstRow = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const lastRow = Math.min(rows.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN)

  return (
    <div
      ref={scrollRef}
      className={css.codeBlock}
      data-unreal-ts-code
      onScroll={event => setScrollTop(event.currentTarget.scrollTop)}
    >
      <div className={css.codeVirtualSpacer} style={{ height: rows.length * ROW_HEIGHT }}>
        {rows.slice(firstRow, lastRow).map((row, offset) => (
          <CodeRow
            key={row.key}
            row={row}
            top={(firstRow + offset) * ROW_HEIGHT}
            lineNumberWidth={lineNumberWidth}
            onToggle={toggle}
          />
        ))}
      </div>
    </div>
  )
}
