/**
 * README figures, generated from the REAL plugin in a real browser.
 *
 * This spec is the screenshot pipeline: it boots a throwaway `dsh web` host,
 * has the fixture drive the plugin's real tools against a stand-in Remote
 * Control endpoint, and writes the images the README embeds into
 * `docs/images/`. It is OPT-IN (`pnpm run screenshots` sets README_SHOTS=1); a
 * plain `pnpm e2e` skips it, because rewriting committed images on every
 * ordinary test run would make unrelated diffs noisy.
 *
 * The figures:
 *   history-cards        the always-open cards, mixed success/failure (red title)
 *   history-card-call    a level-instance call card: Parameters + Returns already open
 *   history-card-details a read card with its typed value tree expanded inline
 *   history-card-raw     one card's single Raw data disclosure opened
 *   history-card-menu    a card's three-dot menu with its Raw data radio item
 *   history-cards.zh     the same cards with the Chinese action titles
 *   history-toolview     the same card as a custom tool view inside the chat transcript
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

import { bootSession, type BootedSession } from './helpers/session.ts'
import {
  cardTitle,
  openRawData,
  openTranscriptTools,
  panel,
  parkPointer,
  rowForCall,
  rows,
  transcriptCard,
  widenRightSidebar,
} from './helpers/gui.ts'

const ENABLED = process.env.README_SHOTS === '1'
const OUT = join('docs', 'images')
const FIGURES = [
  'history-cards',
  'history-card-call',
  'history-card-details',
  'history-card-raw',
  'history-card-menu',
  'history-cards.zh',
  'history-toolview',
] as const

/** The docked panel scrolled to one card, with the pointer parked out of the way. */
async function showCard(page: import('@playwright/test').Page, callId: string): Promise<void> {
  await rowForCall(page, callId).scrollIntoViewIfNeeded()
  await page.waitForTimeout(350)
  await parkPointer(page)
}

test.describe.configure({ mode: 'serial' })

test.describe('README screenshots', () => {
  let session: BootedSession | undefined
  let zhSession: BootedSession | undefined

  test.beforeAll(async () => {
    if (!ENABLED) return
    test.setTimeout(900_000)
    mkdirSync(OUT, { recursive: true })
    session = await bootSession({ tag: 'shots', locale: 'en', viewport: { width: 1440, height: 900 } })
    if (session === undefined) test.skip(true, 'no dsh executable on PATH; set DSH_BIN')
  })

  test.afterAll(async () => {
    await session?.close()
    await zhSession?.close()
  })

  /** Collapse the left sidebar and widen the history column for the figures. */
  async function prepareLayout(page: import('@playwright/test').Page): Promise<void> {
    const collapse = page.getByRole('button', { name: /收起侧边栏|Collapse sidebar|Hide sidebar|Toggle sidebar/i }).first()
    if (await collapse.count() > 0 && await collapse.isVisible().catch(() => false)) {
      await collapse.click({ timeout: 10_000 }).catch(() => {})
      await page.waitForTimeout(600)
    }
    await widenRightSidebar(page, 0.55)
    await page.waitForTimeout(600)
  }

  test('capture the seven figures', async () => {
    if (!ENABLED) {
      test.skip(true, 'screenshots are opt-in: run `pnpm run screenshots`')
      return
    }
    if (session === undefined) return
    const { page } = session

    await expect(panel(page)).toBeVisible()
    await expect(rows(page)).toHaveCount(13)
    await prepareLayout(page)

    // 1. The always-open cards, newest first: failed card's title is red.
    await page.screenshot({ path: join(OUT, 'history-cards.png'), animations: 'disabled' })

    // 2. A level-instance call card: Parameters/Returns visible without any click.
    await showCard(page, 'e2e-call-instance')
    await page.screenshot({ path: join(OUT, 'history-card-call.png'), animations: 'disabled' })

    // 3. A read card with the typed value tree expanded inline.
    await rowForCall(page, 'e2e-read').scrollIntoViewIfNeeded()
    const tree = rowForCall(page, 'e2e-read').locator('[data-unreal-section="value"] [data-unreal-tree-toggle]').first()
    await tree.click()
    await page.waitForTimeout(300)
    await showCard(page, 'e2e-read')
    await page.screenshot({ path: join(OUT, 'history-card-details.png'), animations: 'disabled' })

    // 4. One card's single Raw data disclosure opened: metadata + wire payloads.
    await openRawData(page, 'e2e-write')
    await showCard(page, 'e2e-write')
    await page.screenshot({ path: join(OUT, 'history-card-raw.png'), animations: 'disabled' })

    // 5. The card's three-dot menu, with the Raw data radio item.
    const menuTrigger = rowForCall(page, 'e2e-call-instance').locator('[data-unreal-card-menu]')
    await showCard(page, 'e2e-call-instance')
    await menuTrigger.click()
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(OUT, 'history-card-menu.png'), animations: 'disabled' })
    await page.keyboard.press('Escape')

    // 6. The Chinese action titles on the same cards.
    zhSession = await bootSession({ tag: 'shots-zh', locale: 'zh', viewport: { width: 1440, height: 900 } })
    if (zhSession !== undefined) {
      const zhPage = zhSession.page
      await expect(rows(zhPage)).toHaveCount(13)
      await expect(cardTitle(zhPage, 'e2e-read')).toHaveText('读取 Cube_1.RelativeLocation 属性')
      await prepareLayout(zhPage)
      await zhPage.screenshot({ path: join(OUT, 'history-cards.zh.png'), animations: 'disabled' })
      await expect(rowForCall(zhPage, 'e2e-ping').locator('[data-unreal-card-menu]')).toBeVisible()
      await rowForCall(zhPage, 'e2e-ping').locator('[data-unreal-card-menu]').click()
      await expect(zhPage.locator('[data-unreal-menu-raw]')).toContainText('原始数据')
      await zhPage.keyboard.press('Escape')
    }

    // 7. The same card as a custom tool view in the chat transcript.
    await openTranscriptTools(page)
    await transcriptCard(page, 'e2e-call-instance').scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
    await parkPointer(page)
    await page.screenshot({ path: join(OUT, 'history-toolview.png'), animations: 'disabled' })

    const manifest = FIGURES.map(name => `docs/images/${name}.png`)
    writeFileSync('screenshots.json', `${JSON.stringify(manifest, null, 2)}\n`)
    for (const file of manifest) expect(file).toMatch(/^docs\/images\/history-(card|cards|toolview).*\.png$/)
    console.log('[screenshots]', JSON.stringify(manifest))
  })
})
