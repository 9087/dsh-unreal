/**
 * Durable display-name translations for the panel.
 *
 * Keys are the stable identity; resolved text is only a cache, so the panel can
 * switch languages without re-running a tool. The first localization request in
 * each host process is allowed to refresh and overwrite the persisted values;
 * after that, only keys with no cached translation are resolved.
 *
 * @module dsh-unreal/translations
 */

import type { UnrealStore } from './store.ts'

/** Resolve keys through EditorAutomation for one culture. */
export type TranslationResolver = (
  keys: readonly string[],
  culture: string,
  signal?: AbortSignal,
) => Promise<readonly string[]>

/** Durable translation cache with one refresh window per host process. */
export class TranslationCache {
  private readonly store: UnrealStore

  private readonly resolve: TranslationResolver

  private refreshed = false

  constructor(deps: { readonly store: UnrealStore; readonly resolve: TranslationResolver }) {
    this.store = deps.store
    this.resolve = deps.resolve
  }

  /**
   * Resolve a batch of keys for one culture.
   *
   * The first call after host startup overwrites cached entries for the keys it
   * asks about. Later calls use the durable values for existing keys and only
   * fill in keys that have no cached translation.
   *
   * @param keys - display-name keys, in request order.
   * @param culture - Unreal culture name.
   * @param signal - cancellation for the editor lookup.
   * @returns one text per key; empty when no translation is available.
   */
  async texts(keys: readonly string[], culture: string, signal?: AbortSignal): Promise<readonly string[]> {
    if (keys.length === 0 || culture === '') return keys.map(() => '')

    const cached = this.store.translationsFor(culture, keys)
    const pending = this.refreshed
      ? keys.filter(key => !cached.has(key))
      : [...new Set(keys)]

    if (pending.length > 0) {
      try {
        const resolved = await this.resolve(pending, culture, signal)
        const entries = pending.map((key, index) => ({ key, text: resolved[index] ?? '' }))
        await this.store.saveTranslations(culture, entries)
        entries.forEach((entry) => { if (entry.text !== '') cached.set(entry.key, entry.text) })
      } catch {
        // Keep whatever cache exists; translation must never fail a card.
      }
    }
    this.refreshed = true
    return keys.map(key => cached.get(key) ?? '')
  }
}
