import { afterEach, describe, expect, it, vi } from 'vitest'
import { KIRO_USER_AGENT } from '../src/endpoints.ts'
import type { KiroAccess } from '../src/auth.ts'
import { KiroHttpError } from '../src/http.ts'
import { fetchIdentity } from '../src/identity.ts'
import { config, failureOf, json, PROFILE_ARN, recorder, runtimeOf } from './wire.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const ACCESS: KiroAccess = { token: 'test-access', region: 'us-east-1', profileArn: PROFILE_ARN }

describe('fetchIdentity', () => {
  it('asks the profile\'s region for the user and names the user Kiro reports, trimmed', async () => {
    const named = recorder(() => json(200, { userInfo: { email: ' dev@example.com ', userId: ' d-1.user-1 ' } }))
    await expect(fetchIdentity(ACCESS, config, undefined, runtimeOf(named.fetch)))
      .resolves.toEqual({ email: 'dev@example.com', accountId: 'd-1.user-1' })
    const [call] = named.calls
    const url = new URL(call?.url ?? '')
    // The credential says us-east-1, the profile says eu-central-1, and the profile decides.
    expect(url.origin + url.pathname).toBe('https://management.eu-central-1.kiro.dev/Get-Usage-Limits')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      origin: 'KIRO_CLI',
      resourceType: 'CREDIT',
      isEmailRequired: 'true',
      profileArn: PROFILE_ARN,
    })
    expect(call?.init.method).toBe('GET')
    expect(call?.headers).toEqual({ accept: 'application/json', authorization: 'Bearer test-access', 'user-agent': KIRO_USER_AGENT })
  })

  it('names nothing when Kiro names no user or blank values', async () => {
    const anonymous = recorder(() => json(200, {}))
    await expect(fetchIdentity(ACCESS, config, undefined, runtimeOf(anonymous.fetch))).resolves.toEqual({})
    const blank = recorder(() => json(200, { userInfo: { email: ' ', userId: '' } }))
    await expect(fetchIdentity(ACCESS, config, undefined, runtimeOf(blank.fetch))).resolves.toEqual({})
  })

  it('reports a rejected token as an AUTH failure', async () => {
    const { fetch } = recorder(() => json(403, { message: 'Invalid token' }))

    const error = await failureOf(fetchIdentity(ACCESS, config, undefined, runtimeOf(fetch)))

    expect(error).toBeInstanceOf(KiroHttpError)
    expect(error.code).toBe('AUTH')
  })

  it('sends through the global fetch when no runtime is given', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { userInfo: { email: 'dev@example.com' } }))))

    await expect(fetchIdentity(ACCESS, config)).resolves.toEqual({ email: 'dev@example.com' })
  })
})
