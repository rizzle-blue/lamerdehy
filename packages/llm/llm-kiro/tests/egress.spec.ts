import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { KIRO_CREDENTIAL_KEY, KiroAuth, kiroGrantRecord } from '../src/auth.ts'
import type { KiroAccess } from '../src/auth.ts'
import { listModels, resolveProfile } from '../src/catalog.ts'
import { fetchIdentity } from '../src/identity.ts'
import { config } from './wire.ts'

// `zz-test-1` is shaped like an AWS region and names no real one, so a request that bypassed the proxy
// would fail to resolve instead of reaching AWS.
const REGION = 'zz-test-1'
const ACCESS: KiroAccess = {
  token: 'probe-token',
  region: REGION,
  profileArn: `arn:aws:codewhisperer:${REGION}:111111111111:profile/EGRESS`,
}

let seen: string[] = []
let proxy: Server
let proxyUrl: string
const dirs: string[] = []

beforeAll(async () => {
  proxy = createServer((request, response) => {
    seen.push(`REQ ${request.url ?? ''}`)
    response.writeHead(502)
    response.end('fake-proxy')
  })
  proxy.on('connect', (request, socket) => {
    seen.push(`CONNECT ${request.url ?? ''}`)
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    socket.end()
  })
  const listening = Promise.withResolvers<AddressInfo>()
  proxy.listen(0, '127.0.0.1', () => { listening.resolve(proxy.address() as AddressInfo) })
  const address = await listening.promise
  proxyUrl = `http://127.0.0.1:${String(address.port)}`
})

afterAll(async () => {
  const closed = Promise.withResolvers<undefined>()
  proxy.close(() => { closed.resolve(undefined) })
  await closed.promise
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** The launch environment of a user who exported one proxy for both schemes. */
function proxyEnv(): { get(name: string): { value: string } | undefined } {
  return { get: name => (name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined) }
}

async function observe(run: () => Promise<unknown>): Promise<string[]> {
  seen = []
  const dispose = await installProxyFromEnvironment(proxyEnv(), () => undefined)
  try {
    // The fake proxy refuses every tunnel, so the request fails; the recorded route is the assertion.
    await run().catch(() => undefined)
  } finally {
    await dispose()
  }
  return seen
}

/** The credential store, authorization seam, and Kiro auth on the real transport. */
async function kiro(): Promise<{ ctx: Context; auth: KiroAuth }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-kiro-egress-'))
  dirs.push(dir)
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  await ctx.plugin(AuthorizationService)
  const auth = new KiroAuth(ctx, config)
  auth.register()
  return { ctx, auth }
}

describe('Kiro egress', () => {
  it('sends the device sign-in through the proxy', async () => {
    const { ctx } = await kiro()
    const answers = ['https://org.awsapps.com/start', REGION]

    const observed = await observe(() => ctx.authorization.begin({
      key: KIRO_CREDENTIAL_KEY,
      interaction: { notify: () => {}, prompt: () => Promise.resolve(answers.shift() ?? '') },
    }))

    expect(observed).toContain(`CONNECT oidc.${REGION}.amazonaws.com:443`)
  })

  it('sends the token refresh through the proxy to the region the OIDC client was registered in', async () => {
    const { ctx, auth } = await kiro()
    await ctx.credentials.modifyRecord(KIRO_CREDENTIAL_KEY, () => Promise.resolve(kiroGrantRecord({
      access: 'access-1',
      refresh: 'refresh-1',
      expires: Date.now() - 1,
      region: REGION,
      profileArn: ACCESS.profileArn,
      clientId: 'client-1',
      clientSecret: 'secret-1',
      oidcRegion: REGION,
      startUrl: 'https://org.awsapps.com/start',
    })))

    const observed = await observe(() => auth.credential())

    expect(observed).toContain(`CONNECT oidc.${REGION}.amazonaws.com:443`)
  })

  it('sends profile discovery through the proxy', async () => {
    const observed = await observe(() => resolveProfile('probe-token', REGION, config, { builderId: true }))

    expect(observed).toContain(`CONNECT management.${REGION}.kiro.dev:443`)
  })

  it('sends model discovery through the proxy', async () => {
    const observed = await observe(() => listModels(ACCESS, config))

    expect(observed).toContain(`CONNECT management.${REGION}.kiro.dev:443`)
  })

  it('sends the account identity query through the proxy', async () => {
    const observed = await observe(() => fetchIdentity(ACCESS, config))

    expect(observed).toContain(`CONNECT management.${REGION}.kiro.dev:443`)
  })
})
