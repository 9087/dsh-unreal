/**
 * Durable call history over one `dsh-storage-domain` domain.
 *
 * One domain, one table: every EditorAutomation call this plugin makes is appended as
 * its own record. The layout is `per-record`, so an append rewrites one small
 * document instead of the whole history, and `backup-and-skip` means one
 * corrupt record cannot keep the plugin from loading.
 *
 * Reads are synchronous from the domain's authoritative in-memory state, so a
 * panel poll is cheap. Writes queue on the domain's single write chain.
 *
 * Session grouping is a query over the records, not a second table: a record
 * carries the session it belongs to, so "the current session's history" is
 * `operationsMatching({ sessionId })` and never a copy that could drift.
 *
 * @module dsh-unreal/store
 */

import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { Domain, DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

import { operationRecordSchema, translationRecordSchema } from './records.ts'
import type { OperationRecord, SessionGroup, TranslationRecord } from './records.ts'

/** Storage domain name; also the backend unit name under `<DSH_HOME>/storages`. */
export const UNREAL_DOMAIN_NAME = 'dsh_unreal'

/**
 * Encode a value into a storage key the per-record backend accepts.
 *
 * `dsh-storage-json`'s per-record layout uses the record key as a file name and
 * rejects anything outside `[a-zA-Z0-9_-]` at write time. The encoding is
 * injective: `_` is escaped along with every other unsafe character, so a
 * literal `_2f` in one value cannot collide with an escaped `/` in another.
 *
 * @param value - the raw key.
 * @returns a path-safe key.
 */
export function storageKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, character => `_${character.codePointAt(0)?.toString(16) ?? '3f'}`)
}

/** How many writes pass between two pruning scans. */
const PRUNE_INTERVAL = 64

/** The plugin's declared storage domain. */
export const unrealDomain = defineDomain({
  name: UNREAL_DOMAIN_NAME,
  version: 1,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  tables: {
    operations: domainTable<string, OperationRecord>(operationRecordSchema),
    translations: domainTable<string, TranslationRecord>(translationRecordSchema),
  },
})

/** Filter for {@link UnrealStore.operationsMatching}. */
export interface HistoryQuery {
  /** Only operations from this session. */
  readonly sessionId?: string | undefined
  /** Only operations by this tool. */
  readonly tool?: string | undefined
  /** Only successes or only failures. */
  readonly ok?: boolean | undefined
  /** Only operations at or after this epoch-millisecond timestamp. */
  readonly since?: number | undefined
  /** Maximum records to return, newest first. */
  readonly limit?: number | undefined
}

/** Resolved options for {@link UnrealStore.open}. */
export interface StoreOptions {
  /** Cap on retained operations across all sessions. */
  readonly maxRetainedOperations: number
}

/**
 * Cap a value before it is persisted as part of a record.
 *
 * Records are read back into the panel, so an oversized payload (a mesh's
 * vertex array, a long string list) must not bloat the medium. Past the cap the
 * value degrades to a truncated string, which is still informative and always
 * lossless JSON.
 *
 * @param value - candidate payload.
 * @param maxChars - serialized-character cap.
 * @returns a JSON value within the cap, or `undefined` for `undefined`.
 */
export function boundSnapshot(value: unknown, maxChars: number): JsonValue | undefined {
  if (value === undefined) return undefined
  let text: string
  try {
    text = JSON.stringify(value) ?? 'null'
  } catch {
    return '<unserializable>'
  }
  if (text.length <= maxChars) {
    return JSON.parse(text) as JsonValue
  }
  if (maxChars <= 0) {
    return JSON.parse(text) as JsonValue
  }
  return `${text.slice(0, maxChars)}… (truncated from ${text.length} chars)`
}

/** The plugin's durable state over one storage domain. */
export class UnrealStore {
  private writes = 0

  private readonly domain: Domain<typeof unrealDomain>

  private readonly options: StoreOptions

  /**
   * Fields are declared and assigned explicitly rather than as constructor
   * parameter properties: the latter is non-erasable TypeScript syntax, so
   * Node's strip-only loader — which runs the test files directly — refuses
   * to parse it.
   *
   * @param domain - the opened storage domain.
   * @param options - resolved store options.
   */
  private constructor(domain: Domain<typeof unrealDomain>, options: StoreOptions) {
    this.domain = domain
    this.options = options
  }

  /**
   * Open the domain.
   *
   * @param facility - the mounted `ctx.storageDomain` facility.
   * @param options - resolved store options.
   * @returns the open store; the caller owns {@link UnrealStore.close}.
   */
  static async open(facility: DomainFacility, options: StoreOptions): Promise<UnrealStore> {
    const domain = await facility.open(unrealDomain)
    return new UnrealStore(domain, options)
  }

  /**
   * Append one operation, and prune when the table has grown past its cap.
   *
   * @param record - the completed operation.
   */
  async recordOperation(record: OperationRecord): Promise<void> {
    await this.domain.table('operations').put(storageKey(record.id), record)

    this.writes += 1
    if (this.writes % PRUNE_INTERVAL !== 0) return
    await this.prune()
  }

