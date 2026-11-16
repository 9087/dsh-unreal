/**
 * Functional E2E for the call-history cards, in a real browser against a real
 * `dsh web` host.
 *
 * The history is NOT fabricated: the fixture plugin boots inside the host,
 * drives the plugin's real tools against a stand-in Remote Control endpoint,
 * and the plugin records each call in its durable store.
 *
 * The design under test:
 * - every card leads with an action title (`Read Cube_1.RelativeLocation`);
 * - a failed card paints that title red and shows one short error line;
 * - cards are always expanded — parameters/returns/info are visible with no
 *   outer fold, and no click;
 * - time/status/call id/counts/canonical Types/legacy note/raw JSON/error
 *   code+hint live inside ONE closed "Raw data" disclosure per card.
 */

import { expect, test } from '@playwright/test'

import {
  EXPECTED_CALLS,
  LEGACY_CALL,
  RESULTS_MARKER,
  SERVED_MARKER,
  SESSION_MARKER,
  bootSession,
  type BootedSession,
} from './helpers/session.ts'
import { historyFiles, waitForLogMarker } from './helpers/host.ts'
import {
  cardTitle,
  closeRawData,
  openRawData,
  openHistoryPanel,
  rowForCall,
  rows,
  waitForSession,
} from './helpers/gui.ts'

test.describe.configure({ mode: 'serial' })

/** Rows this spec expects in the current session: the fixture's calls + the legacy row. */
const CURRENT_SESSION_ROWS = EXPECTED_CALLS.length + 1

/** The English action title of each card the fixture creates, keyed by call id. */
const TITLES: Record<string, string> = {
  'e2e-ping': 'Check connectivity',
  'e2e-enum': 'Get ECollisionEnabled enum info',
  'e2e-enum-cache': 'Get ECollisionEnabled enum info',
  'e2e-class': 'Get StaticMeshComponent class info',
  'e2e-proptype': 'Get RelativeLocation property type',
  'e2e-read': 'Read Cube_1.RelativeLocation',
  'e2e-write': 'Set Cube_1.RelativeLocation.Z',
  'e2e-object-class': 'Get Cube_1 class info',
  'e2e-call': 'Call KismetSystemLibrary.GetDisplayName',
  'e2e-call-instance': 'Call Cube_1.GetDisplayName',
  'e2e-call-failed': 'Call Actor.Explode',
  'e2e-enum-failed': 'Get Bogus enum info',
  [LEGACY_CALL]: 'Read Cube_1.bHidden',
}

let session: BootedSession | undefined

test.beforeAll(async () => {
  session = await bootSession({ tag: 'panel' })
  if (session === undefined) test.skip(true, 'no dsh executable on PATH; set DSH_BIN to run the e2e')
})

test.afterAll(async () => {
  await session?.close()
})

test('the fixture drove the real tools and recorded a durable history', async () => {
  if (session === undefined) return
  const failed = session.results.filter(result => !result.ok)
  expect(failed.map(result => result.code).sort()).toEqual([
    'editorautomation/call-failed',
    'editorautomation/enum-not-found',
  ])
  const files = historyFiles(session.fixture.home)
  expect(files.length).toBeGreaterThanOrEqual(EXPECTED_CALLS.length + 2)
  expect(files.every(name => /^[a-zA-Z0-9_-]+\.json$/.test(name))).toBe(true)
})

test('the schema caches prevented duplicate reflection round trips', async () => {
  if (session === undefined) return
  const served = session.served
  expect(served['GetEnumInfo']).toBe(2)
  expect(served['GetFunctionInfo']).toBe(3)
  expect(served['GetPropertyType']).toBe(4)
  expect(served['GetStructInfo']).toBe(1)
  expect(served['GetObjectClass']).toBe(2)
  expect(served['Ping']).toBe(1)
  expect(served['CallFunction']).toBe(3)
})

