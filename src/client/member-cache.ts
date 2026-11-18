/**
 * Client-side cache of struct member schemas, fetched from the host on demand.
 *
 * A record carries only the shape its Details were built with; when the reader
 * expands a nested struct the panel asks the host for that Type's members once and
 * keeps the answer for the rest of the page. One entry per canonical Type, one
 * in-flight request per Type — the Details tree can ask for the same schema from
 * several expanded rows without producing duplicate RPCs.
 *
 * @module dsh-unreal/client/member-cache
 */

import type { DetailMemberTypeView, RpcCaller } from './wire.ts'
import { fetchMembers } from './wire.ts'

/** Type → members, for the current page. Empty is cached; failures are not. */
const cache = new Map<string, readonly DetailMemberTypeView[]>()

/** Type → in-flight request, so one expansion pattern costs one RPC. */
const pending = new Map<string, Promise<readonly DetailMemberTypeView[]>>()

/**
 * The members already known for one Type, without fetching.
 *
 * @param type - canonical Type string.
 * @returns the members, or `undefined` when the Type has not been fetched yet.
 */
export function cachedMembers(type: string): readonly DetailMemberTypeView[] | undefined {
  return cache.get(type)
}

/**
 * Ensure one Type's members are loaded, sharing an in-flight request.
 *
 * @param caller - the host rpc caller.
 * @param type - canonical Type string.
 * @param signal - caller cancellation.
 * @returns the members; empty when the host has none or the request failed.
 */
export async function ensureMembers(
  caller: RpcCaller,
  type: string,
  signal: AbortSignal,
): Promise<readonly DetailMemberTypeView[]> {
  const known = cache.get(type)
  if (known !== undefined) return known
  const inFlight = pending.get(type)
  if (inFlight !== undefined) return await inFlight
  const request = (async (): Promise<readonly DetailMemberTypeView[]> => {
    const members = await fetchMembers(caller, type, signal)
    if (members === undefined) return []
    cache.set(type, members)
    return members
  })()
  pending.set(type, request)
  try {
    return await request
  } finally {
    pending.delete(type)
  }
}
