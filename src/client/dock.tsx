/**
 * The right sidebar as a host for the call-history panel.
 *
 * The sidebar is an extensible tab system: a tab *type* registers its static
 * face with the `sidebarRightTabs` service, its body and chip fill the keyed
 * `sidebar.right.pane.tab` / `sidebar.right.pane.tab.title` seats under that
 * type's `id`, and it is opened by `kind` through `sidebarRight`.
 *
 * Nothing here imports the sidebar's package as a runtime value: the services
 * are reached through `ctx.get`, which is the one lookup the plugin sandbox
 * never gates, and every registration sits in its own guard — `apply` runs
 * inside the client's boot, so a throw here would cost more than this panel.
 *
 * @module dsh-unreal/client/dock
 */

import { NS } from './locales.ts'
import { UnrealHistoryChip, UnrealHistoryPanel, UnrealIcon } from './panel.tsx'
import type { RpcCaller } from './wire.ts'

/** The registration's `id`: the key its body and chip register under. */
export const TAB_ID = 'dsh-unreal'

/** The tab type's `kind`: what `openTab` names. */
export const TAB_KIND = 'unreal-history'

/** Where the panel is listed on the sidebar's guide page. */
const TAB_GUIDE_ORDER = 200

/** How often the optional sidebar services are looked up, and for how long. */
const LOOKUP_INTERVAL_MS = 200
const LOOKUP_ATTEMPTS = 75

/**
 * The cordis pieces this adapter uses, structurally: an optional service lookup,
 * an effect, and a scoped inject.
 */
export interface ClientHostContext {
  /** Look a service up without declaring a dependency on it. */
  get(name: string): unknown
  /** Register a disposable with the plugin's fiber. */
  effect(callback: () => unknown, label: string): void
  /** Run a callback once these services exist, without blocking this plugin's own `apply`. */
  inject?(names: string[], callback: (scope: ClientHostContext) => void): void
}

/** Structural view of the sidebar's navigation face. */
interface SidebarRightFace {
  openTab(kind: string, options?: { revealIfOpened?: boolean }): void
}

/** Structural view of the tab-type registry. */
interface TabRegistryFace {
  register(definition: {
    id: string
    kind: string
    title: (address: string) => string
    guide?: readonly {
      order: number
      title: () => string
      description?: () => string
      icon?: (props: { size?: number; className?: string }) => unknown
    }[]
  }): () => void
}

/** Structural view of the slot service. */
interface SlotServiceFace {
  /** Fill a slot, once its declaration exists. */
  inject(name: string, callback: () => unknown): void
  /** Register one component into a live slot. */
  register(config: Record<string, unknown>, component: unknown): unknown
}

/** Structural view of the connection service. */
interface ConnectionFace {
  readonly rpc: unknown
}

/** The signature the connection's channel caller is used with. */
type ChannelCall = (
  this: unknown,
  channel: string,
  endpoint: string,
  payload: unknown,
  signal?: AbortSignal,
) => Promise<unknown>

/**
 * Build the panel's channel caller.
 *
 * The connection is resolved *per call* rather than captured, so a service that
 * attaches after this plugin still gets used, and a host without one produces a
 * normal failure branch instead of a boot error.
 *
 * @param ctx - the client context.
 * @returns the caller the panel uses.
 */
export function createUnrealCaller(ctx: ClientHostContext): RpcCaller {
  return {
    async call(channel, endpoint, payload, signal) {
      const connection = ctx.get('connection') as ConnectionFace | undefined
      const rpc = connection?.rpc
      if (rpc === null || rpc === undefined || typeof rpc !== 'object') {
        throw new Error('The host exposes no connection channel.')
      }
      const call = (rpc as { call?: unknown }).call
      if (typeof call !== 'function') {
        throw new Error('The host connection has no rpc.call.')
      }
      return await (call as ChannelCall).call(rpc, channel, endpoint, payload, signal)
    },
  }
}

/** Fields on an unknown state object that might name one selected session. */
const SESSION_FIELDS = ['current', 'currentId', 'selected', 'selectedId', 'sessionId'] as const

/**
 * Read the selected session id out of an unknown session-list state.
 *
 * @param state - the store snapshot handed to a selector.
 * @returns the id, or `undefined` when this shape names none.
 */
export function selectedSessionOf(state: unknown): string | undefined {
  if (state === null || typeof state !== 'object') return undefined
  const fields = state as Record<string, unknown>
  for (const key of SESSION_FIELDS) {
    const value = fields[key]
    if (typeof value === 'string' && value !== '') return value
  }
  // Some snapshots keep the state one level down (`{ state }`); read that too.
  const nested = fields['state']
  if (nested !== undefined && nested !== state) return selectedSessionOf(nested)
  return undefined
}

/**
 * Build the structural session resolver the panel uses when the seat does not
 * pass a `sessionId` prop.
 *
 * The primary path is the sidebar's own seat: `sidebar.right.pane.tab` is a
 * session-scope slot, so the framework hands the body its `sessionId`. This
 * fallback exists for a host whose seat composes no such prop.
 *
 * @param ctx - the client context.
 * @returns a reader that never throws.
 */
