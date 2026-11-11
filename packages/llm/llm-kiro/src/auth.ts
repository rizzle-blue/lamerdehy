/**
 * Kiro sign-in and the saved credential. Sign-in is the AWS SSO OIDC device
 * authorization flow (RFC 8628) for AWS Builder ID and IAM Identity Center, as
 * Kiro CLI performs it, registered as an authorization flow on
 * `ctx.authorization`. The grant it produces is stored as one `grant` record
 * under {@link KIRO_CREDENTIAL_KEY}; only this module reads or writes that
 * payload, and every read validates it, because a stored file is not trusted.
 *
 * An access token is refreshed inside `ctx.credentials.modifyRecord`, so
 * refreshes are serialized in the process and, where the credential store
 * supports it, across processes: a refresh token rotates at the issuer, and
 * two writers refreshing one token would invalidate whichever wrote first.
 * Every failure is an `LlmError` whose message is safe to show and whose code
 * is one of `MISSING_CREDENTIAL`, `INVALID_CREDENTIAL`, `AUTH`, `INVALID_START_URL`,
 * `INVALID_REGION`, `LOGIN_UNAVAILABLE`, `LOGIN_DENIED`, `LOGIN_EXPIRED`, `NO_PROFILE`,
 * `INVALID_RESPONSE`, `TIMEOUT`, `ABORTED`, `TRANSPORT`, `RATE_LIMIT`, or `SERVER`.
 *
 * Adapted from omp-kiro-provider (https://github.com/HoangNguyen17193/omp-kiro-provider),
 * MIT License, Copyright (c) 2026 tino; the notice is in ../LICENSE.
 *
 * @module dsh-llm-kiro/auth
 */

import { z } from 'zod'
import type { Context } from '@deepseek-ai/cordis'
import type { AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { APP_IDENTITY, errorChain, INVALID_CREDENTIAL_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import { resolveProfile } from './catalog.ts'
import type { KiroConfig } from './config.ts'
import {
  apiRegionFor, BUILDER_ID_START_URL, isRegion, KIRO_DEFAULT_REGION, oidcBaseUrl, profileRegion,
} from './endpoints.ts'
import { KiroHttpError, requestJson, systemRuntime } from './http.ts'
import type { KiroRuntime } from './http.ts'
import { fetchIdentity } from './identity.ts'
import type { KiroIdentity } from './identity.ts'

/**
 * Address of the saved Kiro credential. The scope is the plugin's registered
 * name, which is what marks this plugin as the owner of the payload format.
 */
export const KIRO_CREDENTIAL_KEY = credentialKey('llm-kiro', 'kiro')

const SCOPES = [
  'codewhisperer:completions',
  'codewhisperer:analysis',
  'codewhisperer:conversations',
  'codewhisperer:transformations',
  'codewhisperer:taskassist',
]
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'

/** Token lifetime assumed when a token response states none. */
const DEFAULT_TOKEN_LIFETIME_S = 3600
/** Polling interval assumed when the device authorization states none (RFC 8628 section 3.2). */
const DEFAULT_POLL_INTERVAL_S = 5
/** Device code lifetime assumed when the device authorization states none. */
const DEFAULT_DEVICE_CODE_LIFETIME_S = 600
/** Added to the polling interval on every `slow_down` answer (RFC 8628 section 3.5). */
const SLOW_DOWN_STEP_MS = 5000

/** Regions probed, in order, when an Identity Center user does not name one. */
const IDC_REGIONS = [
  'us-east-1', 'eu-west-1', 'eu-central-1', 'us-east-2', 'eu-west-2', 'eu-west-3',
  'eu-north-1', 'ap-southeast-1', 'ap-northeast-1', 'us-west-2', 'sa-east-1', 'ap-northeast-2',
]

/** OIDC refresh failures that mean the grant is dead and a new sign-in is required, lowercased. */
const DEAD_GRANT_CODES = [
  'invalid_grant',
  'expired_token',
  'invalid_client',
  'unauthorized_client',
  'invalidgrantexception',
  'expiredtokenexception',
  'invalidclientexception',
  'unauthorizedclientexception',
]

const RegionField = z.string().refine(isRegion, 'not an AWS region')

/** The grant payload as stored; unknown members are dropped on read. */
const Grant = z.object({
  access: z.string().min(1),
  refresh: z.string().min(1),
  expires: z.number(),
  accountId: z.string().min(1).optional(),
  email: z.string().min(1).optional(),
  region: RegionField,
  profileArn: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  oidcRegion: RegionField,
  startUrl: z.url(),
})

const RegisterResponse = z.looseObject({ clientId: z.string().min(1), clientSecret: z.string().min(1) })
const DeviceResponse = z.looseObject({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: z.string().min(1),
  verificationUriComplete: z.string().optional(),
  interval: z.number().positive().optional(),
  expiresIn: z.number().positive().optional(),
})
const TokenResponse = z.looseObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresIn: z.number().positive().optional(),
})

