/**
 * Durable-history tests over the REAL storage stack: the domain spec, the
 * per-record layout, schema validation on reload, session grouping, pruning and
 * the history channel's snapshot/ session-filter rules.
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'

import type { OperationRecord } from '../src/records.ts'
import { buildSnapshot } from '../src/rpc.ts'
import { UNREAL_DOMAIN_NAME, UnrealStore, boundSnapshot, storageKey } from '../src/store.ts'
import type { ResolvedConfig } from '../src/config.ts'
import { openStorage, removeStorage, seedRawRecord } from './helpers/storage.ts'
import type { StorageSession } from './helpers/storage.ts'

/** One call record with sensible defaults. */
function call(overrides: Partial<OperationRecord> & Pick<OperationRecord, 'id' | 'time'>): OperationRecord {
  const { id, time, ...rest } = overrides
  return {
    id,
    time,
    tool: 'unreal_ping',
    ok: true,
    durationMs: 5,
    resultSummary: 'pong',
    ...rest,
  }
}

/** A resolved config for the channel. */
function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    baseUrl: 'http://127.0.0.1:30010',
    requestTimeoutMs: 30_000,
    preflight: false,
    historyLimit: 100,
    maxRetainedOperations: 500,
    snapshotMaxChars: 4000,
    reflectionCacheTtlMs: 300_000,
    reflectionCacheMaxEntries: 512,
    detailsMaxChars: 12_000,
    enrichmentTimeoutMs: 2_000,
    passphrase: undefined,
    ...overrides,
  }
}

describe('storageKey', () => {
  it('keeps safe keys and escapes everything else injectively', () => {
    assert.equal(storageKey('1700000000-call-1'), '1700000000-call-1')
    assert.equal(storageKey('a/b'), 'a_2fb')
    assert.equal(storageKey('a_2fb'), 'a_5f2fb')
    assert.notEqual(storageKey('a/b'), storageKey('a_2fb'))
  })
})

describe('boundSnapshot', () => {
  it('keeps a small payload structurally', () => {
    assert.deepEqual(boundSnapshot({ X: '1' }, 100), { X: '1' })
  })

  it('degrades an oversized payload to a truncated string', () => {
    const bounded = boundSnapshot({ text: 'x'.repeat(500) }, 60)
    assert.equal(typeof bounded, 'string')
    assert.match(String(bounded), /truncated from \d+ chars/)
  })

  it('passes undefined through', () => {
    assert.equal(boundSnapshot(undefined, 10), undefined)
  })
})

describe('UnrealStore over the real storage stack', () => {
  let session: StorageSession
  let store: UnrealStore

  before(async () => {
    session = await openStorage()
    store = await session.openStore({ maxRetainedOperations: 5 })
  })

  after(async () => {
    await store.close()
    await session.close()
    removeStorage(session.root)
  })

  it('uses a domain name the backend accepts and a per-record layout', () => {
    assert.equal(UNREAL_DOMAIN_NAME, 'dsh_unreal')
    assert.match(UNREAL_DOMAIN_NAME, /^[a-z][a-z0-9_]*$/)
  })

  it('appends and reads records newest first', async () => {
    await store.recordOperation(call({ id: 'a', time: 100, sessionId: 's1', tool: 'unreal_ping' }))
    await store.recordOperation(call({ id: 'b', time: 300, sessionId: 's1', tool: 'unreal_get_class_info' }))
    await store.recordOperation(call({ id: 'c', time: 200, sessionId: 's1', tool: 'unreal_ping' }))

    const rows = store.operationsMatching({ sessionId: 's1' })
    assert.deepEqual(rows.map(row => row.id), ['b', 'c', 'a'])
    assert.equal(store.countMatching({ sessionId: 's1' }), 3)
  })

  it('groups records by session and filters strictly', async () => {
    await store.recordOperation(call({ id: 'other-1', time: 400, sessionId: 's2' }))
    await store.recordOperation(call({ id: 'other-2', time: 500, sessionId: 's2' }))
    await store.recordOperation(call({ id: 'legacy', time: 50 }))

    assert.deepEqual(store.operationsMatching({ sessionId: 's2' }).map(row => row.id), ['other-2', 'other-1'])
    assert.equal(store.countMatching({ sessionId: 's3' }), 0)

    const groups = store.sessionGroups()
    assert.deepEqual(groups.map(group => [group.sessionId, group.count]), [
      ['s2', 2],
      ['s1', 3],
      ['', 1],
    ])
    assert.equal(groups[0]!.lastTime, 500)
  })

  it('prunes the oldest records down to the cap', async () => {
    const removed = await store.prune()
    assert.equal(store.operationCount, 5)
    assert.ok(removed >= 1)
    // The newest record survived, the oldest did not.
    assert.equal(store.operationsMatching({}).at(-1)?.id === 'legacy', false)
    assert.ok(store.operationsMatching({}).some(row => row.id === 'other-2'))
  })
})

