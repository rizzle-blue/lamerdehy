import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService, { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type {
  AuthorizationInteraction, AuthorizationNotice, AuthorizationOutcome, AuthorizationPrompt,
} from '@deepseek-ai/dsh-authorization'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { APP_IDENTITY } from '@deepseek-ai/dsh-llm'
import { KIRO_CREDENTIAL_KEY, KiroAuth, kiroGrantRecord } from '../src/auth.ts'
import type { KiroCredential } from '../src/auth.ts'
import { BUILDER_ID_PROFILE_ARN, KIRO_USER_AGENT } from '../src/endpoints.ts'
import { KiroHttpError } from '../src/http.ts'
import { clock, config, failureOf, json, PROFILE_ARN, recorder } from './wire.ts'
import type { Call, Clock, Handler } from './wire.ts'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

interface Harness {
  readonly ctx: Context
  readonly auth: KiroAuth
  readonly calls: Call[]
  readonly time: Clock
}

/** The real credential store and authorization seam over a private directory, with Kiro's flow registered. */
async function harness(
  handler: Handler,
  options: { readonly time?: Clock; readonly sleep?: Clock['sleep'] } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-kiro-auth-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  const time = options.time ?? clock()
  const { fetch, calls } = recorder(handler)
  const auth = new KiroAuth(ctx, config, { fetch, now: time.now, sleep: options.sleep ?? time.sleep })
  auth.register()
  return { ctx, auth, calls, time }
}

/** What the human sees and answers during one attempt. */
interface Surface extends AuthorizationInteraction {
  readonly notices: AuthorizationNotice[]
  readonly prompts: AuthorizationPrompt[]
}

function surface(answers: readonly string[]): Surface {
  const queue = [...answers]
  const notices: AuthorizationNotice[] = []
  const prompts: AuthorizationPrompt[] = []
  return {
    notices,
    prompts,
    notify: (notice) => { notices.push(notice) },
    prompt: (prompt) => {
      prompts.push(prompt)
      return Promise.resolve(queue.shift() ?? '')
    },
  }
}

function begin(h: Harness, interaction: AuthorizationInteraction, signal?: AbortSignal): Promise<AuthorizationOutcome> {
  return h.ctx.authorization.begin({
    key: KIRO_CREDENTIAL_KEY,
    interaction,
    ...signal === undefined ? {} : { signal },
  })
}

const CLIENT = { clientId: 'client-1', clientSecret: 'secret-1' }
const DEVICE = {
  deviceCode: 'dev-1',
  userCode: 'ABCD-EFGH',
  verificationUri: 'https://device.sso/',
  verificationUriComplete: 'https://device.sso/?code=ABCD-EFGH',
  interval: 5,
  expiresIn: 600,
}
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code'
const IDENTITY = { userInfo: { email: 'dev@example.com', userId: 'user-1' } }

const pending = (): Response => json(400, { error: 'authorization_pending' })
const slowDown = (): Response => json(400, { error: 'slow_down' })
const approved = (): Response => json(200, { accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 3600 })

type Answers = Partial<Record<'register' | 'device' | 'profiles' | 'usage', Handler>>

/** The AWS answers of one device sign-in; `answers` replaces an endpoint's default answer, and `tokens` are served in order. */
function aws(tokens: readonly (() => Response)[], answers: Answers = {}): Handler {
  const replies = [...tokens]
  return (call, index) => {
    if (call.url.endsWith('/client/register')) return answers.register?.(call, index) ?? json(200, CLIENT)
    if (call.url.endsWith('/device_authorization')) return answers.device?.(call, index) ?? json(200, DEVICE)
    if (call.url.endsWith('/token')) {
      const next = replies.shift()
      if (next === undefined) throw new Error('unexpected token request')
      return next()
    }
    if (call.url.endsWith('/List-Available-Profiles')) return answers.profiles?.(call, index) ?? json(403, { message: 'denied' })
    if (call.url.includes('/Get-Usage-Limits?')) return answers.usage?.(call, index) ?? json(200, IDENTITY)
    throw new Error(`unexpected request ${call.url}`)
  }
}

const withProfile: Answers = { profiles: () => json(200, { profiles: [{ arn: PROFILE_ARN }] }) }

/** Host and path of every request, without credentials in the query. */
function endpoints(h: Harness): string[] {
  return h.calls.map((call) => {
    const url = new URL(call.url)
    return url.host + url.pathname
  })
}

describe('Kiro sign-in flow', () => {
  it('is offered on the authorization seam under the Kiro credential key', async () => {
    const h = await harness(aws([]))

    const [entry, ...others] = h.ctx.authorization.list()

    expect(others).toEqual([])
    expect(entry).toMatchObject({ key: KIRO_CREDENTIAL_KEY, inFlight: false })
    expect(entry?.methods.map(method => method.id)).toEqual(['device'])
  })

  it('signs in with AWS Builder ID, backs off on slow_down, and stores the grant', async () => {
    const h = await harness(aws([pending, slowDown, approved]))
    const ui = surface([''])

    await expect(begin(h, ui)).resolves.toEqual({ status: 'authorized' })

    // One question, and only the device-code notice carries a page to open and the code to check on it.
    expect(ui.prompts).toEqual([expect.objectContaining({ kind: 'text' })])
    const [deviceNotice, ...otherPages] = ui.notices.filter(notice => notice.url !== undefined)
    expect(otherPages).toEqual([])
    expect(deviceNotice).toMatchObject({ url: 'https://device.sso/?code=ABCD-EFGH', code: 'ABCD-EFGH' })
    for (const notice of ui.notices.filter(candidate => candidate !== deviceNotice)) expect(notice.code).toBeUndefined()
    expect(h.time.sleeps).toEqual([5000, 5000, 10000])
    expect(endpoints(h)).toEqual([
      'oidc.us-east-1.amazonaws.com/client/register',
      'oidc.us-east-1.amazonaws.com/device_authorization',
      'oidc.us-east-1.amazonaws.com/token',
      'oidc.us-east-1.amazonaws.com/token',
      'oidc.us-east-1.amazonaws.com/token',
      // A Builder ID may have no listable profile; every candidate region answered 403.
      'management.us-east-1.kiro.dev/List-Available-Profiles',
      'management.eu-central-1.kiro.dev/List-Available-Profiles',
      'management.us-east-1.kiro.dev/Get-Usage-Limits',
    ])
    expect(h.calls[0]?.init.method).toBe('POST')
    expect(h.calls[0]?.body).toEqual({
      clientName: APP_IDENTITY.product,
      clientType: 'public',
      scopes: [
        'codewhisperer:completions',
        'codewhisperer:analysis',
        'codewhisperer:conversations',
        'codewhisperer:transformations',
        'codewhisperer:taskassist',
      ],
      grantTypes: [DEVICE_GRANT, 'refresh_token'],
    })
    expect(h.calls[1]?.body).toEqual({ ...CLIENT, startUrl: 'https://view.awsapps.com/start' })
    for (const call of h.calls.slice(2, 5)) {
      expect(call.body).toEqual({ ...CLIENT, deviceCode: 'dev-1', grantType: DEVICE_GRANT })
    }
    const lookup = h.calls[7]
    expect(lookup?.headers.authorization).toBe('Bearer access-1')
    expect(new URL(lookup?.url ?? '').searchParams.get('profileArn')).toBe(BUILDER_ID_PROFILE_ARN)
    for (const call of h.calls) expect(call.headers['user-agent']).toBe(KIRO_USER_AGENT)

    await expect(h.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY)).resolves.toEqual({
      kind: 'grant',
      payload: {
        access: 'access-1',
        refresh: 'refresh-1',
        // The clock moved through the three waits before the token arrived.
        expires: 1_000_000 + 20_000 + 3_600_000,
        accountId: 'user-1',
        email: 'dev@example.com',
        region: 'us-east-1',
        profileArn: BUILDER_ID_PROFILE_ARN,
        clientId: 'client-1',
        clientSecret: 'secret-1',
        oidcRegion: 'us-east-1',
        startUrl: 'https://view.awsapps.com/start',
      },
    })
    await expect(h.auth.access()).resolves.toEqual({
      token: 'access-1',
      region: 'us-east-1',
      profileArn: BUILDER_ID_PROFILE_ARN,
    })
  })

  it('signs in through IAM Identity Center in the region the user names, and serves the profile from its own region', async () => {
    const h = await harness(aws([approved], withProfile))
    const ui = surface(['https://org.awsapps.com/start', 'eu-west-1'])

    await expect(begin(h, ui)).resolves.toEqual({ status: 'authorized' })

    expect(ui.prompts).toHaveLength(2)
    expect(endpoints(h)).toEqual([
      'oidc.eu-west-1.amazonaws.com/client/register',
      'oidc.eu-west-1.amazonaws.com/device_authorization',
      'oidc.eu-west-1.amazonaws.com/token',
      // eu-west-1 is served by Kiro's eu-central-1 hosts.
      'management.eu-central-1.kiro.dev/List-Available-Profiles',
      'management.eu-central-1.kiro.dev/Get-Usage-Limits',
    ])
    expect(h.calls[1]?.body).toEqual({ ...CLIENT, startUrl: 'https://org.awsapps.com/start' })
    await expect(h.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY)).resolves.toMatchObject({
      kind: 'grant',
      payload: {
        region: 'eu-central-1',
        profileArn: PROFILE_ARN,
        oidcRegion: 'eu-west-1',
        startUrl: 'https://org.awsapps.com/start',
      },
    })
  })

  it('detects the Identity Center region when the user names none', async () => {
    const h = await harness(aws([approved], {
      ...withProfile,
      register: call => call.url.includes('oidc.us-east-1.')
        ? json(400, { error: 'invalid_request', error_description: 'The start URL is not served here' })
        : json(200, CLIENT),
    }))
    const ui = surface(['https://org.awsapps.com/start', ''])

    await expect(begin(h, ui)).resolves.toEqual({ status: 'authorized' })

    expect(endpoints(h).slice(0, 3)).toEqual([
      'oidc.us-east-1.amazonaws.com/client/register',
      'oidc.eu-west-1.amazonaws.com/client/register',
      'oidc.eu-west-1.amazonaws.com/device_authorization',
    ])
    await expect(h.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY)).resolves.toMatchObject({
      payload: { oidcRegion: 'eu-west-1' },
    })
  })

  it('fails with the last cause when no region can start the sign-in', async () => {
    const h = await harness(aws([], { register: () => json(400, { error: 'invalid_request' }) }))

    const error = await failureOf(begin(h, surface(['https://org.awsapps.com/start', ''])))

    expect(error.code).toBe('LOGIN_UNAVAILABLE')
    expect(error.cause).toBeInstanceOf(KiroHttpError)
    expect(h.calls).toHaveLength(12)
    await expect(h.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY)).resolves.toBeUndefined()
  })

  it('refuses a start URL that is not HTTPS and a region that is not one, before any request', async () => {
    const cases: [string[], string][] = [
      [['not a url'], 'INVALID_START_URL'],
      [['http://org.awsapps.com/start'], 'INVALID_START_URL'],
      [['https://org.awsapps.com/start', 'nowhere'], 'INVALID_REGION'],
    ]
    for (const [answers, code] of cases) {
      const h = await harness(aws([]))

      const error = await failureOf(begin(h, surface(answers)))

      expect(error.code).toBe(code)
      expect(h.calls).toHaveLength(0)
    }
  })

  it('uses the protocol defaults when Kiro states no polling interval, expiry, or full verification URL', async () => {
    const h = await harness(aws([() => json(200, { accessToken: 'access-1', refreshToken: 'refresh-1' })], {
      ...withProfile,
      device: () => json(200, { deviceCode: 'dev-1', userCode: 'ABCD-EFGH', verificationUri: 'https://device.sso/' }),
    }))
    const ui = surface([''])

    await expect(begin(h, ui)).resolves.toEqual({ status: 'authorized' })

    expect(h.time.sleeps).toEqual([5000])
    expect(ui.notices.find(notice => notice.url !== undefined)?.url).toBe('https://device.sso/')
    await expect(h.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY)).resolves.toMatchObject({
      payload: { expires: 1_000_000 + 5_000 + 3_600_000 },
    })
  })

  it('stops with a typed failure when the code is denied or expires, and stores nothing', async () => {
    const denied = await harness(aws([() => json(400, { error: 'access_denied' })]))
    expect((await failureOf(begin(denied, surface([''])))).code).toBe('LOGIN_DENIED')

    const expired = await harness(aws([() => json(400, { __type: 'com.amazonaws.ssooidc#ExpiredTokenException' })]))
    expect((await failureOf(begin(expired, surface([''])))).code).toBe('LOGIN_EXPIRED')

    // The device code's own lifetime bounds the wait: polls at 5 s and 10 s, none after 10 s.
    const waiting = await harness(aws([pending, pending], { device: () => json(200, { ...DEVICE, expiresIn: 10 }) }))
    expect((await failureOf(begin(waiting, surface([''])))).code).toBe('LOGIN_EXPIRED')
    expect(waiting.calls.filter(call => call.url.endsWith('/token'))).toHaveLength(2)
    await expect(waiting.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY)).resolves.toBeUndefined()
  })

  it('passes any other token failure through unchanged', async () => {
    const down = await harness(aws([() => json(500, { message: 'down' })]))
    const unavailable = await failureOf(begin(down, surface([''])))
    expect(unavailable).toBeInstanceOf(KiroHttpError)
    expect(unavailable.code).toBe('SERVER')

    const offline = await harness(aws([() => { throw new TypeError('fetch failed') }]))
    expect((await failureOf(begin(offline, surface([''])))).code).toBe('TRANSPORT')
  })

  it('refuses a token response without a refresh token and stores nothing', async () => {
    const h = await harness(aws([() => json(200, { accessToken: 'access-1' })]))

    const error = await failureOf(begin(h, surface([''])))

    expect(error.code).toBe('INVALID_RESPONSE')
    await expect(h.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY)).resolves.toBeUndefined()
  })

  it('signs in without an identity when Kiro withholds it, storing no empty members', async () => {
    const h = await harness(aws([approved], { usage: () => json(500, { message: 'down' }) }))

    await expect(begin(h, surface(['']))).resolves.toEqual({ status: 'authorized' })

    const stored = await h.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY)
    expect(stored?.kind).toBe('grant')
    const payload = stored?.kind === 'grant' ? stored.payload : undefined
    expect(payload).not.toHaveProperty('email')
    expect(payload).not.toHaveProperty('accountId')
  })

  it('settles as cancelled and stores nothing when the human withdraws while waiting for approval', async () => {
    const controller = new AbortController()
    const time = clock()
    const h = await harness(aws([pending, approved]), {
      time,
      sleep: (ms, signal) => {
        // Withdraw as the second wait begins, after one poll was answered.
        if (time.sleeps.length === 1) controller.abort()
        return time.sleep(ms, signal)
      },
    })

    await expect(begin(h, surface(['']), controller.signal)).resolves.toEqual({ status: 'cancelled' })

    expect(h.calls.filter(call => call.url.endsWith('/token'))).toHaveLength(1)
    await expect(h.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY)).resolves.toBeUndefined()
  })

  it('stops probing regions once the human withdraws', async () => {
    const controller = new AbortController()
    const h = await harness(aws([], {
      register: () => {
        controller.abort()
        return json(400, { error: 'invalid_request' })
      },
    }))

    await expect(begin(h, surface(['https://org.awsapps.com/start', '']), controller.signal))
      .resolves.toEqual({ status: 'cancelled' })

    expect(h.calls).toHaveLength(1)
  })

  it('saves nothing when the human withdraws during the identity lookup', async () => {
    const controller = new AbortController()
    const h = await harness(aws([approved], {
      usage: () => {
        controller.abort()
        return json(500, { message: 'down' })
      },
    }))

    await expect(begin(h, surface(['']), controller.signal)).resolves.toEqual({ status: 'cancelled' })

    await expect(h.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY)).resolves.toBeUndefined()
  })

  it('settles as cancelled when the human declines a question', async () => {
    const h = await harness(aws([]))

    await expect(begin(h, {
      notify: () => {},
      prompt: () => Promise.reject(new AuthorizationDeclinedError()),
    })).resolves.toEqual({ status: 'cancelled' })

    expect(h.calls).toHaveLength(0)
  })
})

