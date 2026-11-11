/**
 * The user a Kiro access token belongs to, from Kiro's `Get-Usage-Limits`
 * management endpoint. That response is the only place Kiro names the user:
 * the access token is opaque and carries no claims.
 *
 * Adapted from omp-kiro-provider (https://github.com/HoangNguyen17193/omp-kiro-provider),
 * MIT License, Copyright (c) 2026 tino; the notice is in ../LICENSE.
 *
 * @module dsh-llm-kiro/identity
 */

import { z } from 'zod'
import type { KiroAccess } from './auth.ts'
import type { KiroConfig } from './config.ts'
import { managementBaseUrl, profileRegion } from './endpoints.ts'
import { requestJson, systemRuntime } from './http.ts'
import type { KiroRuntime } from './http.ts'

const UsageLimits = z.looseObject({
  userInfo: z.looseObject({ email: z.string().nullish(), userId: z.string().nullish() }).nullish(),
})

/** The user Kiro reports for an access token. */
export interface KiroIdentity {
  /** Email of the signed-in user. */
  readonly email?: string
  /** Builder ID or IAM Identity Center user id; stable and unique per user. */
  readonly accountId?: string
}

/**
 * Ask Kiro which user an access token belongs to.
 * @param access - bearer token, region, and profile of the signed-in account.
 * @param config - request budget.
 * @param signal - cancels the request.
 * @param runtime - transport and clock.
 * @returns the user Kiro reports, with blank values left out; empty when Kiro names none.
 * @throws {KiroHttpError} for a non-2xx answer; code `AUTH` when Kiro rejects the token.
 * @throws {LlmError} code `INVALID_RESPONSE` for a malformed answer; `TIMEOUT`, `ABORTED`,
 *   or `TRANSPORT` when the request fails before an answer.
 */
export async function fetchIdentity(
  access: KiroAccess,
  config: KiroConfig,
  signal?: AbortSignal,
  runtime: KiroRuntime = systemRuntime,
): Promise<KiroIdentity> {
  // The profile ARN scopes the answer to the signed-in account.
  const query = new URLSearchParams({
    origin: 'KIRO_CLI',
    resourceType: 'CREDIT',
    isEmailRequired: 'true',
    profileArn: access.profileArn,
  })
  const raw = await requestJson(runtime, {
    method: 'GET',
    url: `${managementBaseUrl(profileRegion(access.profileArn, access.region))}/Get-Usage-Limits?${query.toString()}`,
    headers: { authorization: `Bearer ${access.token}` },
    signal,
    timeoutMs: config.requestTimeoutMs,
    label: 'Kiro account',
  }, UsageLimits)
  const email = raw.userInfo?.email?.trim()
  const accountId = raw.userInfo?.userId?.trim()
  return { ...email ? { email } : {}, ...accountId ? { accountId } : {} }
}