test('every card leads with an action title and is already open', async () => {
  if (session === undefined) return
  const { page } = session

  await expect(rows(page)).toHaveCount(CURRENT_SESSION_ROWS)
  // There is no outer expand control and no disclosure header: Raw data is
  // shown only through the card menu, so each closed card draws nothing.
  await expect(page.locator('[data-unreal-expand]')).toHaveCount(0)
  for (const callId of [...EXPECTED_CALLS, LEGACY_CALL]) {
    const card = rowForCall(page, callId)
    await expect(card.locator('details')).toHaveCount(0)
    await expect(card.locator('[data-unreal-raw]')).toHaveCount(0)
  }

  for (const [callId, title] of Object.entries(TITLES)) {
    await expect(cardTitle(page, callId)).toHaveText(title)
  }

  // Newest first: the last fixture call heads the list.
  await expect(rows(page).first().locator('[data-unreal-title]')).toHaveText('Get Bogus enum info')

  // The session row is gone from the header (the panel is already scoped to one
  // session); the editor endpoint row remains, identity included when readable.
  await expect(page.locator('[data-unreal-session-tag]')).toHaveCount(0)
  await expect(page.locator('[data-unreal-counts]')).toHaveCount(0)
  const editorRow = page.locator('[data-unreal-editor-row]').first()
  await expect(editorRow).toBeVisible()
  await expect(editorRow.locator('[data-unreal-base-url]')).toContainText('127.0.0.1')
})

test('a failed card paints its whole title red and shows one short error line', async () => {
  if (session === undefined) return
  const { page } = session

  const title = cardTitle(page, 'e2e-enum-failed')
  await expect(title).toHaveAttribute('data-unreal-title-tone', 'failed')
  await expect(title).toHaveCSS('color', 'rgb(208, 80, 63)')

  const line = rowForCall(page, 'e2e-enum-failed').locator('[data-unreal-error-line]')
  await expect(line).toBeVisible()
  await expect(line).toHaveText(/No enum named that Type exists\./)
  // The error code/hint are raw material, not part of the visible line.
  await expect(line).not.toContainText('editorautomation/')
  await expect(line).not.toContainText('ErrorCode')
  await expect(line).not.toContainText('Hint')

  // The successful cards' titles keep the normal colour.
  await expect(cardTitle(page, 'e2e-ping')).toHaveAttribute('data-unreal-title-tone', 'ok')
})

test('parameters, returns and value changes are visible without expanding', async () => {
  if (session === undefined) return
  const { page } = session

  // call_function: Parameters + Returns tables are on screen directly.
  const call = rowForCall(page, 'e2e-call-instance')
  await expect(call.locator('[data-unreal-section="inputs"]')).toBeVisible()
  await expect(call.locator('[data-unreal-section="returns"]')).toBeVisible()
  const typeCell = call.locator('[data-unreal-field-name="Object"] [data-unreal-field-type]')
  await expect(typeCell).toHaveText('object Object')
  await expect(typeCell).toHaveAttribute('title', 'object(/Script/Engine.Object)')

  // get_property_value: a typed value row and its expandable tree, no outer fold.
  const read = rowForCall(page, 'e2e-read')
  const valueSection = read.locator('[data-unreal-section="value"]')
  await expect(valueSection).toBeVisible()
  await expect(valueSection.locator('[data-unreal-field-type]').first()).toHaveText('struct Vector')
  await valueSection.locator('[data-unreal-tree-toggle]').first().click()
  await expect(valueSection.locator('[data-unreal-tree-name="Z"]')).toContainText('10.0')

  // set_property_value: the typed change is visible too.
  const write = rowForCall(page, 'e2e-write')
  await expect(write.locator('[data-unreal-section="change"]')).toBeVisible()
  await expect(write.locator('[data-unreal-section="change"]')).toContainText('42.0')

  // An info tool shows its listing directly.
  const enumCard = rowForCall(page, 'e2e-enum')
  await expect(enumCard.locator('[data-unreal-info]')).toBeVisible()
  await expect(enumCard.locator('[data-unreal-info]')).toContainText('QueryAndPhysics')
})