/** The saved Kiro grant: the account's tokens, the OIDC client that refreshes them, and where the account is served. */
export interface KiroCredential {
  /** Bearer access token for Kiro requests. */
  access: string
  /** Rotating OIDC refresh token. */
  refresh: string
  /** Epoch milliseconds at which `access` expires; the configured margin is applied when it is used, not here. */
  expires: number
  /** Builder ID or IAM Identity Center user id, when Kiro reported one at sign-in. */
  accountId?: string | undefined
  /** Email of the user, when Kiro reported one at sign-in. */
  email?: string | undefined
  /** Kiro API region of the management and runtime hosts. */
  region: string
  /** Profile ARN every Kiro request names; it scopes the account's catalog and usage. */
  profileArn: string
  /** OIDC client registered at sign-in; a refresh must reuse it. */
  clientId: string
  /** Secret of that OIDC client. */
  clientSecret: string
  /** Region the OIDC client was registered in; a refresh must use the same one. */
  oidcRegion: string
  /** Builder ID or IAM Identity Center start URL the user signed in with. */
  startUrl: string
}

/** What one Kiro request needs: a bearer token and the profile it is served for. */
export interface KiroAccess {
  /** Bearer access token. */
  token: string
  /** Region of the Kiro host that serves the profile: the profile ARN's region. */
  region: string
  /** Profile ARN the request names; it identifies the account scope. */
  profileArn: string
}

/**
 * The record that stores a credential: the only writer of the payload format.
 * @param credential - the grant to store.
 * @returns a `grant` record whose payload holds no undefined members, as the credential store requires.
 */
export function kiroGrantRecord(credential: KiroCredential): CredentialRecord {
  return {
    kind: 'grant',
    payload: {
      access: credential.access,
      refresh: credential.refresh,
      expires: credential.expires,
      ...credential.accountId === undefined ? {} : { accountId: credential.accountId },
      ...credential.email === undefined ? {} : { email: credential.email },
      region: credential.region,
      profileArn: credential.profileArn,
      clientId: credential.clientId,
      clientSecret: credential.clientSecret,
      oidcRegion: credential.oidcRegion,
      startUrl: credential.startUrl,
    },
  }
}

/** The credential a stored record holds, validated; the message never quotes the record. */
function grantOf(record: CredentialRecord | undefined): KiroCredential {
  if (record === undefined) {
    throw new LlmError(
      'Kiro is not signed in. Sign in with AWS Builder ID or IAM Identity Center under Settings → Models → Subscription accounts.',
      'MISSING_CREDENTIAL',
    )
  }
  const parsed = record.kind === 'grant' ? Grant.safeParse(record.payload) : undefined
  if (parsed === undefined || !parsed.success) {
    throw new LlmError('The saved Kiro sign-in is unreadable. Sign in again under Settings → Models → Subscription accounts.', INVALID_CREDENTIAL_CODE)
  }
  return parsed.data
}

