/**
 * E2E for the transcript renderer: every tool call in the chat draws the same
 * card as the history sidebar (`tool.call.toolview`), fed from the durable
 * record by call id.
 *
 * This boots its own throwaway host so the transcript starts collapsed; the
 * custom cards are still mounted behind the shell's two process disclosures
 * ("Completed in …" and "Called tools"), which {@link openTranscriptTools}
 * opens. Everything asserted here is the real plugin rendering real durable
 * records produced by the fixture's real tool calls.
 */

import { expect, test } from '@playwright/test'

import {
  EXPECTED_CALLS,
  RESULTS_MARKER,
  SERVED_MARKER,
  SESSION_MARKER,
  bootSession,
  type BootedSession,
} from './helpers/session.ts'
import {
  cardTitle,
  openHistoryPanel,
  openRawData,
  openTranscriptRaw,
  openTranscriptTools,
  panel,
  rowForCall,
  rows,
  transcriptCard,
  transcriptCards,
  transcriptTitle,
  waitForSession,
} from './helpers/gui.ts'

test.describe.configure({ mode: 'serial' })

/** Normalize whitespace so two renderings of the same record compare. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

let session: BootedSession | undefined

test.beforeAll(async () => {
  session = await bootSession({ tag: 'transcript' })
  if (session === undefined) test.skip(true, 'no dsh executable on PATH; set DSH_BIN')
})

test.afterAll(async () => {
  await session?.close()
})

test('the transcript mounts one custom card per tool call', async () => {
  if (session === undefined) return
  const { page } = session
  await openHistoryPanel(page)
  await openTranscriptTools(page)

  await expect(transcriptCards(page)).toHaveCount(EXPECTED_CALLS.length)
  for (const callId of EXPECTED_CALLS) {
    await expect(transcriptCard(page, callId)).toHaveAttribute('data-unreal-toolview-phase', 'result')
  }
  // The result arm renders the durable record's card, not the compact fallback.
  await expect(page.locator('[data-unreal-toolview-fallback]')).toHaveCount(0)
  await expect(page.locator('[data-unreal-toolview-running="true"]')).toHaveCount(0)
  await expect(page.getByText(/Called tools|调用的工具/).first()).toBeVisible()
})

test('a transcript card shows the same title, Parameters and Returns as the sidebar', async () => {
  if (session === undefined) return
  const { page } = session
  const callId = 'e2e-call-instance'

  await expect(transcriptTitle(page, callId)).toHaveText('Call Cube_1.GetDisplayName')
  const tCard = transcriptCard(page, callId)
  const sCard = rowForCall(page, callId)
  await expect(tCard.locator('[data-unreal-section="inputs"]')).toBeVisible()
  await expect(tCard.locator('[data-unreal-section="returns"]')).toBeVisible()

  // Same record, same card component: the visible tables agree exactly.
  expect(normalize(await tCard.locator('[data-unreal-section="inputs"]').innerText()))
    .toBe(normalize(await sCard.locator('[data-unreal-section="inputs"]').innerText()))
  expect(normalize(await tCard.locator('[data-unreal-section="returns"]').innerText()))
    .toBe(normalize(await sCard.locator('[data-unreal-section="returns"]').innerText()))
  await expect(transcriptTitle(page, callId)).toHaveText(normalize(await cardTitle(page, callId).innerText()))

  // One time, one title, one menu: the transcript does not duplicate the card.
  await expect(tCard.locator('[data-unreal-time]')).toHaveCount(1)
  await expect(tCard.locator('[data-unreal-title]')).toHaveCount(1)
  await expect(tCard.locator('[data-unreal-card-menu]')).toHaveCount(1)
  expect(normalize(await tCard.locator('[data-unreal-time]').innerText())).toMatch(/\d{1,2}:\d{2}/)
})

test('a failed transcript card turns its title red and shows the short error line', async () => {
  if (session === undefined) return
  const { page } = session
  const callId = 'e2e-enum-failed'
  const title = transcriptTitle(page, callId)
  await expect(title).toHaveText('Get Bogus enum info')
  await expect(title).toHaveAttribute('data-unreal-title-tone', 'failed')
  await expect(title).toHaveCSS('color', 'rgb(208, 80, 63)')
  const line = transcriptCard(page, callId).locator('[data-unreal-error-line]')
  await expect(line).toBeVisible()
  await expect(line).toHaveText(/No enum named that Type exists\./)
  await expect(line).not.toContainText('ErrorCode')
})

test('the Raw data block opens from the transcript card menu', async () => {
  if (session === undefined) return
  const { page } = session
  const callId = 'e2e-enum'
  const card = transcriptCard(page, callId)
  const trigger = card.locator('[data-unreal-card-menu]')
  await expect(trigger).toHaveAttribute('data-unreal-card-menu', 'closed')
  await expect(card.locator('[data-unreal-raw]')).toHaveCount(0)

  const raw = await openTranscriptRaw(page, callId)
  const text = await raw.innerText()
  expect(text).toContain('e2e-enum')
  expect(text).toContain('enum(/Script/Engine.ECollisionEnabled)')
  expect(text).toContain('unreal_get_enum_info')

  // Toggling the radio item again hides it: one menu, one block.
  await trigger.click()
  await page.locator('[data-unreal-menu-raw]').first().click()
  await expect(card.locator('[data-unreal-raw]')).toHaveCount(0)
})

test('the sidebar panel is unchanged and still works beside the transcript', async () => {
  if (session === undefined) return
  const { page } = session
  await expect(panel(page)).toBeVisible()
  await expect(rows(page)).toHaveCount(EXPECTED_CALLS.length + 1)
  await expect(rows(page).first().locator('[data-unreal-title]')).toHaveText('Get Bogus enum info')
  await expect(cardTitle(page, 'e2e-read')).toHaveText('Read Cube_1.RelativeLocation')
  const raw = await openRawData(page, 'e2e-read')
  await expect(raw).toContainText('unreal_get_property_value')
  await rowForCall(page, 'e2e-read').locator('[data-unreal-card-menu]').click()
  await page.locator('[data-unreal-menu-raw]').first().click()
  await expect(rowForCall(page, 'e2e-read').locator('[data-unreal-raw]')).toHaveCount(0)
})

test('the transcript survives a reload and still draws the cards', async () => {
  if (session === undefined) return
  const { page } = session
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForSession(page)
  await openHistoryPanel(page)
  await openTranscriptTools(page)
  await expect(transcriptCards(page)).toHaveCount(EXPECTED_CALLS.length)
  await expect(transcriptTitle(page, 'e2e-call-instance')).toHaveText('Call Cube_1.GetDisplayName')
  await expect(transcriptTitle(page, 'e2e-enum-failed')).toHaveCSS('color', 'rgb(208, 80, 63)')
})

test('the fixtures and markers the boot waits for are stable', () => {
  expect(SESSION_MARKER).toBe('DSH_UNREAL_E2E_READY=')
  expect(RESULTS_MARKER).toBe('DSH_UNREAL_E2E_RESULTS=')
  expect(SERVED_MARKER).toBe('DSH_UNREAL_E2E_SERVED=')
})
