/**
 * The one failure notice every card body ends with.
 *
 * Details and Custom bodies both place it after their content, so a failed call reads
 * as "here is what it did, and here is why it failed" — never as an error banner that
 * hides the payload. Raw data keeps its own error rows untouched.
 *
 * @module dsh-unreal/client/card-failure
 */

import type { ReactNode } from 'react'

import css from './panel.module.css'
import { failureLine } from './card-title.ts'
import type { Tr } from './details-view.tsx'
import type { OperationView } from './wire.ts'

/** What one failed record should show at the end of its body. */
export interface CardFailure {
  /** The Engine/transport message, without the adapter's diagnostic prefix. */
  readonly message: string
  /** The Engine's remediation hint, when it has one. */
  readonly hint?: string | undefined
}

/**
 * The failure a record should show, if any.
 *
 * @param operation - the recorded call.
 * @param tr - message lookup, for the generic fallback label.
 * @returns the failure, or `undefined` for a successful record.
 */
export function cardFailure(operation: OperationView, tr: Tr): CardFailure | undefined {
  if (operation.ok) return undefined
  const message = failureLine(operation, tr) ?? tr('row.failed')
  const hint = operation.errorHint?.trim()
  return {
    message,
    ...(hint === undefined || hint === '' ? {} : { hint }),
  }
}

/**
 * The shared failure notice markup, for callers that already derived the failure.
 *
 * @param props - the failure to render and the translator for its labels.
 * @returns the notice.
 */
export function FailureNoticeView(props: { readonly failure: CardFailure; readonly tr: Tr }): ReactNode {
  return (
    <div className={css.cardError} data-unreal-error-line>
      <div className={css.failureRows}>
        <span className={css.failureLabel}>{props.tr('failure.errorLabel')}</span>
        <span>{props.failure.message}</span>
        {props.failure.hint !== undefined && (
          <>
            <span className={css.failureLabel}>{props.tr('failure.hintLabel')}</span>
            <span>{props.failure.hint}</span>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The shared failure notice, rendered at the end of a Details or Custom body.
 *
 * @param props - the record (its failure is derived) and the translator.
 * @returns the notice, or nothing for a successful record.
 */
export function FailureNotice(props: { readonly operation: OperationView; readonly tr: Tr }): ReactNode {
  const failure = cardFailure(props.operation, props.tr)
  if (failure === undefined) return undefined
  return <FailureNoticeView failure={failure} tr={props.tr} />
}
