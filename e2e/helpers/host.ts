/**
 * Host-process plumbing for the real-browser E2E: resolve a `dsh` executable,
 * boot `dsh web` against a throwaway `DSH_HOME`, install this package into the
 * throwaway profile, and tear the process down again.
 *
 * Two rules this file exists to keep:
 *
 * - Nothing here may end a process this file did not start. `stopHost` kills the
 *   exact child it spawned (and, only as a last resort, that child's own tree by
 *   PID).
 * - The throwaway profile links this checkout the way a user's profile carries
 *   it: a `dsh.profile.bundles` entry, a `file:` dependency, and a
 *   `node_modules/dsh-unreal` junction back to this repository.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

/** Repository root (the package the profile links to). */
export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The package name installed into the throwaway profile. */
export const PACKAGE_NAME = 'dsh-unreal'

/** A `dsh` invocation, split into the executable and the arguments that precede the command. */
export interface DshCommand {
  cmd: string
  prefix: string[]
  /** How this was found, for the report. */
  via: string
}

/**
 * Find the `dsh` CLI.
 *
 * Order: `DSH_BIN` (an explicit instruction always wins) → the `dsh` shim on
 * `PATH`, whose sibling `@deepseek-ai/dsh/lib/bin.js` is spawned directly with
 * the current Node (one process, so teardown is exact) → `npx --no-install`.
 * A machine with none of those is a machine this suite cannot run on: the
 * caller skips instead of failing.
 */
export function resolveDsh(): DshCommand | undefined {
  const explicit = process.env.DSH_BIN
  if (explicit !== undefined && explicit !== '' && existsSync(explicit)) {
    if (/\.(js|mjs|cjs)$/i.test(explicit)) return { cmd: process.execPath, prefix: [explicit], via: 'DSH_BIN' }
    return { cmd: explicit, prefix: [], via: 'DSH_BIN' }
  }
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (dir === '') continue
    const entry = join(dir, '..', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    if (existsSync(entry)) return { cmd: process.execPath, prefix: [entry], via: `PATH shim in ${dir}` }
  }
  return undefined
}

/** One booted host: the child process, its base URL (with the browser token), and its log. */
export interface Host {
  proc: ChildProcess
  url: string
  port: number
  logFile: string
}

/**
 * A port nothing else is on, checked by actually binding it.
 *
 * A random number is not enough: Windows keeps whole ranges of ports reserved
 * for its own services, and a `listen` on one of those fails with `EACCES`,
 * which reads as "dsh web exited with code 1" instead of the test's own result.
 */
export async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const port = 20_000 + Math.floor(Math.random() * 30_000)
    if (await canBind(port)) return port
  }
  throw new Error('no bindable port found in 20000..50000 after 40 tries')
}

/** Whether this process can listen on one port right now (and can let it go again). */
async function canBind(port: number): Promise<boolean> {
  return await new Promise<boolean>((settle) => {
    const probe = createServer()
    probe.once('error', () => { settle(false) })
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => { settle(true) })
    })
  })
}

/**
 * Start `dsh web` with a private home and wait until it prints its URL.
 *
 * @param dsh - the resolved CLI.
 * @param home - the throwaway `DSH_HOME` (all user data lands under it).
 * @param workspace - the host's working directory (the session's workspace root).
 * @param logFile - where the child's stdout+stderr go.
 * @param options - extra CLI arguments (`--patch`), the fixture locale, and extra env.
 */
