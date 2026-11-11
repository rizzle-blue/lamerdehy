/** The authorization Remote runs offered flows, relays their questions, and never returns secrets. */
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService, { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationFlow, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AuthorizationController from '../src/index.ts'
import type { SignInAttemptId, SignInAttemptView, SignInPromptId, SignInWatchFrame } from '../src/types.ts'
import { MemoryCredentials } from './memory.ts'

const CHATGPT = credentialKey('llm-pi-ai', 'openai-codex')
const KIRO = credentialKey('llm-kiro', 'kiro')
const HIDDEN = credentialKey('llm-pi-ai', 'anthropic')

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

type Runner = (session: AuthorizationSession) => Promise<void>

async function harness(
  runners: Partial<Record<CredentialKey, Runner>> = {},
): Promise<{ ctx: Context; controller: AuthorizationController }> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(MemoryCredentials)
  await ctx.plugin(AuthorizationService)
  const flow = (key: CredentialKey, label: string): AuthorizationFlow => ({
    key,
    label,
    methods: [{ id: 'oauth', label: 'Browser' }, { id: 'device', label: 'Device code' }],
    run: session => (runners[key] ?? (() => Promise.resolve()))(session),
  })
  await new Promise<void>((resolve) => {
    ctx.inject(['authorization'], (child) => {
      child.authorization.registerFlow(flow(CHATGPT, 'ChatGPT'))
      child.authorization.registerFlow(flow(HIDDEN, 'Anthropic'))
      resolve()
    })
  })
  await ctx.plugin(AuthorizationController, { flows: ['llm-pi-ai/openai-codex', 'llm-kiro/kiro'] })
  const controller = ctx.get('authorizationController')
  if (controller === undefined) throw new Error('authorization controller did not mount')
  return { ctx, controller }
}

const grant = { kind: 'grant' as const, payload: { token: 'secret-token' } }

/** Collect watch frames until `done` holds for one. */
async function frames(
  controller: AuthorizationController,
  key: CredentialKey,
  done: (frame: SignInWatchFrame) => boolean,
): Promise<SignInWatchFrame[]> {
  const abort = new AbortController()
  const seen: SignInWatchFrame[] = []
  for await (const frame of controller.watch(key, abort.signal)) {
    seen.push(frame)
    if (done(frame)) abort.abort()
  }
  return seen
}

async function settled(controller: AuthorizationController, key: CredentialKey): Promise<SignInAttemptView> {
  const seen = await frames(controller, key, frame => frame.attempt !== null && frame.attempt.status !== 'running')
  return seen.at(-1)!.attempt!
}

async function prompted(controller: AuthorizationController, key: CredentialKey): Promise<SignInAttemptView> {
  const seen = await frames(controller, key, frame => frame.attempt?.prompt !== undefined)
  return seen.at(-1)!.attempt!
}

