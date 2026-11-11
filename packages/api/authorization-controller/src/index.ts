/**
 * Host owner of the `authorization` Remote namespace: lets a settings page
 * list the account sign-ins this composition offers, run one through
 * `ctx.authorization`, answer its questions, cancel it, and sign out.
 *
 * Attempt state lives here rather than in the page, so a reload or a second
 * tab rejoins the running attempt through `watch`. Only flows named by
 * {@link Config.flows} are reachable: `ctx.authorization` also carries flows a
 * product page should not offer, such as every pi-ai catalog provider.
 * @module @deepseek-ai/dsh-api-authorization-controller
 */

import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-authorization'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import type { AuthorizationNotice, AuthorizationOutcome, AuthorizationPrompt } from '@deepseek-ai/dsh-authorization'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SignInAttemptId, SignInAttemptView, SignInEntry, SignInPromptId, SignInPromptView, SignInWatchFrame,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `authorization` Remote namespace. */
    authorizationController: AuthorizationController
  }
}

/** Failure text for an error that is not a {@link HarnessError}, whose message may quote a provider response. */
const GENERIC_FAILURE = 'Sign-in failed. Try again, or check that this computer can reach the account service.'

/** Link schemes a page may open; any other notice link is dropped before it reaches the page. */
const LINK_PROTOCOLS: ReadonlySet<string> = new Set(['https:', 'http:'])

/**
 * The notice as a page may render it: its link survives only as an absolute
 * `http(s)` URL, so a flow cannot hand the page a `javascript:` or `data:` link.
 * @param notice - what the flow reported.
 * @returns the notice with an unsafe or malformed link removed.
 */
function projectNotice(notice: AuthorizationNotice): AuthorizationNotice {
  const { url, ...rest } = notice
  if (url === undefined || (URL.canParse(url) && LINK_PROTOCOLS.has(new URL(url).protocol))) return notice
  return rest
}

/** Deployment policy of the controller. */
export interface Config {
  /** Credential keys (`<scope>/<id>`) whose sign-in the page may offer, in display order. */
  flows: string[]
}

/** The question an attempt is waiting on and the callbacks that settle it. */
interface PendingPrompt {
  readonly view: SignInPromptView
  readonly resolve: (value: string) => void
  readonly reject: (error: Error) => void
}

/** A change to an attempt view; members left out keep their value. */
interface ViewChange {
  readonly status?: SignInAttemptView['status']
  readonly notices?: SignInAttemptView['notices']
  /** `null` removes the pending question. */
  readonly prompt?: SignInPromptView | null
  readonly error?: string
}

/** Mutable Host record of one attempt; {@link SignInAttemptView} is its published projection. */
interface Attempt {
  view: SignInAttemptView
  readonly controller: AbortController
  pending: PendingPrompt | undefined
  /** Settles once `ctx.authorization` reports the attempt's outcome; never rejects. */
  settled: Promise<void>
}

/**
 * Host service backing the generated `ctx.remote.authorization` namespace.
 * No method returns a credential value, and prompt answers are handed to the
 * flow without being retained or echoed.
 */
export class AuthorizationController extends TypertRemoteService {
  static inject = ['authorization', 'credentials']

  static Config: z<Config> = z.object({
    flows: z.array(z.string()).default(['llm-pi-ai/openai-codex', 'llm-kiro/kiro']),
  })

  private readonly flows: readonly CredentialKey[]
  private readonly attempts = new Map<CredentialKey, Attempt>()
  private readonly watchers = new Map<CredentialKey, Set<() => void>>()
  private disposed = false
  /** Sign-outs in progress by key; `start` refuses a key while its sign-out runs. */
  private readonly signingOut = new Map<CredentialKey, Promise<void>>()

  /**
   * @param ctx - Host context carrying `ctx.authorization` and `ctx.credentials`.
   * @param config - the offered flows.
   * @throws TypeError when a configured flow is not a `<scope>/<id>` credential key.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'authorizationController', { namespace: 'authorization' })
    this.flows = config.flows.map(parseCredentialKey)
    ctx.effect(() => async () => {
      this.disposed = true
      const attempts = [...this.attempts.values()]
      for (const attempt of attempts) this.withdraw(attempt)
      // Open watch streams end instead of waiting for a change that can no longer come.
      for (const listeners of this.watchers.values()) for (const listener of listeners) listener()
      // An admitted commit still writes through `ctx.credentials`; hold that dependency until it lands.
      await Promise.all([...attempts.map(attempt => attempt.settled), ...this.signingOut.values()])
    }, 'authorization-controller: running attempts, sign-outs, and watch streams')
  }

  /**
   * The offered sign-ins whose flow is registered right now, in configured order.
   * @returns one entry per available flow with its stored-credential state.
   */
  @Remote
  async list(): Promise<SignInEntry[]> {
    const entries: SignInEntry[] = []
    for (const key of this.flows) {
      const flow = this.ctx.authorization.describe(key)
      if (flow === undefined) continue
      const stored = await this.ctx.credentials.describeRecord(key)
      entries.push({ key, label: flow.label, methods: [...flow.methods], signedIn: stored.configured })
    }
    return entries
  }

