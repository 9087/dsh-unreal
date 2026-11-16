/**
 * Plugin entry point.
 *
 * Wires four things together and nothing else: one EditorAutomation HTTP client, the
 * durable call-history store, the read-only history channel the sidebar panel
 * uses, and the tool surface. The plugin adds no approval policy of its own —
 * the harness's permission system governs the tools like any other.
 *
 * @module dsh-unreal
 */

import type { Context } from '@deepseek-ai/cordis'

import { Config, resolveConfig } from './config.ts'
import { EditorInfoCache } from './editor-info-cache.ts'
import { EditorAutomationClient } from './kit/client.ts'
import { ReflectionService } from './kit/reflection.ts'
import { registerHistoryChannel } from './rpc.ts'
import { SchemaCache } from './schema-cache.ts'
import { UnrealStore } from './store.ts'
import { registerTools } from './tools.ts'
import { TranslationCache } from './translations.ts'

/** Cordis plugin name. */
export const name = 'unreal'

/**
 * Services that must be ready before `apply` runs: the tool registry for
 * registration and the storage domain facility for the call history.
 */
export const inject = ['tools', 'storageDomain']

export { Config }

/**
 * Mount the plugin.
 *
 * @param ctx - plugin context; every registration below is disposed with this fiber.
 * @param config - schema-validated plugin config.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const resolved = resolveConfig(config)

  const client = new EditorAutomationClient({
    baseUrl: resolved.baseUrl,
    passphrase: resolved.passphrase,
    requestTimeoutMs: resolved.requestTimeoutMs,
  })

  const store = await UnrealStore.open(ctx.storageDomain, {
    maxRetainedOperations: resolved.maxRetainedOperations,
  })
  ctx.effect(() => () => {
    void store.close()
  }, 'dsh-unreal: storage domain')

  // Reflection answers (`Get*Info`) exist for display/schema, not to be
  // re-fetched per call: one memory cache serves the tools AND the record
  // enrichment, so a signature a tool just resolved is reused when the call it
  // produced is turned into typed Details. It is memory-only by design — a host
  // restart drops it, and the durable history does not depend on it.
  const reflectionCache = new SchemaCache({
    ttlMs: resolved.reflectionCacheTtlMs,
    maxEntries: resolved.reflectionCacheMaxEntries,
    now: () => Date.now(),
  })
  const reflection = new ReflectionService({
    client,
    cache: reflectionCache,
    log: line => { ctx.logger.debug(line) },
  })
  const translations = new TranslationCache({
    store,
    resolve: (keys, culture, signal) => reflection.localizedTexts(keys, culture, signal),
  })
  // Invalidate on transport errors is handled by the reflection service; the
  // explicit path (a config change/remount) gets a fresh cache because the
  // plugin is reconstructed.

  registerHistoryChannel(ctx, {
    store,
    config: resolved,
    now: () => Date.now(),
    localizeTexts: (keys, culture, signal) => translations.texts(keys, culture, signal),
    // The panel polls every 4 s; identity is cached for ~10 s so the poll is
    // not an RC round trip, while a restarted editor's new PID still appears
    // within two polls.
    editor: new EditorInfoCache({ source: reflection }),
  })

  registerTools(ctx, {
    client,
    reflection,
    store,
    config: resolved,
    now: () => Date.now(),
  })

  // Advisory liveness probe at mount: puts the answer in the host log without
  // ever being able to fail the mount or delay a tool call. A missing editor is
  // normal (the user may start it later), so a failure is a debug line, not a
  // warning that implies something is broken.
  if (resolved.preflight) {
    void client.ping().then(
      value => {
        ctx.logger.info(`dsh-unreal: EditorAutomation answered "${value}" at ${client.origin}`)
      },
      (error: unknown) => {
        ctx.logger.debug(
          `dsh-unreal: EditorAutomation is not reachable at ${client.origin} yet (${error instanceof Error ? error.message : String(error)})`,
        )
      },
    )
  }
}
