/**
 * Tests for the short-lived editor-identity cache behind the snapshot poll:
 * successful answers are shared for the TTL, a restarted editor's new PID shows
 * up after it, failures are remembered briefly and never throw, and concurrent
 * reads share one lookup.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { EditorInfoCache } from '../src/editor-info-cache.ts'
import type { EditorInfoView, ReflectionService } from '../src/kit/reflection.ts'

/** The identity every test starts from. */
const INFO: EditorInfoView = {
  processId: 76644,
  engineVersion: '5.5.0-0+UE5',
  projectName: 'Game',
  projectDir: 'C:\\PROJECTS\\UnrealEngine\\Game',
  isEditor: true,
}

/**
 * A reflection source answering a scripted sequence of results, counting calls.
 *
 * @param sequence - results (or thrown errors) in call order.
 * @param calls - receives one entry per call.
 * @returns the structural source the cache consumes.
 */
function source(
  sequence: (EditorInfoView | Error)[],
  calls: number[] = [],
): Pick<ReflectionService, 'getEditorInfo'> {
  return {
    async getEditorInfo(_signal?: AbortSignal): Promise<EditorInfoView> {
      calls.push(calls.length + 1)
      const next = sequence.shift()
      if (next === undefined) throw new Error('unscripted GetEditorInfo call')
      if (next instanceof Error) throw next
      return next
    },
  }
}

describe('EditorInfoCache', () => {
  it('serves a second resolve inside the TTL without a second round trip', async () => {
    const calls: number[] = []
    let clock = 1_000
    const cache = new EditorInfoCache({
      source: source([INFO], calls),
      ttlMs: 10_000,
      now: () => clock,
    })

    assert.deepEqual(await cache.resolve(), INFO)
    clock += 5_000
    assert.deepEqual(await cache.resolve(), INFO)
    assert.equal(calls.length, 1)
  })

  it('refreshes after the TTL, so a restarted editor reports its new PID', async () => {
    const calls: number[] = []
    let clock = 1_000
    const restarted = { ...INFO, processId: 76645 }
    const cache = new EditorInfoCache({
      source: source([INFO, restarted], calls),
      ttlMs: 10_000,
      now: () => clock,
    })

    assert.equal((await cache.resolve())?.processId, 76644)
    clock += 10_001
    assert.equal((await cache.resolve())?.processId, 76645)
    assert.equal(calls.length, 2)
  })

  it('remembers a failure for the shorter window and resolves undefined instead of throwing', async () => {
    const calls: number[] = []
    let clock = 1_000
    const cache = new EditorInfoCache({
      source: source([new Error('unreachable'), INFO], calls),
      ttlMs: 10_000,
      failureTtlMs: 4_000,
      now: () => clock,
    })

    assert.equal(await cache.resolve(), undefined)
    clock += 2_000
    assert.equal(await cache.resolve(), undefined)
    assert.equal(calls.length, 1)
    clock += 4_001
    assert.deepEqual(await cache.resolve(), INFO)
    assert.equal(calls.length, 2)
  })

  it('shares one in-flight lookup between concurrent resolves', async () => {
    const calls: number[] = []
    let settle: ((info: EditorInfoView) => void) | undefined
    const pending = new Promise<EditorInfoView>((resolve) => { settle = resolve })
    const cache = new EditorInfoCache({
      source: {
        getEditorInfo: () => {
          calls.push(calls.length + 1)
          return pending
        },
      },
      ttlMs: 10_000,
    })

    const first = cache.resolve()
    const second = cache.resolve()
    assert.equal(calls.length, 1)
    settle?.(INFO)
    const [a, b] = await Promise.all([first, second])
    assert.deepEqual(a, INFO)
    assert.deepEqual(b, INFO)
  })

  it('gives up on a slow lookup at its own timeout and reports no identity', async () => {
    const cache = new EditorInfoCache({
      source: {
        getEditorInfo: (signal?: AbortSignal) => new Promise<EditorInfoView>((_resolve, reject) => {
          signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
        }),
      },
      timeoutMs: 20,
    })

    assert.equal(await cache.resolve(), undefined)
  })
})
