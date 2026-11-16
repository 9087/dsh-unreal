/**
 * Plugin configuration.
 *
 * Cordis convention: an exported `Config` interface plus a same-named
 * Schemastery schema. Domain record schemas in `records.ts` use zod instead —
 * that split is deliberate in `dsh-storage-domain`.
 *
 * @module dsh-unreal/config
 */

import Schema from '@deepseek-ai/schemastery'

import { DEFAULT_BASE_URL, DEFAULT_REQUEST_TIMEOUT_MS } from './kit/client.ts'

/** Plugin configuration. */
export interface Config {
  /**
   * Base URL of the editor's Remote Control HTTP API.
   *
   * The `DSH_UNREAL_BASE_URL` environment variable overrides this value when
   * set, which is the seam automated tests and scripted hosts use to point the
   * plugin at a stand-in editor without editing a profile.
   */
  baseUrl: string
  /**
   * Plaintext passphrase. The engine hashes it with MD5 and compares the hex in
   * a `Passphrase` header; leave empty when the editor does not restrict access.
   */
  passphrase?: string
  /** Per-request budget in milliseconds. */
  requestTimeoutMs: number
  /** Probe the editor once at mount and log what answered. */
  preflight: boolean
  /** Maximum operations one history read returns when the caller names no limit. */
  historyLimit: number
  /** Cap on retained operations across all sessions before the oldest are pruned. */
  maxRetainedOperations: number
  /** Cap on one stored params/result payload, in serialized characters. */
  snapshotMaxChars: number
  /**
   * How long a cached EditorAutomation reflection answer stays fresh, in milliseconds;
   * `0` means it never goes stale (only a transport error or a remount clears
   * the cache). The cache is memory-only, so it dies with the host process.
   */
  reflectionCacheTtlMs: number
  /** Maximum reflection answers held in memory; the oldest is evicted past this. */
  reflectionCacheMaxEntries: number
  /** Character budget for one record's typed Details enrichment. */
  detailsMaxChars: number
  /**
   * How long record enrichment may spend on cached reflection lookups before
   * the record is written without them. Bounds a tool call's added latency.
   */
  enrichmentTimeoutMs: number
}

/** Schemastery schema for {@link Config}. */
export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string()
    .default(DEFAULT_BASE_URL)
    .description('Base URL of the Unreal Remote Control HTTP API.'),
  passphrase: Schema.string()
    .role('secret')
    .description('Plaintext passphrase; sent as the MD5 hex the engine compares.'),
  requestTimeoutMs: Schema.natural()
    .default(DEFAULT_REQUEST_TIMEOUT_MS)
    .description('Per-request budget in milliseconds.'),
  preflight: Schema.boolean()
    .default(true)
    .description('Probe the editor once at startup and log whether EditorAutomation answered.'),
  historyLimit: Schema.natural()
    .default(100)
    .description('Operations one history read returns when the caller names no limit.'),
  maxRetainedOperations: Schema.natural()
    .default(500)
    .description('Retained operation count before the oldest are pruned.'),
  snapshotMaxChars: Schema.natural()
    .default(0)
    .description('Cap on a stored params/result payload, in serialized characters; 0 means unlimited.'),
  reflectionCacheTtlMs: Schema.natural()
    .default(300_000)
    .description('Freshness window of a cached EditorAutomation reflection answer, in milliseconds; 0 never goes stale.'),
  reflectionCacheMaxEntries: Schema.natural()
    .default(512)
    .description('Maximum reflection answers held in memory.'),
  detailsMaxChars: Schema.natural()
    .default(12_000)
    .description('Character budget for one record\'s typed Details enrichment.'),
  enrichmentTimeoutMs: Schema.natural()
    .default(2_000)
    .description('How long record enrichment may spend on reflection lookups before the record is written without Details.'),
})

/**
 * Fill in every optional field so callers never branch on `undefined`.
 *
 * Not `extends Config`: under `exactOptionalPropertyTypes` an always-present
 * `string | undefined` is not assignable to an optional `string`.
 */
export type ResolvedConfig = Omit<Config, 'passphrase'> & {
  readonly passphrase: string | undefined
}

/**
 * Normalize a validated config for runtime use.
 *
 * @param config - the schema-validated plugin config.
 * @returns the config with absent optionals made explicit.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const envBaseUrl = process.env.DSH_UNREAL_BASE_URL
  return {
    ...config,
    baseUrl: envBaseUrl === undefined || envBaseUrl.trim() === '' ? config.baseUrl : envBaseUrl.trim(),
    passphrase: config.passphrase === undefined || config.passphrase === '' ? undefined : config.passphrase,
  }
}
