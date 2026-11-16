/**
 * Browser-side helpers for the call-history E2E: dismiss first-run notices,
 * wait for the shell, and open the panel's right-sidebar tab.
 */

import { expect, type Locator, type Page } from '@playwright/test'
import { setTimeout as sleep } from 'node:timers/promises'

/** The data attribute the panel publishes on its root element. */
export const PANEL = '[data-unreal-panel]'

/** Rows and their parts, as the panel publishes them. */
export const ROW = '[data-unreal-row]'
export const ROW_TOOL = '[data-unreal-tool]'
export const ROW_STATUS = '[data-unreal-status]'

/** The transcript's custom tool card wrapper (`tool.call.toolview`). */
export const TRANSCRIPT_CARD = '[data-unreal-toolview]'

/** The prompt the fixture session carries, used as "the session is on screen". */
export const FIXTURE_PROMPT = 'Inspect the cube component and raise it to Z=42.'

/** Button labels a first-run notice may use, in both shipped languages. */
const NOTICE_BUTTONS = [
  '继续', '稍后配置', '稍后', '以后再说', '知道了', '关闭',
  'Continue', 'Later', 'Skip', 'Skip for now', 'Not now', 'Got it', 'Dismiss', 'Close',
]

/**
 * Dismiss any first-run notices that would sit over the page and swallow clicks.
 *
 * @param page - the page.
 */
export async function dismissNotices(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    let clicked = false
    for (const name of NOTICE_BUTTONS) {
      const button = page.getByRole('button', { name, exact: true }).first()
      if (!await button.isVisible().catch(() => false)) continue
      await button.click({ timeout: 5_000 }).catch(() => {})
      clicked = true
      await sleep(1_200)
      break
    }
    if (!clicked) break
  }
  await sleep(400)
}

/**
 * Wait until the shell and the fixture session are on screen.
 *
 * @param page - the page.
 * @param timeoutMs - how long the shell gets to boot.
 */
export async function waitForSession(page: Page, timeoutMs = 90_000): Promise<void> {
  await page.waitForSelector('text=/工作区|Workspaces/', { timeout: timeoutMs })
  await dismissNotices(page)
  await expect(page.getByText(FIXTURE_PROMPT, { exact: false }).first()).toBeVisible({ timeout: timeoutMs })
}

/**
 * Open the panel's tab through the right sidebar's own guide, without relying on
 * a left-sidebar entry (the plugin deliberately registers none).
 *
 * The right column starts collapsed in a fresh session: expand it, then either
 * the guide is already showing (click our guide card) or the strip's add
 * control opens it. A tab that is already open is a no-op on retry.
 *
 * @param page - the page.
 */
export async function openHistoryPanel(page: Page): Promise<void> {
  const guideEntry = page.locator('[data-sidebar-right-guide-entry="unreal-history"]').first()
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await panel(page).isVisible().catch(() => false)) return

    const expand = page.locator('[data-sidebar-right-expand="true"]').first()
    if (await expand.isVisible().catch(() => false)) {
      await expand.click({ timeout: 20_000 })
      await sleep(700)
    }

    if (!(await guideEntry.isVisible().catch(() => false))) {
      const add = page.locator('[data-dockkit-add-tab]').first()
      if (await add.isVisible().catch(() => false)) {
        await add.click({ timeout: 20_000 })
        await sleep(700)
      }
    }

    if (await guideEntry.isVisible().catch(() => false)) {
      await guideEntry.click({ timeout: 20_000 })
    }
    await sleep(1_500)
  }
  await expect(panel(page)).toBeVisible({ timeout: 20_000 })
}

/** The panel, wherever the sidebar put it. */
export function panel(page: Page): Locator {
  return page.locator(PANEL).first()
}

/** Every history row currently drawn. */
export function rows(page: Page): Locator {
  return panel(page).locator(ROW)
}

/** One row by the tool call that produced it (`data-unreal-row-id` ends with the call id). */
export function rowForCall(page: Page, callId: string): Locator {
  return panel(page).locator(`${ROW}[data-unreal-row-id$="-${callId}"]`).first()
}

/** The row whose target names a tool label, for "does this row exist" checks. */
export function rowWithTool(page: Page, label: string): Locator {
  return rows(page).filter({ has: page.locator(ROW_TOOL, { hasText: label }) }).first()
}

/**
 * The action title of one card.
 *
 * @param page - the page.
 * @param callId - the tool call the card belongs to.
 * @returns the title locator.
 */
export function cardTitle(page: Page, callId: string): Locator {
  return rowForCall(page, callId).locator('[data-unreal-title]').first()
}

/**
 * The single Raw data disclosure of one card.
 *
 * @param page - the page.
 * @param callId - the tool call the card belongs to.
 * @returns the disclosure locator.
 */
export function rawData(page: Page, callId: string): Locator {
  return rowForCall(page, callId).locator('[data-unreal-raw]').first()
}

/**
 * Toggle one card's Raw data block through its three-dot menu (the only
 * control; there is no disclosure header in the card).
 *
 * @param page - the page.
 * @param callId - the tool call the card belongs to.
 */