test('the cards lead with the call time, and the body carries no folded metadata', async () => {
  if (session === undefined) return
  const { page } = session

  const enumBody = await rowForCall(page, 'e2e-enum').locator('[data-unreal-card-body]').innerText()
  expect(enumBody).not.toContain('entries')
  expect(enumBody).not.toContain('call:')
  expect(enumBody).not.toMatch(/\d{1,2}:\d{2}/)

  const readBody = await rowForCall(page, 'e2e-read').locator('[data-unreal-card-body]').innerText()
  expect(readBody).not.toContain('struct(/Script/CoreUObject.Vector)')
  expect(readBody).not.toContain('X, Y, Z')

  const legacyBody = await rowForCall(page, LEGACY_CALL).locator('[data-unreal-card-body]').innerText()
  expect(legacyBody).not.toContain('Recorded before structured details existed')
})

test('a card with no structured body leaves no empty padded strip', async () => {
  if (session === undefined) return
  const { page } = session

  // A successful ping has a title and nothing else; the body div must collapse.
  const body = rowForCall(page, 'e2e-ping').locator('[data-unreal-card-body]')
  await expect(body).toHaveCount(1)
  await expect(body).toBeHidden()
})

test('the one Raw data fold holds the metadata and the wire payloads', async () => {
  if (session === undefined) return
  const { page } = session

  const raw = await openRawData(page, 'e2e-enum-cache')
  const text = await raw.innerText()
  expect(text).toContain('e2e-enum-cache') // call id
  expect(text).toContain('unreal_get_enum_info') // tool
  // Time lives on the card's first line, not in the fold.
  const cardTime = await rowForCall(page, 'e2e-enum-cache').locator('[data-unreal-time]').innerText()
  expect(cardTime).toMatch(/\d{1,2}:\d{2}/)
  expect(text).not.toMatch(/\d{1,2}:\d{2}/)
  expect(text).toContain('enum(/Script/Engine.ECollisionEnabled)') // canonical Type echo
  expect(text).toContain('entries') // entry count
  await expect(raw.locator('[data-unreal-raw-block]').first()).toContainText('"type"')
  await closeRawData(page, 'e2e-enum-cache')

  // A failed record keeps code + hint + message in raw data only.
  const failedRaw = await openRawData(page, 'e2e-enum-failed')
  const failedText = await failedRaw.innerText()
  expect(failedText).toContain('editorautomation/enum-not-found')
  expect(failedText).toContain('error hint')
  expect(failedText).toContain('Pass a Type like enum(/Script/Engine.ECollisionEnabled).')
  await closeRawData(page, 'e2e-enum-failed')
})

test('the three-dot card menu toggles the Raw data block with one radio item', async () => {
  if (session === undefined) return
  const { page } = session

  const row = rowForCall(page, 'e2e-read')
  const trigger = row.locator('[data-unreal-card-menu]')
  const raw = row.locator('[data-unreal-raw]')
  await expect(trigger).toHaveAttribute('data-unreal-card-menu', 'closed')
  await expect(raw).toHaveCount(0)

  await trigger.click()
  const item = page.locator('[data-unreal-menu-raw]')
  await expect(item).toHaveAttribute('role', 'menuitemradio')
  await expect(item).toHaveAttribute('aria-checked', 'false')

  await item.click()
  await expect(raw).toBeVisible()

  await trigger.click()
  await expect(page.locator('[data-unreal-menu-raw]')).toHaveAttribute('aria-checked', 'true')
  await page.locator('[data-unreal-menu-raw]').click()
  await expect(raw).toHaveCount(0)
})

