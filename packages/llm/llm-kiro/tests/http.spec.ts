import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { Config } from '../src/config.ts'
import {
  apiRegionFor, isRegion, KIRO_USER_AGENT, managementBaseUrl, oidcBaseUrl, profileRegion, regionFromProfileArn, runtimeBaseUrl,
} from '../src/endpoints.ts'
import { httpErrorFrom, KiroHttpError, requestJson, systemRuntime } from '../src/http.ts'
import type { KiroRequest } from '../src/http.ts'
import { failureOf, hangingFetch, json, PROFILE_ARN, recorder, runtimeOf, thrown } from './wire.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Kiro configuration', () => {
  it('defaults every budget', () => {
    expect(Config({})).toMatchObject({
      requestTimeoutMs: 15_000,
      firstEventTimeoutMs: 180_000,
      idleTimeoutMs: 300_000,
      expiryMarginMs: 300_000,
    })
  })

  it('accepts a refresh margin of zero and rejects every budget outside its bounds', () => {
    expect(Config({ expiryMarginMs: 0 }).expiryMarginMs).toBe(0)
    expect(() => Config({ requestTimeoutMs: 0 })).toThrow()
    // A refresh holds the credential store's write lock for one request, so the budget stays under the store's wait.
    expect(() => Config({ requestTimeoutMs: 25_001 })).toThrow()
    expect(() => Config({ firstEventTimeoutMs: 0 })).toThrow()
    expect(() => Config({ idleTimeoutMs: MAX_TIMER_DELAY_MS + 1 })).toThrow()
    expect(() => Config({ expiryMarginMs: -1 })).toThrow()
  })
})

describe('Kiro endpoints', () => {
  it('maps an SSO region onto the Kiro API region that serves it', () => {
    expect(apiRegionFor('us-west-2')).toBe('us-east-1')
    expect(apiRegionFor('eu-north-1')).toBe('eu-central-1')
    // A region the table does not list serves itself, and inherited object keys are never mappings.
    expect(apiRegionFor('ap-south-2')).toBe('ap-south-2')
    expect(apiRegionFor('constructor')).toBe('constructor')
  })

  it('reads the region of a profile ARN and falls back when the ARN names none', () => {
    expect(regionFromProfileArn(PROFILE_ARN)).toBe('eu-central-1')
    expect(regionFromProfileArn('not-an-arn')).toBeUndefined()
    expect(regionFromProfileArn('arn:aws:codewhisperer:nowhere:1:profile/x')).toBeUndefined()
    expect(profileRegion(PROFILE_ARN, 'us-east-1')).toBe('eu-central-1')
    expect(profileRegion('not-an-arn', 'us-east-1')).toBe('us-east-1')
  })

  it('builds the hosts of a region and refuses text that is not one', () => {
    expect(isRegion('us-gov-west-1')).toBe(true)
    expect(isRegion('evil.example/x#')).toBe(false)
    expect(oidcBaseUrl('eu-west-1')).toBe('https://oidc.eu-west-1.amazonaws.com')
    expect(managementBaseUrl('us-east-1')).toBe('https://management.us-east-1.kiro.dev')
    expect(runtimeBaseUrl('eu-central-1')).toBe('https://runtime.eu-central-1.kiro.dev')
    for (const build of [oidcBaseUrl, managementBaseUrl, runtimeBaseUrl]) {
      expect(thrown(() => build('evil.example/x#'))).toMatchObject({ code: 'INVALID_REGION' })
    }
  })
})

