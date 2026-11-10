/**
 * Kiro account usage: the plan, the monthly and bonus credit allowances, and
 * the signed-in user, from Kiro's `Get-Usage-Limits` management endpoint. The
 * same response names the user, which is the only identity Kiro exposes: the
 * access token is opaque and carries no claims.
 *
 * Adapted from omp-kiro-provider (https://github.com/HoangNguyen17193/omp-kiro-provider),
 * MIT License, Copyright (c) 2026 tino; the notice is in ../LICENSE.
 *
 * @module dsh-llm-kiro/usage
 */

import { z } from 'zod'
import type { KiroAccess } from './auth.ts'
import type { KiroConfig } from './config.ts'
import { managementBaseUrl, profileRegion } from './endpoints.ts'
import { requestJson, systemRuntime } from './http.ts'
import type { KiroRuntime } from './http.ts'

/** Share of an allowance after which it reads as nearly spent. */
const WARNING_FRACTION = 0.9

/** Kiro reports reset times as epoch seconds or ISO strings. */
const Epoch = z.union([z.number(), z.string()]).nullish()
const Count = z.number().nullish()

const FreeTrial = z.looseObject({
  freeTrialStatus: z.string().nullish(),
  freeTrialExpiry: Epoch,
  currentUsage: Count,
  currentUsageWithPrecision: Count,
  usageLimit: Count,
  usageLimitWithPrecision: Count,
})

const Breakdown = z.looseObject({
  resourceType: z.string().nullish(),
  displayName: z.string().nullish(),
  displayNamePlural: z.string().nullish(),
  currentUsage: Count,
  currentUsageWithPrecision: Count,
  usageLimit: Count,
  usageLimitWithPrecision: Count,
  currentOverages: Count,
  currentOveragesWithPrecision: Count,
  nextDateReset: Epoch,
  freeTrialInfo: FreeTrial.nullish(),
})

const UsageLimits = z.looseObject({
  nextDateReset: Epoch,
  usageBreakdownList: z.array(Breakdown).nullish(),
  usageBreakdown: Breakdown.nullish(),
  subscriptionInfo: z.looseObject({ subscriptionTitle: z.string().nullish() }).nullish(),
  overageConfiguration: z.looseObject({ overageStatus: z.string().nullish() }).nullish(),
  userInfo: z.looseObject({ email: z.string().nullish(), userId: z.string().nullish() }).nullish(),
})

/** How much of one allowance is spent: `warning` from 90%, `exhausted` at the limit, `unknown` without both numbers. */
export type KiroUsageStatus = 'ok' | 'warning' | 'exhausted' | 'unknown'

/** One credit allowance of the account. */
export interface KiroUsageLimit {
  /** `kiro:<resource type>` for the monthly allowance and `kiro:<resource type>:bonus` for bonus credits. */
  readonly id: string
  /** Display name, such as `Credits` or `Bonus credits`. */
  readonly label: string
  /** `monthly` allowances reset; `bonus` allowances expire. */
  readonly kind: 'monthly' | 'bonus'
  /** Credits spent; absent when Kiro reports none. */
  readonly used?: number
  /** Credits allowed; absent when Kiro reports none. */
  readonly limit?: number
  /** How much of the allowance is spent. */
  readonly status: KiroUsageStatus
  /** Epoch milliseconds at which the allowance resets or expires. */
  readonly resetsAt?: number
  /** Further facts Kiro reported, such as overage or trial status. */
  readonly notes: readonly string[]
}

/** The user Kiro reports for an access token. */
export interface KiroIdentity {
  /** Email of the signed-in user. */
  readonly email?: string
  /** Builder ID or IAM Identity Center user id; stable and unique per user. */
  readonly accountId?: string
}

/** Account usage at one moment. */
export interface KiroUsageReport extends KiroIdentity {
  /** Epoch milliseconds at which the report was fetched. */
  readonly fetchedAt: number
  /** Subscription title, such as `KIRO PRO`. */
  readonly plan?: string
  /** Whether Kiro bills usage beyond the allowance, as Kiro names it. */
  readonly overageStatus?: string
  /** The monthly allowance and bonus allowance of each resource Kiro reports. */
  readonly limits: readonly KiroUsageLimit[]
}