export async function startHost(
  dsh: DshCommand,
  home: string,
  workspace: string,
  logFile: string,
  options: { extraArgs?: readonly string[]; locale?: string; env?: Record<string, string> } = {},
): Promise<Host> {
  const port = await freePort()
  const fd = openSync(logFile, 'a')
  const proc = spawn(
    dsh.cmd,
    [...dsh.prefix, 'web', ...(options.extraArgs ?? []), '--host', '127.0.0.1', '--port', String(port), '--no-open'],
    {
      cwd: workspace,
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_E2E_WORKSPACE: workspace,
        ...(options.locale === undefined ? {} : { DSH_E2E_LOCALE: options.locale }),
        ...(options.env ?? {}),
      },
      stdio: ['ignore', fd, fd],
      windowsHide: true,
    },
  )
  const pattern = new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=\\S+`)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`dsh web exited with code ${proc.exitCode}:\n${tail(logFile)}`)
    const text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    const match = pattern.exec(text)
    if (match !== null) return { proc, url: match[0], port, logFile }
    await sleep(400)
  }
  await stopHost(proc)
  throw new Error(`dsh web never printed a URL within 120s:\n${tail(logFile)}`)
}

/** The last few lines of a log, for an error message that says what actually happened. */
export function tail(file: string): string {
  if (!existsSync(file)) return '(no log)'
  return readFileSync(file, 'utf8').split('\n').slice(-30).join('\n')
}

/**
 * Wait for a fixture plugin to announce itself in the host log.
 *
 * @param logFile - the host's stdout+stderr file.
 * @param marker - the literal prefix to look for.
 * @param timeoutMs - how long the fixture gets to run.
 * @returns the text after the marker, on the matching line.
 */
export async function waitForLogMarker(logFile: string, marker: string, timeoutMs = 90_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const text = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
    const line = text.split('\n').find(entry => entry.includes(marker))
    if (line !== undefined) return line.slice(line.indexOf(marker) + marker.length).trim()
    if (Date.now() >= deadline) throw new Error(`the host log never carried ${marker}:\n${tail(logFile)}`)
    await sleep(200)
  }
}

/**
 * End exactly one host process — the one this file started.
 *
 * @param proc - the child this harness spawned.
 */
export async function stopHost(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return
  const exited = new Promise<void>(settle => proc.once('exit', () => settle()))
  proc.kill()
  const settled = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)])
  if (settled || proc.pid === undefined) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolveKill) => {
      const killer = spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.once('exit', () => resolveKill())
      killer.once('error', () => resolveKill())
    })
    await Promise.race([exited, sleep(3000)])
  }
}

/** A prepared throwaway home plus the workspace the sessions live in. */
export interface Fixture {
  home: string
  workspace: string
  logFile: string
  /** Remove the whole temporary home. */
  cleanup(): void
}

/**
 * Create the temporary home/workspace pair this suite owns.
 *
 * The settings pin an English UI (the panel's own labels are what the tests
 * click on), and the credentials placeholder keeps the first-run "add an API
 * key" modal — which would sit over every later click — from opening.
 *
 * @param tag - a short label for the temp directory name.
 * @param locale - the UI language preference to pin.
 * @returns the fixture.
 */
export function makeFixture(tag: string, locale: 'en' | 'zh' = 'en'): Fixture {
  const home = join(tmpdir(), `dsh-unreal-e2e-${tag}-${randomUUID().slice(0, 8)}`)
  const workspace = join(home, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(join(home, 'settings.yaml'), `locale:\n  preference: ${locale}\n`)
  writeFileSync(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: sk-e2e-placeholder-not-a-real-key\n')
  return {
    home,
    workspace,
    logFile: join(home, 'host.log'),
    cleanup: () => { rmSync(home, { recursive: true, force: true }) },
  }
}

/**
 * First boot on a fresh `DSH_HOME`, then make this plugin part of that profile.
 *
 * `dsh web` creates `<home>/profiles/web` on its first run with only the base
 * bundles, so the plugin is added to it exactly the way a user's profile
 * carries it: an entry in `dsh.profile.bundles` plus a
 * `node_modules/dsh-unreal` junction back to this checkout. The workspace
 * registry is seeded too, so the GUI has a workspace to open a session in
 * without a native directory picker (which no browser can drive).
 *
 * @returns the workspace id written into the registry.
 */
export async function bootstrapHome(dsh: DshCommand, fixture: Fixture): Promise<string> {
  const first = await startHost(dsh, fixture.home, fixture.workspace, fixture.logFile)
  await stopHost(first.proc)

  const profile = join(fixture.home, 'profiles', 'web')
  if (!existsSync(join(profile, 'package.json'))) {
    throw new Error(`dsh web did not create a profile at ${profile}:\n${tail(fixture.logFile)}`)
  }
  const packageFile = join(profile, 'package.json')
  const manifest = JSON.parse(readFileSync(packageFile, 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
  if (!manifest.dsh.profile.bundles.includes(PACKAGE_NAME)) manifest.dsh.profile.bundles.push(PACKAGE_NAME)
  manifest.dependencies[PACKAGE_NAME] = `file:${repoRoot}`
  writeFileSync(packageFile, `${JSON.stringify(manifest, null, 2)}\n`)

  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  const link = join(profile, 'node_modules', PACKAGE_NAME)
  if (!existsSync(link)) symlinkSync(repoRoot, link, 'junction')

  const workspaceId = randomUUID()
  const registryFile = join(fixture.home, 'storages', 'workspace.json')
  const registry = JSON.parse(readFileSync(registryFile, 'utf8')) as {
    global: { workspaceIds: string[] }
    tables: { workspaces: Record<string, unknown> }
  }
  registry.global.workspaceIds = [workspaceId]
  registry.tables.workspaces = {
    [workspaceId]: {
      path: fixture.workspace,
      title: basename(fixture.workspace),
      sessionIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  }
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`)
  return workspaceId
}