describe('Kiro system runtime', () => {
  it('reads the wall clock', () => {
    const before = Date.now()
    const reading = systemRuntime.now()
    expect(reading).toBeGreaterThanOrEqual(before)
    expect(reading).toBeLessThanOrEqual(Date.now())
  })

  it('sends through the global fetch resolved at call time', async () => {
    const answer = new Response('ok')
    const stub = vi.fn(() => Promise.resolve(answer))
    vi.stubGlobal('fetch', stub)

    await expect(systemRuntime.fetch('https://example.test/a', { method: 'GET' })).resolves.toBe(answer)
    expect(stub).toHaveBeenCalledWith('https://example.test/a', { method: 'GET' })
  })

  it('waits out a delay and stops when its signal aborts', async () => {
    await systemRuntime.sleep(1, new AbortController().signal)

    const controller = new AbortController()
    const waiting = systemRuntime.sleep(60_000, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toThrow()
    await expect(systemRuntime.sleep(60_000, controller.signal)).rejects.toThrow()
  })
})

const Echo = z.looseObject({ ok: z.boolean() })

function request(overrides: Partial<KiroRequest> = {}): KiroRequest {
  return { method: 'GET', url: 'https://management.us-east-1.kiro.dev/Echo?profileArn=private', timeoutMs: 1000, label: 'Kiro test', ...overrides }
}

describe('requestJson', () => {
  it('sends the Kiro user-agent that a caller cannot replace, refuses redirects, and returns the validated body', async () => {
    const { fetch, calls } = recorder(() => json(200, { ok: true, extra: 1 }))

    await expect(requestJson(
      runtimeOf(fetch),
      request({ headers: { authorization: 'Bearer t', 'user-agent': 'custom' } }),
      Echo,
    )).resolves.toEqual({ ok: true, extra: 1 })

    const [call] = calls
    expect(call?.init.method).toBe('GET')
    expect(call?.init.redirect).toBe('error')
    expect(call?.init.body).toBeUndefined()
    expect(call?.headers).toEqual({ accept: 'application/json', authorization: 'Bearer t', 'user-agent': KIRO_USER_AGENT })
  })

  it('sends a JSON body with its content type', async () => {
    const { fetch, calls } = recorder(() => json(200, { ok: true }))

    await requestJson(runtimeOf(fetch), request({ method: 'POST', body: { a: 1 } }), Echo)

    expect(calls[0]?.headers['content-type']).toBe('application/json')
    expect(calls[0]?.body).toEqual({ a: 1 })
  })

  it('turns a non-2xx answer into a typed failure that carries the status', async () => {
    const error = await failureOf(requestJson(
      runtimeOf(() => Promise.resolve(json(403, { message: 'Invalid token' }))),
      request(),
      Echo,
    ))

    expect(error).toBeInstanceOf(KiroHttpError)
    expect(error.code).toBe('AUTH')
    expect(error.failure.status).toBe(403)
  })

  it('reports a network failure with its cause and without the request query', async () => {
    const cause = new TypeError('fetch failed')

    const error = await failureOf(requestJson(runtimeOf(() => Promise.reject(cause)), request(), Echo))

    expect(error.code).toBe('TRANSPORT')
    expect(error.cause).toBe(cause)
    expect(error.message).not.toContain('private')
  })

  it('reports a body that breaks off as a network failure', async () => {
    const broken = new Response(
      new ReadableStream({ start(controller) { controller.error(new Error('reset')) } }),
      { status: 200 },
    )

    const error = await failureOf(requestJson(runtimeOf(() => Promise.resolve(broken)), request(), Echo))

    expect(error.code).toBe('TRANSPORT')
  })

  it('reports an elapsed deadline as TIMEOUT and a caller cancellation as ABORTED', async () => {
    vi.useFakeTimers()
    const timedOut = failureOf(requestJson(runtimeOf(hangingFetch()), request({ timeoutMs: 50 }), Echo))
    await vi.advanceTimersByTimeAsync(50)
    expect((await timedOut).code).toBe('TIMEOUT')
    vi.useRealTimers()

    const controller = new AbortController()
    const cancelled = failureOf(requestJson(runtimeOf(hangingFetch()), request({ signal: controller.signal }), Echo))
    controller.abort()
    expect((await cancelled).code).toBe('ABORTED')
  })

  it('rejects a body that is not JSON or does not match its schema, without quoting it', async () => {
    const notJson = await failureOf(requestJson(
      runtimeOf(() => Promise.resolve(new Response('<html>secret-page</html>'))),
      request(),
      Echo,
    ))
    expect(notJson.code).toBe('INVALID_RESPONSE')
    expect(notJson.message).not.toContain('secret-page')

    const mismatch = await failureOf(requestJson(
      runtimeOf(() => Promise.resolve(json(200, { ok: 'secret-value' }))),
      request(),
      Echo,
    ))
    expect(mismatch.code).toBe('INVALID_RESPONSE')
    expect(mismatch.message).not.toContain('secret-value')
  })
})

const NOW = Date.parse('2026-01-01T00:00:00Z')

async function failure(status: number, body: BodyInit | null, headers: Record<string, string> = {}): Promise<KiroHttpError> {
  return httpErrorFrom(new Response(body, { status, headers }), 'Kiro test', NOW)
}

describe('httpErrorFrom', () => {
  const cases: [number, string, string][] = [
    [401, '{}', 'AUTH'],
    [403, '{}', 'AUTH'],
    [402, '{}', 'QUOTA'],
    [400, JSON.stringify({ message: 'Monthly usage limit reached' }), 'QUOTA'],
    [429, '{}', 'RATE_LIMIT'],
    [413, '{}', 'CONTEXT_WINDOW_EXCEEDED'],
    [400, JSON.stringify({ reason: 'CONTENT_LENGTH_EXCEEDS_THRESHOLD' }), 'CONTEXT_WINDOW_EXCEEDED'],
    [400, JSON.stringify({ message: 'Input is too long.' }), 'CONTEXT_WINDOW_EXCEEDED'],
    [400, JSON.stringify({ message: 'Improperly formed request.' }), 'INVALID_REQUEST'],
    [500, '{}', 'SERVER'],
    [503, '{}', 'SERVER'],
    [404, '{}', 'HTTP_404'],
  ]

  it.each(cases)('classifies HTTP %i with body %s as %s', async (status, body, code) => {
    expect((await failure(status, body)).code).toBe(code)
  })

  it('reads the OAuth or AWS error code, the server message, and the Kiro reason from the body', async () => {
    const oauth = await failure(400, JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid refresh token provided' }))
    expect(oauth).toMatchObject({ status: 400, errorCode: 'invalid_grant', detail: 'Invalid refresh token provided' })

    const aws = await failure(400, JSON.stringify({ __type: 'com.amazonaws.ssooidc#InvalidGrantException', Message: 'Invalid grant provided' }))
    expect(aws).toMatchObject({ errorCode: 'InvalidGrantException', detail: 'Invalid grant provided' })

    // AWS sends absent members as null.
    const nulled = await failure(400, JSON.stringify({ error: 'expired_token', error_description: null }))
    expect(nulled.errorCode).toBe('expired_token')
    expect(nulled.detail).toBeUndefined()

    const throttled = await failure(429, JSON.stringify({ message: 'Too many requests', reason: 'USER_REQUEST_RATE_EXCEEDED' }))
    expect(throttled).toMatchObject({ detail: 'Too many requests', reason: 'USER_REQUEST_RATE_EXCEEDED' })
    expect(throttled.errorCode).toBeUndefined()

    const repeated = await failure(403, JSON.stringify({ error: 'denied', message: 'denied' }))
    expect(repeated).toMatchObject({ errorCode: 'denied', detail: 'denied' })
  })

  it('never puts the content of a body that is not a JSON error into the message', async () => {
    const text = await failure(502, 'Bad gateway: Bearer s3cret')
    expect(text.message).not.toContain('s3cret')
    expect(text.detail).toBeUndefined()

    expect((await failure(502, new Uint8Array([1, 2, 3]))).detail).toBeUndefined()

    const array = await failure(500, '[]')
    expect(array.errorCode).toBeUndefined()
    expect(array.detail).toBeUndefined()
  })

  it('keeps the status when the body is empty or cannot be read', async () => {
    expect((await failure(500, null)).failure.status).toBe(500)

    const broken = new Response(
      new ReadableStream({ start(controller) { controller.error(new Error('reset')) } }),
      { status: 500 },
    )
    const error = await httpErrorFrom(broken, 'Kiro test', NOW)
    expect(error.failure.status).toBe(500)
    expect(error.detail).toBeUndefined()
  })

  it('carries the provider retry delay and request id when the answer has them', async () => {
    const seconds = await failure(429, '{}', { 'retry-after': '3', 'x-amzn-requestid': 'req-1' })
    expect(seconds.failure.providerRetryAfterMs).toBe(3000)
    expect(seconds.failure.requestId).toBe('req-1')

    const dated = await failure(503, '{}', { 'retry-after': 'Thu, 01 Jan 2026 00:00:30 GMT' })
    expect(dated.failure.providerRetryAfterMs).toBe(30_000)

    // Zero, unreadable, and past delays are not delays.
    for (const unusable of ['0', 'soon', 'Wed, 31 Dec 2025 23:59:00 GMT']) {
      expect((await failure(503, '{}', { 'retry-after': unusable })).failure.providerRetryAfterMs).toBeUndefined()
    }
    const bare = await failure(503, '{}')
    expect(bare.failure.providerRetryAfterMs).toBeUndefined()
    expect(bare.failure.requestId).toBeUndefined()
  })

  it('reads the retry date against the real clock when none is given', async () => {
    const error = await httpErrorFrom(new Response('{}', { status: 500 }), 'Kiro test')

    expect(error.failure.status).toBe(500)
  })
})
