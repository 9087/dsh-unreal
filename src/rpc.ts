/**
 * The Host side of the call-history panel's data channel.
 *
 * The panel lives in the browser and cannot read the storage domain, so the
 * host exposes one read-only endpoint over a named connection channel and the
 * client calls it with `connection.rpc.call(channel, endpoint, payload)`.
 *
 * The channel is mounted through `ctx.inject(['connection', 'webServer'])`, so
 * the tools keep working in a profile with no web server (headless, SDK) and
 * the panel simply has nothing to talk to there.
 *
 * @module dsh-unreal/rpc
 */

import type { Context } from '@deepseek-ai/cordis'

import type { ResolvedConfig } from './config.ts'
import { structTypeOf } from './details.ts'
import type { ReflectionService } from './kit/reflection.ts'
import { classTypeFromObjectPath } from './kit/type-derive.ts'
import type { OperationRecord, SessionGroup } from './records.ts'
import { readScreenshotDataUrl } from './screenshots.ts'
import type { UnrealStore } from './store.ts'

/** Channel name the client calls. Kept in sync with `src/client/wire.ts`. */
export const UNREAL_CHANNEL = '/dsh-unreal'

/** The success branch of a channel reply. */
export interface RpcOk<T> {
  readonly ok: true
  readonly value: T
}

/** The failure branch of a channel reply. `internal` is the catch-all code. */
export interface RpcFailure {
  readonly ok: false
  readonly error: {
    readonly code: string
    readonly message: string
    readonly details: unknown
  }
}

/** One channel reply. */
export type RpcResult<T> = RpcOk<T> | RpcFailure

/** Signature of one channel handler. */
export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<RpcResult<unknown>>

/**
 * The slice of the host connection service this plugin mounts a channel with.
 *
 * `rpc.handle` is the published surface but hardcodes the provider's own context
 * as the registration owner; `register` takes the owner as a parameter, so
 * naming our own `webServer`-injecting context restores the documented intent
 * ("channel registrations belong to the caller fiber"). `register` is absent on
 * some builds, which is why `handle` stays as the fallback. Declared locally so
 * the build stays off the connection package's version line.
 */
interface ConnectionServiceSurface {
  readonly rpc: {
    readonly handle: (
      channel: string,
      handler: ConnectionRpcHandler,
      options?: { readonly authority: 'trusted-host' | 'loopback' },
    ) => () => Promise<void>
  }
  readonly register?: (
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
    options?: { readonly authority: 'trusted-host' | 'loopback' },
  ) => () => Promise<void>
}

/** Editor identity carried by a snapshot; every field is optional. */
export interface EditorIdentitySnapshot {
  /** OS process id of the editor. */
  readonly processId?: number | undefined
  /** Engine version, e.g. `5.5.0-0+UE5`. */
  readonly engineVersion?: string | undefined
  /** Project name (the `.uproject` base name). */
  readonly projectName?: string | undefined
  /** Absolute project directory. */
  readonly projectDir?: string | undefined
  /** Whether the answering process is an editor. */
  readonly isEditor?: boolean | undefined
}

/**
 * The snapshot's window onto the editor identity.
 *
 * Structural on purpose: the cache implementation lives in
 * `editor-info-cache.ts`, and this channel only needs “give me the identity or
 * nothing, never throw”.
 */
export interface EditorIdentityResolver {
  /** Resolve the identity, or `undefined` when the editor cannot answer. */
  resolve(signal?: AbortSignal): Promise<EditorIdentitySnapshot | undefined>
}

/** What the panel receives from one `snapshot` call. */
export interface HistorySnapshot {
  /** The session the reply is for; `null` when the client named none. */
  readonly sessionId: string | null
  /** Newest-first records for THAT session only. */
  readonly operations: readonly OperationRecord[]
  /** Records retained for that session. */
  readonly retained: number
  /** Total records retained across every session. */
  readonly totalRetained: number
  /** Every session with records, counts only — the grouping the header shows. */
  readonly sessions: readonly SessionGroup[]
  /** The editor the tools talk to. */
  readonly baseUrl: string
  /** Whether a passphrase is configured for the editor. */
  readonly passphraseConfigured: boolean
  /**
   * Identity of the editor process behind `baseUrl`; `null` when it could not
   * be read (editor not running, or an EditorAutomation without `GetEditorInfo`).
   */
  readonly editor: EditorIdentitySnapshot | null
  /** Host time the snapshot was taken, so the panel can show staleness. */
  readonly time: number
}