/** Refuse a start URL that is not an HTTPS address. */
function assertStartUrl(value: string): void {
  if (!URL.canParse(value) || new URL(value).protocol !== 'https:') {
    throw new LlmError(
      `Kiro: "${value}" is not an HTTPS IAM Identity Center start URL such as https://<org>.awsapps.com/start`,
      'INVALID_START_URL',
    )
  }
}

/** Ask which region hosts the Identity Center directory; a blank answer means every probed region. */
async function askRegions(session: AuthorizationSession): Promise<readonly string[]> {
  const input = (await session.prompt({
    kind: 'text',
    message: 'IAM Identity Center region (leave blank to detect)',
    placeholder: 'us-east-1',
  })).trim()
  if (input === '') return IDC_REGIONS
  if (!isRegion(input)) throw new LlmError(`Kiro: "${input}" is not an AWS region such as us-east-1`, 'INVALID_REGION')
  return [input]
}

/** An OIDC client and the device authorization it obtained. */
interface RegisteredDevice {
  readonly region: string
  readonly client: z.infer<typeof RegisterResponse>
  readonly device: z.infer<typeof DeviceResponse>
}

/**
 * Kiro sign-in and the saved credential, over the credential and authorization
 * seams. The credential is read per operation and never cached, so a sign-in
 * or sign-out reaches the next request without a restart.
 */
export class KiroAuth {
  private readonly ctx: Context
  private readonly config: KiroConfig
  private readonly runtime: KiroRuntime

  constructor(ctx: Context, config: KiroConfig, runtime: KiroRuntime = systemRuntime) {
    this.ctx = ctx
    this.config = config
    this.runtime = runtime
  }