test('a legacy record uses the same card layout with its note only in Raw data', async () => {
  if (session === undefined) return
  const { page } = session
  await expect(cardTitle(page, LEGACY_CALL)).toHaveText('Read Cube_1.bHidden')
  // The legacy card has no structured body: only its Raw data fold.
  const body = rowForCall(page, LEGACY_CALL).locator('[data-unreal-card-body]')
  await expect(body.locator('[data-unreal-details-view]')).toHaveCount(0)
  await expect(body.locator('[data-unreal-info]')).toHaveCount(0)
  const raw = await openRawData(page, LEGACY_CALL)
  await expect(raw.locator('[data-unreal-legacy]')).toBeVisible()
  await expect(raw.locator('[data-unreal-raw-block]').first()).toContainText('bHidden')
  await closeRawData(page, LEGACY_CALL)
})

test('the filter matches the action title and restores every card', async () => {
  if (session === undefined) return
  const { page } = session
  const filter = page.locator('[data-unreal-filter]').first()
  await filter.fill('Call Cube_1')
  await expect(rows(page)).toHaveCount(1)
  await expect(cardTitle(page, 'e2e-call-instance')).toHaveText('Call Cube_1.GetDisplayName')
  await filter.fill('Write property')
  await expect(rows(page)).toHaveCount(1)
  await filter.fill('')
  await expect(rows(page)).toHaveCount(CURRENT_SESSION_ROWS)
})

test('the cards survive a page reload (durable, read back from disk)', async () => {
  if (session === undefined) return
  const { page } = session
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitForSession(page)
  await openHistoryPanel(page)
  await expect(rows(page)).toHaveCount(CURRENT_SESSION_ROWS)
  await expect(rows(page).first().locator('[data-unreal-title]')).toHaveText('Get Bogus enum info')
  await expect(cardTitle(page, 'e2e-read')).toHaveText('Read Cube_1.RelativeLocation')
  expect(historyFiles(session.fixture.home).length).toBeGreaterThanOrEqual(EXPECTED_CALLS.length + 2)
})

test('the fixtures and markers the boot waits for are stable', () => {
  expect(SESSION_MARKER).toBe('DSH_UNREAL_E2E_READY=')
  expect(RESULTS_MARKER).toBe('DSH_UNREAL_E2E_RESULTS=')
  expect(SERVED_MARKER).toBe('DSH_UNREAL_E2E_SERVED=')
  expect(typeof waitForLogMarker).toBe('function')
})

test.describe('Chinese action titles', () => {
  let zhSession: BootedSession | undefined

  test.beforeAll(async () => {
    zhSession = await bootSession({ tag: 'panel-zh', locale: 'zh' })
    if (zhSession === undefined) test.skip(true, 'no dsh executable on PATH; set DSH_BIN')
  })

  test.afterAll(async () => {
    await zhSession?.close()
  })

  test('the same cards read as the requested Chinese actions', async () => {
    if (zhSession === undefined) return
    const { page } = zhSession
    await expect(rows(page)).toHaveCount(CURRENT_SESSION_ROWS)
    const titles: Record<string, string> = {
      'e2e-ping': '检查连通',
      'e2e-enum': '获取 ECollisionEnabled 的枚举信息',
      'e2e-class': '获取 StaticMeshComponent 的类信息',
      'e2e-proptype': '获取 RelativeLocation 的属性类型',
      'e2e-read': '读取 Cube_1.RelativeLocation 属性',
      'e2e-write': '设置 Cube_1.RelativeLocation.Z 属性',
      'e2e-object-class': '获取 Cube_1 的类信息',
      'e2e-call-instance': '调用 Cube_1.GetDisplayName 函数',
      'e2e-enum-failed': '获取 Bogus 的枚举信息',
    }
    for (const [callId, title] of Object.entries(titles)) {
      await expect(cardTitle(page, callId)).toHaveText(title)
    }
    await expect(cardTitle(page, 'e2e-enum-failed')).toHaveCSS('color', 'rgb(208, 80, 63)')
    const raw = await openRawData(page, 'e2e-enum')
    await expect(raw).toContainText('unreal_get_enum_info')
    await closeRawData(page, 'e2e-enum')
  })
})