describe('authorization controller', () => {
  it('lists only offered and registered flows with their sign-in state', async () => {
    const { ctx, controller } = await harness()
    expect(await controller.list()).toEqual([{
      key: CHATGPT,
      label: 'ChatGPT',
      methods: [{ id: 'oauth', label: 'Browser' }, { id: 'device', label: 'Device code' }],
      signedIn: false,
    }])
    await ctx.credentials.modifyRecord(CHATGPT, () => Promise.resolve(grant))
    expect((await controller.list())[0]?.signedIn).toBe(true)
    await controller.signOut(CHATGPT)
    expect((await controller.list())[0]?.signedIn).toBe(false)
  })

  it('relays notices and prompts, then reports the commit without the secret', async () => {
    const { ctx, controller } = await harness({
      [CHATGPT]: async (session) => {
        session.notify({ message: 'Open this page', url: 'https://auth.example/start', code: 'ABCD' })
        const pasted = await session.prompt({ kind: 'secret', message: 'Paste the code', placeholder: 'code' })
        expect(session.method).toBe('device')
        await session.commit({ kind: 'grant', payload: { token: pasted } })
      },
    })
    const started = controller.start(CHATGPT, 'device')
    expect(started.status).toBe('running')
    const waiting = await prompted(controller, CHATGPT)
    expect(waiting.notices).toEqual([{ message: 'Open this page', url: 'https://auth.example/start', code: 'ABCD' }])
    expect(waiting.prompt).toMatchObject({ kind: 'secret', message: 'Paste the code', placeholder: 'code' })
    controller.answer(waiting.attemptId, waiting.prompt!.promptId, 'typed-secret')
    const done = await settled(controller, CHATGPT)
    expect(done.status).toBe('authorized')
    expect(done.prompt).toBeUndefined()
    expect(JSON.stringify(done)).not.toContain('typed-secret')
    expect(await ctx.credentials.readRecord(CHATGPT)).toEqual({ kind: 'grant', payload: { token: 'typed-secret' } })
  })

  it('presents select prompts with their options', async () => {
    const { controller } = await harness({
      [CHATGPT]: async (session) => {
        const choice = await session.prompt({ kind: 'select', message: 'Pick', options: [{ id: 'browser', label: 'Browser' }] })
        await session.commit({ kind: 'grant', payload: { choice } })
      },
    })
    controller.start(CHATGPT, undefined)
    const waiting = await prompted(controller, CHATGPT)
    expect(waiting.prompt).toMatchObject({ kind: 'select', options: [{ id: 'browser', label: 'Browser' }] })
    controller.answer(waiting.attemptId, waiting.prompt!.promptId, 'browser')
    expect((await settled(controller, CHATGPT)).status).toBe('authorized')
  })

  it('joins the running attempt instead of starting a second', async () => {
    const release = Promise.withResolvers<undefined>()
    const { controller } = await harness({ [CHATGPT]: () => release.promise })
    const first = controller.start(CHATGPT, undefined)
    expect(controller.start(CHATGPT, undefined).attemptId).toBe(first.attemptId)
    controller.cancel(first.attemptId)
    release.resolve(undefined)
    expect((await settled(controller, CHATGPT)).status).toBe('cancelled')
  })

  it('cancels a waiting question as a decline', async () => {
    let rejection: unknown
    const { controller } = await harness({
      [CHATGPT]: async (session) => {
        try { await session.prompt({ kind: 'text', message: 'Start URL' }) }
        catch (error) { rejection = error; throw error }
      },
    })
    controller.start(CHATGPT, undefined)
    const waiting = await prompted(controller, CHATGPT)
    controller.cancel(waiting.attemptId)
    controller.cancel('unknown' as SignInAttemptId)
    expect((await settled(controller, CHATGPT)).status).toBe('cancelled')
    expect(rejection).toBeInstanceOf(AuthorizationDeclinedError)
    controller.cancel(waiting.attemptId)
    expect((await settled(controller, CHATGPT)).status).toBe('cancelled')
  })

  it('withdraws a question the flow retires through its own signal', async () => {
    const { controller } = await harness({
      [CHATGPT]: async (session) => {
        const race = new AbortController()
        const asked = session.prompt({ kind: 'text', message: 'Paste the redirect URL', signal: race.signal })
        race.abort()
        await expect(asked).rejects.toThrow('withdrawn')
        const late = new AbortController()
        late.abort()
        await expect(session.prompt({ kind: 'text', message: 'gone', signal: late.signal })).rejects.toThrow('withdrawn')
        await session.commit(grant)
      },
    })
    controller.start(CHATGPT, undefined)
    const done = await settled(controller, CHATGPT)
    expect(done.status).toBe('authorized')
    expect(done.prompt).toBeUndefined()
  })

  it('refuses a second concurrent question from one flow', async () => {
    const { controller } = await harness({
      [CHATGPT]: async (session) => {
        const first = session.prompt({ kind: 'text', message: 'one' })
        await expect(session.prompt({ kind: 'text', message: 'two' })).rejects.toThrow('already pending')
        await first
        await session.commit(grant)
      },
    })
    controller.start(CHATGPT, undefined)
    const waiting = await prompted(controller, CHATGPT)
    controller.answer(waiting.attemptId, waiting.prompt!.promptId, 'x')
    expect((await settled(controller, CHATGPT)).status).toBe('authorized')
  })

  it('rejects stale answers', async () => {
    const { controller } = await harness({
      [CHATGPT]: async (session) => { await session.prompt({ kind: 'text', message: 'q' }); await session.commit(grant) },
    })
    controller.start(CHATGPT, undefined)
    const waiting = await prompted(controller, CHATGPT)
    const stale = (): unknown => {
      try { controller.answer(waiting.attemptId, 'other' as SignInPromptId, 'x') } catch (error) { return error }
      return undefined
    }
    expect(remoteErrorOf(stale())).toMatchObject({ code: 'authorization/stale-prompt' })
    let missing: unknown
    try { controller.answer('nope' as SignInAttemptId, waiting.prompt!.promptId, 'x') } catch (error) { missing = error }
    expect(remoteErrorOf(missing)).toMatchObject({ code: 'authorization/stale-prompt', details: { attemptId: 'nope' } })
    controller.answer(waiting.attemptId, waiting.prompt!.promptId, 'x')
    await settled(controller, CHATGPT)
  })

  it('refuses keys it does not offer', async () => {
    const { controller } = await harness()
    let error: unknown
    try { controller.start(HIDDEN, undefined) } catch (caught) { error = caught }
    expect(remoteErrorOf(error)).toMatchObject({ code: 'authorization/unknown-flow', details: { key: HIDDEN } })
    await expect(controller.signOut(HIDDEN)).rejects.toMatchObject({ code: 'authorization/unknown-flow' })
    await expect(controller.watch(HIDDEN, new AbortController().signal)[Symbol.asyncIterator]().next())
      .rejects.toMatchObject({ code: 'authorization/unknown-flow' })
  })

  it('reports harness failures verbatim and hides other failure text', async () => {
    let fail: Error = new LlmError('Kiro sign-in code expired. Start again.', 'LOGIN_EXPIRED')
    const { controller } = await harness({ [CHATGPT]: () => Promise.reject(fail) })
    controller.start(CHATGPT, undefined)
    expect(await settled(controller, CHATGPT)).toMatchObject({ status: 'failed', error: 'Kiro sign-in code expired. Start again.' })
    fail = new Error('token endpoint said {"refresh_token":"leak"}')
    controller.start(CHATGPT, undefined)
    const hidden = await settled(controller, CHATGPT)
    expect(hidden.status).toBe('failed')
    expect(hidden.error).not.toContain('leak')
  })

  it('fails an attempt whose flow leaves a question unanswered, and releases the question', async () => {
    let asked: Promise<string> | undefined
    const { controller } = await harness({
      [CHATGPT]: (session) => {
        asked = session.prompt({ kind: 'text', message: 'orphan' })
        asked.catch(() => {})
        return Promise.reject(Symbol('broken'))
      },
    })
    controller.start(CHATGPT, undefined)
    expect((await settled(controller, CHATGPT)).status).toBe('failed')
    await expect(asked).rejects.toThrow('ended')
  })

  it('signs out by withdrawing a running attempt and deleting the record', async () => {
    const { ctx, controller } = await harness({
      [CHATGPT]: async (session) => { await session.prompt({ kind: 'text', message: 'q' }) },
    })
    await ctx.credentials.modifyRecord(CHATGPT, () => Promise.resolve(grant))
    controller.start(CHATGPT, undefined)
    await prompted(controller, CHATGPT)
    await controller.signOut(CHATGPT)
    expect(await ctx.credentials.readRecord(CHATGPT)).toBeUndefined()
    expect((await settled(controller, CHATGPT)).status).toBe('cancelled')
    await controller.signOut(CHATGPT)
  })

  it('signs out after a settled attempt without touching it', async () => {
    const { ctx, controller } = await harness({ [CHATGPT]: session => session.commit(grant) })
    controller.start(CHATGPT, undefined)
    expect((await settled(controller, CHATGPT)).status).toBe('authorized')
    await controller.signOut(CHATGPT)
    expect(await ctx.credentials.readRecord(CHATGPT)).toBeUndefined()
    expect((await settled(controller, CHATGPT)).status).toBe('authorized')
  })

  it('keeps a replaced attempt from changing the page', async () => {
    const late = Promise.withResolvers<undefined>()
    let calls = 0
    const { controller } = await harness({
      [CHATGPT]: async (session) => {
        calls++
        if (calls === 1) {
          await late.promise
          session.notify({ message: 'from the orphaned first attempt' })
          return
        }
        await session.commit(grant)
      },
    })
    const first = controller.start(CHATGPT, undefined)
    controller.cancel(first.attemptId)
    expect((await settled(controller, CHATGPT)).status).toBe('cancelled')
    const second = controller.start(CHATGPT, undefined)
    expect(second.attemptId).not.toBe(first.attemptId)
    expect(await settled(controller, CHATGPT)).toMatchObject({ attemptId: second.attemptId, status: 'authorized', notices: [] })
    late.resolve(undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(await settled(controller, CHATGPT)).toMatchObject({ attemptId: second.attemptId, notices: [] })
  })

  it('serves several watchers of one key', async () => {
    const { controller } = await harness({ [CHATGPT]: session => session.commit(grant) })
    const both = Promise.all([settled(controller, CHATGPT), settled(controller, CHATGPT)])
    controller.start(CHATGPT, undefined)
    const [one, two] = await both
    expect(one).toEqual(two)
  })

  it('signs out after an in-flight commit lands, so the commit cannot restore the sign-in', async () => {
    const writing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const { ctx, controller } = await harness({
      [CHATGPT]: session => session.commit(grant),
    })
    const credentials = ctx.credentials
    const modify = credentials.modifyRecord.bind(credentials)
    credentials.modifyRecord = async (key, mutate) => {
      writing.resolve(undefined)
      await release.promise
      return modify(key, mutate)
    }
    controller.start(CHATGPT, undefined)
    await writing.promise
    const signedOut = controller.signOut(CHATGPT)
    release.resolve(undefined)
    await signedOut
    expect(await credentials.readRecord(CHATGPT)).toBeUndefined()
  })

  it('refuses a start while a sign-out is still waiting on a committing attempt, and joins concurrent sign-outs', async () => {
    const writing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const { ctx, controller } = await harness({ [CHATGPT]: session => session.commit(grant) })
    const credentials = ctx.credentials
    const modify = credentials.modifyRecord.bind(credentials)
    let writes = 0
    credentials.modifyRecord = async (key, mutate) => {
      writes++
      writing.resolve(undefined)
      await release.promise
      return modify(key, mutate)
    }
    controller.start(CHATGPT, undefined)
    await writing.promise
    const deleteRecord = vi.spyOn(credentials, 'deleteRecord')
    const signedOut = Promise.all([controller.signOut(CHATGPT), controller.signOut(CHATGPT)])
    let refused: unknown
    try { controller.start(CHATGPT, undefined) } catch (error) { refused = error }
    expect(remoteErrorOf(refused)).toMatchObject({ code: 'authorization/unavailable' })
    release.resolve(undefined)
    await signedOut
    expect(deleteRecord).toHaveBeenCalledTimes(1)
    expect(writes).toBe(1)
    expect(await credentials.readRecord(CHATGPT)).toBeUndefined()
    // The sign-out finished, so a new sign-in is accepted again.
    expect(controller.start(CHATGPT, undefined).status).toBe('running')
    expect((await settled(controller, CHATGPT)).status).toBe('authorized')
  })

  it('holds disposal until an admitted commit and a pending sign-out have landed', async () => {
    const writing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const { ctx, controller } = await harness({ [CHATGPT]: session => session.commit(grant) })
    const credentials = ctx.credentials
    const modify = credentials.modifyRecord.bind(credentials)
    let landed = false
    credentials.modifyRecord = async (key, mutate) => {
      writing.resolve(undefined)
      await release.promise
      const stored = await modify(key, mutate)
      landed = true
      return stored
    }
    controller.start(CHATGPT, undefined)
    await writing.promise
    const signedOut = controller.signOut(CHATGPT)
    let disposedFirst = false
    const disposing = ctx.fiber.dispose().then(() => { disposedFirst = !landed })
    await new Promise(resolve => setTimeout(resolve, 0))
    release.resolve(undefined)
    await Promise.all([disposing, signedOut])
    expect(landed).toBe(true)
    expect(disposedFirst).toBe(false)
  })

  it('drops notices and refuses questions from a flow that outlives its cancelled attempt', async () => {
    const late = Promise.withResolvers<undefined>()
    let asked: Promise<string> | undefined
    const { controller } = await harness({
      [CHATGPT]: async (session) => {
        await late.promise
        session.notify({ message: 'after cancel' })
        asked = session.prompt({ kind: 'text', message: 'after cancel' })
        await asked.catch(() => undefined)
      },
    })
    const first = controller.start(CHATGPT, undefined)
    controller.cancel(first.attemptId)
    expect((await settled(controller, CHATGPT)).status).toBe('cancelled')
    late.resolve(undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
    await expect(asked).rejects.toThrow('no longer running')
    expect(await settled(controller, CHATGPT)).toMatchObject({ status: 'cancelled', notices: [] })
  })

  it('moves an open watch to the attempt a restart begins', async () => {
    let calls = 0
    const { controller } = await harness({
      [CHATGPT]: async (session) => {
        calls++
        if (calls === 1) throw new LlmError('first failed', 'X')
        await session.prompt({ kind: 'text', message: 'second' })
      },
    })
    const first = controller.start(CHATGPT, undefined)
    expect((await settled(controller, CHATGPT)).status).toBe('failed')
    const abort = new AbortController()
    const iterator: AsyncIterator<SignInWatchFrame> = controller.watch(CHATGPT, abort.signal)[Symbol.asyncIterator]()
    const opening = await iterator.next()
    expect(opening.done !== true && opening.value.attempt?.attemptId).toBe(first.attemptId)
    const second = controller.start(CHATGPT, undefined)
    const next = await iterator.next()
    expect(next.done !== true && next.value.attempt).toMatchObject({ attemptId: second.attemptId, status: 'running' })
    abort.abort()
    await iterator.next()
    controller.cancel(second.attemptId)
  })

  it('starts a fresh attempt after cancel even while the withdrawn flow is still unwinding', async () => {
    const unwind = Promise.withResolvers<undefined>()
    let calls = 0
    const { controller } = await harness({
      [CHATGPT]: async (session) => {
        calls++
        if (calls === 1) { await unwind.promise; return }
        await session.commit(grant)
      },
    })
    const first = controller.start(CHATGPT, undefined)
    controller.cancel(first.attemptId)
    const second = controller.start(CHATGPT, undefined)
    expect(second.attemptId).not.toBe(first.attemptId)
    unwind.resolve(undefined)
    expect(await settled(controller, CHATGPT)).toMatchObject({ attemptId: second.attemptId, status: 'authorized' })
  })

  it('drops a restart cancelled before the withdrawn flow finished unwinding', async () => {
    const unwind = Promise.withResolvers<undefined>()
    let calls = 0
    const { controller } = await harness({
      [CHATGPT]: async () => { calls++; await unwind.promise },
    })
    const first = controller.start(CHATGPT, undefined)
    controller.cancel(first.attemptId)
    const second = controller.start(CHATGPT, undefined)
    controller.cancel(second.attemptId)
    unwind.resolve(undefined)
    expect(await settled(controller, CHATGPT)).toMatchObject({ attemptId: second.attemptId, status: 'cancelled' })
    expect(calls).toBe(1)
  })

  it('ends open watches and refuses new attempts once disposed', async () => {
    const { ctx, controller } = await harness()
    const iterator = controller.watch(CHATGPT, new AbortController().signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual({ attempt: null })
    const pending = iterator.next()
    await ctx.fiber.dispose()
    expect((await pending).done).toBe(true)
    let error: unknown
    try { controller.start(CHATGPT, undefined) } catch (caught) { error = caught }
    expect(remoteErrorOf(error)).toMatchObject({ code: 'authorization/unavailable' })
  })

  it('keeps only absolute http(s) links in notices', async () => {
    const { controller } = await harness({
      [CHATGPT]: async (session) => {
        session.notify({ message: 'script', url: 'javascript:alert(1)' })
        session.notify({ message: 'relative', url: '/start' })
        session.notify({ message: 'device', url: 'https://device.example/verify', code: 'AB-12' })
        session.notify({ message: 'loopback', url: 'http://127.0.0.1:1455/auth' })
        await session.commit(grant)
      },
    })
    controller.start(CHATGPT, undefined)
    expect((await settled(controller, CHATGPT)).notices).toEqual([
      { message: 'script' },
      { message: 'relative' },
      { message: 'device', url: 'https://device.example/verify', code: 'AB-12' },
      { message: 'loopback', url: 'http://127.0.0.1:1455/auth' },
    ])
  })

  it('opens a watch with null before any attempt and stops on abort', async () => {
    const { controller } = await harness()
    const abort = new AbortController()
    const iterator = controller.watch(CHATGPT, abort.signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual({ attempt: null })
    const pending = iterator.next()
    abort.abort()
    expect((await pending).done).toBe(true)
  })

  it('withdraws running attempts when the controller is disposed', async () => {
    let signal: AbortSignal | undefined
    const { ctx, controller } = await harness({
      [CHATGPT]: async (session) => { signal = session.signal; await session.prompt({ kind: 'text', message: 'q' }) },
    })
    controller.start(CHATGPT, undefined)
    await prompted(controller, CHATGPT)
    await ctx.fiber.dispose()
    expect(signal?.aborted).toBe(true)
  })

  it('fails to load with a malformed flow key', async () => {
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(AuthorizationService)
    expect(() => new AuthorizationController(ctx, { flows: ['not-a-key'] })).toThrow(TypeError)
  })

  it('serves the configured default flows', () => {
    expect(AuthorizationController.Config({} as never)).toEqual({ flows: ['llm-pi-ai/openai-codex', 'llm-kiro/kiro'] })
    expect(KIRO).toBe('llm-kiro/kiro')
  })
})