  /**
   * Start a sign-in, or return the attempt already running for the key.
   * @param key - an offered credential key.
   * @param method - one of the flow's method ids; omitted runs its first.
   * @returns the attempt's current view; later changes arrive through {@link watch}.
   * @throws RemoteError `authorization/unknown-flow` when the key is not offered.
   * @throws RemoteError `authorization/unavailable` when the controller is shutting down or a
   *   sign-out for the key is in progress.
   */
  @Remote
  start(key: CredentialKey, method: string | undefined): SignInAttemptView {
    const offered = this.offered(key)
    const current = this.attempts.get(offered)
    // A withdrawn attempt may still be unwinding; a new start replaces it instead of joining it.
    if (current !== undefined && this.live(current)) return current.view
    if (this.disposed) throw new RemoteError('authorization/unavailable', 'the sign-in service is shutting down', {})
    // A sign-in begun now could commit after the pending delete and restore what the user removed.
    if (this.signingOut.has(offered)) {
      throw new RemoteError('authorization/unavailable', 'a sign-out for this account is still in progress', {})
    }
    const controller = new AbortController()
    const attempt: Attempt = {
      view: { attemptId: brandString<SignInAttemptId>(randomUUID()), key: offered, status: 'running', notices: [] },
      controller,
      pending: undefined,
      settled: Promise.resolve(),
    }
    this.attempts.set(offered, attempt)
    // Watchers still showing the previous attempt switch to this one.
    this.publish(offered)
    const begin = (): Promise<AuthorizationOutcome> => this.ctx.authorization.begin({
      key: offered,
      ...method === undefined ? {} : { method },
      signal: controller.signal,
      interaction: {
        notify: (notice) => {
          // A withdrawn flow can keep running after its attempt settled; its notices are not shown.
          if (!this.live(attempt)) return
          this.update(attempt, { notices: [...attempt.view.notices, projectNotice(notice)] })
        },
        prompt: prompt => this.ask(attempt, prompt),
      },
    })
    // `ctx.authorization` holds the key until a withdrawn attempt settles, so a
    // restart issued while one is unwinding begins once it has.
    const unwinding = current?.view.status === 'running' ? current.settled : undefined
    attempt.settled = (unwinding === undefined
      ? begin()
      : unwinding.then(() => controller.signal.aborted ? { status: 'cancelled' as const } : begin())
    ).then((outcome) => {
      this.finish(attempt, { status: outcome.status })
    }, (error: unknown) => {
      this.ctx.logger.warn('authorization-controller: sign-in for "%s" failed (%s)', offered,
        error instanceof Error ? error.name : typeof error)
      this.finish(attempt, { status: 'failed', error: error instanceof HarnessError ? error.message : GENERIC_FAILURE })
    })
    return attempt.view
  }

  /**
   * Answer the question a running attempt is waiting on.
   * @param attemptId - the attempt the page is showing.
   * @param promptId - the question the page is showing.
   * @param value - typed text, or the chosen option's id.
   * @throws RemoteError `authorization/stale-prompt` when that question is no longer pending.
   */
  @Remote
  answer(attemptId: SignInAttemptId, promptId: SignInPromptId, value: string): void {
    const attempt = this.byId(attemptId)
    const pending = attempt?.pending
    if (attempt === undefined || pending === undefined || pending.view.promptId !== promptId) {
      throw new RemoteError('authorization/stale-prompt', 'that sign-in question is no longer pending', { attemptId })
    }
    attempt.pending = undefined
    this.update(attempt, { prompt: null })
    pending.resolve(value)
  }

  /**
   * Withdraw a running attempt; an attempt that already settled is left as it is.
   * @param attemptId - the attempt the page is showing.
   */
  @Remote
  cancel(attemptId: SignInAttemptId): void {
    const attempt = this.byId(attemptId)
    if (attempt?.view.status === 'running') this.withdraw(attempt)
  }

  /**
   * Withdraw any running attempt for the key, wait for it to settle, then
   * delete its stored credential. Waiting matters when the attempt is already
   * committing its credential: `ctx.authorization` lets an admitted commit
   * finish, and deleting first would let that commit restore the sign-in.
   * This forgets the sign-in locally; it does not revoke it at the issuer.
   * @param key - an offered credential key.
   * @throws RemoteError `authorization/unknown-flow` when the key is not offered.
   */
  @Remote
  async signOut(key: CredentialKey): Promise<void> {
    const offered = this.offered(key)
    // A second sign-out for the key joins the one in progress.
    const running = this.signingOut.get(offered)
    if (running !== undefined) { await running; return }
    const attempt = this.attempts.get(offered)
    const signingOut = (async () => {
      if (attempt?.view.status === 'running') {
        this.withdraw(attempt)
        await attempt.settled
      }
      await this.ctx.credentials.deleteRecord(offered)
    })().finally(() => { this.signingOut.delete(offered) })
    this.signingOut.set(offered, signingOut)
    await signingOut
  }

