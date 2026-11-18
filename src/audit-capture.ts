/**
 * Per-tool-call capture of the Remote Control requests a tool made.
 *
 * A history card's default Inputs/Outputs sections must be built from the *reflected
 * signature* of the function that actually ran, so the executor records every RC call
 * made inside one tool body. An async-local store keys those calls to the tool
 * invocation: concurrent tool calls never see each other's requests, and reflection
 * lookups made outside a tool call (panel polling, enrichment) record nothing.
 *
 * @module dsh-unreal/audit-capture
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** One Remote Control call, as recorded for the default Details sections. */
export interface RcCallSnapshot {
  /** Library class default object the call targeted. */
  readonly objectPath: string
  /** UFunction name. */
  readonly functionName: string
  /** The parameters the tool sent, as nested-JSON text. */
  readonly parametersJson: string
  /** The out parameters the Engine answered, as nested-JSON text. */
  readonly outParametersJson: string
  /** The return value the Engine answered, as nested-JSON text. */
  readonly returnValueJson?: string | undefined
  /** Canonical return Type. */
  readonly returnType?: string | undefined
}

/** The capture of one tool invocation. */
const captureStore = new AsyncLocalStorage<RcCallSnapshot[]>()

/**
 * Record one RC call into the current tool invocation, if there is one.
 *
 * @param call - the request and its out parameters.
 */
export function captureRcCall(call: RcCallSnapshot): void {
  const calls = captureStore.getStore()
  if (calls !== undefined) calls.push(call)
}

/**
 * Run one tool body with a fresh RC-call capture.
 *
 * @param calls - the array the body's calls are appended to.
 * @param run - the body.
 * @returns the body's result.
 */
export async function withRcCapture<T>(calls: RcCallSnapshot[], run: () => Promise<T>): Promise<T> {
  return await captureStore.run(calls, run)
}
