/** Real Loader composition: the controller, `ctx.authorization`, and local credentials mount from cordis.yml; the flow is a fixture. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import AuthorizationController from '../src/index.ts'
import type { SignInAttemptView } from '../src/types.ts'

const KEY = credentialKey('fixture-account', 'subscription')

/** A sign-in flow plugin standing in for a provider: one question, then a grant built from the answer. */
const FixtureFlow = {
  name: 'fixture-flow',
  inject: ['authorization'],
  apply(ctx: Context) {
    ctx.authorization.registerFlow({
      key: KEY,
      label: 'Fixture subscription',
      methods: [{ id: 'device', label: 'Device code' }],
      async run(session) {
        session.notify({ message: 'Approve in your browser.', url: 'https://auth.example/device', code: 'WXYZ-1234' })
        const code = await session.prompt({ kind: 'secret', message: 'Paste the code' })
        await session.commit({ kind: 'grant', payload: { token: `granted-${code}` } })
      },
    })
  },
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function load(): Promise<{ ctx: Context; controller: AuthorizationController; credentialsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-authorization-controller-'))
  const credentialsPath = join(root, '.credentials.yaml')
  const modules: Record<string, unknown> = {
    '@deepseek-ai/dsh-credentials-local': LocalCredentialProvider,
    '@deepseek-ai/dsh-authorization': AuthorizationService,
    'fixture-flow': FixtureFlow,
    '@deepseek-ai/dsh-api-authorization-controller': AuthorizationController,
  }
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: 'cordis:@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(credentialsPath)}`,
    '    watch: false',
    "- name: 'cordis:@deepseek-ai/dsh-authorization'",
    "- name: 'cordis:fixture-flow'",
    "- name: 'cordis:@deepseek-ai/dsh-api-authorization-controller'",
    '  config:',
    `    flows: [${KEY}]`,
    '',
  ].join('\n'))
  const ctx = context = new Context()
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  for (const [specifier, plugin] of Object.entries(modules)) ctx.loader.builtins[specifier] = plugin
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const controller = ctx.get('authorizationController')
  if (controller === undefined) throw new Error('the Loader did not mount the authorization controller')
  return { ctx, controller, credentialsPath }
}

/** Follow one key's watch until `done` holds, returning that frame's attempt. */
async function until(controller: AuthorizationController, done: (attempt: SignInAttemptView) => boolean): Promise<SignInAttemptView> {
  const abort = new AbortController()
  for await (const frame of controller.watch(KEY, abort.signal)) {
    if (frame.attempt !== null && done(frame.attempt)) {
      abort.abort()
      return frame.attempt
    }
  }
  throw new Error('the watch ended before the expected frame')
}

describe('authorization controller through a real cordis.yml Loader composition', () => {
  it('signs in with a page-answered question, stores the grant on disk, and signs out', async () => {
    const { controller, credentialsPath } = await load()
    expect(await controller.list()).toEqual([{
      key: KEY, label: 'Fixture subscription', methods: [{ id: 'device', label: 'Device code' }], signedIn: false,
    }])

    controller.start(KEY, undefined)
    const asking = await until(controller, attempt => attempt.prompt !== undefined)
    expect(asking.notices).toEqual([{ message: 'Approve in your browser.', url: 'https://auth.example/device', code: 'WXYZ-1234' }])
    controller.answer(asking.attemptId, asking.prompt!.promptId, 'typed-code')
    const done = await until(controller, attempt => attempt.status !== 'running')
    expect(done).toMatchObject({ status: 'authorized' })
    expect(JSON.stringify(done)).not.toContain('typed-code')

    expect((await controller.list())[0]?.signedIn).toBe(true)
    expect(await readFile(credentialsPath, 'utf8')).toContain('granted-typed-code')

    await controller.signOut(KEY)
    expect((await controller.list())[0]?.signedIn).toBe(false)
    expect(await readFile(credentialsPath, 'utf8')).not.toContain('granted-typed-code')
  })

  it('withdraws a waiting sign-in and ends open watches when the composition is disposed', async () => {
    const { ctx, controller } = await load()
    controller.start(KEY, undefined)
    await until(controller, attempt => attempt.prompt !== undefined)
    const iterator = controller.watch(KEY, new AbortController().signal)[Symbol.asyncIterator]()
    await iterator.next()
    const ended = iterator.next()
    await ctx.fiber.dispose()
    context = undefined
    expect((await ended).done).toBe(true)
  })
})
