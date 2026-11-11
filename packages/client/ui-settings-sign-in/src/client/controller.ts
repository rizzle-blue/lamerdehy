/**
 * Page state for the subscription-account sign-ins on the Models page: the
 * offered sign-ins with their stored-credential state, and the one attempt
 * the user opened in the dialog. Attempt state belongs to the Host; this
 * controller mirrors it through `authorization.watch` so a reload or second
 * tab shows the same attempt.
 * @module @deepseek-ai/dsh-client-ui-settings-sign-in/controller
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {
  CredentialKey, SignInAttemptView, SignInEntry, SignInWatchFrame,
} from '@deepseek-ai/dsh-api-authorization-controller/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'

/** What the section renders. */
export interface SignInState {
  /** `loading` until the first list read settles. */
  status: 'loading' | 'ready' | 'failed'
  entries: readonly SignInEntry[]
  /** The sign-in shown in the dialog; absent while it is closed. */
  open?: {
    key: CredentialKey
    label: string
    /** Latest Host attempt for the key; `null` until the Host reports one. */
    attempt: SignInAttemptView | null
    /** Whether a Remote call from the dialog failed; the Host state is unknown. */
    failed: boolean
  }
  /** The sign-in awaiting sign-out confirmation. */
  confirmSignOut?: { readonly key: CredentialKey; readonly label: string; failed?: boolean }
}

/** Inject face of the section entry. */
export interface SignInFace {
  hooks: {
    /** Section snapshot bound by the renderer as useSignIn. */
    signIn: SnapshotStore<SignInState>
  }
  /** Open the dialog and start, or rejoin, the attempt. */
  start: (key: CredentialKey) => void
  /** Answer the dialog's pending question. */
  answer: (value: string) => void
  /** Withdraw the running attempt; the dialog stays open showing the result. */
  cancel: () => void
  /** Close the dialog, withdrawing a running attempt. */
  close: () => void
  /** Ask to sign out of one account. */
  requestSignOut: (key: CredentialKey) => void
  /** Confirm or dismiss the pending sign-out. */
  confirmSignOut: (confirmed: boolean) => void
  /** Retry reading the account list after a failed read. */
  retry: () => void
  /** Open a sign-in page in a new browser tab. */
  openUrl: (url: string) => void
}

/** Section state and Remote calls for one browser plugin instance. */
export class SignInController {
  /** Section snapshot; the renderer binds it as `useSignIn`. */
  readonly store: SnapshotStore<SignInState> = createSnapshotStore<SignInState>({ status: 'loading', entries: [] })
  private watching: { key: CredentialKey; dispose: () => void } | undefined
  private generation = 0
  private dialogRevision = 0

  /** @param ctx - the browser plugin context carrying `ctx.remote`. */
  constructor(private readonly ctx: ClientContext) {}

  /** Re-read the offered sign-ins; a stale read is dropped. */
  async refresh(): Promise<void> {
    const generation = ++this.generation
    const result = await this.ctx.remote.authorization.list()
    if (generation !== this.generation) return
    this.store.update((draft) => {
      if (result.ok) {
        draft.status = 'ready'
        draft.entries = result.value
      } else {
        draft.status = 'failed'
      }
    })
  }

  /** Stop following the open attempt. Host attempts keep running. */
  dispose(): void {
    this.generation++
    this.dialogRevision++
    this.unwatch()
  }

  /**
   * Build the inject face handed to the section component.
   * @returns the snapshot hook source and the section actions.
   */
  inject(): SignInFace {
    return {
      hooks: { signIn: this.store },
      start: (key) => { void this.start(key) },
      answer: (value) => { void this.answer(value) },
      cancel: () => { void this.cancel() },
      close: () => { void this.close() },
      requestSignOut: (key) => {
        const entry = this.store.getSnapshot().entries.find(candidate => candidate.key === key)
        if (entry === undefined) return
        this.store.update((draft) => { draft.confirmSignOut = { key, label: entry.label } })
      },
      confirmSignOut: (confirmed) => { void this.confirmSignOut(confirmed) },
      retry: () => { void this.refresh() },
      openUrl: (url) => { globalThis.open(url, '_blank', 'noopener,noreferrer') },
    }
  }