/** Remember one session as the workspace's own (what a real open/close would have written). */
export function claimSession(fixture: Fixture, workspaceId: string, sessionId: string): void {
  const registryFile = join(fixture.home, 'storages', 'workspace.json')
  const registry = JSON.parse(readFileSync(registryFile, 'utf8')) as {
    tables: { workspaces: Record<string, { sessionIds: string[] }> }
  }
  const workspace = registry.tables.workspaces[workspaceId]
  if (workspace === undefined) throw new Error(`workspace ${workspaceId} left the registry`)
  if (!workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId)
  writeFileSync(registryFile, `${JSON.stringify(registry, null, 2)}\n`)
}

/**
 * The files the plugin's durable history wrote under `<home>/storages/dsh_unreal`.
 *
 * @param home - the throwaway `DSH_HOME`.
 * @returns the operation record files, or an empty list when none exist.
 */
export function historyFiles(home: string): string[] {
  const dir = join(home, 'storages', 'dsh_unreal', 'operations')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(name => name.endsWith('.json'))
}

/**
 * The full session tree under `<home>/sessions`, for diagnostics.
 *
 * @param home - the throwaway `DSH_HOME`.
 * @returns a one-line description of what the host wrote.
 */
export function describeHome(home: string): string {
  const parts: string[] = []
  const sessions = join(home, 'sessions')
  if (!existsSync(sessions)) parts.push('sessions: (missing)')
  else {
    const listed: string[] = []
    for (const bucket of readdirSync(sessions)) {
      const ids = readdirSync(join(sessions, bucket)).slice(0, 6).map((id) => {
        const dir = join(sessions, bucket, id)
        const log = readdirSync(dir).find(name => name.startsWith('session.'))
        return log === undefined ? `${id}(no log)` : `${id}(${log})`
      })
      listed.push(`${bucket}: ${ids.length === 0 ? '(empty)' : ids.join(', ')}`)
    }
    parts.push(`sessions: ${listed.join(' | ') || '(empty)'}`)
  }
  const storages = join(home, 'storages')
  parts.push(`storages: ${existsSync(storages) ? readdirSync(storages).join(', ') : '(missing)'}`)
  return parts.join('\n')
}

/** The newest modification time under one directory, for a "did the host write" check. */
export function newestMtime(dir: string): number {
  if (!existsSync(dir)) return 0
  let newest = 0
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) newest = Math.max(newest, newestMtime(full))
    else newest = Math.max(newest, statSync(full).mtimeMs)
  }
  return newest
}

/**
 * Seed one history row in the shape a build **before typed Details** wrote: the
 * record has `params`/`result` but no `details`.
 *
 * Written straight to the plugin's per-record storage document
 * (`{version, record}` under `<home>/storages/dsh_unreal/operations/`), which is
 * exactly the format the domain layer validates on boot — so the browser run
 * proves the old-record fallback against a real load, not a mock.
 *
 * @param home - the throwaway `DSH_HOME`.
 * @param sessionId - the session the seeded row belongs to.
 */
export function seedLegacyHistory(home: string, sessionId: string): void {
  const dir = join(home, 'storages', 'dsh_unreal', 'operations')
  mkdirSync(dir, { recursive: true })
  const record = {
    // The `-legacy-e2e-1` suffix is the call id the spec addresses it by.
    id: 'seed-legacy-e2e-1',
    time: Date.now() - 3_600_000,
    sessionId,
    tool: 'unreal_get_property_value',
    ok: true,
    durationMs: 9,
    objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
    propertyPath: 'bHidden',
    resultSummary: 'true',
    params: {
      objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      propertyPath: 'bHidden',
    },
    result: {
      objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      propertyPath: 'bHidden',
      valueJson: '"true"',
      value: true,
    },
  }
  // `{ version, record }` is the per-record document format of dsh-storage-json.
  // No `recordVersion`/`details`: exactly the shape a pre-Details build wrote.
  writeFileSync(join(dir, `${record.id}.json`), `${JSON.stringify({ version: 1, record }, null, 2)}\n`)
}