  /**
   * The saved credential, refreshed first when its access token expires within
   * the configured margin. The refresh re-reads the record while it holds the
   * credential store's write lock, so a refresh another request or process
   * finished meanwhile is used instead of repeated.
   * @param signal - cancels a refresh. A cancelled caller leaves the saved credential unchanged.
   * @returns the valid credential.
   * @throws {LlmError} code `MISSING_CREDENTIAL` when nothing is saved, `INVALID_CREDENTIAL` when the
   *   saved grant is unreadable, `AUTH` when Kiro refuses the refresh token because the sign-in expired or
   *   was revoked, or the failure of the refresh request (`TIMEOUT`, `ABORTED`, `TRANSPORT`, `SERVER`, ...).
   */
  async credential(signal?: AbortSignal): Promise<KiroCredential> {
    const current = grantOf(await this.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY))
    if (!this.stale(current)) return current
    const stored = await this.ctx.credentials.modifyRecord(KIRO_CREDENTIAL_KEY, async (record) => {
      const latest = grantOf(record)
      if (!this.stale(latest)) return undefined
      return kiroGrantRecord(await this.refresh(latest, signal))
    })
    return grantOf(stored)
  }

  /**
   * The saved credential as a Kiro request needs it.
   * @param signal - cancels a refresh.
   * @returns the bearer token, the region serving the profile, and the profile ARN.
   * @throws {LlmError} as {@link KiroAuth.credential}.
   */
  async access(signal?: AbortSignal): Promise<KiroAccess> {
    const credential = await this.credential(signal)
    return {
      token: credential.access,
      region: profileRegion(credential.profileArn, credential.region),
      profileArn: credential.profileArn,
    }
  }

  /**
   * Offer Kiro sign-in on `ctx.authorization`; the flow is withdrawn with the context.
   *
   * The flow asks at most two text questions, in order: the Identity Center
   * start URL (blank for AWS Builder ID), then, only when a URL was given, the
   * Identity Center region (blank to detect it). It sends progress notices
   * without a `url`, then exactly one device-code notice carrying the
   * verification `url` and the `code` to check, then waits for the human to
   * approve. The grant is committed through the session, so a cancelled
   * attempt stores nothing.
   */
  register(): void {
    this.ctx.authorization.registerFlow({
      key: KIRO_CREDENTIAL_KEY,
      label: 'Kiro',
      methods: [{ id: 'device', label: 'AWS Builder ID or IAM Identity Center' }],
      run: session => this.signIn(session),
    })
  }

  /** Whether an access token is expired, or expires within the configured margin. */
  private stale(credential: KiroCredential): boolean {
    return this.runtime.now() >= credential.expires - this.config.expiryMarginMs
  }

  /** Exchange the refresh token for a new access token, keeping the rest of the grant. */
  private async refresh(previous: KiroCredential, signal: AbortSignal | undefined): Promise<KiroCredential> {
    let token: z.infer<typeof TokenResponse>
    try {
      token = await requestJson(this.runtime, {
        method: 'POST',
        url: `${oidcBaseUrl(previous.oidcRegion)}/token`,
        body: {
          clientId: previous.clientId,
          clientSecret: previous.clientSecret,
          refreshToken: previous.refresh,
          grantType: 'refresh_token',
        },
        signal,
        timeoutMs: this.config.requestTimeoutMs,
        label: 'Kiro token refresh',
      }, TokenResponse)
    } catch (error) {
      if (error instanceof KiroHttpError && error.errorCode !== undefined
        && DEAD_GRANT_CODES.includes(error.errorCode.toLowerCase())) {
        throw new LlmError(
          `Kiro sign-in expired or was revoked (${error.errorCode}). Sign in again under Settings → Models → Subscription accounts.`,
          'AUTH',
          { cause: error },
        )
      }
      throw error
    }
    return {
      ...previous,
      access: token.accessToken,
      // Kiro may omit a rotated refresh token; the previous one stays valid.
      refresh: token.refreshToken ?? previous.refresh,
      expires: this.runtime.now() + (token.expiresIn ?? DEFAULT_TOKEN_LIFETIME_S) * 1000,
    }
  }

  /** Run one sign-in attempt and commit the grant it produces. */
  private async signIn(session: AuthorizationSession): Promise<void> {
    const { signal } = session
    const startInput = (await session.prompt({
      kind: 'text',
      message: 'IAM Identity Center start URL (leave blank for AWS Builder ID)',
      placeholder: 'https://<org>.awsapps.com/start',
    })).trim()
    const builderId = startInput === ''
    if (!builderId) assertStartUrl(startInput)
    const startUrl = builderId ? BUILDER_ID_START_URL : startInput
    const regions = builderId ? [KIRO_DEFAULT_REGION] : await askRegions(session)
    const registered = await this.startDevice(session, regions, startUrl)
    const { client, device } = registered
    session.notify({
      message: 'Approve the Kiro sign-in in your browser. Check that the page shows the code below.',
      url: device.verificationUriComplete ?? device.verificationUri,
      code: device.userCode,
    })
    session.notify({ message: 'Waiting for approval…' })
    const token = await this.pollForToken(registered, signal)
    if (token.refreshToken === undefined) throw new LlmError('Kiro sign-in returned no refresh token', 'INVALID_RESPONSE')
    const profile = await resolveProfile(
      token.accessToken, apiRegionFor(registered.region), this.config, { builderId, signal }, this.runtime,
    )
    const identity = await this.identityOf(
      { token: token.accessToken, region: profile.region, profileArn: profile.arn }, signal,
    )
    await session.commit(kiroGrantRecord({
      access: token.accessToken,
      refresh: token.refreshToken,
      expires: this.runtime.now() + (token.expiresIn ?? DEFAULT_TOKEN_LIFETIME_S) * 1000,
      ...identity,
      region: profile.region,
      profileArn: profile.arn,
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      oidcRegion: registered.region,
      startUrl,
    }))
    session.notify({ message: identity.email === undefined ? 'Signed in to Kiro.' : `Signed in to Kiro as ${identity.email}.` })
  }

  /** Register an OIDC client and start device authorization in the first region that accepts the start URL. */
  private async startDevice(
    session: AuthorizationSession,
    regions: readonly string[],
    startUrl: string,
  ): Promise<RegisteredDevice> {
    let lastError: unknown
    for (const region of regions) {
      session.notify({ message: `Contacting AWS SSO in ${region}…` })
      try {
        return await this.registerAndAuthorize(region, startUrl, session.signal)
      } catch (error) {
        if (session.signal.aborted) throw error
        lastError = error
      }
    }
    throw new LlmError(`Kiro: could not start device sign-in (${errorChain(lastError)})`, 'LOGIN_UNAVAILABLE', { cause: lastError })
  }

  private async registerAndAuthorize(region: string, startUrl: string, signal: AbortSignal): Promise<RegisteredDevice> {
    const base = oidcBaseUrl(region)
    const client = await requestJson(this.runtime, {
      method: 'POST',
      url: `${base}/client/register`,
      body: {
        clientName: APP_IDENTITY.product,
        clientType: 'public',
        scopes: SCOPES,
        grantTypes: [DEVICE_GRANT, 'refresh_token'],
      },
      signal,
      timeoutMs: this.config.requestTimeoutMs,
      label: 'Kiro client registration',
    }, RegisterResponse)
    const device = await requestJson(this.runtime, {
      method: 'POST',
      url: `${base}/device_authorization`,
      body: { clientId: client.clientId, clientSecret: client.clientSecret, startUrl },
      signal,
      timeoutMs: this.config.requestTimeoutMs,
      label: 'Kiro device authorization',
    }, DeviceResponse)
    return { region, client, device }
  }

  /**
   * Poll the token endpoint until the human approves (RFC 8628 section 3.5):
   * `authorization_pending` keeps waiting, `slow_down` lengthens the interval,
   * and the device code's lifetime bounds the whole wait.
   */
  private async pollForToken(registered: RegisteredDevice, signal: AbortSignal): Promise<z.infer<typeof TokenResponse>> {
    const { region, client, device } = registered
    let intervalMs = (device.interval ?? DEFAULT_POLL_INTERVAL_S) * 1000
    const deadlineAt = this.runtime.now() + (device.expiresIn ?? DEFAULT_DEVICE_CODE_LIFETIME_S) * 1000
    while (this.runtime.now() < deadlineAt) {
      await this.runtime.sleep(intervalMs, signal)
      try {
        return await requestJson(this.runtime, {
          method: 'POST',
          url: `${oidcBaseUrl(region)}/token`,
          body: {
            clientId: client.clientId,
            clientSecret: client.clientSecret,
            deviceCode: device.deviceCode,
            grantType: DEVICE_GRANT,
          },
          signal,
          timeoutMs: this.config.requestTimeoutMs,
          label: 'Kiro token request',
        }, TokenResponse)
      } catch (error) {
        const code = error instanceof KiroHttpError ? error.errorCode?.toLowerCase() : undefined
        if (code === 'authorization_pending' || code === 'authorizationpendingexception') continue
        if (code === 'slow_down' || code === 'slowdownexception') {
          intervalMs += SLOW_DOWN_STEP_MS
          continue
        }
        if (code === 'access_denied' || code === 'accessdeniedexception') {
          throw new LlmError('The Kiro sign-in was denied in the browser. Try again.', 'LOGIN_DENIED', { cause: error })
        }
        if (code === 'expired_token' || code === 'expiredtokenexception') break
        throw error
      }
    }
    throw new LlmError('The Kiro sign-in code expired before it was approved. Try again.', 'LOGIN_EXPIRED')
  }

  /**
   * The user Kiro reports for a new grant. The identity only labels the sign-in,
   * so a lookup Kiro fails never blocks it; a cancelled sign-in still fails, so
   * it saves nothing.
   */
  private async identityOf(access: KiroAccess, signal: AbortSignal): Promise<KiroIdentity> {
    try {
      return await fetchIdentity(access, this.config, signal, this.runtime)
    } catch (error) {
      if (signal.aborted) throw error
      return {}
    }
  }
}
