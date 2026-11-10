/**
 * The HTTP transport shared by Kiro sign-in, profile, catalog, and usage
 * requests: one JSON request under a deadline, every failure mapped to a typed
 * `LlmError`, and every response validated before use. Sign-in tokens and
 * bearer tokens travel in these requests, so redirects fail and no failure
 * message quotes a response body that is not a recognized JSON error.
 *
 * Adapted from omp-kiro-provider (https://github.com/HoangNguyen17193/omp-kiro-provider),
 * MIT License, Copyright (c) 2026 tino; the notice is in ../LICENSE.
 *
 * @module dsh-llm-kiro/http
 */

import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import {
  isContextWindowExceededError, isQuotaExceededError, LlmError, ProviderRequestId,
} from '@deepseek-ai/dsh-llm'
import type { LlmErrorOptions } from '@deepseek-ai/dsh-llm'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { KIRO_USER_AGENT } from './endpoints.ts'

/** Code of a request deadline's timeout reason; {@link requestJson} reports it as `TIMEOUT`. */
const REQUEST_TIMEOUT = 'KIRO_REQUEST_TIMEOUT'

/** A `fetch`-compatible transport. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

/**
 * The ambient facilities Kiro requests and sign-in depend on. Production uses
 * {@link systemRuntime}; a caller that must not reach the network or wait on
 * the wall clock supplies its own.
 */
export interface KiroRuntime {
  /** Sends one HTTP request. */
  readonly fetch: FetchLike
  /**
   * Read the clock.
   * @returns the current time in epoch milliseconds.
   */
  now(): number
  /**
   * Wait without blocking the event loop.
   * @param ms - delay in milliseconds.
   * @param signal - cancels the wait.
   * @returns once the delay has elapsed.
   * @throws when `signal` aborts before the delay elapses.
   */
  sleep(ms: number, signal: AbortSignal): Promise<void>
}

/** The platform's `fetch`, clock, and timers; Node's `fetch` follows the process proxy policy. */
export const systemRuntime: KiroRuntime = {
  fetch: (url, init) => fetch(url, init),
  now: () => Date.now(),
  sleep: (ms, signal) => delay(ms, undefined, { signal }),
}

/** Server-reported facts of an HTTP failure, with absent fields as `undefined`. */
export interface KiroErrorFacts {
  /** OAuth `error` code or AWS `__type` suffix, such as `invalid_grant`. */
  readonly errorCode: string | undefined
  /** Kiro `reason` code, such as `CONTENT_LENGTH_EXCEEDS_THRESHOLD`. */
  readonly reason: string | undefined
  /** The server's own message, without this package's label. */
  readonly detail: string | undefined
}

/**
 * A non-2xx answer from a Kiro or AWS endpoint. Its `code` is the canonical
 * provider-neutral class of the failure; the OAuth and AWS codes the sign-in
 * and refresh logic branches on are separate fields, never parsed from the message.
 */
export class KiroHttpError extends LlmError {
  /** HTTP status of the answer. */
  readonly status: number
  /** OAuth `error` code or AWS `__type` suffix, such as `invalid_grant`; absent when the body named none. */
  readonly errorCode: string | undefined
  /** Kiro `reason` code; absent when the body named none. */
  readonly reason: string | undefined
  /** The server's own message; absent when the body carried none. */
  readonly detail: string | undefined

  constructor(message: string, code: string, facts: KiroErrorFacts, options: LlmErrorOptions & { status: number }) {
    super(message, code, options)
    this.name = 'KiroHttpError'
    this.status = options.status
    this.errorCode = facts.errorCode
    this.reason = facts.reason
    this.detail = facts.detail
  }
}

// AWS and Kiro may send absent fields as `null`; nullish keeps the rest of the body usable.
const ErrorBody = z.looseObject({
  message: z.string().nullish(),
  Message: z.string().nullish(),
  reason: z.string().nullish(),
  error: z.string().nullish(),
  error_description: z.string().nullish(),
  __type: z.string().nullish(),
})

/** The recognized fields of an error body, or undefined when the text is not a JSON error object. */
function errorBody(text: string): z.infer<typeof ErrorBody> | undefined {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    // Not JSON: the caller describes such a body by its type and size.
    return undefined
  }
  const parsed = ErrorBody.safeParse(json)
  return parsed.success ? parsed.data : undefined
}

/** The canonical failure class of one HTTP answer. */
function classify(status: number, reason: string | undefined, detail: string): string {
  if (status === 401 || status === 403) return 'AUTH'
  if (status === 402 || isQuotaExceededError(detail)) return 'QUOTA'
  if (status === 429) return 'RATE_LIMIT'
  if (status === 413 || reason === 'CONTENT_LENGTH_EXCEEDS_THRESHOLD' || isContextWindowExceededError(detail)
    || /input is too long/iu.test(detail)) return 'CONTEXT_WINDOW_EXCEEDED'
  if (status === 400) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return `HTTP_${status}`
}

/** The delay a `Retry-After` header asks for, in milliseconds, when it names a positive one. */
function retryAfterMs(headers: Headers, now: number): number | undefined {
  const value = headers.get('retry-after')
  if (value === null) return undefined
  const delayMs = /^\d+(?:\.\d+)?$/u.test(value) ? Number(value) * 1000 : Date.parse(value) - now
  return Number.isFinite(delayMs) && delayMs > 0 ? delayMs : undefined
}

