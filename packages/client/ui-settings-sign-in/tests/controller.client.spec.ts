/** Section state follows the Host attempt, drives every Remote call, and survives call and stream failures. */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteError, TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type {
  CredentialKey, SignInAttemptView, SignInEntry, SignInWatchFrame,
} from '@deepseek-ai/dsh-api-authorization-controller/types'
import { SignInController } from '../src/client/controller.ts'

const CHATGPT = 'llm-pi-ai/openai-codex' as CredentialKey
const KIRO = 'llm-kiro/kiro' as CredentialKey

const roots: Context[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

const entries = (signedIn = false): SignInEntry[] => [
  { key: CHATGPT, label: 'ChatGPT', methods: [{ id: 'oauth', label: 'Browser' }], signedIn },
  { key: KIRO, label: 'Kiro', methods: [{ id: 'device', label: 'Device' }], signedIn: false },
]

function view(rest: Partial<SignInAttemptView> = {}): SignInAttemptView {
  return { attemptId: 'a1' as SignInAttemptView['attemptId'], key: CHATGPT, status: 'running', notices: [], ...rest }
}

/** A scripted Remote result; failures share the success type so one mock can return either. */
type Result<T> = { ok: true; value: T } | { ok: false; error: RemoteError }
const ok = <T>(value: T): Promise<Result<T>> => Promise.resolve({ ok: true, value })
const fail = <T = never>(code: 'gateway/internal' | 'authorization/stale-prompt' = 'gateway/internal'): Promise<Result<T>> =>
  Promise.resolve({ ok: false, error: new RemoteError(code, 'refused', code === 'gateway/internal' ? {} : { attemptId: 'a1' }) })

/** A watch stream the spec pushes frames into, shaped like the Gateway's RemoteStream. */
class FakeStream {
  readonly accepted: SignInWatchFrame[] = []
  disposed = false
  /** Keep delivering after dispose, standing in for a frame already in flight. */
  ignoreDispose = false
  private queue: SignInWatchFrame[] = []
  private wake: (() => void) | undefined
  private failure: Error | undefined

  push(frame: SignInWatchFrame): void { this.queue.push(frame); this.wake?.() }
  fail(error: Error): void { this.failure = error; this.wake?.() }
  dispose(): Promise<void> { this.disposed = !this.ignoreDispose; this.wake?.(); return Promise.resolve() }

  async *[Symbol.asyncIterator](): AsyncGenerator<{ value: SignInWatchFrame; accept: () => void }> {
    while (!this.disposed) {
      const next = this.queue.shift()
      if (next !== undefined) {
        yield { value: next, accept: () => { this.accepted.push(next) } }
        continue
      }
      if (this.failure !== undefined) throw this.failure
      await new Promise<void>((resolve) => { this.wake = resolve })
    }
  }
}

async function bench(authorization: Record<string, unknown> = {}) {
  const ctx = new Context()
  roots.push(ctx)
  const streams: FakeStream[] = []
  const opened: string[] = []
  const face = {
    list: vi.fn(() => ok(entries())),
    start: vi.fn(() => ok(view())),
    answer: vi.fn(() => ok(undefined)),
    cancel: vi.fn(() => ok(undefined)),
    signOut: vi.fn(() => ok(undefined)),
    watch: vi.fn((key: string) => { opened.push(key); return (async function* () {})() }),
    ...authorization,
  }
  new TestRemote(ctx, {
    authorization: face,
    $stream: (options: { open: (signal: AbortSignal) => unknown; ended: () => Error }) => {
      options.open(new AbortController().signal)
      expect(options.ended().message).toBe('authorization watch ended')
      const stream = new FakeStream()
      streams.push(stream)
      return stream
    },
  })
  const controller = new SignInController(ctx)
  await controller.refresh()
  return { ctx, controller, face, streams, opened, actions: controller.inject() }
}

const flush = async (): Promise<void> => { for (let index = 0; index < 10; index++) await Promise.resolve() }

describe('SignInController', () => {
  it('loads the offered sign-ins and reports a failed read', async () => {
    const { controller, face } = await bench()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', entries: entries() })
    face.list.mockImplementationOnce(() => fail())
    await controller.refresh()
    expect(controller.store.getSnapshot().status).toBe('failed')
  })

  it('drops a list read that a newer read or disposal overtook', async () => {
    const slow = Promise.withResolvers<{ ok: true; value: SignInEntry[] }>()
    const { controller, face } = await bench()
    face.list.mockImplementationOnce(() => slow.promise)
    const pending = controller.refresh()
    controller.dispose()
    slow.resolve({ ok: true, value: [] })
    await pending
    expect(controller.store.getSnapshot().entries).toEqual(entries())
  })

  it('opens the dialog, starts the attempt, and follows Host frames', async () => {
    const { controller, actions, face, streams, opened } = await bench()
    actions.start(CHATGPT)
    expect(controller.store.getSnapshot().open).toMatchObject({ key: CHATGPT, label: 'ChatGPT', attempt: null, failed: false })
    await flush()
    expect(face.start).toHaveBeenCalledWith(CHATGPT, undefined)
    expect(opened).toEqual([CHATGPT])
    expect(controller.store.getSnapshot().open?.attempt).toEqual(view())
    const prompt = { promptId: 'p1' as never, kind: 'text' as const, message: 'Start URL' }
    streams[0]!.push({ attempt: view({ prompt }) })
    await flush()
    expect(streams[0]!.accepted).toHaveLength(1)
    expect(controller.store.getSnapshot().open?.attempt?.prompt).toEqual(prompt)
    actions.answer('https://org.awsapps.com/start')
    await flush()
    expect(face.answer).toHaveBeenCalledWith('a1', 'p1', 'https://org.awsapps.com/start')
  })

  it('opens observation only after the start response, avoiding an older attempt baseline', async () => {
    const started = Promise.withResolvers<{ ok: true; value: SignInAttemptView }>()
    const { controller, actions, face, streams } = await bench()
    face.start.mockImplementationOnce(() => started.promise)
    actions.start(CHATGPT)
    await flush()
    expect(streams).toHaveLength(0)
    started.resolve({ ok: true, value: view() })
    await flush()
    streams[0]!.push({ attempt: view({ notices: [{ message: 'newer' }] }) })
    await flush()
    expect(controller.store.getSnapshot().open?.attempt?.notices).toEqual([{ message: 'newer' }])
  })

  it('refreshes the list once a followed attempt is authorized', async () => {
    const { actions, face, streams } = await bench()
    actions.start(CHATGPT)
    await flush()
    face.list.mockClear()
    streams[0]!.push({ attempt: view({ status: 'authorized' }) })
    await flush()
    expect(face.list).toHaveBeenCalledTimes(1)
  })

  it('marks the dialog failed when a call or the stream fails', async () => {
    const { controller, actions, face, streams } = await bench({ start: vi.fn(() => fail()) })
    actions.start(CHATGPT)
    await flush()
    expect(controller.store.getSnapshot().open?.failed).toBe(true)
    actions.close()
    await flush()
    face.start.mockImplementation(() => ok(view()))
    actions.start(KIRO)
    await flush()
    expect(controller.store.getSnapshot().open).toMatchObject({ key: KIRO, failed: false })
    streams.at(-1)!.fail(new Error('carrier gone'))
    await flush()
    expect(controller.store.getSnapshot().open?.failed).toBe(true)
  })

  it('ignores a stale answer and reports other answer failures', async () => {
    const { controller, actions, face, streams } = await bench()
    actions.start(CHATGPT)
    await flush()
    streams[0]!.push({ attempt: view({ prompt: { promptId: 'p1' as never, kind: 'secret', message: 'Paste' } }) })
    await flush()
    face.answer.mockImplementationOnce(() => fail('authorization/stale-prompt'))
    actions.answer('x')
    await flush()
    expect(controller.store.getSnapshot().open?.failed).toBe(false)
    face.answer.mockImplementationOnce(() => fail())
    actions.answer('x')
    await flush()
    expect(controller.store.getSnapshot().open?.failed).toBe(true)
  })

  it('does nothing for an answer or cancel without a matching attempt', async () => {
    const { actions, face, streams } = await bench()
    actions.answer('x')
    actions.cancel()
    actions.start('llm-none/none' as CredentialKey)
    await flush()
    expect(face.start).not.toHaveBeenCalled()
    actions.start(CHATGPT)
    await flush()
    actions.answer('x')
    streams[0]!.push({ attempt: view({ status: 'cancelled' }) })
    await flush()
    actions.cancel()
    await flush()
    expect(face.answer).not.toHaveBeenCalled()
    expect(face.cancel).not.toHaveBeenCalled()
  })

  it('drops an answer failure that arrives after the dialog closed', async () => {
    const answered = Promise.withResolvers<Result<undefined>>()
    const { controller, actions, face, streams } = await bench()
    face.answer.mockImplementationOnce(() => answered.promise)
    actions.start(CHATGPT)
    await flush()
    streams[0]!.push({ attempt: view({ prompt: { promptId: 'p1' as never, kind: 'text', message: 'q' } }) })
    await flush()
    actions.answer('x')
    actions.close()
    answered.resolve(await fail<undefined>())
    await flush()
    expect(controller.store.getSnapshot().open).toBeUndefined()
  })

  it('cancels a running attempt and reports a failed cancel', async () => {
    const { controller, actions, face } = await bench()
    actions.start(CHATGPT)
    await flush()
    actions.cancel()
    await flush()
    expect(face.cancel).toHaveBeenCalledWith('a1')
    face.cancel.mockImplementationOnce(() => fail())
    actions.cancel()
    await flush()
    expect(controller.store.getSnapshot().open?.failed).toBe(true)
  })

  it('closes the dialog, withdrawing a running attempt and dropping its stream', async () => {
    const { controller, actions, face, streams } = await bench()
    actions.start(CHATGPT)
    await flush()
    actions.close()
    await flush()
    expect(controller.store.getSnapshot().open).toBeUndefined()
    expect(face.cancel).toHaveBeenCalledWith('a1')
    expect(streams[0]!.disposed).toBe(true)
    actions.close()
    await flush()
    expect(face.cancel).toHaveBeenCalledTimes(1)
  })

  it('drops a start response for a dialog the user already closed', async () => {
    const started = Promise.withResolvers<{ ok: true; value: SignInAttemptView }>()
    const { controller, actions, face } = await bench()
    face.start.mockImplementationOnce(() => started.promise)
    actions.start(CHATGPT)
    actions.close()
    started.resolve({ ok: true, value: view() })
    await flush()
    expect(controller.store.getSnapshot().open).toBeUndefined()
    expect(face.cancel).toHaveBeenCalledWith('a1')
  })

  it('reopens observation when the same sign-in restarts', async () => {
    const { actions, streams } = await bench()
    actions.start(CHATGPT)
    await flush()
    actions.start(CHATGPT)
    await flush()
    expect(streams).toHaveLength(2)
    expect(streams[0]!.disposed).toBe(true)
  })

  it('stops applying frames from a stream it replaced', async () => {
    const { controller, actions, streams } = await bench()
    actions.start(CHATGPT)
    await flush()
    streams[0]!.ignoreDispose = true
    actions.start(KIRO)
    await flush()
    streams[0]!.push({ attempt: view({ notices: [{ message: 'stale' }] }) })
    await flush()
    expect(controller.store.getSnapshot().open?.attempt?.notices).toEqual([])
    streams[0]!.fail(new Error('late'))
    await flush()
    expect(controller.store.getSnapshot().open?.failed).toBe(false)
    streams[1]!.push({ attempt: view({ key: KIRO, notices: [{ message: 'live' }] }) })
    await flush()
    expect(controller.store.getSnapshot().open?.attempt?.notices).toEqual([{ message: 'live' }])
  })

  it('ignores a failure of a stream it replaced', async () => {
    const { controller, actions, streams } = await bench()
    actions.start(CHATGPT)
    await flush()
    streams[0]!.ignoreDispose = true
    actions.start(KIRO)
    await flush()
    streams[0]!.fail(new Error('late'))
    await flush()
    expect(controller.store.getSnapshot().open?.failed).toBe(false)
  })

  it('ignores frames for a sign-in that is no longer open', async () => {
    const { controller, actions, streams } = await bench()
    actions.start(CHATGPT)
    await flush()
    controller.store.update((draft) => { delete draft.open })
    streams[0]!.push({ attempt: view() })
    await flush()
    expect(controller.store.getSnapshot().open).toBeUndefined()
  })

  it('confirms sign-out before deleting, then refreshes', async () => {
    const { controller, actions, face } = await bench()
    actions.requestSignOut('llm-none/none' as CredentialKey)
    expect(controller.store.getSnapshot().confirmSignOut).toBeUndefined()
    actions.requestSignOut(CHATGPT)
    expect(controller.store.getSnapshot().confirmSignOut).toEqual({ key: CHATGPT, label: 'ChatGPT' })
    actions.confirmSignOut(false)
    await flush()
    expect(face.signOut).not.toHaveBeenCalled()
    actions.confirmSignOut(true)
    await flush()
    expect(face.signOut).not.toHaveBeenCalled()
    actions.requestSignOut(CHATGPT)
    face.list.mockClear()
    actions.confirmSignOut(true)
    await flush()
    expect(face.signOut).toHaveBeenCalledWith(CHATGPT)
    expect(face.list).toHaveBeenCalledTimes(1)
    expect(controller.store.getSnapshot().confirmSignOut).toBeUndefined()
  })

  it('shows a failed sign-out until the next read succeeds', async () => {
    const { controller, actions, face } = await bench({ signOut: vi.fn(() => fail()) })
    face.list.mockImplementation(() => fail())
    actions.requestSignOut(CHATGPT)
    actions.confirmSignOut(true)
    await flush()
    expect(controller.store.getSnapshot().confirmSignOut?.failed).toBe(true)
  })

  it('opens sign-in pages in a new tab without an opener', async () => {
    const open = vi.fn()
    vi.stubGlobal('open', open)
    const { actions } = await bench()
    actions.openUrl('https://auth.example/start')
    expect(open).toHaveBeenCalledWith('https://auth.example/start', '_blank', 'noopener,noreferrer')
  })
})
