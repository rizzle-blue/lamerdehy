import { afterEach, describe, expect, it, vi } from 'vitest'
import { KIRO_USER_AGENT } from '../src/endpoints.ts'
import type { KiroAccess } from '../src/auth.ts'
import { KiroHttpError } from '../src/http.ts'
import { fetchIdentity, queryUsage, renderUsage } from '../src/usage.ts'
import type { KiroUsageLimit, KiroUsageReport } from '../src/usage.ts'
import { config, failureOf, json, PROFILE_ARN, recorder, runtimeOf } from './wire.ts'
import type { Call } from './wire.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

const ACCESS: KiroAccess = { token: 'test-access', region: 'us-east-1', profileArn: PROFILE_ARN }
/** 2026-11-01T00:00:00Z in epoch seconds, the unit Kiro reports reset times in. */
const RESET_SECONDS = 1_793_491_200

function usageOf(body: unknown): { result: Promise<KiroUsageReport>; calls: Call[] } {
  const { fetch, calls } = recorder(() => json(200, body))
  return { calls, result: queryUsage(ACCESS, config, undefined, runtimeOf(fetch)) }
}

describe('queryUsage', () => {
  it('reports the plan, the user, and the monthly and bonus credits of the profile\'s region', async () => {
    const { calls, result } = usageOf({
      subscriptionInfo: { subscriptionTitle: 'KIRO PRO MAX' },
      overageConfiguration: { overageStatus: 'DISABLED' },
      userInfo: { email: 'dev@example.com', userId: 'd-1234567890.user-1' },
      nextDateReset: RESET_SECONDS,
      usageBreakdownList: [
        {
          resourceType: 'CREDIT',
          displayNamePlural: 'Credits',
          currentUsage: 1250,
          currentUsageWithPrecision: 1250.5,
          usageLimit: 5000,
          usageLimitWithPrecision: 5000,
          currentOverages: 0,
          nextDateReset: null,
          freeTrialInfo: { freeTrialStatus: 'ACTIVE', currentUsage: 10, usageLimit: 500, freeTrialExpiry: '2026-10-15T00:00:00Z' },
        },
      ],
    })

    await expect(result).resolves.toEqual({
      fetchedAt: 1_000_000,
      email: 'dev@example.com',
      accountId: 'd-1234567890.user-1',
      plan: 'KIRO PRO MAX',
      overageStatus: 'DISABLED',
      limits: [
        {
          id: 'kiro:credit',
          label: 'Credits',
          kind: 'monthly',
          used: 1250.5,
          limit: 5000,
          status: 'ok',
          // The bucket's null reset falls back to the account-wide one, converted from seconds.
          resetsAt: RESET_SECONDS * 1000,
          notes: [],
        },
        {
          id: 'kiro:credit:bonus',
          label: 'Bonus credits',
          kind: 'bonus',
          used: 10,
          limit: 500,
          status: 'ok',
          resetsAt: Date.parse('2026-10-15T00:00:00Z'),
          notes: ['Status: ACTIVE'],
        },
      ],
    })
    const [call] = calls
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

  it('flags nearly spent and exhausted allowances', async () => {
    const statuses = []
    for (const used of [4499, 4500, 5000, 5200]) {
      const { result } = usageOf({ usageBreakdownList: [{ resourceType: 'CREDIT', currentUsage: used, usageLimit: 5000 }] })
      statuses.push((await result).limits[0]?.status)
    }

    expect(statuses).toEqual(['ok', 'warning', 'exhausted', 'exhausted'])
  })

  it('keeps what Kiro reported and falls back for what it left out', async () => {
    const { result } = usageOf({
      nextDateReset: RESET_SECONDS,
      usageBreakdown: {
        displayName: 'Credit',
        currentUsage: 5,
        usageLimit: 0,
        currentOveragesWithPrecision: 2.5,
        currentOverages: 9,
        // An unreadable reset reads as absent, so the account-wide one applies.
        nextDateReset: 'garbage',
        freeTrialInfo: { freeTrialStatus: null, usageLimit: 10 },
      },
    })

    await expect(result).resolves.toEqual({
      fetchedAt: 1_000_000,
      limits: [
        {
          id: 'kiro:usage-0',
          label: 'Credit',
          kind: 'monthly',
          used: 5,
          limit: 0,
          status: 'unknown',
          resetsAt: RESET_SECONDS * 1000,
          notes: ['Overage: 2.5'],
        },
        { id: 'kiro:usage-0:bonus', label: 'Bonus credits', kind: 'bonus', limit: 10, status: 'unknown', notes: [] },
      ],
    })
  })

  it('reports no bonus allowance without a trial limit, and nothing for an empty answer or a blank user', async () => {
    const trial = usageOf({ usageBreakdownList: [{ resourceType: 'CREDIT', freeTrialInfo: { usageLimit: null } }] })
    expect((await trial.result).limits.map(limit => limit.id)).toEqual(['kiro:credit'])

    for (const body of [{}, { userInfo: { email: ' ', userId: null }, usageBreakdownList: [] }]) {
      await expect(usageOf(body).result).resolves.toEqual({ fetchedAt: 1_000_000, limits: [] })
    }
  })

  it('reports a rejected token as an AUTH failure', async () => {
    const { fetch } = recorder(() => json(403, { message: 'Invalid token' }))

    const error = await failureOf(queryUsage(ACCESS, config, undefined, runtimeOf(fetch)))

    expect(error).toBeInstanceOf(KiroHttpError)
    expect(error.code).toBe('AUTH')
  })

  it('sends through the global fetch when no runtime is given', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(json(200, { userInfo: { email: 'dev@example.com' } }))))

    await expect(queryUsage(ACCESS, config)).resolves.toMatchObject({ email: 'dev@example.com', limits: [] })
    await expect(fetchIdentity(ACCESS, config)).resolves.toEqual({ email: 'dev@example.com' })
  })
})

