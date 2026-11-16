/**
 * One booted throwaway host + browser page, wired for the call-history suite.
 *
 * A single helper so the functional spec and the screenshot spec cannot drift:
 * both need the same profile installation, the same stand-in Remote Control
 * port, and the same localStorage pin that opens the fixture session.
 */

import { resolve } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from '@playwright/test'

import {
  PACKAGE_NAME,
  bootstrapHome,
  claimSession,
  freePort,
  makeFixture,
  resolveDsh,
  seedLegacyHistory,
  startHost,
  stopHost,
  waitForLogMarker,
  type DshCommand,
  type Fixture,
  type Host,
} from './host.ts'
import { openHistoryPanel, waitForSession } from './gui.ts'

/** The fixture session the seed plugin publishes (and prints to the host log). */
export const SESSION_ID = 'e2e-unreal-history'
/** The marker line the fixture prints after driving the real tools. */
export const SESSION_MARKER = 'DSH_UNREAL_E2E_READY='
/** The per-call outcomes marker line. */
export const RESULTS_MARKER = 'DSH_UNREAL_E2E_RESULTS='
/** The per-EditorAutomation-function request-count marker line (the cache evidence). */
export const SERVED_MARKER = 'DSH_UNREAL_E2E_SERVED='

/** A booted host and the page attached to it. */
export interface BootedSession {
  readonly dsh: DshCommand
  readonly fixture: Fixture
  readonly host: Host
  readonly browser: Browser
  readonly context: BrowserContext
  readonly page: Page
  /** The session id the fixture published. */
  readonly sessionId: string
  /** The fixture's per-call outcomes, as it printed them. */
  readonly results: readonly { callId: string; ok: boolean; code: string }[]
  /** EditorAutomation requests the stand-in answered, counted per function. */
  readonly served: Readonly<Record<string, number>>
  /** Close the browser and stop the host; never touches another process. */
  close(): Promise<void>
}

/** Every call the fixture drives for the current session, in execution order. */
export const EXPECTED_CALLS = [
  'e2e-ping',
  'e2e-enum',
  'e2e-enum-cache',
  'e2e-class',
  'e2e-proptype',
  'e2e-read',
  'e2e-write',
  'e2e-object-class',
  'e2e-call',
  'e2e-call-instance',
  'e2e-call-failed',
  'e2e-enum-failed',
] as const

/** The call recorded under a different session, which this panel must not show. */
export const OTHER_SESSION_CALL = 'e2e-other'

/** The legacy row seeded into storage before boot (no typed details). */
export const LEGACY_CALL = 'legacy-e2e-1'

/** Options for one boot. */
export interface BootOptions {
  /** A short tag for the temp directory and the host log name. */
  readonly tag: string
  /** The pinned UI language. */
  readonly locale?: 'en' | 'zh'
  /** The browser viewport. */
  readonly viewport?: { width: number; height: number }
  /** Whether to open the panel before returning. */
  readonly openPanel?: boolean
}

/**
 * Boot a throwaway `dsh web` with this plugin installed, wait for the fixture
 * session and its durable history, then open the GUI on that session.
 *
 * @param options - tag, locale, viewport and whether to open the panel.
 * @returns the booted session; the caller owns {@link BootedSession.close}.
 * @throws when no `dsh` executable can be found — callers turn that into a skip.
 */
export async function bootSession(options: BootOptions): Promise<BootedSession | undefined> {
  const dsh = resolveDsh()
  if (dsh === undefined) return undefined

  const locale = options.locale ?? 'en'
  const fixture = makeFixture(options.tag, locale)
  const workspaceId = await bootstrapHome(dsh, fixture)
  claimSession(fixture, workspaceId, SESSION_ID)
  // A row written before typed Details existed, so the browser spec can prove
  // the old-record fallback against a real load.
  seedLegacyHistory(fixture.home, SESSION_ID)

  // The stand-in Remote Control endpoint lives in the fixture plugin, inside the
  // host process; the plugin transport is pointed at it through the documented
  // `DSH_UNREAL_BASE_URL` override.
  const rcPort = await freePort()
  const host = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile, {
    extraArgs: ['--patch', resolve('e2e', 'fixtures', 'profile.patch.yml')],
    locale,
    env: {
      DSH_E2E_RC_PORT: String(rcPort),
      DSH_UNREAL_BASE_URL: `http://127.0.0.1:${rcPort}`,
      DSH_E2E_SESSION: SESSION_ID,
    },
  })

  let browser: Browser | undefined
  try {
    const sessionId = await waitForLogMarker(host.logFile, SESSION_MARKER)
    const resultsLine = await waitForLogMarker(host.logFile, RESULTS_MARKER)
    const results = JSON.parse(resultsLine) as { callId: string; ok: boolean; code: string }[]
    const servedLine = await waitForLogMarker(host.logFile, SERVED_MARKER)
    const served = JSON.parse(servedLine) as Record<string, number>

    browser = await chromium.launch()
    const context = await browser.newContext({
      viewport: options.viewport ?? { width: 1440, height: 900 },
      locale: locale === 'zh' ? 'zh-CN' : 'en-US',
    })
    // The session is published by the host, not created by the GUI, so the
    // persisted client store is what tells the shell to open it.
    await context.addInitScript((id: string) => {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
    }, sessionId)
    const page = await context.newPage()
    page.setDefaultTimeout(30_000)
    await page.goto(host.url, { waitUntil: 'domcontentloaded' })
    await waitForSession(page)
    if (options.openPanel !== false) await openHistoryPanel(page)

    return {
      dsh,
      fixture,
      host,
      browser,
      context,
      page,
      sessionId,
      results,
      served,
      async close() {
        await browser?.close().catch(() => {})
        await stopHost(host.proc)
        try { fixture.cleanup() } catch { /* windows temp dirs may still be locked */ }
      },
    }
  } catch (error) {
    await browser?.close().catch(() => {})
    await stopHost(host.proc)
    try { fixture.cleanup() } catch { /* ignore */ }
    throw error
  }
}

/** The package name installed into the throwaway profile (re-exported for assertions). */
export { PACKAGE_NAME }
