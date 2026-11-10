import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService from '@deepseek-ai/dsh-authorization'
import LocalCredentialProvider from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createInboxStub, unsupportedModel } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { registerKiroCommands } from '../src/commands.ts'

const key = credentialKey('llm-kiro', 'kiro')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-kiro-commands-'))
  const ctx = new Context()
  const approved = Promise.withResolvers<undefined>()
  const finished = Promise.withResolvers<undefined>()
  const prompts: string[] = []
  let loginSignal: AbortSignal | undefined
  const mounted = ctx.plugin({
    name: 'kiro-command-test',
    async apply(child: Context) {
      await child.plugin(LocalCredentialProvider, { path: join(directory, '.credentials.yaml'), watch: false })
      await child.plugin(AuthorizationService)
      await child.plugin(SessionStore)
      await child.plugin(SessionProjectionRegistry)
      await child.plugin(AgentRegistry)
      await child.plugin(CommandRuntime)
      await child.inject(['authorization', 'credentials', 'commands'], (scoped) => {
        scoped.authorization.registerFlow({
          key,
          label: 'Kiro fixture',
          methods: [{ id: 'device', label: 'Device authorization' }],
          async run(session) {
            loginSignal = session.signal
            const cancelled = Promise.withResolvers<never>()
            const onAbort = (): void => { cancelled.reject(session.signal.reason) }
            session.signal.addEventListener('abort', onAbort, { once: true })
            try {
              prompts.push(await session.prompt({ kind: 'text', message: 'Start URL' }))
              if (prompts[0] !== '') prompts.push(await session.prompt({ kind: 'text', message: 'Region' }))
              session.notify({ message: 'Approve Kiro', url: 'https://device.sso.us-east-1.amazonaws.com/', code: 'ABCD' })
              session.notify({ message: 'Waiting for approval' })
              await Promise.race([approved.promise, cancelled.promise])
              await session.commit({ kind: 'grant', payload: { access: 'fixture-access' } })
            } finally {
              session.signal.removeEventListener('abort', onAbort)
              finished.resolve(undefined)
            }
          },
        })
        registerKiroCommands(scoped, {
          key,
          usage: async () => { throw new LlmError('Sign in with /kiro-login.', 'MISSING_CREDENTIAL') },
        })
      })
    },
  })
  cleanups.push(async () => {
    await (await mounted).dispose()
    await rm(directory, { recursive: true, force: true })
  })
  await mounted
  const session = ctx.sessions.create(SessionId('kiro-command-fixture'))
  const agent: Agent = {
    id: session.id, options: {}, session,
    model: unsupportedModel(), inbox: createInboxStub(), ctx: new Context(), status: 'idle',
    send() {}, followup() {}, steer() {}, cancel() {},
    inject(input) { this.inbox.append('next-step', input) },
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(undefined),
  }
  await ctx.agents.register(agent)
  const run = async (name: string, rawInput = '') => {
    const result = await ctx.commands.execute(agent, `/${name}${rawInput === '' ? '' : ` ${rawInput}`}`, [], new AbortController().signal)
    if (result === undefined) throw new Error(`Command ${name} is missing`)
    return result.result
  }
  return { ctx, session, mounted, run, approved, finished, prompts, loginSignal: () => loginSignal }
}

describe('Kiro account commands', () => {
  it('returns approval instructions before settlement and preserves them across progress notices', async () => {
    const f = await harness()
    const result = await f.run('kiro-login')
    expect(result.text).toContain('https://device.sso.us-east-1.amazonaws.com/')
    expect(result.text).toContain('ABCD')
    expect(f.prompts).toEqual([''])
    expect(await f.ctx.credentials.readRecord(key)).toBeUndefined()
    expect((await f.run('kiro-login', 'status')).text).toContain('ABCD')
    f.approved.resolve(undefined)
    await f.finished.promise
    await expect.poll(() => f.ctx.credentials.readRecord(key)).toEqual({ kind: 'grant', payload: { access: 'fixture-access' } })
    await expect.poll(async () => (await f.run('kiro-login', 'status')).text).not.toContain('ABCD')
    expect(f.session.snapshotEvents().filter(event => event.type === 'user/message' || event.type === 'assistant/message')).toEqual([])
  })

  it('cancels the device flow before deleting a saved credential', async () => {
    const f = await harness()
    await f.ctx.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload: { access: 'old-access' } }))
    await f.run('kiro-login', 'https://example.awsapps.com/start eu-west-1')
    expect(f.prompts).toEqual(['https://example.awsapps.com/start', 'eu-west-1'])
    await f.run('kiro-logout')
    expect(f.loginSignal()?.aborted).toBe(true)
    await f.finished.promise
    expect(await f.ctx.credentials.readRecord(key)).toBeUndefined()
  })

  it('reports a failed authorization without committing a credential', async () => {
    const f = await harness()
    await f.run('kiro-login')
    f.approved.reject(new LlmError('Device code expired; run /kiro-login again.', 'AUTH'))
    await f.finished.promise
    await expect.poll(async () => (await f.run('kiro-login', 'status')).kind).toBe('error')
    expect(await f.ctx.credentials.readRecord(key)).toBeUndefined()
  })

  it('settles an unfinished flow before plugin disposal completes', async () => {
    const f = await harness()
    await f.run('kiro-login')
    await (await f.mounted).dispose()
    expect(f.loginSignal()?.aborted).toBe(true)
    await f.finished.promise
  })
})