  private async start(key: CredentialKey): Promise<void> {
    const entry = this.store.getSnapshot().entries.find(candidate => candidate.key === key)
    if (entry === undefined) return
    const revision = ++this.dialogRevision
    this.unwatch()
    this.store.update((draft) => { draft.open = { key, label: entry.label, attempt: null, failed: false } })
    const started = await this.ctx.remote.authorization.start(key, undefined)
    if (revision !== this.dialogRevision) {
      // Closing before start returns must still withdraw the attempt it created.
      // A newer dialog for this key has rejoined that attempt and owns it instead.
      if (started.ok && started.value.status === 'running' && this.store.getSnapshot().open?.key !== key) {
        await this.ctx.remote.authorization.cancel(started.value.attemptId)
      }
      return
    }
    this.store.update((draft) => {
      if (draft.open === undefined) return
      if (started.ok) draft.open.attempt = started.value
      else draft.open.failed = true
    })
    // Open after the start response so a baseline for the previous attempt cannot overwrite it.
    if (started.ok) this.watch(key)
  }

  private async answer(value: string): Promise<void> {
    const prompt = this.store.getSnapshot().open?.attempt?.prompt
    const attempt = this.store.getSnapshot().open?.attempt
    if (attempt === undefined || attempt === null || prompt === undefined) return
    const revision = this.dialogRevision
    const result = await this.ctx.remote.authorization.answer(attempt.attemptId, prompt.promptId, value)
    // A stale question means a newer frame is already on its way; nothing to show.
    if (revision === this.dialogRevision && !result.ok && result.error.code !== 'authorization/stale-prompt') this.markFailed()
  }

  private async cancel(): Promise<void> {
    const attempt = this.store.getSnapshot().open?.attempt
    if (attempt === undefined || attempt === null || attempt.status !== 'running') return
    const revision = this.dialogRevision
    const result = await this.ctx.remote.authorization.cancel(attempt.attemptId)
    if (revision === this.dialogRevision && !result.ok) this.markFailed()
  }

  private async close(): Promise<void> {
    this.dialogRevision++
    const attempt = this.store.getSnapshot().open?.attempt
    this.unwatch()
    this.store.update((draft) => { delete draft.open })
    if (attempt !== undefined && attempt !== null && attempt.status === 'running') {
      await this.ctx.remote.authorization.cancel(attempt.attemptId)
    }
  }

  private async confirmSignOut(confirmed: boolean): Promise<void> {
    const target = this.store.getSnapshot().confirmSignOut
    if (!confirmed) {
      this.store.update((draft) => { delete draft.confirmSignOut })
      return
    }
    if (target === undefined) return
    const result = await this.ctx.remote.authorization.signOut(target.key)
    if (!result.ok) {
      this.store.update((draft) => { if (draft.confirmSignOut?.key === target.key) draft.confirmSignOut.failed = true })
      return
    }
    this.store.update((draft) => { delete draft.confirmSignOut })
    await this.refresh()
  }

  private markFailed(): void {
    this.store.update((draft) => { if (draft.open !== undefined) draft.open.failed = true })
  }

  private watch(key: CredentialKey): void {
    if (this.watching?.key === key) return
    this.unwatch()
    const stream = this.ctx.remote.$stream<SignInWatchFrame>({
      name: 'authorization',
      open: signal => this.ctx.remote.authorization.watch(key, signal),
      ended: () => new Error('authorization watch ended'),
    })
    const watching = { key, dispose: () => { void stream.dispose() } }
    this.watching = watching
    void (async () => {
      for await (const frame of stream) {
        if (this.watching !== watching) return
        frame.accept()
        const attempt = frame.value.attempt
        this.store.update((draft) => {
          if (draft.open?.key === key) draft.open.attempt = attempt
        })
        if (attempt !== null && attempt.status === 'authorized') void this.refresh()
      }
    })().catch(() => { if (this.watching === watching) this.markFailed() })
  }

  private unwatch(): void {
    const watching = this.watching
    this.watching = undefined
    watching?.dispose()
  }
}
