/**
 * Test fixture: the REAL storage stack (hub → json backend → domain layer) on a
 * temporary directory, so the durable history is exercised exactly as it is in
 * a running host.
 *
 * A harness owns one context/backend/facility set. Reopening a fixture over the
 * same root simulates a host restart, which is how "survives reload" is tested
 * without a browser.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Context } from '@deepseek-ai/cordis'
import { Storage } from '@deepseek-ai/dsh-storage'
import { DomainFacility, descriptorOf } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'

import type { OperationRecord } from '../../src/records.ts'
import { UnrealStore, unrealDomain, storageKey } from '../../src/store.ts'
import type { StoreOptions } from '../../src/store.ts'

/** One open stack over a storage root. */
export interface StorageSession {
  /** The directory the json backend writes under (the host's `storages` dir). */
  readonly root: string
  /** Open the plugin's history store over this stack. */
  openStore(options?: Partial<StoreOptions>): Promise<UnrealStore>
  /** Close the backend and release the context. */
  close(): Promise<void>
}

/**
 * Create one stack over `root` (a fresh temp dir when omitted).
 *
 * @param root - an existing storage root, for a restart simulation.
 * @returns the open stack.
 */
export async function openStorage(root?: string): Promise<StorageSession> {
  const directory = root ?? mkdtempSync(join(tmpdir(), 'dsh-unreal-test-'))
  const ctx = new Context()
  const hub = new Storage(ctx)
  const backend = new JsonStorageBackend(directory)
  hub.backend.register('json', backend)
  const facility = new DomainFacility(ctx, { backend: 'json' })
  return {
    root: directory,
    async openStore(options: Partial<StoreOptions> = {}) {
      return await UnrealStore.open(facility, { maxRetainedOperations: 500, ...options })
    },
    async close() {
      await backend.close()
    },
  }
}

/**
 * Write one record the way the backend stores it, WITHOUT going through the
 * plugin — this is the e2e seeding path, and it must round-trip through the
 * real domain layer's zod validation.
 *
 * @param root - the storage root.
 * @param record - the record to persist.
 */
export async function seedRawRecord(root: string, record: OperationRecord): Promise<void> {
  const backend = new JsonStorageBackend(root)
  try {
    const unit = await backend.kv.open(descriptorOf(unrealDomain))
    try {
      await unit.putRecord('operations', storageKey(record.id), record)
    } finally {
      await unit.close()
    }
  } finally {
    await backend.close()
  }
}

/**
 * Remove one temporary storage root.
 *
 * @param root - the directory to remove.
 */
export function removeStorage(root: string): void {
  rmSync(root, { recursive: true, force: true })
}