  /**
   * Stream the latest attempt for one key: the current state, then one frame per change.
   * @param key - an offered credential key.
   * @param signal - stream lifetime; aborting stops observation, not the attempt.
   * @returns frames carrying the whole attempt view.
   * @throws RemoteError `authorization/unknown-flow` when the key is not offered.
   */
  @Remote({ mode: 'stream' })
  async *watch(key: CredentialKey, signal: AbortSignal): AsyncIterable<SignInWatchFrame> {
    const offered = this.offered(key)
    // Changes since the last frame; set by a change or an abort, cleared when a frame goes out.
    let pending = Promise.withResolvers<undefined>()
    const listener = (): void => { pending.resolve(undefined) }
    const listeners = this.watchers.get(offered) ?? new Set()
    this.watchers.set(offered, listeners)
    listeners.add(listener)
    signal.addEventListener('abort', listener, { once: true })
    try {
      while (!signal.aborted && !this.disposed) {
        const changed = pending.promise
        yield { attempt: this.attempts.get(offered)?.view ?? null }
        await changed
        pending = Promise.withResolvers<undefined>()
      }
    } finally {
      signal.removeEventListener('abort', listener)
      listeners.delete(listener)
      if (listeners.size === 0) this.watchers.delete(offered)
    }
  }

  /** The offered key equal to a wire value, or the refusal. */
  private offered(key: string): CredentialKey {
    const match = this.flows.find(flow => flow === key)
    if (match === undefined) {
      throw new RemoteError('authorization/unknown-flow', `no sign-in is offered for "${key}"`, { key })
    }
    return match
  }

  /** Whether the attempt still runs and has not been withdrawn. */
  private live(attempt: Attempt): boolean {
    return attempt.view.status === 'running' && !attempt.controller.signal.aborted
  }

  private byId(attemptId: SignInAttemptId): Attempt | undefined {
    return [...this.attempts.values()].find(attempt => attempt.view.attemptId === attemptId)
  }

  /**
   * Publish a question and wait for {@link answer}. A question the flow
   * withdraws through its own signal (a browser callback won the race)
   * disappears from the page and rejects with a plain error, which the
   * authorization seam does not read as the human declining.
   */
  private ask(attempt: Attempt, prompt: AuthorizationPrompt): Promise<string> {
    // A withdrawn or settled attempt has no page to ask; the flow unwinds.
    if (!this.live(attempt)) return Promise.reject(new Error('the sign-in attempt is no longer running'))
    if (attempt.pending !== undefined) {
      return Promise.reject(new Error('a sign-in question is already pending'))
    }
    const promptId = brandString<SignInPromptId>(randomUUID())
    const view: SignInPromptView = prompt.kind === 'select'
      ? { promptId, kind: 'select', message: prompt.message, options: prompt.options }
      : {
        promptId,
        kind: prompt.kind,
        message: prompt.message,
        ...prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder },
      }
    return new Promise<string>((resolve, reject) => {
      // Every settlement below removes this listener, so it runs only while this question is pending.
      const withdraw = (): void => {
        attempt.pending = undefined
        this.update(attempt, { prompt: null })
        reject(new Error('the sign-in question was withdrawn'))
      }
      prompt.signal?.addEventListener('abort', withdraw, { once: true })
      const settle = <T>(callback: (value: T) => void) => (value: T): void => {
        prompt.signal?.removeEventListener('abort', withdraw)
        callback(value)
      }
      attempt.pending = { view, resolve: settle(resolve), reject: settle(reject) }
      this.update(attempt, { prompt: view })
      if (prompt.signal?.aborted === true) withdraw()
    })
  }

  /** Abort a running attempt and decline its pending question so the flow can unwind. */
  private withdraw(attempt: Attempt): void {
    attempt.controller.abort()
    const pending = attempt.pending
    attempt.pending = undefined
    pending?.reject(new AuthorizationDeclinedError('the sign-in was cancelled'))
  }

  private finish(attempt: Attempt, change: Pick<ViewChange, 'status' | 'error'>): void {
    const pending = attempt.pending
    attempt.pending = undefined
    pending?.reject(new Error('the sign-in attempt ended'))
    this.update(attempt, { ...change, prompt: null })
  }

  /** Replace the attempt's view and wake every watcher of its key. */
  private update(attempt: Attempt, change: ViewChange): void {
    const view = attempt.view
    const prompt = change.prompt === undefined ? view.prompt : change.prompt ?? undefined
    const error = change.error ?? view.error
    attempt.view = {
      attemptId: view.attemptId,
      key: view.key,
      status: change.status ?? view.status,
      notices: change.notices ?? view.notices,
      ...prompt === undefined ? {} : { prompt },
      ...error === undefined ? {} : { error },
    }
    if (this.attempts.get(attempt.view.key) !== attempt) return
    this.publish(attempt.view.key)
  }

  /** Wake every watcher of one key. */
  private publish(key: CredentialKey): void {
    for (const listener of this.watchers.get(key) ?? []) listener()
  }
}

export default AuthorizationController