export function createSessionResolver(ctx: ClientHostContext): () => string | undefined {
  return () => {
    try {
      const sessions = ctx.get('sessions') as
        | { readonly list?: { getSnapshot?: () => unknown } }
        | undefined
      const getSnapshot = sessions?.list?.getSnapshot
      if (typeof getSnapshot !== 'function') return undefined
      return selectedSessionOf(getSnapshot.call(sessions?.list))
    } catch {
      return undefined
    }
  }
}

/** How one lookup result reads in the diagnostic string. Never throws. */
function shape(ctx: ClientHostContext, name: string): string {
  try {
    const value = ctx.get(name)
    if (value === undefined) return 'missing'
    return typeof value === 'object' || typeof value === 'function' ? 'ok' : typeof value
  } catch (error: unknown) {
    return `threw(${error instanceof Error ? error.message : String(error)})`
  }
}

/** Run one registration, costing that surface only. */
function guard(label: string, run: () => void): void {
  try {
    run()
  } catch (error: unknown) {
    console.error(`dsh-unreal: ${label} failed`, error)
  }
}

/** What the dock needs from the plugin entry. */
export interface DockOptions {
  /** The channel caller the panel is given. */
  readonly caller: RpcCaller
  /** Resolve the current session structurally, as a fallback. */
  readonly resolveSessionId: () => string | undefined
  /** The tab's title, read per call so a language change needs no re-registration. */
  readonly title: () => string
  /** The one-line blurb the sidebar's guide page shows for this panel. */
  readonly guideDescription: () => string
}

/**
 * Find the sidebar's services and attach the panel to them.
 *
 * @param ctx - the client context, structurally.
 * @param options - the caller, the session resolver and the copy.
 */
export function attachHistoryDock(ctx: ClientHostContext, options: DockOptions): void {
  let timer: number | undefined
  let attached = false
  /** The last lookup's shape, kept so giving up can say which half was missing. */
  let detail = 'not looked up yet'

  const stop = (): void => {
    if (timer === undefined) return
    window.clearTimeout(timer)
    timer = undefined
  }

  const look = (): boolean => {
    if (attached) return true
    try {
      let sidebar: SidebarRightFace | undefined
      let registry: TabRegistryFace | undefined
      let slots: SlotServiceFace | undefined
      try {
        sidebar = ctx.get('sidebarRight') as SidebarRightFace | undefined
        registry = ctx.get('sidebarRightTabs') as TabRegistryFace | undefined
        slots = ctx.get('slots') as SlotServiceFace | undefined
      } catch (error: unknown) {
        detail = `ctx.get threw: ${error instanceof Error ? error.message : String(error)}`
        return false
      }
      detail = [
        `sidebarRight=${shape(ctx, 'sidebarRight')}`,
        `sidebarRightTabs=${shape(ctx, 'sidebarRightTabs')}`,
        `slots=${shape(ctx, 'slots')}`,
      ].join(' ')
      if (sidebar === undefined || registry === undefined || slots === undefined) return false

      // Set before registering: the registry throws on a duplicate id, so a
      // retry must never register the same tab type twice.
      attached = true

      // Stage 1: the tab type, so `openTab(kind)` resolves and the chip has a
      // name. The `guide` entry lists the panel on the sidebar's guide page.
      guard('tab type', () => {
        ctx.effect(
          () => registry.register({
            id: TAB_ID,
            kind: TAB_KIND,
            title: () => options.title(),
            guide: [{
              order: TAB_GUIDE_ORDER,
              title: () => options.title(),
              description: () => options.guideDescription(),
              icon: UnrealIcon,
            }],
          }),
          'dsh-unreal: right-sidebar tab type',
        )
      })

      // Stage 2: the body and the chip, dispatched by the tab type's id. A keyed
      // seat takes `key` (not `id`) — passing the wrong one fails the seat.
      guard('tab body', () => {
        slots.inject('sidebar.right.pane.tab', () => slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          locale: NS,
          inject: () => ({ caller: options.caller, resolveSessionId: options.resolveSessionId }),
        }, UnrealHistoryPanel))
      })
      guard('tab chip', () => {
        slots.inject('sidebar.right.pane.tab.title', () => slots.register({
          name: 'sidebar.right.pane.tab.title',
          key: TAB_ID,
          locale: NS,
          inject: () => ({}),
        }, UnrealHistoryChip))
      })

      // No left-sidebar footer entry: the tab type is reachable from the right
      // sidebar's own add/guide surfaces.

      return true
    } catch (error: unknown) {
      detail = `dock wiring threw: ${error instanceof Error ? error.message : String(error)}`
      return false
    }
  }

  // The teardown rides the plugin's fiber.
  ctx.effect(() => stop, 'dsh-unreal: dock lookup')
  if (look()) return

  let attempts = 0
  const tick = (): void => {
    timer = undefined
    if (look()) {
      stop()
      return
    }
    attempts += 1
    if (attempts >= LOOKUP_ATTEMPTS) {
      stop()
      console.warn(
        `dsh-unreal: no right sidebar after ${LOOKUP_ATTEMPTS} looks (${detail});`
        + ' the call-history panel has no tab to live in',
      )
      return
    }
    timer = window.setTimeout(tick, LOOKUP_INTERVAL_MS)
  }
  timer = window.setTimeout(tick, LOOKUP_INTERVAL_MS)
}
