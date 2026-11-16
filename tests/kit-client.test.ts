/**
 * Unit tests for the Remote Control transport and the EditorAutomation result check.
 *
 * The transport is the layer that owns the request shape, the passphrase and
 * the timeout, so it is tested against a fake `fetch` with no editor running.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  DEFAULT_BASE_URL,
  EditorAutomationClient,
  assertKitResult,
  hashPassphrase,
  normalizeBaseUrl,
} from '../src/kit/client.ts'
import type { FetchLike } from '../src/kit/client.ts'
import { KitError, classifyHttpFailure } from '../src/kit/errors.ts'
import { EDITOR_AUTOMATION_CDO, kitErrorCodeName, parameterDirectionName } from '../src/kit/types.ts'

/** One recorded `fetch` call. */
interface FetchCall {
  url: string
  init: RequestInit
}

/** A fake `fetch` that answers one response and records the call. */
function fakeFetch(response: { status?: number; body?: string } | ((url: string, init: RequestInit) => Promise<Response>)): {
  fetch: FetchLike
  calls: FetchCall[]
} {
  const calls: FetchCall[] = []
  if (typeof response === 'function') {
    return {
      calls,
      fetch: async (url, init) => {
        calls.push({ url, init })
        return await response(url, init)
      },
    }
  }
  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init })
      return new Response(response.body ?? '{}', { status: response.status ?? 200 })
    },
  }
}

/** Build a client over a fake transport. */
function client(fetchImpl: FetchLike, passphrase?: string): EditorAutomationClient {
  return new EditorAutomationClient(
    {
      baseUrl: 'http://127.0.0.1:30010',
      requestTimeoutMs: 5_000,
      ...(passphrase === undefined ? {} : { passphrase }),
    },
    fetchImpl,
  )
}

/** Await a promise expected to reject with a KitError, and return it. */
async function rejection(promise: Promise<unknown>): Promise<KitError> {
  try {
    await promise
  } catch (error: unknown) {
    assert.ok(error instanceof KitError, `expected a KitError, got ${String(error)}`)
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('normalizeBaseUrl', () => {
  it('accepts the four spellings seen in the wild', () => {
    assert.equal(normalizeBaseUrl('127.0.0.1:30010'), 'http://127.0.0.1:30010')
    assert.equal(normalizeBaseUrl('http://127.0.0.1:30010'), 'http://127.0.0.1:30010')
    assert.equal(normalizeBaseUrl('http://127.0.0.1:30010/'), 'http://127.0.0.1:30010')
    assert.equal(normalizeBaseUrl('  https://example.test:30010//  '), 'https://example.test:30010')
  })

  it('rejects an empty base URL with rc/bad-request', () => {
    assert.throws(() => normalizeBaseUrl('   '), (error: unknown) => {
      assert.ok(error instanceof KitError)
      assert.equal(error.code, 'rc/bad-request')
      return true
    })
    assert.equal(DEFAULT_BASE_URL, 'http://127.0.0.1:30010')
  })
})

describe('EditorAutomationClient.call', () => {
  it('PUTs the EditorAutomation CDO call and unwraps ReturnValue', async () => {
    const { fetch, calls } = fakeFetch({ body: '{"ReturnValue":"pong"}' })
    const kit = client(fetch)

    const returned = await kit.call('Ping', {}, undefined)

    assert.equal(returned, 'pong')
    assert.equal(calls.length, 1)
    const call = calls[0]!
    assert.equal(call.url, 'http://127.0.0.1:30010/remote/object/call')
    assert.equal(call.init.method, 'PUT')
    assert.deepEqual(JSON.parse(String(call.init.body)), {
      ObjectPath: EDITOR_AUTOMATION_CDO,
      FunctionName: 'Ping',
      Parameters: {},
    })
    assert.equal((call.init.headers as Record<string, string>)['Content-Type'], 'application/json')
  })

  it('passes function parameters through unchanged', async () => {
    const { fetch, calls } = fakeFetch({ body: '{"ReturnValue":{"ErrorCode":0}}' })
    const kit = client(fetch)

    await kit.call('GetFunctionInfo', { Type: 'class(/Script/Engine.Actor)', FunctionName: 'K2_GetActorLocation' })

    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)).Parameters, {
      Type: 'class(/Script/Engine.Actor)',
      FunctionName: 'K2_GetActorLocation',
    })
  })

  it('sends the MD5 of a configured passphrase in the Passphrase header', async () => {
    const { fetch, calls } = fakeFetch({ body: '{"ReturnValue":"pong"}' })
    await client(fetch, 'hunter2').ping()

    assert.equal(hashPassphrase('hunter2'), '2ab96390c7dbe3439de74d0c9b0b1767')
    assert.equal((calls[0]!.init.headers as Record<string, string>)['Passphrase'], '2ab96390c7dbe3439de74d0c9b0b1767')
  })

  it('omits the Passphrase header when none is configured', async () => {
    const { fetch, calls } = fakeFetch({ body: '{"ReturnValue":"pong"}' })
    await client(fetch).ping()

    assert.equal((calls[0]!.init.headers as Record<string, string>)['Passphrase'], undefined)
  })

  it('classifies a 401 as rc/unauthorized', async () => {
    const { fetch } = fakeFetch({ status: 401, body: '{"errorMessage":"bad passphrase"}' })
    const error = await rejection(client(fetch).ping())
    assert.equal(error.code, 'rc/unauthorized')
    assert.match(error.message, /bad passphrase/)
    assert.equal(error.status, 401)
    assert.ok(error.hint !== undefined)
  })

  it('classifies a 500 as rc/server-error', async () => {
    const { fetch } = fakeFetch({ status: 500, body: '{"errorMessage":"boom"}' })
    const error = await rejection(client(fetch).ping())
    assert.equal(error.code, 'rc/server-error')
    assert.match(error.message, /boom/)
  })

  it('classifies a 404 as rc/not-found with a route hint', async () => {
    const { fetch } = fakeFetch({ status: 404, body: '' })
    const error = await rejection(client(fetch).ping())
    assert.equal(error.code, 'rc/not-found')
    assert.match(error.hint ?? '', /Remote Control/)
  })

  it('rejects a non-JSON body as rc/bad-response', async () => {
    const { fetch } = fakeFetch({ body: 'not json at all' })
    const error = await rejection(client(fetch).ping())
    assert.equal(error.code, 'rc/bad-response')
    assert.match(error.message, /Ping/)
  })

  it('rejects a reply without ReturnValue as rc/bad-response', async () => {
    const { fetch } = fakeFetch({ body: '{"Other":1}' })
    const error = await rejection(client(fetch).call('GetPropertyValue', {}))
    assert.equal(error.code, 'rc/bad-response')
    assert.match(error.message, /ReturnValue/)
    assert.equal(error.functionName, 'GetPropertyValue')
  })

  it('rejects Ping answering something other than a string as rc/bad-response', async () => {
    const { fetch } = fakeFetch({ body: '{"ReturnValue":{"NotPong":true}}' })
    const error = await rejection(client(fetch).ping())
    assert.equal(error.code, 'rc/bad-response')
  })

  it('classifies a transport failure as rc/unreachable with the editor hint', async () => {
    const { fetch } = fakeFetch(async () => {
      throw new TypeError('fetch failed')
    })
    const error = await rejection(client(fetch).ping())
    assert.equal(error.code, 'rc/unreachable')
    assert.match(error.hint ?? '', /Unreal editor/)
  })

  it('classifies an expired request budget as rc/timeout', async () => {
    const { fetch } = fakeFetch(async (_url, init) => {
      // Never answer; settle only when the timeout aborts the request.
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }, { once: true })
      })
    })
    const kit = new EditorAutomationClient(
      { baseUrl: '127.0.0.1:30010', requestTimeoutMs: 20 },
      fetch,
    )
    const error = await rejection(kit.ping())
    assert.equal(error.code, 'rc/timeout')
    assert.match(error.message, /exceeded 20ms/)
  })

  it('classifies a caller cancellation as rc/cancelled', async () => {
    const controller = new AbortController()
    const { fetch } = fakeFetch(async (_url, init) => {
      return await new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }, { once: true })
        controller.abort()
      })
    })
    const error = await rejection(client(fetch).ping(controller.signal))
    assert.equal(error.code, 'rc/cancelled')
  })

  it('does not send a request for an already-cancelled call', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetch, calls } = fakeFetch({ body: '{"ReturnValue":"pong"}' })
    const error = await rejection(client(fetch).ping(controller.signal))
    assert.equal(error.code, 'rc/cancelled')
    assert.equal(calls.length, 0)
  })
})

