/**
 * Client-side cache of reflected function signatures, fetched on demand.
 *
 * Records written before the host built default Details only carry the RC
 * parameters/out parameters text. When such a card is shown, the panel asks the
 * host for that function's signature once and renders Inputs/Outputs with the
 * Engine's names, Types and display names. One entry per object path + function,
 * one in-flight request per key.
 *
 * @module dsh-unreal/client/signature-cache
 */

import type { RpcCaller, SignatureView } from './wire.ts'
import { fetchSignature } from './wire.ts'

/** Key → signature, for the current page. Failures are not cached. */
const cache = new Map<string, SignatureView>()

/** Key → in-flight request, so several cards cost one RPC. */
const pending = new Map<string, Promise<SignatureView | undefined>>()

/** Cache key for one function. */
function signatureKey(objectPath: string, functionName: string): string {
  return `${objectPath}\u0000${functionName}`
}

/**
 * Ensure one function's signature is loaded, sharing an in-flight request.
 *
 * @param caller - the host rpc caller.
 * @param objectPath - the object whose class owns the function.
 * @param functionName - the UFunction name.
 * @param signal - caller cancellation.
 * @returns the signature, or `undefined` when the host cannot resolve it.
 */
export async function ensureSignature(
  caller: RpcCaller,
  objectPath: string,
  functionName: string,
  signal: AbortSignal,
): Promise<SignatureView | undefined> {
  const key = signatureKey(objectPath, functionName)
  const known = cache.get(key)
  if (known !== undefined) return known
  const inFlight = pending.get(key)
  if (inFlight !== undefined) return await inFlight
  const request = (async (): Promise<SignatureView | undefined> => {
    const signature = await fetchSignature(caller, objectPath, functionName, signal)
    if (signature !== undefined) cache.set(key, signature)
    return signature
  })()
  pending.set(key, request)
  try {
    return await request
  } finally {
    pending.delete(key)
  }
}
