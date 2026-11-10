/**
 * Native Kiro provider registration and AWS device authorization for Harness profiles.
 * Wire behavior is adapted from the MIT-licensed omp-kiro-provider; see ../LICENSE.
 * @module @deepseek-ai/dsh-llm-kiro
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { KiroAdapter } from './adapter.ts'
import { KiroAuth, KIRO_CREDENTIAL_KEY } from './auth.ts'
import { Config as KiroSchema } from './config.ts'
import type { KiroConfig } from './config.ts'
import { registerKiroCommands } from './commands.ts'
import { queryUsage, renderUsage } from './usage.ts'

/** Deployment settings for Kiro authorization and inference. */
export interface Config extends KiroConfig {}

/** Validated Kiro deployment settings. */
export const Config = KiroSchema

/** Loader identity for the Kiro adapter. */
export const name = 'llm-kiro'

/** Required provider and credential services. */
export const inject = ['llm', 'credentials', 'authorization']

/**
 * Register Kiro without contacting AWS until authorization or model use.
 * @param ctx - plugin-owned context whose disposal removes registrations.
 * @param config - validated deployment settings.
 */
export function apply(ctx: Context, config: Config): void {
  const auth = new KiroAuth(ctx, config)
  auth.register()
  const adapter = new KiroAdapter(auth, config, {
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref,
    ),
  })
  ctx.llm.registerAdapter(['kiro'], adapter)
  ctx.inject(['commands', 'credentials', 'authorization'], (child) => {
    registerKiroCommands(child, {
      key: KIRO_CREDENTIAL_KEY,
      usage: async signal => renderUsage(await queryUsage(await auth.access(signal), config, signal)),
    })
  })
}
