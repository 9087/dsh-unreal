/**
 * Classified failures of the EditorAutomation transport and tool layer.
 *
 * Two vocabularies meet here and stay separate:
 *
 * - **`rc/*`** — the Remote Control HTTP transport: unreachable, timeout,
 *   cancelled, an HTTP status, an unreadable answer.
 * - **`editorautomation/*`** — the EditorAutomation function ran and returned its own
 *   `ErrorCode`; the symbolic name comes from the header's per-function enum
 *   (`kit/types.ts`), so a row says `editorautomation/enum-not-found` instead of an
 *   opaque number.
 *
 * The class is deliberately dependency-free: this layer has to be testable
 * against a fake transport and must not import DSH.
 *
 * @module dsh-unreal/kit/errors
 */

/** Failure codes this adapter classifies. */
export type KitErrorCode =
  | 'rc/unreachable'
  | 'rc/timeout'
  | 'rc/cancelled'
  | 'rc/unauthorized'
  | 'rc/forbidden'
  | 'rc/not-found'
  | 'rc/bad-request'
  | 'rc/server-error'
  | 'rc/bad-response'
  | `rc/http-${number}`
  | `editorautomation/${string}`

/** One classified failure. */
export class KitError extends Error {
  /** Classified code, stable enough to grep and to key copy on. */
  readonly code: KitErrorCode

  /** Engine- or transport-supplied remediation hint, when there is one. */
  readonly hint: string | undefined

  /** HTTP status, for transport failures. */
  readonly status: number | undefined

  /** The EditorAutomation function that failed, when the failure is call-scoped. */
  readonly functionName: string | undefined

  /** Raw detail kept for the record (bounded by the caller). */
  readonly detail: string | undefined

  /**
   * @param code - classified code.
   * @param message - the message a reader sees; engine text stays inside it.
   * @param options - hint, status, the EditorAutomation function, detail, cause.
   */
  constructor(
    code: KitErrorCode,
    message: string,
    options: {
      readonly hint?: string | undefined
      readonly status?: number | undefined
      readonly functionName?: string | undefined
      readonly detail?: string | undefined
      readonly cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'KitError'
    this.code = code
    this.hint = options.hint
    this.status = options.status
    this.functionName = options.functionName
    this.detail = options.detail
  }
}

/**
 * Whether a value is one of this adapter's classified failures.
 *
 * @param value - candidate.
 * @returns true for a {@link KitError}.
 */
export function isKitError(value: unknown): value is KitError {
  return value instanceof KitError
}

/**
 * Coerce any thrown value into a {@link KitError}.
 *
 * @param error - the thrown value.
 * @param fallbackCode - the code to use for a plain `Error`.
 * @param functionName - the EditorAutomation function the call was making, when known.
 * @returns the classified failure.
 */
export function asKitError(
  error: unknown,
  fallbackCode: KitErrorCode = 'rc/bad-response',
  functionName?: string,
): KitError {
  if (error instanceof KitError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new KitError(fallbackCode, message, {
    ...(functionName === undefined ? {} : { functionName }),
    ...(error === undefined ? {} : { cause: error }),
  })
}

/**
 * Classify one non-2xx Remote Control response.
 *
 * Remote Control answers failures with `{"errorMessage": "..."}` and a status
 * that says what class of failure it is; a missing status (0) is treated as a
 * transport problem rather than as success.
 *
 * @param status - HTTP status.
 * @param bodyText - raw response body.
 * @param route - the route that failed, for the message.
 * @returns the classified failure.
 */
export function classifyHttpFailure(status: number, bodyText: string, route: string): KitError {
  const detail = readErrorMessage(bodyText)
  const suffix = detail === undefined ? '' : `: ${detail}`
  if (status === 401) {
    return new KitError('rc/unauthorized', `Remote Control refused the passphrase for ${route}${suffix}`, {
      status,
      ...(detail === undefined ? {} : { detail }),
      hint: 'Set the plugin\'s passphrase config to the value the editor expects, or clear it when the editor does not restrict access.',
    })
  }
  if (status === 403) {
    return new KitError('rc/forbidden', `Remote Control refused ${route} by policy${suffix}`, { status, ...optionalDetail(detail) })
  }
  if (status === 404) {
    return new KitError('rc/not-found', `Remote Control has no route ${route}${suffix}`, {
      status,
      ...optionalDetail(detail),
      hint: 'This engine build may not enable the Remote Control Web API.',
    })
  }
  if (status === 400 || status === 422) {
    return new KitError('rc/bad-request', `Remote Control rejected the request body for ${route}${suffix}`, {
      status,
      ...optionalDetail(detail),
    })
  }
  if (status >= 500) {
    return new KitError('rc/server-error', `Remote Control reported an internal error on ${route}${suffix}`, {
      status,
      ...optionalDetail(detail),
    })
  }
  return new KitError(`rc/http-${status}`, `Remote Control answered ${status} on ${route}${suffix}`, {
    status,
    ...optionalDetail(detail),
  })
}

/** Spread a detail only when it exists (keeps `exactOptionalPropertyTypes` honest). */
function optionalDetail(detail: string | undefined): { detail?: string } {
  return detail === undefined ? {} : { detail }
}

/**
 * Read Remote Control's error text out of a failure body.
 *
 * @param bodyText - raw body.
 * @returns the engine's message, or `undefined` when the body carries none.
 */
function readErrorMessage(bodyText: string): string | undefined {
  const text = bodyText.trim()
  if (text === '') return undefined
  try {
    const parsed = JSON.parse(text) as unknown
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      for (const key of ['errorMessage', 'ErrorMessage', 'message', 'Message']) {
        const value = record[key]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
    }
  } catch {
    // A non-JSON failure body is still worth reporting as text.
  }
  return text.length > 400 ? `${text.slice(0, 400)}…` : text
}