async function toggleRawData(page: Page, callId: string): Promise<void> {
  const row = rowForCall(page, callId)
  await row.scrollIntoViewIfNeeded()
  await row.locator('[data-unreal-card-menu]').first().click({ timeout: 20_000 })
  await page.locator('[data-unreal-menu-raw]').first().click({ timeout: 20_000 })
  await sleep(200)
}

/**
 * Open one card's Raw data block.
 *
 * @param page - the page.
 * @param callId - the tool call the card belongs to.
 * @returns the block, now open.
 */
export async function openRawData(page: Page, callId: string): Promise<Locator> {
  const raw = rawData(page, callId)
  if (!(await raw.isVisible().catch(() => false))) await toggleRawData(page, callId)
  await expect(raw).toBeVisible({ timeout: 20_000 })
  return raw
}

/**
 * Collapse one card's Raw data block again.
 *
 * @param page - the page.
 * @param callId - the tool call the card belongs to.
 */
export async function closeRawData(page: Page, callId: string): Promise<void> {
  const raw = rawData(page, callId)
  if (await raw.isVisible().catch(() => false)) await toggleRawData(page, callId)
  await expect(raw).toHaveCount(0)
}

/**
 * Widen the docked right sidebar with the shell's own drag handle, until it is
 * at least `fraction` of the window wide. Best-effort: a shell without the
 * handle simply keeps its default width.
 *
 * @param page - the page.
 * @param fraction - the share of the viewport the panel should take.
 */
export async function widenRightSidebar(page: Page, fraction = 0.5): Promise<void> {
  const handle = page.locator('[data-side="rightbar"]').first()
  if (await handle.count() === 0) return
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 }
  const target = Math.round(viewport.width * (1 - fraction))
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const box = await handle.boundingBox().catch(() => null)
    if (box === null) { await sleep(300); continue }
    const y = Math.round(viewport.height / 2)
    await page.mouse.move(box.x + box.width / 2, y)
    await sleep(150)
    await page.mouse.down()
    await page.mouse.move(target, y, { steps: 12 })
    await page.mouse.up()
    await sleep(600)
    const panelBox = await page.locator('[data-sidebar-right-panel]').first().boundingBox().catch(() => null)
    if ((panelBox?.width ?? 0) >= viewport.width * fraction * 0.9) return
  }
}

/** Move the pointer to a neutral spot so no hover highlight lands in a figure. */
export async function parkPointer(page: Page): Promise<void> {
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 }
  await page.mouse.move(Math.round(viewport.width / 2), Math.round(viewport.height - 24))
  await sleep(250)
}

/**
 * Expand the transcript's process group(s) so the custom tool cards inside are
 * rendered. The shell folds a turn's tool calls behind two disclosures ("Done
 * in …", then "Called tools"); both are clicked when still closed.
 *
 * @param page - the page.
 */
export async function openTranscriptTools(page: Page): Promise<void> {
  const completed = page.getByText(/Completed in|已完成|Done in/).first()
  if (await completed.count() > 0) {
    await completed.click({ timeout: 20_000 }).catch(() => {})
    await sleep(500)
  }
  const called = page.getByText(/Called tools|调用的工具/).first()
  if (await called.count() > 0) {
    // "Called tools" is itself a disclosure; clicking when open would close it.
    const expanded = await called.getAttribute('aria-expanded').catch(() => null)
    if (expanded !== 'true') await called.click({ timeout: 20_000 }).catch(() => {})
    await sleep(500)
  }
  await expect(page.locator(TRANSCRIPT_CARD).first()).toBeVisible({ timeout: 30_000 })
}

/** Every custom tool card in the transcript (never the sidebar). */
export function transcriptCards(page: Page): Locator {
  return page.locator(TRANSCRIPT_CARD)
}

/** One transcript tool card by the tool call id the shell passes it. */
export function transcriptCard(page: Page, callId: string): Locator {
  return page.locator(`${TRANSCRIPT_CARD}[data-unreal-toolview-call="${callId}"]`).first()
}

/** The action title inside one transcript card. */
export function transcriptTitle(page: Page, callId: string): Locator {
  return transcriptCard(page, callId).locator('[data-unreal-title]').first()
}

/**
 * Toggle one transcript card's Raw data block through its three-dot menu.
 *
 * @param page - the page.
 * @param callId - the tool call the card belongs to.
 */
async function toggleTranscriptRaw(page: Page, callId: string): Promise<void> {
  const card = transcriptCard(page, callId)
  await card.scrollIntoViewIfNeeded()
  await card.locator('[data-unreal-card-menu]').first().click({ timeout: 20_000 })
  await page.locator('[data-unreal-menu-raw]').first().click({ timeout: 20_000 })
  await sleep(200)
}

/**
 * Open one transcript card's Raw data block.
 *
 * @param page - the page.
 * @param callId - the tool call the card belongs to.
 * @returns the Raw data block.
 */
export async function openTranscriptRaw(page: Page, callId: string): Promise<Locator> {
  const raw = transcriptCard(page, callId).locator('[data-unreal-raw]').first()
  if (!(await raw.isVisible().catch(() => false))) await toggleTranscriptRaw(page, callId)
  await expect(raw).toBeVisible({ timeout: 20_000 })
  return raw
}