  /**
   * Query the history, newest first.
   *
   * @param query - filters.
   * @returns matching operations, newest first.
   */
  operationsMatching(query: HistoryQuery = {}): OperationRecord[] {
    const matched: OperationRecord[] = []
    for (const [, record] of this.domain.table('operations').entries()) {
      if (query.sessionId !== undefined && record.sessionId !== query.sessionId) continue
      if (query.tool !== undefined && record.tool !== query.tool) continue
      if (query.ok !== undefined && record.ok !== query.ok) continue
      if (query.since !== undefined && record.time < query.since) continue
      matched.push(record)
    }
    matched.sort((a, b) => b.time - a.time)
    return query.limit === undefined ? matched : matched.slice(0, query.limit)
  }

  /**
   * One operation by record id, for endpoints that serve a record's artifact.
   *
   * @param id - the record id.
   * @returns the record, or `undefined` when it is not retained.
   */
  operationById(id: string): OperationRecord | undefined {
    return this.domain.table('operations').get(storageKey(id)) as OperationRecord | undefined
  }

  /**
   * Count the history without building the rows, for a header figure.
   *
   * @param query - filters; `limit` is ignored.
   * @returns the number of matching records.
   */
  countMatching(query: HistoryQuery = {}): number {
    const limit = query.limit
    // `limit` is meaningless for a count; drop it before delegating.
    const { limit: _ignored, ...filters } = query
    void limit
    return this.operationsMatching(filters).length
  }

  /** Total retained operations, across every session. */
  get operationCount(): number {
    return this.domain.table('operations').size
  }

  /**
   * Every session that has records, with its count and its newest record's time.
   *
   * This is the grouping the panel's header reads: the records themselves are
   * always filtered by session at read time, so the groups exist to say "how
   * many sessions does this history cover" rather than to slice it twice.
   *
   * @returns groups sorted by their newest record, newest first.
   */
  sessionGroups(): SessionGroup[] {
    const groups = new Map<string, { count: number; lastTime: number }>()
    for (const [, record] of this.domain.table('operations').entries()) {
      const key = record.sessionId ?? ''
      const existing = groups.get(key)
      if (existing === undefined) {
        groups.set(key, { count: 1, lastTime: record.time })
        continue
      }
      existing.count += 1
      if (record.time > existing.lastTime) existing.lastTime = record.time
    }
    return [...groups.entries()]
      .map(([sessionId, value]) => ({ sessionId, count: value.count, lastTime: value.lastTime }))
      .sort((a, b) => b.lastTime - a.lastTime)
  }

  /** Read one cached translation; `undefined` when it was never stored. */
  translation(culture: string, key: string): string | undefined {
    return this.domain.table('translations').get(storageKey(`${culture}\u0000${key}`))?.text
  }

  /** Read the cached translations for a set of keys. */
  translationsFor(culture: string, keys: readonly string[]): Map<string, string> {
    const found = new Map<string, string>()
    const table = this.domain.table('translations')
    for (const key of keys) {
      const record = table.get(storageKey(`${culture}\u0000${key}`))
      if (record !== undefined) found.set(key, record.text)
    }
    return found
  }

  /** Persist non-empty translations, overwriting the previous values. */
  async saveTranslations(culture: string, entries: readonly { key: string; text: string }[]): Promise<void> {
    if (entries.length === 0) return
    const table = this.domain.table('translations')
    const updatedAt = Date.now()
    for (const entry of entries) {
      if (entry.text === '') continue
      await table.put(storageKey(`${culture}\u0000${entry.key}`), {
        culture,
        key: entry.key,
        text: entry.text,
        updatedAt,
      })
    }
  }

  /**
   * Remove every record retained for one session.
   *
   * @param sessionId - the session whose history is cleared.
   * @returns the number of records removed.
   */
  async clearSession(sessionId: string): Promise<number> {
    const table = this.domain.table('operations')
    let removed = 0
    for (const [key, record] of table.entries()) {
      if (record.sessionId !== sessionId) continue
      if (await table.delete(key)) removed += 1
    }
    return removed
  }

  /**
   * Drop the oldest operations until the table fits its cap.
   *
   * @returns the number of records pruned.
   */
  async prune(): Promise<number> {
    const table = this.domain.table('operations')
    if (table.size <= this.options.maxRetainedOperations) return 0
    const oldestFirst = [...table.entries()].sort((a, b) => a[1].time - b[1].time)
    const excess = table.size - this.options.maxRetainedOperations
    let removed = 0
    for (let index = 0; index < excess; index += 1) {
      const entry = oldestFirst[index]
      if (entry === undefined) break
      if (await table.delete(entry[0])) removed += 1
    }
    return removed
  }

  /** Release the domain. Callers own this, normally as an effect disposer. */
  async close(): Promise<void> {
    await this.domain.close()
  }
}