type UsageLimits = z.infer<typeof UsageLimits>
type Breakdown = z.infer<typeof Breakdown>

/** An epoch in seconds or an ISO date as epoch milliseconds, or undefined when absent or unreadable. */
function toMillis(value: number | string | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined
  const ms = typeof value === 'number' ? value * 1000 : Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

function statusFor(used: number | undefined, limit: number | undefined): KiroUsageStatus {
  if (used === undefined || !limit) return 'unknown'
  if (used >= limit) return 'exhausted'
  return used / limit >= WARNING_FRACTION ? 'warning' : 'ok'
}

/** The facts of one allowance, with the status they imply. */
function creditLimit(input: Omit<KiroUsageLimit, 'status' | 'used' | 'limit' | 'resetsAt'> & {
  used: number | undefined
  limit: number | undefined
  resetsAt: number | undefined
}): KiroUsageLimit {
  const { used, limit, resetsAt, ...rest } = input
  return {
    ...rest,
    ...used === undefined ? {} : { used },
    ...limit === undefined ? {} : { limit },
    status: statusFor(used, limit),
    ...resetsAt === undefined ? {} : { resetsAt },
  }
}

/** The monthly allowance of one resource and, when it has an active trial, its bonus allowance. */
function limitsFor(bucket: Breakdown, index: number, fallbackReset: number | undefined): KiroUsageLimit[] {
  const id = `kiro:${(bucket.resourceType ?? `usage-${index}`).toLowerCase()}`
  const overages = bucket.currentOveragesWithPrecision ?? bucket.currentOverages ?? 0
  const limits = [
    creditLimit({
      id,
      label: bucket.displayNamePlural ?? bucket.displayName ?? 'Credits',
      kind: 'monthly',
      used: bucket.currentUsageWithPrecision ?? bucket.currentUsage ?? undefined,
      limit: bucket.usageLimitWithPrecision ?? bucket.usageLimit ?? undefined,
      resetsAt: toMillis(bucket.nextDateReset) ?? fallbackReset,
      notes: overages > 0 ? [`Overage: ${overages}`] : [],
    }),
  ]
  const trial = bucket.freeTrialInfo
  const trialLimit = trial?.usageLimitWithPrecision ?? trial?.usageLimit ?? undefined
  if (trial && trialLimit) {
    limits.push(creditLimit({
      id: `${id}:bonus`,
      label: 'Bonus credits',
      kind: 'bonus',
      used: trial.currentUsageWithPrecision ?? trial.currentUsage ?? undefined,
      limit: trialLimit,
      resetsAt: toMillis(trial.freeTrialExpiry),
      notes: trial.freeTrialStatus ? [`Status: ${trial.freeTrialStatus}`] : [],
    }))
  }
  return limits
}

/** Request the account's limits; the profile ARN scopes them to the signed-in account. */
async function requestUsageLimits(
  access: KiroAccess,
  config: KiroConfig,
  signal: AbortSignal | undefined,
  runtime: KiroRuntime,
): Promise<UsageLimits> {
  const query = new URLSearchParams({
    origin: 'KIRO_CLI',
    resourceType: 'CREDIT',
    isEmailRequired: 'true',
    profileArn: access.profileArn,
  })
  return requestJson(runtime, {
    method: 'GET',
    url: `${managementBaseUrl(profileRegion(access.profileArn, access.region))}/Get-Usage-Limits?${query.toString()}`,
    headers: { authorization: `Bearer ${access.token}` },
    signal,
    timeoutMs: config.requestTimeoutMs,
    label: 'Kiro usage',
  }, UsageLimits)
}

/** The user a response names; blank values count as absent. */
function identityOf(raw: UsageLimits): KiroIdentity {
  const email = raw.userInfo?.email?.trim()
  const accountId = raw.userInfo?.userId?.trim()
  return { ...email ? { email } : {}, ...accountId ? { accountId } : {} }
}

/**
 * Ask Kiro which user an access token belongs to.
 * @param access - bearer token, region, and profile of the signed-in account.
 * @param config - request budget.
 * @param signal - cancels the request.
 * @param runtime - transport and clock.
 * @returns the user Kiro reports; empty when Kiro names none.
 * @throws {LlmError} the failure of the request, as {@link queryUsage} documents.
 */
export async function fetchIdentity(
  access: KiroAccess,
  config: KiroConfig,
  signal?: AbortSignal,
  runtime: KiroRuntime = systemRuntime,
): Promise<KiroIdentity> {
  return identityOf(await requestUsageLimits(access, config, signal, runtime))
}

/**
 * Query the signed-in account's plan and credit usage.
 * @param access - bearer token, region, and profile of the signed-in account.
 * @param config - request budget.
 * @param signal - cancels the request.
 * @param runtime - transport and clock.
 * @returns the plan, the user, and each allowance with its status.
 * @throws {KiroHttpError} for a non-2xx answer; code `AUTH` when Kiro rejects the token.
 * @throws {LlmError} code `INVALID_RESPONSE` for a malformed answer; `TIMEOUT`, `ABORTED`,
 *   or `TRANSPORT` when the request fails before an answer.
 */
export async function queryUsage(
  access: KiroAccess,
  config: KiroConfig,
  signal?: AbortSignal,
  runtime: KiroRuntime = systemRuntime,
): Promise<KiroUsageReport> {
  const raw = await requestUsageLimits(access, config, signal, runtime)
  const plan = raw.subscriptionInfo?.subscriptionTitle
  const overageStatus = raw.overageConfiguration?.overageStatus
  const buckets = raw.usageBreakdownList ?? (raw.usageBreakdown ? [raw.usageBreakdown] : [])
  const fallbackReset = toMillis(raw.nextDateReset)
  return {
    fetchedAt: runtime.now(),
    ...identityOf(raw),
    ...plan ? { plan } : {},
    ...overageStatus ? { overageStatus } : {},
    limits: buckets.flatMap((bucket, index) => limitsFor(bucket, index, fallbackReset)),
  }
}

/** Credits with at most two decimals and no trailing zeros. */
function credits(value: number): string {
  return String(Math.round(value * 100) / 100)
}

/** One allowance as a line of text. */
function renderLimit(limit: KiroUsageLimit): string {
  let text = `${limit.label}: `
  if (limit.used === undefined) {
    text += 'no usage reported'
  } else if (!limit.limit) {
    text += `${credits(limit.used)} used`
  } else {
    const percent = Math.round((limit.used / limit.limit) * 100)
    text += `${credits(limit.used)} of ${credits(limit.limit)} used (${percent}%), `
      + `${credits(Math.max(0, limit.limit - limit.used))} remaining`
  }
  if (limit.resetsAt !== undefined) {
    text += `, ${limit.kind === 'bonus' ? 'expires' : 'resets'} ${new Date(limit.resetsAt).toISOString().slice(0, 10)}`
  }
  if (limit.status === 'warning') text += ' - nearly spent'
  if (limit.status === 'exhausted') text += ' - exhausted'
  if (limit.notes.length > 0) text += ` (${limit.notes.join('; ')})`
  return text
}

/**
 * Describe a usage report for a person: plan, account, one line per allowance,
 * and overage billing. Dates are UTC and the text carries no credentials.
 * @param report - the report to describe.
 * @returns multi-line text without a trailing newline.
 */
export function renderUsage(report: KiroUsageReport): string {
  const lines = [report.plan === undefined ? 'Kiro usage' : `Kiro plan: ${report.plan}`]
  const { email, accountId } = report
  if (email !== undefined) lines.push(`Account: ${email}${accountId === undefined ? '' : ` (${accountId})`}`)
  else if (accountId !== undefined) lines.push(`Account: ${accountId}`)
  if (report.limits.length === 0) lines.push('Kiro reported no credit allowances.')
  for (const limit of report.limits) lines.push(renderLimit(limit))
  if (report.overageStatus !== undefined) lines.push(`Overage: ${report.overageStatus}`)
  return lines.join('\n')
}