/** Dependencies the channel needs. */
export interface HistoryChannelDeps {
  /** Durable operations. */
  readonly store: UnrealStore
  /** Resolved plugin config. */
  readonly config: ResolvedConfig
  /** Injected clock. */
  readonly now: () => number
  /** Editor identity for the header; absent means the snapshot reports none. */
  readonly editor?: EditorIdentityResolver | undefined
  /** Resolve display-name keys for the UI's current culture. */
  readonly localizeTexts?: ((keys: readonly string[], culture: string, signal: AbortSignal) => Promise<readonly string[]>) | undefined
  /**
   * Reflection service, for the on-demand `members` endpoint the Details tree calls
   * when the reader expands a nested struct: schemas are fetched per Type instead of
   * being packed (depth-limited) into every record.
   */
  readonly reflection?: ReflectionService | undefined
}

/** Build one channel failure. */
function rpcError(message: string): RpcFailure {
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

/** Read a bounded integer out of an unvalidated wire payload. */
function numberField(payload: unknown, key: string, fallback: number): number {
  if (payload === null || typeof payload !== 'object') return fallback
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** Read a string field out of an unvalidated wire payload. */
function stringField(payload: unknown, key: string): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Build the snapshot the panel renders.
 *
 * Session filtering is the core rule: a page shows ONLY the history of the
 * session it is showing. A payload that names no session therefore gets no
 * operations at all — never the page-wide list, which would put another
 * session's calls (and another workspace's objects) in front of the reader.
 *
 * @param deps - store, config and clock.
 * @param payload - wire payload, narrowed field by field.
 * @param editor - the editor identity already resolved for this reply.
 * @returns the snapshot.
 */
export function buildSnapshot(
  deps: HistoryChannelDeps,
  payload: unknown,
  editor: EditorIdentitySnapshot | null = null,
): HistorySnapshot {
  const limit = Math.min(numberField(payload, 'limit', deps.config.historyLimit), 500)
  const sessionId = stringField(payload, 'sessionId')

  const operations = sessionId === undefined
    ? []
    : deps.store.operationsMatching({ sessionId, limit })

  return {
    sessionId: sessionId ?? null,
    operations,
    retained: sessionId === undefined ? 0 : deps.store.countMatching({ sessionId }),
    totalRetained: deps.store.operationCount,
    sessions: deps.store.sessionGroups(),
    baseUrl: deps.config.baseUrl,
    passphraseConfigured: deps.config.passphrase !== undefined,
    editor,
    time: deps.now(),
  }
}

/**
 * Mount the read-only history channel when the host has a web connection.
 *
 * @param ctx - plugin context.
 * @param deps - store, config and clock.
 */
export function registerHistoryChannel(ctx: Context, deps: HistoryChannelDeps): void {
  ctx.inject(['connection', 'webServer'], scoped => {
    const service = scoped.get('connection') as ConnectionServiceSurface | undefined
    if (service === undefined) return

    const handler: ConnectionRpcHandler = async (endpoint, payload, signal) => {
      if (signal.aborted) return rpcError('The request was cancelled.')
      switch (endpoint) {
        case 'snapshot':
          try {
            // Identity is an enrichment of the reply, never a precondition:
            // an editor that is down or older than GetEditorInfo yields `null`
            // and the history still renders.
            let editor: EditorIdentitySnapshot | null = null
            try {
              editor = (await deps.editor?.resolve(signal)) ?? null
            } catch {
              editor = null
            }
            return { ok: true, value: buildSnapshot(deps, payload, editor) }
          } catch (error: unknown) {
            return rpcError(error instanceof Error ? error.message : String(error))
          }
        case 'localize': {
          const keys = Array.isArray(payload) ? undefined : (payload as Record<string, unknown> | null)?.['keys']
          const culture = stringField(payload, 'culture')
          if (!Array.isArray(keys) || culture === undefined || deps.localizeTexts === undefined) {
            return rpcError('A keys array and a culture are required.')
          }
          const texts = await deps.localizeTexts(keys.filter((key): key is string => typeof key === 'string'), culture, signal)
          return { ok: true, value: { texts } }
        }
        case 'screenshot': {
          // The preview endpoint only serves files this adapter named under its temp
          // screenshot root: a record can never be used to read an arbitrary file.
          const id = stringField(payload, 'id')
          if (id === undefined) return rpcError('id is required.')
          const record = deps.store.operationById(id)
          if (record === undefined) return rpcError('No such record.')
          const result = record.result
          const filePath = result !== null && typeof result === 'object' && !Array.isArray(result)
            ? (result as Record<string, unknown>)['filePath']
            : undefined
          if (typeof filePath !== 'string' || filePath === '') return rpcError('This record has no screenshot file.')
          const dataUrl = await readScreenshotDataUrl(filePath)
          if (dataUrl === undefined) return rpcError('The screenshot file is no longer available.')
          return { ok: true, value: { dataUrl } }
        }
        case 'clear': {
          const sessionId = stringField(payload, 'sessionId')
          if (sessionId === undefined) return rpcError('sessionId is required.')
          try {
            const cleared = await deps.store.clearSession(sessionId)
            return { ok: true, value: { cleared } }
          } catch (error: unknown) {
            return rpcError(error instanceof Error ? error.message : String(error))
          }
        }
        case 'signature': {
          // On-demand function signature for the card: old records only carried the RC
          // parameter text, so the panel asks for the reflected names/Types/display names
          // when it expands a card that predates the default Details sections.
          const objectPath = stringField(payload, 'objectPath')
          const functionName = stringField(payload, 'functionName')
          if (objectPath === undefined || functionName === undefined) {
            return rpcError('objectPath and functionName are required.')
          }
          if (deps.reflection === undefined) return rpcError('Reflection is unavailable.')
          try {
            let classType = classTypeFromObjectPath(objectPath)
            if (classType === undefined) {
              classType = (await deps.reflection.objectClass(objectPath, signal)).value.classType
            }
            const functionView = (await deps.reflection.functionInfo(classType, functionName, signal)).value.function
            return {
              ok: true,
              value: {
                functionName: functionView.name,
                returnType: functionView.returnType,
                parameters: functionView.parameters.map(parameter => ({
                  name: parameter.name,
                  type: parameter.type,
                  direction: parameter.direction,
                  ...(parameter.displayNameText === undefined ? {} : { displayNameText: parameter.displayNameText }),
                })),
              },
            }
          } catch (error: unknown) {
            return rpcError(error instanceof Error ? error.message : String(error))
          }
        }
        case 'members': {
          // On-demand schema for one Type: the Details tree fetches members when the
          // reader expands a struct instead of every record carrying nested schemas.
          const type = stringField(payload, 'type')
          if (type === undefined) return rpcError('type is required.')
          if (deps.reflection === undefined) return rpcError('Reflection is unavailable.')
          const structType = structTypeOf(type)
          if (structType === undefined) return rpcError(`Type "${type}" has no struct members.`)
          try {
            const info = await deps.reflection.structInfo(structType, signal)
            const members = info.value.members.slice(0, 128).map(member => ({
              name: member.name,
              type: member.type,
              ...(member.displayNameText === undefined ? {} : { displayNameText: member.displayNameText }),
            }))
            return { ok: true, value: { members } }
          } catch (error: unknown) {
            return rpcError(error instanceof Error ? error.message : String(error))
          }
        }
        default:
          return rpcError(`Unknown endpoint "${endpoint}".`)
      }
    }

    // `register` needs the trailing authority option on some releases, which
    // read it unconditionally. Bound so the method keeps its receiver.
    const registerChannel = service.register?.bind(service)
    if (registerChannel !== undefined) {
      scoped.effect(
        () => registerChannel(scoped, UNREAL_CHANNEL, handler, { authority: 'loopback' }),
        'dsh-unreal: connection channel',
      )
      return
    }
    scoped.effect(
      () => service.rpc.handle(UNREAL_CHANNEL, handler, { authority: 'loopback' }),
      'dsh-unreal: connection channel',
    )
  })
}
