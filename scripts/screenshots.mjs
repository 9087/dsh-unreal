#!/usr/bin/env node
/**
 * Regenerate the README figures (`docs/images/*.png`) from the real plugin in a
 * real browser.
 *
 * The work is done by `e2e/screenshots.spec.ts`, which is opt-in: this wrapper
 * sets `README_SHOTS=1` and runs that ONE spec, so an ordinary `pnpm e2e` never
 * rewrites committed images.
 *
 * Requirements: a built `lib/` (`pnpm run build`, the shell serves `lib/`, not
 * `src/`) and a `dsh` executable (`DSH_BIN`, or `dsh` on PATH).
 *
 * Usage:
 *   pnpm run build
 *   pnpm run screenshots
 *
 * The figures, written into `docs/images/`:
 *   history-sidebar   the docked call history beside the session, mixed statuses
 *   history-expanded  one write row expanded, params plus before/after result
 *   history-error     one failed call expanded, engine message and hint
 *
 * The spec also rewrites `screenshots.json` at the repository root.
 */
import { spawn } from 'node:child_process'

const command = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const child = spawn(command, ['exec', 'playwright', 'test', 'e2e/screenshots.spec.ts'], {
  stdio: 'inherit',
  env: { ...process.env, README_SHOTS: '1' },
  shell: process.platform === 'win32',
})
child.on('error', (error) => {
  console.error('[screenshots] could not start playwright:', error.message)
  process.exit(1)
})
child.on('exit', code => process.exit(code ?? 1))
