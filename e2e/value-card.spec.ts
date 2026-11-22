/**
 * The read-property card's Custom view: the raw value text is fetched as a typed
 * Details table from the host's on-demand schema (property Type + struct members),
 * so member Types and per-Type value rendering come from reflection.
 */

import { expect, test } from '@playwright/test'

import { rowForCall } from './helpers/gui.ts'
import { bootSession } from './helpers/session.ts'

test('a property read renders its value as a typed Details table', async () => {
  const boot = await bootSession({ tag: 'value-card', openPanel: true })
  test.skip(boot === undefined, 'no dsh executable')
  if (boot === undefined) return
  try {
    const row = rowForCall(boot.page, 'e2e-read')
    await row.scrollIntoViewIfNeeded()
    const typed = row.locator('[data-unreal-typed-value]').first()
    await expect(typed).toBeVisible({ timeout: 20_000 })
    // The struct itself is the root row, with its Type; its members are children.
    await expect(typed).toContainText('RelativeLocation')
    const toggle = typed.locator('[data-unreal-tree-toggle]').first()
    await toggle.click()
    const text = await typed.innerText()
    expect(text).toContain('double')
    expect(text).toContain('10.0')
    expect(text).not.toContain('"10.0"')
  } finally {
    await boot.close()
  }
})