describe('fetchIdentity', () => {
  it('names the user Kiro reports, trimmed, and nothing when Kiro names none', async () => {
    const named = recorder(() => json(200, { userInfo: { email: ' dev@example.com ', userId: ' d-1.user-1 ' } }))
    await expect(fetchIdentity(ACCESS, config, undefined, runtimeOf(named.fetch)))
      .resolves.toEqual({ email: 'dev@example.com', accountId: 'd-1.user-1' })
    expect(new URL(named.calls[0]?.url ?? '').searchParams.get('isEmailRequired')).toBe('true')

    const anonymous = recorder(() => json(200, {}))
    await expect(fetchIdentity(ACCESS, config, undefined, runtimeOf(anonymous.fetch))).resolves.toEqual({})
  })
})

const MONTHLY: KiroUsageLimit = {
  id: 'kiro:credit',
  label: 'Credits',
  kind: 'monthly',
  status: 'ok',
  notes: [],
}

/** The report text for a report holding only these allowances. */
function renderLimits(...limits: KiroUsageLimit[]): string {
  return renderUsage({ fetchedAt: 0, limits })
}

describe('renderUsage', () => {
  it('shows the plan, the account, each allowance with its rounded amounts and UTC date, and overage billing', () => {
    const text = renderUsage({
      fetchedAt: 0,
      plan: 'KIRO PRO MAX',
      email: 'dev@example.com',
      accountId: 'd-123.user-1',
      overageStatus: 'DISABLED',
      limits: [
        { ...MONTHLY, used: 1250.5, limit: 5000, resetsAt: Date.parse('2026-11-01T00:00:00Z') },
        {
          id: 'kiro:credit:bonus',
          label: 'Bonus credits',
          kind: 'bonus',
          used: 490.123,
          limit: 500,
          status: 'warning',
          resetsAt: Date.parse('2026-10-15T00:00:00Z'),
          notes: ['Status: ACTIVE'],
        },
      ],
    })

    for (const fact of [
      'KIRO PRO MAX', 'dev@example.com', 'd-123.user-1', 'DISABLED',
      '1250.5', '5000', '25%', '3749.5', '2026-11-01',
      'Bonus credits', '490.12', '500', '98%', '9.88', '2026-10-15', 'ACTIVE',
    ]) {
      expect(text).toContain(fact)
    }
    // One line for each allowance.
    expect(text.split('\n').filter(line => line.includes('Credits') || line.includes('Bonus credits'))).toHaveLength(2)
  })

  it('shows an account given by only an email or only an id', () => {
    expect(renderUsage({ fetchedAt: 0, email: 'dev@example.com', limits: [] })).toContain('dev@example.com')
    expect(renderUsage({ fetchedAt: 0, accountId: 'd-1.user-1', limits: [] })).toContain('d-1.user-1')
  })

  it('distinguishes the status of an allowance that holds the same amounts', () => {
    const amounts = { used: 4600, limit: 5000 } as const
    const lines = (['ok', 'warning', 'exhausted'] as const).map(status => renderLimits({ ...MONTHLY, ...amounts, status }))

    expect(new Set(lines).size).toBe(3)
  })

  it('renders partial and over-limit allowances without inventing numbers', () => {
    expect(renderUsage({ fetchedAt: 0, limits: [] })).not.toBe('')
    expect(renderLimits({ ...MONTHLY, status: 'unknown' })).toContain('Credits')
    expect(renderLimits({ ...MONTHLY, used: 12, status: 'unknown' })).toContain('12')
    expect(renderLimits({ ...MONTHLY, used: 5, limit: 0, status: 'unknown' })).not.toContain('%')
    const over = renderLimits({ ...MONTHLY, used: 5200, limit: 5000, status: 'exhausted' })
    expect(over).toContain('104%')
    // The remaining credits of an overspent allowance read as zero, not as a negative number.
    expect(over).not.toMatch(/-\d/u)
  })
})