describe('history survives a restart (reload)', () => {
  it('reopens the same records from disk and re-validates them against the zod schema', async () => {
    const first = await openStorage()
    const store = await first.openStore()
    await store.recordOperation(call({
      id: 'persisted-1',
      time: 1_700_000_000_000,
      sessionId: 'session-a',
      tool: 'unreal_set_property_value',
      objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1',
      propertyPath: 'RelativeLocation.Z',
      params: { objectPath: '/Game/Maps/Demo.Demo:PersistentLevel.Cube_1', propertyPath: 'RelativeLocation.Z', valueJson: '"42.0"' },
      result: { oldValueJson: '"0.0"', newValueJson: '"42.0"', changed: true },
      details: {
        v: 1,
        sections: [{
          kind: 'change',
          before: { name: 'before', type: 'double', value: '0.0' },
          after: { name: 'after', type: 'double', value: '42.0' },
        }],
      },
      ok: false,
      errorCode: 'editorautomation/unsupported-property',
      errorMessage: 'Cannot serialize OverrideMaterials.',
    }))
    await store.close()
    await first.close()

    const second = await openStorage(first.root)
    try {
      const reopened = await second.openStore()
      const rows = reopened.operationsMatching({ sessionId: 'session-a' })
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.tool, 'unreal_set_property_value')
      assert.equal(rows[0]!.ok, false)
      assert.equal(rows[0]!.errorCode, 'editorautomation/unsupported-property')
      assert.equal(rows[0]!.propertyPath, 'RelativeLocation.Z')
      // The typed Details are durable: they are stored with the record, so the
      // panel still renders a Details table after a host restart.
      assert.equal(rows[0]!.details?.sections[0]?.kind, 'change')
      assert.equal(rows[0]!.details?.sections[0]?.after?.value, '42.0')
      assert.equal(reopened.sessionGroups()[0]!.sessionId, 'session-a')
      await reopened.close()
    } finally {
      await second.close()
      removeStorage(first.root)
    }
  })

  it('loads a record written directly by the backend (the e2e seeding path)', async () => {
    const first = await openStorage()
    const seeded = call({
      id: 'seed-1',
      time: 1_700_000_100_000,
      sessionId: 'seed-session',
      tool: 'unreal_get_enum_info',
      targetType: 'enum(/Script/Engine.ECollisionEnabled)',
      resultSummary: '5 entries',
    })
    await seedRawRecord(first.root, seeded)

    // A fresh stack over the same root is what a booting host does.
    const second = await openStorage(first.root)
    try {
      const store = await second.openStore()
      const rows = store.operationsMatching({ sessionId: 'seed-session' })
      assert.equal(rows.length, 1)
      assert.equal(rows[0]!.targetType, 'enum(/Script/Engine.ECollisionEnabled)')
      // A record written by a build before typed Details existed still loads;
      // the panel falls back to raw payloads for it.
      assert.equal(rows[0]!.details, undefined)
      await store.close()
    } finally {
      await second.close()
      await first.close()
      removeStorage(first.root)
    }
  })
})

describe('history channel snapshot', () => {
  let session: StorageSession
  let store: UnrealStore

  before(async () => {
    session = await openStorage()
    store = await session.openStore()
    await store.recordOperation(call({ id: 'current-1', time: 10, sessionId: 'current', tool: 'unreal_ping' }))
    await store.recordOperation(call({ id: 'current-2', time: 20, sessionId: 'current', tool: 'unreal_get_class_info', ok: false, errorCode: 'editorautomation/class-not-found', errorMessage: 'No class.' }))
    await store.recordOperation(call({ id: 'other-1', time: 30, sessionId: 'other' }))
  })

  after(async () => {
    await store.close()
    await session.close()
    removeStorage(session.root)
  })

  it('returns only the requested session, newest first', () => {
    const snapshot = buildSnapshot({ store, config: config(), now: () => 42 }, { sessionId: 'current' })
    assert.equal(snapshot.sessionId, 'current')
    assert.deepEqual(snapshot.operations.map(row => row.id), ['current-2', 'current-1'])
    assert.equal(snapshot.retained, 2)
    assert.equal(snapshot.totalRetained, 3)
    assert.deepEqual(snapshot.sessions.map(group => group.sessionId), ['other', 'current'])
    assert.equal(snapshot.baseUrl, 'http://127.0.0.1:30010')
    // Identity is enrichment: with no resolver supplied the reply still renders.
    assert.equal(snapshot.editor, null)
    assert.equal(snapshot.time, 42)
  })

  it('carries the editor identity the channel resolved', () => {
    const editor = {
      processId: 76644,
      engineVersion: '5.5.0-0+UE5',
      projectName: 'Game',
      projectDir: 'C:\\PROJECTS\\UnrealEngine\\Game',
      isEditor: true,
    }
    const snapshot = buildSnapshot({ store, config: config(), now: () => 5 }, { sessionId: 'current' }, editor)
    assert.deepEqual(snapshot.editor, editor)
    assert.equal(snapshot.time, 5)
  })

  it('returns NO operations when the client names no session', () => {
    const snapshot = buildSnapshot({ store, config: config(), now: () => 42 }, {})
    assert.equal(snapshot.sessionId, null)
    assert.deepEqual(snapshot.operations, [])
    assert.equal(snapshot.retained, 0)
    // The grouping is still reported, so the panel can say the history spans sessions.
    assert.equal(snapshot.sessions.length, 2)
  })

  it('bounds the row count with the request limit', () => {
    const snapshot = buildSnapshot({ store, config: config(), now: () => 1 }, { sessionId: 'current', limit: 1 })
    assert.equal(snapshot.operations.length, 1)
    assert.equal(snapshot.operations[0]!.id, 'current-2')
    assert.equal(snapshot.retained, 2)
  })

  it('ignores an unreadable payload instead of throwing', () => {
    const snapshot = buildSnapshot({ store, config: config(), now: () => 1 }, null)
    assert.deepEqual(snapshot.operations, [])
    assert.equal(snapshot.sessionId, null)
  })
})
