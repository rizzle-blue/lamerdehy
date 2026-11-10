/** Human-facing Kiro authorization and credit queries, independent of model turns. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization'
import { HarnessError } from '@deepseek-ai/dsh-llm'

/** Dependencies owned by the Kiro credential and usage implementations. */
export interface KiroCommandOptions {
  /** Owner-scoped grant addressed by the authorization flow. */
  key: CredentialKey
  /** Return a human-readable account usage report, without credential fields. */
  usage(signal: AbortSignal): Promise<string>
}

type LoginState =
  | { kind: 'idle' }
  | { kind: 'pending'; text: string; controller: AbortController; completion: Promise<void> }
  | { kind: 'authorized' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; text: string }

/** Unknown exceptions can contain credentials; only provider-safe errors reach command output. */
function failureText(error: unknown): string {
  return error instanceof HarnessError ? error.message : 'Kiro operation failed. Retry or check the Kiro account service.'
}

function assertNever(value: never): never {
  throw new TypeError(`Unknown Kiro login state: ${String(value)}`)
}

/**
 * Register account commands and cancel any unfinished login on plugin disposal.
 * Login returns the device approval link before polling completes; status reports its settlement.
 * @param ctx - scoped context with commands, credentials, and authorization.
 * @param options - credential address and authenticated usage query.
 */
export function registerKiroCommands(ctx: Context, options: KiroCommandOptions): void {
  let state: LoginState = { kind: 'idle' }
  const status = (): CommandResult => {
    switch (state.kind) {
      case 'idle': return { kind: 'success', text: 'Run /kiro-login to sign in with AWS Builder ID.' }
      case 'pending': return { kind: 'success', text: state.text }
      case 'authorized': return { kind: 'success', text: 'Kiro sign-in completed. Refresh the model list and select a kiro model.' }
      case 'cancelled': return { kind: 'success', text: 'Kiro sign-in cancelled.' }
      case 'failed': return { kind: 'error', text: state.text }
      default: return assertNever(state)
    }
  }
  const cancel = async (): Promise<void> => {
    if (state.kind !== 'pending') return
    const pending = state
    pending.controller.abort()
    await pending.completion
  }
  ctx.effect(() => async () => { await cancel() }, 'kiro: device login')
  ctx.commands.register({
    name: 'kiro-login',
    description: 'Sign in to Kiro with AWS Builder ID or IAM Identity Center',
    input: { hint: '[<start-url> [<region>]|status|cancel]' },
    async handler(invocation) {
      const args = invocation.rawInput.trim().split(/\s+/).filter(Boolean)
      if (args[0] === 'status' && args.length === 1) return status()
      if (args[0] === 'cancel' && args.length === 1) {
        await cancel()
        return status()
      }
      if (args.length > 2 || (args[0] !== undefined && !args[0].startsWith('https://'))) {
        return { kind: 'error', text: 'Usage: /kiro-login [<https-start-url> [<region>]|status|cancel]' }
      }
      if (state.kind === 'pending') return status()
      invocation.signal.throwIfAborted()
      const controller = new AbortController()
      const ready = Promise.withResolvers<void>()
      const pending: Extract<LoginState, { kind: 'pending' }> = {
        kind: 'pending', text: 'Starting Kiro device authorization. Run /kiro-login status for progress.',
        controller, completion: Promise.resolve(),
      }
      state = pending
      const replies = [args[0] ?? '', args[1] ?? '']
      const onAbort = (): void => { controller.abort(invocation.signal.reason) }
      invocation.signal.addEventListener('abort', onAbort, { once: true })
      pending.completion = ctx.authorization.begin({
        key: options.key,
        signal: controller.signal,
        interaction: {
          prompt(prompt) {
            const reply = replies.shift()
            if (prompt.kind !== 'text' || reply === undefined) {
              return Promise.reject(new AuthorizationDeclinedError('Kiro requested an unsupported login prompt'))
            }
            return Promise.resolve(reply)
          },
          notify(notice) {
            if (notice.url !== undefined) {
              pending.text = `${notice.message}\n${notice.url}`
                + (notice.code === undefined ? '' : `\nCode: ${notice.code}`)
                + '\nAfter approval, run /kiro-login status. Use /kiro-login cancel to withdraw.'
              ready.resolve()
            }
          },
        },
      }).then((outcome) => {
        state = outcome.status === 'authorized' ? { kind: 'authorized' } : { kind: 'cancelled' }
      }, (error: unknown) => {
        state = { kind: 'failed', text: failureText(error) }
        ctx.logger.warn('Kiro sign-in failed; /kiro-login status reports the failure. Retry /kiro-login.')
      }).finally(() => { ready.resolve() })
      try {
        await ready.promise
        return status()
      } finally {
        invocation.signal.removeEventListener('abort', onAbort)
      }
    },
  })
  ctx.commands.register({
    name: 'kiro-logout', description: 'Remove the saved Kiro credential',
    async handler() {
      await cancel()
      await ctx.credentials.deleteRecord(options.key)
      state = { kind: 'idle' }
      return { kind: 'success', text: 'Kiro signed out. The saved credential was removed.' }
    },
  })
  ctx.commands.register({
    name: 'kiro-usage', description: 'Show the Kiro plan and remaining credits',
    async handler({ signal }) {
      try {
        return { kind: 'success', text: await options.usage(signal) }
      } catch (error) {
        return { kind: 'error', text: failureText(error) }
      }
    },
  })
}
