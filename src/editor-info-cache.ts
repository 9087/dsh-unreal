/**
 * A tiny TTL cache for the editor's identity, for the sidebar snapshot.
 *
 * The panel polls `/dsh-unreal snapshot` every four seconds. The editor's PID,
 * version and project do not change every four seconds — but they must change
 * when the editor restarts — so this cache turns the poll into at most one
 * `GetEditorInfo` round trip per TTL window (default 10 s, i.e. a change is
 * visible within two polls) instead of one per poll.
 *
 * It is deliberately **best-effort**: a lookup that fails (the editor is not
 * running, an older EditorAutomation has no `GetEditorInfo`) caches the failure for a
 * bounded window and resolves `undefined`. The snapshot must never fail because
 * the editor is unreachable, and a recovered editor shows up within a couple of
 * polls (the failure window is longer than the success one, so an offline
 * editor does not cost an RC attempt on every poll).
 *
 * @module dsh-unreal/editor-info-cache
 */

import type { EditorInfoView, ReflectionService } from './kit/reflection.ts'

/** What the cache needs from the reflection layer. */
type EditorInfoSource = Pick<ReflectionService, 'getEditorInfo'>

/** Construction options. */
export interface EditorInfoCacheOptions {
  /** The reflection service that performs the actual lookup. */
  readonly source: EditorInfoSource
  /** How long a successful identity stays fresh. Default 10 s. */
  readonly ttlMs?: number
  /** How long a failed lookup is remembered. Default 15 s. */
  readonly failureTtlMs?: number
  /** How long one lookup may take before it is abandoned. Default 1.5 s. */
  readonly timeoutMs?: number
  /** Injected clock, for tests. */
  readonly now?: () => number
}

/** One cached answer. `info` undefined is a remembered failure. */
interface CacheEntry {
  readonly at: number
  readonly info: EditorInfoView | undefined
  readonly ttlMs: number
}

/** Default freshness of a successful identity. */
export const EDITOR_INFO_TTL_MS = 10_000

/** Default freshness of a remembered failure. */
export const EDITOR_INFO_FAILURE_TTL_MS = 15_000

/** Default lookup budget: a poll must not wait out the Remote Control timeout. */
export const EDITOR_INFO_TIMEOUT_MS = 1_500

/**
 * Cache the editor identity for the snapshot poll.
 *
 * Concurrent `resolve` calls share one in-flight lookup (single flight), so a
 * burst of snapshot reads never multiplies the RC traffic. Aborts and timeouts
 * resolve `undefined`; neither throws.
 */
export class EditorInfoCache {
  private readonly source: EditorInfoSource
  private readonly ttlMs: number
  private readonly failureTtlMs: number
  private readonly timeoutMs: number
  private readonly now: () => number
  private entry: CacheEntry | undefined
  private inflight: Promise<EditorInfoView | undefined> | undefined

  /**
   * @param options - source and timing.
   */
  constructor(options: EditorInfoCacheOptions) {
    this.source = options.source
    this.ttlMs = options.ttlMs ?? EDITOR_INFO_TTL_MS
    this.failureTtlMs = options.failureTtlMs ?? EDITOR_INFO_FAILURE_TTL_MS
    this.timeoutMs = options.timeoutMs ?? EDITOR_INFO_TIMEOUT_MS
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * The editor identity, cached for a short window.
   *
   * @param signal - caller cancellation (the snapshot request's signal).
   * @returns the identity, or `undefined` when the editor could not be asked.
   */
  async resolve(signal?: AbortSignal): Promise<EditorInfoView | undefined> {
    const now = this.now()
    if (this.entry !== undefined && now - this.entry.at < this.entry.ttlMs) return this.entry.info
    if (this.inflight !== undefined) return await this.inflight

    const lookup = this.load(signal)
    this.inflight = lookup
    try {
      return await lookup
    } finally {
      if (this.inflight === lookup) this.inflight = undefined
    }
  }

  /**
   * Perform one lookup with the poll's own timeout, remembering either answer.
   *
   * @param signal - caller cancellation.
   * @returns the identity, or `undefined`.
   */
  private async load(signal?: AbortSignal): Promise<EditorInfoView | undefined> {
    const controller = new AbortController()
    const forwardAbort = (): void => { controller.abort() }
    signal?.addEventListener('abort', forwardAbort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, this.timeoutMs)

    let info: EditorInfoView | undefined
    try {
      info = await this.source.getEditorInfo(controller.signal)
    } catch {
      // Unreachable editor, older EditorAutomation without the function, or the
      // timeout above: all mean "no identity", never a failed snapshot.
      info = undefined
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forwardAbort)
    }

    // A caller cancellation is not an editor verdict: do not remember it, so
    // the next poll asks again. A timeout inside our own budget is remembered
    // briefly like any other failure.
    if (signal?.aborted === true && !timedOut) return undefined

    this.entry = { at: this.now(), info, ttlMs: info === undefined ? this.failureTtlMs : this.ttlMs }
    return info
  }
}
