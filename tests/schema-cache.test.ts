/**
 * Unit tests for the reflection schema cache: TTL, single-flight dedupe,
 * bounded size, failure handling and explicit invalidation.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { SchemaCache } from '../src/schema-cache.ts'

/** A controllable clock. */
function clock(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = start
  return {
    now: () => current,
    advance: (ms: number) => { current += ms },
  }
}

/** A deferred promise, so a test can decide when a load settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('SchemaCache', () => {
  it('serves a stored value from cache until its TTL expires', async () => {
    const time = clock()
    const cache = new SchemaCache({ ttlMs: 1_000, maxEntries: 10, now: time.now })
    let loads = 0

    const first = await cache.getOrLoad('k', async () => { loads += 1; return 'v1' })
    assert.equal(first.cached, false)
    assert.equal(first.source, 'fetched')

    const second = await cache.getOrLoad('k', async () => { loads += 1; return 'v2' })
    assert.equal(loads, 1)
    assert.equal(second.value, 'v1')
    assert.equal(second.cached, true)
    assert.equal(second.source, 'hit')
    assert.equal(second.ageMs, 0)

    time.advance(999)
    const stillFresh = await cache.getOrLoad('k', async () => { loads += 1; return 'v3' })
    assert.equal(stillFresh.value, 'v1')
    assert.equal(stillFresh.ageMs, 999)
    assert.equal(loads, 1)

    time.advance(1)
    const expired = await cache.getOrLoad('k', async () => { loads += 1; return 'v4' })
    assert.equal(loads, 2)
    assert.equal(expired.value, 'v4')
    assert.equal(expired.cached, false)
  })

  it('never expires an entry when ttlMs is 0', async () => {
    const time = clock()
    const cache = new SchemaCache({ ttlMs: 0, maxEntries: 10, now: time.now })
    let loads = 0
    await cache.getOrLoad('k', async () => { loads += 1; return 1 })
    time.advance(10_000_000)
    const lookup = await cache.getOrLoad('k', async () => { loads += 1; return 2 })
    assert.equal(lookup.value, 1)
    assert.equal(lookup.cached, true)
    assert.equal(loads, 1)
  })

  it('dedupes concurrent misses into one load (single flight)', async () => {
    const cache = new SchemaCache({ ttlMs: 60_000, maxEntries: 10, now: () => 1 })
    const gate = deferred<string>()
    let loads = 0
    const load = (): Promise<string> => { loads += 1; return gate.promise }

    const a = cache.getOrLoad('k', load)
    const b = cache.getOrLoad('k', load)
    gate.resolve('shared')

    const [first, second] = await Promise.all([a, b])
    assert.equal(loads, 1)
    assert.deepEqual([first.source, second.source].sort(), ['fetched', 'single-flight'])
    assert.equal(first.value, 'shared')
    assert.equal(second.value, 'shared')

    // The shared load's value is in the cache afterwards.
    const third = await cache.getOrLoad('k', load)
    assert.equal(third.source, 'hit')
    assert.equal(loads, 1)
    assert.equal(cache.stats().shared, 1)
  })

  it('does not cache a failed load', async () => {
    const cache = new SchemaCache({ ttlMs: 60_000, maxEntries: 10, now: () => 1 })
    let loads = 0
    await assert.rejects(
      cache.getOrLoad('k', async () => {
        loads += 1
        throw new Error('editor gone')
      }),
      /editor gone/,
    )
    assert.equal(cache.size, 0)

    const retried = await cache.getOrLoad('k', async () => { loads += 1; return 'ok' })
    assert.equal(loads, 2)
    assert.equal(retried.value, 'ok')
    assert.equal(cache.size, 1)
  })

  it('evicts the oldest entry past maxEntries', async () => {
    const time = clock()
    const cache = new SchemaCache({ ttlMs: 60_000, maxEntries: 2, now: time.now })
    await cache.getOrLoad('a', async () => 'A')
    time.advance(1)
    await cache.getOrLoad('b', async () => 'B')
    time.advance(1)
    await cache.getOrLoad('c', async () => 'C')

    assert.equal(cache.size, 2)
    assert.equal(cache.get('a'), undefined)
    assert.equal(cache.get('b')?.value, 'B')
    assert.equal(cache.get('c')?.value, 'C')
    assert.equal(cache.stats().evictions, 1)
  })

  it('clear drops entries and prevents an in-flight load from repopulating the cache', async () => {
    const cache = new SchemaCache({ ttlMs: 60_000, maxEntries: 10, now: () => 1 })
    const gate = deferred<string>()
    const inFlight = cache.getOrLoad('k', () => gate.promise)
    assert.equal(cache.clear(), 0)
    gate.resolve('stale')
    const lookup = await inFlight
    // The caller still gets its value, but the cleared generation is not stored.
    assert.equal(lookup.value, 'stale')
    assert.equal(cache.size, 0)
    assert.equal(cache.stats().clears, 1)
  })

  it('reports hit/miss/share/store counters', async () => {
    const cache = new SchemaCache({ ttlMs: 60_000, maxEntries: 10, now: () => 1 })
    await cache.getOrLoad('a', async () => 1)
    await cache.getOrLoad('a', async () => 1)
    const gate = deferred<number>()
    const miss = cache.getOrLoad('b', () => gate.promise)
    const shared = cache.getOrLoad('b', () => gate.promise)
    gate.resolve(2)
    await Promise.all([miss, shared])

    assert.deepEqual(cache.stats(), {
      hits: 1,
      misses: 2,
      shared: 1,
      stores: 2,
      evictions: 0,
      clears: 0,
      entries: 2,
    })
  })
})
