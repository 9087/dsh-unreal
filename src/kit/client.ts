/**
 * HTTP transport for the one Remote Control route this adapter uses:
 * `PUT /remote/object/call` against the EditorAutomation class default object.
 *
 * Deliberately free of DSH and Cordis imports: this is the layer that owns the
 * request shape, the optional passphrase and the timeout, and it is the layer
 * worth unit-testing against a fake `fetch`.
 *
 * Two engine behaviours shape it:
 *
 * - **Every EditorAutomation entry point is a `BlueprintCallable` on the CDO**, so the
 *   request is always the same shape — `{ObjectPath, FunctionName, Parameters}`
 *   — and only `FunctionName`/`Parameters` vary.
 * - **Remote Control serializes USTRUCT members by their C++ names**
 *   (PascalCase) and reads request fields through `FJsonObjectConverter`, which
 *   standardizes the first character's case. This client sends the canonical
 *   PascalCase keys; lowercase `objectPath` is accepted by the engine too.
 *
 * @module dsh-unreal/kit/client
 */

import { createHash } from 'node:crypto'

import { KitError, classifyHttpFailure } from './errors.ts'
import {
  EDITOR_AUTOMATION_CDO,
  OBJECT_CALL_ROUTE,
  kitErrorCodeName,
} from './types.ts'
import type { KitCallFunctionResult, KitErrorFields, KitGetEditorInfoResult } from './types.ts'

/** The payload of one EditorAutomation library function invoked through the CallFunction dispatcher. */
export interface EditorAutomationInvokeResult {
  /** Parsed ReturnValueJson: the function's native return value (structs and arrays as objects). */
  readonly payload: unknown
  /** The raw ReturnValueJson text, exactly as the Engine serialized it. */
  readonly raw: string
  /** Canonical Type string of the return value; empty when the function returns nothing. */
  readonly returnType: string
  readonly returnedNothing: boolean
}

/** Parse one nested-JSON text; empty text is null, unparsable text is returned as-is. */
function parseNestedJsonText(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return text
  }
}

/** The engine's default Remote Control port. */
export const DEFAULT_BASE_URL = 'http://127.0.0.1:30010'

/** Per-request budget. EditorAutomation handlers run on the game thread and can stall. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Test seam: the subset of `fetch` this client uses. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>

/** Resolved transport settings. */
export interface EditorAutomationClientConfig {
  /** Base URL or bare `host:port` of the Remote Control HTTP API. */
  readonly baseUrl: string
  /**
   * Plaintext passphrase. The engine compares the **MD5 hex** against
   * `URemoteControlSettings::Passphrases`, so the hash is computed here and the
   * plaintext never leaves this module.
   */
  readonly passphrase?: string | undefined
  /** Per-request budget in milliseconds. */
  readonly requestTimeoutMs: number
}

/** One raw response, read before classification. */
interface RawOutcome {
  readonly status: number
  readonly bodyText: string
}

/**
 * Client for one editor's Remote Control HTTP API.
 *
 * Stateless apart from configuration, so one instance serves every tool call.
 */
export class EditorAutomationClient {
  /** Normalized origin, e.g. `http://127.0.0.1:30010`. */
  readonly origin: string

  private readonly passphraseHash: string | undefined
  private readonly requestTimeoutMs: number
  private readonly fetchImpl: FetchLike

  /**
   * @param config - resolved transport settings.
   * @param fetchImpl - injection seam for tests; defaults to global `fetch`.
   */
  constructor(config: EditorAutomationClientConfig, fetchImpl?: FetchLike) {
    this.origin = normalizeBaseUrl(config.baseUrl)
    this.passphraseHash = config.passphrase === undefined || config.passphrase === ''
      ? undefined
      : hashPassphrase(config.passphrase)
    this.requestTimeoutMs = config.requestTimeoutMs
    this.fetchImpl = fetchImpl ?? ((input, init) => globalThis.fetch(input, init))
  }

  /** Whether a passphrase is configured. */
  get hasPassphrase(): boolean {
    return this.passphraseHash !== undefined
  }

  /**
   * `Ping` — the liveness probe. Returns the string `pong` on a healthy plugin.
   *
   * @param signal - caller cancellation.
   * @returns the probe's return value.
   */
  async ping(signal?: AbortSignal): Promise<string> {
    const returned = await this.call('Ping', {}, signal)
    if (typeof returned !== 'string') {
      throw new KitError('rc/bad-response', `Ping answered ${describe(returned)} instead of "pong".`, {
        detail: bounded(JSON.stringify(returned) ?? String(returned)),
      })
    }
    return returned
  }

