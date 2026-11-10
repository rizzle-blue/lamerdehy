/**
 * Doubles for Kiro HTTP exchanges: a recording `fetch`, a deterministic clock,
 * and canned responses. A test that uses them neither reaches the network nor
 * waits on the wall clock.
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { Config } from '../src/config.ts'
import type { KiroConfig } from '../src/config.ts'
import type { FetchLike, KiroRuntime } from '../src/http.ts'

/** The settings every test runs under unless it says otherwise. */
export const config: KiroConfig = Config({})

/** A profile in Kiro's EU region, which tells a profile's region apart from a credential's own. */
export const PROFILE_ARN = 'arn:aws:codewhisperer:eu-central-1:111111111111:profile/TESTPROFILE'

/** One request the code under test sent. */
export interface Call {
  readonly url: string
  readonly init: RequestInit
  readonly headers: Readonly<Record<string, string>>
  readonly body: unknown
}

/** Answers one request; `index` is its position among the requests sent so far. */
export type Handler = (call: Call, index: number) => Response | Promise<Response>

/**
 * A JSON response.
 * @param status - HTTP status.
 * @param body - value serialized as the body.
 * @param headers - extra response headers.
 * @returns the response.
 */
export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
}

/**
 * A `fetch` that records every request and answers from `handler`. Like a real
 * one, it fails when the request's signal aborts before the answer settles, so
 * a handler may return a promise that never settles to model a stalled server.
 * @param handler - answers each request.
 * @returns the transport and the requests it received, in order.
 */
export function recorder(handler: Handler): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = (url, init) => {
    const call: Call = {
      url,
      init,
      headers: init.headers as Record<string, string>,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    const answer = Promise.resolve(handler(call, calls.length - 1))
    const { promise: aborted, reject } = Promise.withResolvers<never>()
    const onAbort = (): void => { reject(new Error('aborted')) }
    if (init.signal?.aborted === true) onAbort()
    else init.signal?.addEventListener('abort', onAbort, { once: true })
    return Promise.race([answer, aborted])
  }
  return { fetch, calls }
}

/** A clock whose sleeps return at once, advance it, and are recorded. */
export interface Clock {
  /** Every delay slept, in order. */
  readonly sleeps: number[]
  readonly now: () => number
  readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * A deterministic clock.
 * @param start - the first reading, in epoch milliseconds.
 * @returns the clock; a sleep on an aborted signal rejects like the real one.
 */
export function clock(start = 1_000_000): Clock {
  let current = start
  const sleeps: number[] = []
  return {
    sleeps,
    now: () => current,
    sleep: (ms, signal) => {
      signal.throwIfAborted()
      sleeps.push(ms)
      current += ms
      return Promise.resolve()
    },
  }
}

/**
 * The runtime a test hands the code under test.
 * @param fetch - transport.
 * @param time - clock; a fresh one when omitted.
 * @returns the runtime.
 */
export function runtimeOf(fetch: FetchLike, time: Clock = clock()): KiroRuntime {
  return { fetch, now: time.now, sleep: time.sleep }
}

/**
 * The failure an operation rejects with.
 * @param operation - an operation expected to reject with an `LlmError`.
 * @returns the error; the test fails when the operation resolves or rejects with anything else.
 */
export async function failureOf(operation: Promise<unknown>): Promise<LlmError> {
  const outcome = await operation.then(() => undefined, (cause: unknown) => cause)
  if (!(outcome instanceof LlmError)) throw new Error('expected the operation to reject with an LlmError', { cause: outcome })
  return outcome
}

/**
 * The value a synchronous call throws.
 * @param run - the call.
 * @returns the thrown value, or undefined when the call returns.
 */
export function thrown(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  return undefined
}

/**
 * A transport that never answers and fails only when its signal aborts, like a stalled connection.
 * @returns the transport.
 */
export function hangingFetch(): FetchLike {
  return (_url, init) => {
    const { promise, reject } = Promise.withResolvers<Response>()
    const signal = init.signal
    if (signal?.aborted === true) reject(new Error('aborted'))
    else signal?.addEventListener('abort', () => { reject(new Error('aborted')) }, { once: true })
    return promise
  }
}
