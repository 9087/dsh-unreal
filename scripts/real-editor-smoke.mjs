#!/usr/bin/env node
/**
 * Optional real-editor smoke check: exercises the built adapter against a live
 * Unreal editor at 127.0.0.1:30010 (EditorAutomation + Remote Control enabled).
 *
 * Read-only: Ping, GetEnumInfo, GetClassInfo, GetPropertyType, and one
 * deliberately invalid GetEnumInfo to see the classified failure. Skips
 * quietly when nothing is listening, so it is safe to run anywhere.
 *
 * Usage (after `pnpm run build`):
 *   node scripts/real-editor-smoke.mjs
 *   set DSH_UNREAL_SMOKE_URL=http://127.0.0.1:30010   # non-default port
 */
import { EditorAutomationClient, assertKitResult } from '../lib/kit/client.js'

const baseUrl = process.env.DSH_UNREAL_SMOKE_URL ?? 'http://127.0.0.1:30010'
const client = new EditorAutomationClient({ baseUrl, requestTimeoutMs: 15_000 })

try {
  const pong = await client.ping()
  console.log(`Ping -> ${pong}`)

  const enums = assertKitResult('GetEnumInfo', await client.call('GetEnumInfo', {
    Type: 'enum(/Script/Engine.ECollisionEnabled)',
  }))
  console.log(`GetEnumInfo -> ${enums.Info?.Entries?.length ?? 0} entries; first = ${JSON.stringify(enums.Info?.Entries?.[0])}`)

  const classes = assertKitResult('GetClassInfo', await client.call('GetClassInfo', {
    Type: 'class(/Script/Engine.StaticMeshComponent)',
  }))
  console.log(`GetClassInfo -> ${classes.Info?.Properties?.length ?? 0} properties, ${classes.Info?.Functions?.length ?? 0} functions`)

  const type = assertKitResult('GetPropertyType', await client.call('GetPropertyType', {
    Type: 'class(/Script/Engine.SceneComponent)',
    PropertyPath: 'RelativeLocation',
  }))
  console.log(`GetPropertyType -> ${type.Type}`)

  // GetObjectClass is the entry point level-instance typing depends on. A CDO
  // path proves the route + shape; a level instance needs a live map object.
  const objectClass = assertKitResult('GetObjectClass', await client.call('GetObjectClass', {
    ObjectPath: '/Script/Engine.Default__StaticMeshComponent',
  }))
  console.log(`GetObjectClass(CDO) -> ${objectClass.ClassType}`)

  // The failure shape a missing object answers with (ObjectNotFound = 2), which
  // is what the adapter maps to `editorkit/object-not-found`.
  const objectClassFailure = await client.call('GetObjectClass', { ObjectPath: '/Game/NoSuch.NoSuch' })
  console.log(`GetObjectClass(invalid) -> ${JSON.stringify(objectClassFailure)}`)

  const failure = await client.call('GetEnumInfo', { Type: 'enum(/Script/Engine.NoSuchEnum)' })
  console.log(`GetEnumInfo(invalid) -> ${JSON.stringify(failure)}`)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('Could not reach the Remote Control API')) {
    console.log(`[smoke] no editor at ${baseUrl}; skipping`)
    process.exit(0)
  }
  console.error(`[smoke] FAILED: ${message}`)
  process.exit(1)
}