function credential(time: Clock, overrides: Partial<KiroCredential> = {}): KiroCredential {
  return {
    access: 'access-1',
    refresh: 'refresh-1',
    expires: time.now() + 3_600_000,
    accountId: 'user-1',
    email: 'dev@example.com',
    region: 'us-east-1',
    profileArn: PROFILE_ARN,
    clientId: 'client-1',
    clientSecret: 'secret-1',
    oidcRegion: 'eu-west-1',
    startUrl: 'https://org.awsapps.com/start',
    ...overrides,
  }
}

async function store(h: Harness, record: CredentialRecord): Promise<void> {
  await h.ctx.credentials.modifyRecord(KIRO_CREDENTIAL_KEY, () => Promise.resolve(record))
}

const noRequest: Handler = () => {
  throw new Error('no request was expected')
}

describe('Kiro credential', () => {
  it('is missing until a sign-in stored it, and points the user to the Models page sign-in', async () => {
    const h = await harness(noRequest)

    for (const read of [() => h.auth.credential(), () => h.auth.access()]) {
      const error = await failureOf(read())

      expect(error.code).toBe('MISSING_CREDENTIAL')
      expect(error.message).toContain('Settings → Models → Subscription accounts')
    }
  })

  it('refuses a stored value that is not a usable Kiro grant, without quoting it', async () => {
    const h = await harness(noRequest)
    const records: CredentialRecord[] = [
      { kind: 'api-key', key: 'sk-secret' },
      { kind: 'grant', payload: { access: 'secret-token' } },
      kiroGrantRecord(credential(h.time, { region: 'evil.example/x#' })),
      kiroGrantRecord(credential(h.time, { startUrl: 'not a url' })),
    ]
    for (const record of records) {
      await store(h, record)

      const error = await failureOf(h.auth.credential())

      expect(error.code).toBe('INVALID_CREDENTIAL')
      for (const secret of ['sk-secret', 'secret-token', 'secret-1', 'refresh-1']) expect(error.message).not.toContain(secret)
    }
  })

  it('returns a credential that is not near expiry without a request, and serves its profile from the ARN\'s region', async () => {
    const h = await harness(noRequest)
    const saved = credential(h.time)
    await store(h, kiroGrantRecord(saved))

    await expect(h.auth.credential()).resolves.toEqual(saved)
    // The credential recorded us-east-1, but the profile lives in eu-central-1.
    await expect(h.auth.access()).resolves.toEqual({ token: 'access-1', region: 'eu-central-1', profileArn: PROFILE_ARN })
  })

  it('reads the real clock when no runtime is given', async () => {
    const h = await harness(noRequest)
    const real = new KiroAuth(h.ctx, config)
    await store(h, kiroGrantRecord(credential(h.time, { expires: Date.now() + 3_600_000 })))

    await expect(real.access()).resolves.toMatchObject({ token: 'access-1' })
  })

  it('refreshes inside the margin with the registered OIDC client, keeping the refresh token Kiro does not rotate', async () => {
    const h = await harness(() => json(200, { accessToken: 'access-2', expiresIn: 1800 }))
    const saved = credential(h.time, { expires: h.time.now() + 60_000 })
    await store(h, kiroGrantRecord(saved))

    const refreshed = await h.auth.credential()

    expect(refreshed).toEqual({ ...saved, access: 'access-2', expires: h.time.now() + 1_800_000 })
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]?.url).toBe('https://oidc.eu-west-1.amazonaws.com/token')
    expect(h.calls[0]?.body).toEqual({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      refreshToken: 'refresh-1',
      grantType: 'refresh_token',
    })
    expect(h.calls[0]?.headers['user-agent']).toBe(KIRO_USER_AGENT)
    await expect(h.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY)).resolves.toEqual(kiroGrantRecord(refreshed))
    // The stored credential is fresh now, so the next read makes no request.
    await h.auth.credential()
    expect(h.calls).toHaveLength(1)
  })

  it('stores a rotated refresh token and assumes an hour when Kiro states no lifetime', async () => {
    const h = await harness(() => json(200, { accessToken: 'access-3', refreshToken: 'refresh-2' }))
    await store(h, kiroGrantRecord(credential(h.time, { expires: h.time.now() - 1 })))

    const refreshed = await h.auth.credential()

    expect(refreshed).toMatchObject({ access: 'access-3', refresh: 'refresh-2', expires: h.time.now() + 3_600_000 })
  })

  it('refreshes once when several callers find the credential expired together', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const h = await harness(async () => {
      entered.resolve(undefined)
      await release.promise
      return json(200, { accessToken: 'access-2', refreshToken: 'refresh-2', expiresIn: 3600 })
    })
    await store(h, kiroGrantRecord(credential(h.time, { expires: h.time.now() - 1 })))

    const first = h.auth.credential()
    const second = h.auth.credential()
    await entered.promise
    release.resolve(undefined)

    const [one, two] = await Promise.all([first, second])
    expect(one.access).toBe('access-2')
    expect(two.access).toBe('access-2')
    expect(h.calls).toHaveLength(1)
  })

  it('uses a refresh another writer finished while this caller waited for the record lock', async () => {
    const h = await harness(noRequest)
    await store(h, kiroGrantRecord(credential(h.time, { expires: h.time.now() - 1 })))
    const held = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    const other = h.ctx.credentials.modifyRecord(KIRO_CREDENTIAL_KEY, async () => {
      held.resolve(undefined)
      await gate.promise
      return kiroGrantRecord(credential(h.time, { access: 'access-other' }))
    })
    await held.promise

    // This caller read the expired credential before the other writer committed, then queues behind it.
    const waiting = h.auth.credential()
    gate.resolve(undefined)
    await other

    await expect(waiting).resolves.toMatchObject({ access: 'access-other' })
    expect(h.calls).toHaveLength(0)
  })

  it('reports a dead refresh grant as an AUTH failure that points to the Models page sign-in, and keeps the saved credential', async () => {
    const dead = [
      { error: 'invalid_grant', error_description: 'Invalid refresh token provided' },
      { error: 'expired_token', error_description: null },
      { __type: 'com.amazonaws.ssooidc#InvalidGrantException', message: 'Invalid grant provided' },
    ]
    for (const body of dead) {
      const h = await harness(() => json(400, body))
      await store(h, kiroGrantRecord(credential(h.time, { expires: h.time.now() - 1 })))

      const error = await failureOf(h.auth.credential())

      expect(error.code).toBe('AUTH')
      expect(error.message).toContain('Settings → Models → Subscription accounts')
      expect(error.message).not.toContain('refresh-1')
      expect(error.message).not.toContain('secret-1')
      expect(error.cause).toBeInstanceOf(KiroHttpError)
      await expect(h.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY)).resolves.toMatchObject({
        payload: { access: 'access-1', refresh: 'refresh-1' },
      })
    }
  })

  it('leaves a transient refresh failure retryable and the saved credential unchanged', async () => {
    const failures: [Handler, string][] = [
      [() => json(500, { message: 'Service unavailable' }), 'SERVER'],
      [() => json(400, { error: 'invalid_request' }), 'INVALID_REQUEST'],
      [() => { throw new TypeError('fetch failed') }, 'TRANSPORT'],
    ]
    for (const [handler, code] of failures) {
      const h = await harness(handler)
      await store(h, kiroGrantRecord(credential(h.time, { expires: h.time.now() - 1 })))

      const error = await failureOf(h.auth.credential())

      expect(error.code).toBe(code)
      await expect(h.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY)).resolves.toMatchObject({
        payload: { access: 'access-1' },
      })
    }
  })

  it('cancels a refresh in flight and keeps the saved credential', async () => {
    const entered = Promise.withResolvers<undefined>()
    const h = await harness(() => {
      entered.resolve(undefined)
      return new Promise<Response>(() => {})
    })
    await store(h, kiroGrantRecord(credential(h.time, { expires: h.time.now() - 1 })))
    const controller = new AbortController()

    const refreshing = failureOf(h.auth.credential(controller.signal))
    await entered.promise
    controller.abort()

    expect((await refreshing).code).toBe('ABORTED')
    await expect(h.ctx.credentials.readRecord(KIRO_CREDENTIAL_KEY)).resolves.toMatchObject({
      payload: { access: 'access-1' },
    })
  })
})
