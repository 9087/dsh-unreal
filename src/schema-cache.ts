/**
 * A small in-memory cache for EditorAutomation reflection results.
 *
 * The `Get*Info` entry points exist so a caller can learn the **shape** of the
 * editor's data — enum entries, struct members, property types, function
 * signatures — and that shape changes only when the editor reloads. Fetching it
 * again for every call would add a game-thread round trip per tool call for an
 * answer the plugin already has, so the history panel's typed details are built
 * from this cache.
 *
 * Three properties matter and each has a test:
 *
 * - **TTL.** An answer older than `ttlMs` is a miss. `ttlMs = 0` means entries
 *   never go stale (only {@link SchemaCache.clear} invalidates them).
 * - **Single flight.** Concurrent misses for one key share one load, so a burst
 *   of tool calls in one model step costs one round trip, not N.
 * - **Bounded.** Past `maxEntries` the oldest stored entry is evicted, so a
 *   session that probes many types cannot grow the cache without limit.
 *
 * A failed load is never stored. {@link SchemaCache.clear} also invalidates
 * loads that were already in flight when it ran, so a transport error cannot
 * repopulate the cache with answers from an editor that has since restarted.
 *
 * @module dsh-unreal/schema-cache
 */

/** Cache counters, for logs and tests. */
export interface CacheStats {
  /** Lookups served from a fresh entry. */
  readonly hits: number
  /** Lookups that had no fresh entry. */
  readonly misses: number
  /** Lookups that joined an in-flight load instead of starting one. */
  readonly shared: number
  /** Successful loads stored. */
  readonly stores: number
  /** Entries evicted to stay under `maxEntries`. */
  readonly evictions: number
  /** Calls to {@link SchemaCache.clear}. */
  readonly clears: number
  /** Entries currently held. */
  readonly entries: number
}

/** Where one lookup's value came from. */
export type CacheSource = 'hit' | 'single-flight' | 'fetched'

/** One lookup result. */
export interface CacheLookup<T> {
  /** The cached or freshly loaded value. */
  readonly value: T
  /** Where it came from. */
  readonly source: CacheSource
  /** Whether it was served without a new load (`hit`). */
  readonly cached: boolean
  /** Age of a hit in milliseconds; `0` for a fresh load. */
  readonly ageMs: number
}

/** How one cache behaves. */
export interface SchemaCacheOptions {
  /** Freshness window in milliseconds; `0` never goes stale. */
  readonly ttlMs: number
  /** Maximum entries held; the oldest is evicted past this. */
  readonly maxEntries: number
  /** Injected clock, so TTL tests need no sleeping. */
  readonly now: () => number
}

/** One stored entry. */
interface Entry {
  readonly value: unknown
  readonly storedAt: number
}

/**
 * The reflection-result cache.
 *
 * Values are the canonical **mapped** views (`ReflectionService` maps them once
 * on load), not the raw result structs: the panel and the enrichment layer only
 * ever read the mapped shape.
 */
export class SchemaCache {
  private readonly entries = new Map<string, Entry>()

  private readonly inflight = new Map<string, Promise<unknown>>()

  private readonly options: SchemaCacheOptions

  /** Bumped by {@link clear}; a load that resolves under an older generation is not stored. */
  private generation = 0

  private counters = {
    hits: 0,
    misses: 0,
    shared: 0,
    stores: 0,
    evictions: 0,
    clears: 0,
  }

  /**
   * @param options - TTL, entry cap and clock.
   */
  constructor(options: SchemaCacheOptions) {
    this.options = options
  }

  /** Entries currently held. */
  get size(): number {
    return this.entries.size
  }

  /**
   * Read one key if it is fresh.
   *
   * @param key - cache key.
   * @returns the lookup, or `undefined` when absent or stale.
   */
  get<T>(key: string): CacheLookup<T> | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    const ageMs = this.options.now() - entry.storedAt
    if (this.options.ttlMs > 0 && ageMs >= this.options.ttlMs) {
      // An expired entry is dropped here rather than lingering until a write.
      this.entries.delete(key)
      return undefined
    }
    this.counters.hits += 1
    return { value: entry.value as T, source: 'hit', cached: true, ageMs: Math.max(0, ageMs) }
  }

  /**
   * Load one key through the cache, deduplicating concurrent misses.
   *
   * @param key - cache key.
   * @param load - the miss path.
   * @returns the value and where it came from.
   * @throws whatever `load` throws; nothing is stored on failure.
   */
  async getOrLoad<T>(key: string, load: () => Promise<T>): Promise<CacheLookup<T>> {
    const hit = this.get<T>(key)
    if (hit !== undefined) return hit

    const pending = this.inflight.get(key)
    if (pending !== undefined) {
      this.counters.shared += 1
      const value = await pending
      return { value: value as T, source: 'single-flight', cached: false, ageMs: 0 }
    }

    this.counters.misses += 1
    const generation = this.generation
    const promise = load()
    this.inflight.set(key, promise)
    try {
      const value = await promise
      if (generation === this.generation) this.store(key, value)
      return { value, source: 'fetched', cached: false, ageMs: 0 }
    } finally {
      if (this.inflight.get(key) === promise) this.inflight.delete(key)
    }
  }

  /**
   * Drop every entry and invalidate in-flight loads.
   *
   * @returns the number of entries that were held.
   */
  clear(): number {
    const held = this.entries.size
    this.entries.clear()
    this.generation += 1
    this.counters.clears += 1
    return held
  }

  /** A snapshot of the counters. */
  stats(): CacheStats {
    return {
      ...this.counters,
      entries: this.entries.size,
    }
  }

  /** Store one value, evicting the oldest entry past the cap. */
  private store(key: string, value: unknown): void {
    this.entries.set(key, { value, storedAt: this.options.now() })
    this.counters.stores += 1
    while (this.entries.size > this.options.maxEntries) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [candidate, entry] of this.entries) {
        if (entry.storedAt < oldestAt) {
          oldestAt = entry.storedAt
          oldestKey = candidate
        }
      }
      if (oldestKey === undefined) break
      this.entries.delete(oldestKey)
      this.counters.evictions += 1
    }
  }
}