describe('classifyHttpFailure', () => {
  it('names the status class in the code', () => {
    assert.equal(classifyHttpFailure(400, '', '/x').code, 'rc/bad-request')
    assert.equal(classifyHttpFailure(403, '', '/x').code, 'rc/forbidden')
    assert.equal(classifyHttpFailure(418, '', '/x').code, 'rc/http-418')
  })
})

describe('assertKitResult', () => {
  it('returns a result whose ErrorCode is 0 or absent', () => {
    assert.deepEqual(assertKitResult('GetEnumInfo', { ErrorCode: 0, Info: {} }), { ErrorCode: 0, Info: {} })
    assert.deepEqual(assertKitResult('GetEnumInfo', {}), {})
  })

  it('maps ErrorCode 3 of GetEnumInfo to editorautomation/enum-not-found', async () => {
    const error = await rejection(Promise.resolve().then(() =>
      assertKitResult('GetEnumInfo', { ErrorCode: 3, ErrorMessage: 'No enum.', Hint: 'Pass an enum Type.' })))
    assert.equal(error.code, 'editorautomation/enum-not-found')
    assert.equal(error.functionName, 'GetEnumInfo')
    assert.match(error.message, /ErrorCode 3 \(enum-not-found\): No enum\./)
    assert.equal(error.hint, 'Pass an enum Type.')
  })

  it('uses the per-function code table, so code 3 differs by function', async () => {
    const classInfo = await rejection(Promise.resolve().then(() =>
      assertKitResult('GetClassInfo', { ErrorCode: 3 })))
    assert.equal(classInfo.code, 'editorautomation/class-not-found')
    const callFunction = await rejection(Promise.resolve().then(() =>
      assertKitResult('CallFunction', { ErrorCode: 7 })))
    assert.equal(callFunction.code, 'editorautomation/call-failed')
  })

  it('rejects a non-object ReturnValue as rc/bad-response', async () => {
    const error = await rejection(Promise.resolve().then(() => assertKitResult('GetEnumInfo', 'poison')))
    assert.equal(error.code, 'rc/bad-response')
  })
})

describe('code tables', () => {
  it('names parameter directions', () => {
    assert.equal(parameterDirectionName(0), 'input')
    assert.equal(parameterDirectionName(1), 'output')
    assert.equal(parameterDirectionName(2), 'input-output')
    assert.equal(parameterDirectionName(9), 'direction-9')
  })

  it('falls back to a numeric name for an unknown error code', () => {
    assert.equal(kitErrorCodeName('GetEnumInfo', 42), 'error-42')
    assert.equal(kitErrorCodeName('NotAFunction', 1), 'error-1')
  })
})