/**
 * Turn a non-2xx response into a {@link KiroHttpError}. The OAuth or AWS error
 * code and the server's message are part of the failure message; a body that is
 * not a recognized JSON error is described by its type and size and never
 * quoted, because an intermediary that echoes the request could otherwise copy
 * client secrets or tokens into a message.
 * @param response - the failed response; its body is consumed.
 * @param label - names the operation in the message, such as `Kiro token request`.
 * @param now - the clock reading `Retry-After` dates are measured against.
 * @returns the typed failure, classified by status and by the body's wording.
 */
export async function httpErrorFrom(response: Response, label: string, now: number = Date.now()): Promise<KiroHttpError> {
  // The status stays the primary fact when the body cannot be read.
  const text = await response.text().catch(() => '')
  const body = errorBody(text)
  const errorCode = body?.error ?? body?.__type?.split('#').pop()
  const detail = body?.message ?? body?.Message ?? body?.error_description ?? undefined
  const reason = body?.reason ?? undefined
  const parts = [`${label} failed: HTTP ${response.status}`]
  if (errorCode && errorCode !== detail) parts.push(detail ? `${errorCode}:` : errorCode)
  if (detail) parts.push(detail)
  else if (body === undefined && text !== '') {
    parts.push(`(non-JSON ${response.headers.get('content-type') ?? 'unknown'} body, ${text.length} bytes)`)
  }
  if (reason) parts.push(`(${reason})`)
  const requestId = response.headers.get('x-amzn-requestid')
  const retryAfter = retryAfterMs(response.headers, now)
  return new KiroHttpError(parts.join(' '), classify(response.status, reason, detail ?? ''), { errorCode, reason, detail }, {
    status: response.status,
    ...retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter },
    ...requestId ? { requestId: ProviderRequestId(requestId) } : {},
  })
}

/** One JSON request to a Kiro or AWS endpoint. */
export interface KiroRequest {
  /** HTTP method. */
  readonly method: 'GET' | 'POST'
  /** Absolute URL; the credential it carries goes to this origin only, because redirects fail. */
  readonly url: string
  /** Request headers, such as `authorization`; the Kiro `user-agent` is added and cannot be replaced. */
  readonly headers?: Readonly<Record<string, string>>
  /** JSON body, sent as `application/json`. */
  readonly body?: unknown
  /** Caller cancellation, fused with this request's own deadline. */
  readonly signal?: AbortSignal | undefined
  /** Deadline of the whole exchange, in milliseconds. */
  readonly timeoutMs: number
  /** Names the operation in failures, such as `Kiro model discovery`. */
  readonly label: string
}

/** Classify a failed `fetch` or body read: this request's deadline, the caller's cancellation, or the network. */
function transportFailure(request: KiroRequest, signal: AbortSignal, error: unknown): LlmError {
  const expired = timeoutOf(signal, REQUEST_TIMEOUT)
  if (expired !== undefined) {
    return new LlmError(`${request.label} timed out after ${expired.timeoutMs} ms`, 'TIMEOUT', { cause: error })
  }
  if (signal.aborted) return new LlmError(`${request.label} was cancelled`, 'ABORTED', { cause: error })
  return new LlmError(`${request.label} could not reach ${new URL(request.url).host}`, 'TRANSPORT', { cause: error })
}

/** The first distinct paths of a validation failure, without the offending values. */
function issuePaths(error: z.ZodError): string[] {
  return [...new Set(error.issues.map(issue => ['$', ...issue.path].map(String).join('.')))].slice(0, 3)
}

/**
 * Send one JSON request and validate the response body.
 * @param runtime - transport and clock.
 * @param request - the request, its deadline, and the label failures carry.
 * @param schema - validates the 2xx body; the value it returns is the result.
 * @returns the validated response body.
 * @throws {KiroHttpError} for a non-2xx answer, classified by status and wording.
 * @throws {LlmError} code `TIMEOUT` when the deadline elapses, `ABORTED` when the caller cancels,
 *   `TRANSPORT` for a network failure, and `INVALID_RESPONSE` when the body is not JSON or fails `schema`.
 */
export async function requestJson<T>(runtime: KiroRuntime, request: KiroRequest, schema: z.ZodType<T>): Promise<T> {
  using limit = deadline(request.signal, request.timeoutMs, REQUEST_TIMEOUT)
  const init: RequestInit = {
    method: request.method,
    // The bearer token and the OIDC client secret must stay on the origin they were sent to.
    redirect: 'error',
    signal: limit.signal,
    headers: {
      accept: 'application/json',
      ...request.body === undefined ? {} : { 'content-type': 'application/json' },
      ...request.headers,
      'user-agent': KIRO_USER_AGENT,
    },
    ...request.body === undefined ? {} : { body: JSON.stringify(request.body) },
  }
  let response: Response
  try {
    response = await runtime.fetch(request.url, init)
  } catch (error) {
    throw transportFailure(request, limit.signal, error)
  }
  if (!response.ok) throw await httpErrorFrom(response, request.label, runtime.now())
  let text: string
  try {
    text = await response.text()
  } catch (error) {
    throw transportFailure(request, limit.signal, error)
  }
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (error) {
    throw new LlmError(`${request.label} did not answer with JSON`, 'INVALID_RESPONSE', { cause: error })
  }
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    throw new LlmError(`${request.label} returned an unexpected response (${issuePaths(parsed.error).join(', ')})`, 'INVALID_RESPONSE')
  }
  return parsed.data
}