  /**
   * `GetEditorInfo` — identity of the editor process behind this endpoint.
   *
   * A newer EditorAutomation build than this adapter was written against may not
   * answer the function at all; callers that can proceed without identity
   * (`unreal_ping`) treat that as “no identity”, not as a failure.
   *
   * @param signal - caller cancellation.
   * @returns the raw result struct, `ErrorCode` already asserted.
   * @throws {KitError} `editorautomation/<code>` or a classified transport failure.
   */
  async getEditorInfo(signal?: AbortSignal): Promise<KitGetEditorInfoResult> {
    const returned = await this.call('GetEditorInfo', {}, signal)
    return assertKitResult<KitGetEditorInfoResult>('GetEditorInfo', returned)
  }

  /**
   * Call one EditorAutomation function and return its `ReturnValue`.
   *
   * @param functionName - the `UEditorAutomationCoreLibrary` function name, e.g. `GetEnumInfo`.
   * @param parameters - the function's parameters, keyed by C++ parameter name.
   * @param signal - caller cancellation.
   * @returns whatever the engine serialized under `ReturnValue`.
   * @throws {KitError} classified transport failure, or a reply the engine did
   * not shape as a Remote Control object call.
   */
  async callOn(objectPath: string, functionName: string, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const body = { ObjectPath: objectPath, FunctionName: functionName, Parameters: parameters }
    const outcome = await this.send(OBJECT_CALL_ROUTE, body, signal)
    if (outcome.status < 200 || outcome.status >= 300) {
      throw classifyHttpFailure(outcome.status, outcome.bodyText, OBJECT_CALL_ROUTE)
    }
    const parsed = parseJson(outcome.bodyText)
    if (parsed === undefined || parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new KitError(
        'rc/bad-response',
        `Remote Control answered ${functionName} with something that is not a JSON object.`,
        { functionName, detail: bounded(outcome.bodyText) },
      )
    }
    const envelope = parsed as Record<string, unknown>
    if (!Object.prototype.hasOwnProperty.call(envelope, 'ReturnValue')) {
      // A Remote Control build that answers the call's serialized fields at the
      // top level rather than under `ReturnValue` is a contract break worth
      // naming, not something to guess around.
      throw new KitError(
        'rc/bad-response',
        `Remote Control answered ${functionName} without a "ReturnValue" member.`,
        { functionName, detail: bounded(outcome.bodyText) },
      )
    }
    return envelope['ReturnValue']
  }

  /** Call one UEditorAutomationCoreLibrary function on the default EditorAutomation CDO. */
  async call(functionName: string, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return await this.callOn(EDITOR_AUTOMATION_CDO, functionName, parameters, signal)
  }

  /** Call one UEditorAutomationUMGLibrary function on its default CDO. */
  async callUMG(functionName: string, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return await this.callOn('/Script/EditorAutomation.Default__EditorAutomationUMGLibrary', functionName, parameters, signal)
  }

