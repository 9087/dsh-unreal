/**
 * Browser half of the Unreal EditorAutomation plugin.
 *
 * This module does one thing: mount the call-history panel into the right
 * sidebar. The panel is an optional surface — a host without a right sidebar
 * must keep working — so every registration is guarded and the sidebar's
 * services are discovered structurally through `ctx.get`.
 *
 * @module dsh-unreal/client
 */

import type { Context } from '@deepseek-ai/cordis'

import { NS, en, localize, zh } from './locales.ts'
import type { Translator } from './locales.ts'
import { attachHistoryDock, createSessionResolver, createUnrealCaller } from './dock.tsx'
import type { ClientHostContext } from './dock.tsx'
import { attachToolViews } from './toolview.tsx'

/** Cordis plugin name, distinct from the host half's. */
export const name = 'dsh-unreal/client'

/**
 * Services this half requires: the slot framework, the locale service and the
 * host connection (the panel's history channel). A composition without any of
 * them has no surface for this plugin to draw on.
 */
export const inject = ['slots', 'locale', 'connection']

export { UNREAL_CHANNEL } from './wire.ts'

// Exported so a harness can render the panel without importing the bundle:
// `.tsx` is unreadable to Node's type-stripping loader.
export { UnrealHistoryPanel } from './panel.tsx'

/** Structural view of the locale service. */
interface LocaleFace {
  /** Register this plugin's dictionaries under its own namespace. */
  register(namespace: string, dictionaries: unknown): () => void
  /** Bind a translator to one namespace. */
  bind?(namespace: string): Translator
}

/**
 * A translator that may not exist yet.
 *
 * The dock's title is a callback the framework may call on any later render, so
 * holding the translator in a mutable box lets a late registration take effect
 * without re-mounting anything.
 */
interface TranslatorHolder {
  current: Translator | undefined
}

/**
 * Register this plugin's dictionaries and keep a translator.
 *
 * `bind` is attempted first on purpose: it reads the active locale at call
 * time, so even a refused registration (a reload racing its predecessor) still
 * yields a translator that resolves the dictionaries already registered under
 * this namespace.
 *
 * @param ctx - the client context.
 * @returns the holder, filled in as soon as the service is reachable.
 */
function bindLocale(ctx: ClientHostContext): TranslatorHolder {
  const holder: TranslatorHolder = { current: undefined }

  const attach = (scope: ClientHostContext): void => {
    let locale: LocaleFace | undefined
    try {
      locale = scope.get('locale') as LocaleFace | undefined
    } catch (error: unknown) {
      console.warn('dsh-unreal: locale lookup failed; using English copy', error)
      return
    }
    if (locale === undefined || typeof locale.register !== 'function') return
    try {
      holder.current = typeof locale.bind === 'function' ? locale.bind(NS) : undefined
    } catch (error: unknown) {
      console.warn('dsh-unreal: locale bind failed; using English copy', error)
    }
    try {
      scope.effect(() => locale.register(NS, { zh, en }), 'dsh-unreal: dictionaries')
    } catch (error: unknown) {
      // A collision on reload is expected and harmless: the previous
      // registration is still serving this namespace.
      console.warn('dsh-unreal: locale registration refused; using the dictionaries already registered', error)
    }
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['locale'], scope => { attach(scope) })
  } else {
    attach(ctx)
  }
  return holder
}

/**
 * Mount the call-history panel.
 *
 * @param ctx - client context carrying the connection and slot services.
 */
export function apply(ctx: Context): void {
  const host = ctx as unknown as ClientHostContext
  const translator = bindLocale(host)
  const caller = createUnrealCaller(host)
  const resolveSessionId = createSessionResolver(host)
  attachHistoryDock(host, {
    caller,
    resolveSessionId,
    title: () => localize(translator.current, 'panel.title'),
    guideDescription: () => localize(translator.current, 'panel.guideDescription'),
  })
  // The transcript's custom tool views: every tool call in chat draws the same
  // card as the history sidebar. Guarded in its own function so a host without
  // the tool slot keeps the sidebar panel.
  try {
    attachToolViews(host, { caller, resolveSessionId })
  } catch (error: unknown) {
    console.warn('dsh-unreal: transcript tool views refused; the history panel still works', error)
  }
}
