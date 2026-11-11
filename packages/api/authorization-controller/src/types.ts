/**
 * Wire types of the generated `authorization` Remote namespace: the sign-in
 * rows a settings page lists and the observable state of one running attempt.
 * Client-safe: no Host imports, and no member ever carries a credential value
 * or a prompt answer.
 * @module @deepseek-ai/dsh-api-authorization-controller/types
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
import type { AuthorizationMethod, AuthorizationNotice, AuthorizationPromptOption } from '@deepseek-ai/dsh-authorization/types'

export type { CredentialKey } from '@deepseek-ai/dsh-credentials/types'
export type { AuthorizationMethod, AuthorizationNotice, AuthorizationPromptOption } from '@deepseek-ai/dsh-authorization/types'

/** Identity of one Host-side sign-in attempt. */
export type SignInAttemptId = Branded<'AuthorizationSignInAttemptId'>

/** Identity of one question an attempt is waiting on; a newer question gets a new id. */
export type SignInPromptId = Branded<'AuthorizationSignInPromptId'>

/** One account a settings page can sign in to. */
export interface SignInEntry {
  /** Credential record the sign-in writes. */
  readonly key: CredentialKey
  /** User-facing name of the account. */
  readonly label: string
  /** Sign-in methods the flow offers, most preferred first. */
  readonly methods: readonly AuthorizationMethod[]
  /** Whether a credential record is stored for {@link key}. */
  readonly signedIn: boolean
}

/** The question an attempt is waiting on, without its abort signal. */
export type SignInPromptView = {
  readonly promptId: SignInPromptId
} & ({
  readonly kind: 'text' | 'secret'
  readonly message: string
  readonly placeholder?: string
} | {
  readonly kind: 'select'
  readonly message: string
  readonly options: readonly AuthorizationPromptOption[]
})

/** Lifecycle state of one attempt. */
export type SignInAttemptStatus = 'running' | 'authorized' | 'cancelled' | 'failed'

/** Everything a page renders about one attempt; replaced whole on every change. */
export interface SignInAttemptView {
  readonly attemptId: SignInAttemptId
  readonly key: CredentialKey
  readonly status: SignInAttemptStatus
  /** Notices the flow sent, oldest first. */
  readonly notices: readonly AuthorizationNotice[]
  /** The pending question; present only while `status` is `running`. */
  readonly prompt?: SignInPromptView
  /** Failure text safe to show; present only when `status` is `failed`. */
  readonly error?: string
}

/** One `watch` frame: the latest attempt for the key, or `null` when none has started since the Host began. */
export interface SignInWatchFrame {
  readonly attempt: SignInAttemptView | null
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The key names no sign-in this controller offers. */
    'authorization/unknown-flow': { readonly key: string }
    /** The controller is shutting down and starts no new attempt. */
    'authorization/unavailable': {}
    /** The attempt or question was replaced or already answered. */
    'authorization/stale-prompt': { readonly attemptId: string }
  }
}