  /**
   * Invoke one EditorAutomation library function through its generic `CallFunction` dispatcher.
   *
   * Every tool in this plugin uses this one calling convention: it serializes the
   * parameters and lets EditorAutomation's dispatcher invoke the function, so call-level
   * failures come back uniformly and native return values arrive as nested JSON.
   *
   * @param library - EditorAutomation library CDO path, e.g. `/Script/EditorAutomation.Default__EditorAutomationLevelLibrary`.
   * @param functionName - the BlueprintCallable function to invoke.
   * @param parameters - parameters keyed by C++ parameter name.
   * @param signal - caller cancellation.
   * @returns the parsed payload plus raw text, return Type and emptiness.
   */
  async invoke(
    library: string,
    functionName: string,
    parameters: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<EditorAutomationInvokeResult> {
    const returned = await this.call(
      'CallFunction',
      {
        ObjectPath: library,
        FunctionName: functionName,
        ParametersJson: JSON.stringify(parameters),
        bGenerateTransaction: false,
      },
      signal,
    )
    const result = assertKitResult<KitCallFunctionResult>('CallFunction', returned)
    const raw = result.ReturnValueJson ?? ''
    return {
      payload: parseNestedJsonText(raw),
      raw,
      returnType: result.ReturnType ?? '',
      returnedNothing: raw.trim() === '',
    }
  }

  /**
   * Send one request with the timeout and the caller's cancellation forwarded.
   *
   * @param route - route path.
   * @param body - JSON request body.
   * @param signal - caller cancellation.
   * @returns the raw status and body, whatever the status.
   * @throws {KitError} `rc/unreachable`, `rc/timeout`, `rc/cancelled`.
   */
  private async send(route: string, body: unknown, signal?: AbortSignal): Promise<RawOutcome> {
    if (isAborted(signal)) {
      throw new KitError('rc/cancelled', 'The Remote Control call was cancelled before it was sent.')
    }
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.requestTimeoutMs)
    const forwardAbort = (): void => { controller.abort() }
    signal?.addEventListener('abort', forwardAbort, { once: true })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (this.passphraseHash !== undefined) headers['Passphrase'] = this.passphraseHash

    try {
      const response = await this.fetchImpl(`${this.origin}${route}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      return { status: response.status, bodyText: await response.text() }
    } catch (error: unknown) {
      if (isAborted(signal)) {
        throw new KitError('rc/cancelled', 'The Remote Control call was cancelled.', { cause: error })
      }
      if (timedOut) {
        throw new KitError(
          'rc/timeout',
          `The Remote Control call to ${route} exceeded ${this.requestTimeoutMs}ms.`,
          {
            cause: error,
            hint: 'The editor may be busy on the game thread. Retry, or raise requestTimeoutMs.',
          },
        )
      }
      throw new KitError(
        'rc/unreachable',
        `Could not reach the Remote Control API at ${this.origin}${route}.`,
        {
          cause: error,
          hint: 'Start the Unreal editor with the EditorAutomation plugin enabled and the Remote Control Web API listening on this port.',
        },
      )
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }
  }
}

/**
 * Assert that one EditorAutomation result struct reports success, and return it.
 *
 * `ErrorCode` absent is treated as 0: Remote Control serializes every UPROPERTY,
 * so a real reply carries the field, and treating an absent field as failure
 * would only misreport a build that omits defaults.
 *
 * @param functionName - the EditorAutomation function that produced the result.
 * @param returned - the `ReturnValue` object.
 * @returns the same object, narrowed to a result struct.
 * @throws {KitError} `editorautomation/<code-name>` when `ErrorCode` is not 0.
 */
export function assertKitResult<T extends KitErrorFields>(functionName: string, returned: unknown): T {
  if (returned === null || returned === undefined || typeof returned !== 'object' || Array.isArray(returned)) {
    throw new KitError(
      'rc/bad-response',
      `${functionName} answered ${describe(returned)} instead of its result struct.`,
      { functionName, detail: bounded(JSON.stringify(returned) ?? String(returned)) },
    )
  }
  const result = returned as T
  const code = typeof result.ErrorCode === 'number' && Number.isFinite(result.ErrorCode) ? result.ErrorCode : 0
  if (code === 0) return result

  const codeName = kitErrorCodeName(functionName, code)
  const message = typeof result.ErrorMessage === 'string' && result.ErrorMessage.trim() !== ''
    ? result.ErrorMessage.trim()
    : `${functionName} failed with ErrorCode ${code}.`
  const hint = typeof result.Hint === 'string' && result.Hint.trim() !== '' ? result.Hint.trim() : undefined
  throw new KitError(`editorautomation/${codeName}`, `ErrorCode ${code} (${codeName}): ${message}`, {
    functionName,
    ...(hint === undefined ? {} : { hint }),
  })
}

/**
 * Normalize a configured base URL to an origin.
 *
 * @param input - `127.0.0.1:30010`, `http://127.0.0.1:30010`, either with a
 * trailing slash.
 * @returns origin without a trailing slash.
 * @throws {KitError} `rc/bad-request` when the value is empty.
 */
export function normalizeBaseUrl(input: string): string {
  const trimmed = input.trim()
  if (trimmed === '') {
    throw new KitError('rc/bad-request', 'The Remote Control base URL is empty.', {
      hint: `Set it to ${DEFAULT_BASE_URL} unless the editor was reconfigured.`,
    })
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  return withScheme.replace(/\/+$/, '')
}

/**
 * MD5 hex of a passphrase, matching `FMD5::HashAnsiString`.
 *
 * @param passphrase - plaintext passphrase.
 * @returns 32 lower-case hex digits.
 */
export function hashPassphrase(passphrase: string): string {
  return createHash('md5').update(passphrase, 'utf8').digest('hex')
}

/** Parse a body that may be empty or non-JSON. */
function parseJson(bodyText: string): unknown {  const trimmed = bodyText.trim()
  if (trimmed === '') return undefined
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
}

/** A short, safe description of a returned value, for failure messages. */
function describe(value: unknown): string {
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return 'an array'
  return typeof value
}

/** Clip detail text so a failure record cannot grow without bound. */
function bounded(text: string, max = 400): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

/**
 * Whether a caller signal has already fired.
 *
 * Read through a call on purpose: `AbortSignal.aborted` is a readonly property,
 * so control-flow narrowing would otherwise freeze it at whatever the first
 * check saw and reject every later comparison as unreachable.
 *
 * @param signal - caller signal, possibly absent.
 * @returns `true` when the signal exists and has fired.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted
}
