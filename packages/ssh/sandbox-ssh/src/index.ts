/** Remote argv wrapper that selects and applies the sandbox on the SSH host. */
import { NO_RESTRICTIONS, SandboxProvider, SandboxUnavailableError, assertRestrictionsSupported } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import type {} from '@deepseek-ai/dsh-ssh'
import { sandboxReleaseIdSchema } from '@deepseek-ai/dsh-ssh/schemas'
import { z } from 'zod'

const factsSchema = z.object({
  argv: z.array(z.string()).min(1),
  enforcement: z.enum(['full', 'partial']),
  denialSignatures: z.array(z.string()),
  runnerFailureRules: z.array(z.object({
    allowedExitCodes: z.array(z.number().int()).optional(),
    fatalSignatures: z.array(z.string()),
    informationalLines: z.array(z.string()).optional(),
  }).strict()),
  env: z.record(z.string(), z.string()),
  releaseId: sandboxReleaseIdSchema,
}).strict()

/** Resolve each confinement request on the same host as its filesystem and subprocess providers. */
export class SshSandboxProvider extends SandboxProvider {
  static inject = ['ssh']

  override async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    signal?.throwIfAborted()
    // The SSH wire carries no restriction fields, so the remote helper cannot enforce them.
    assertRestrictionsSupported(policy, NO_RESTRICTIONS, 'ssh')
    try {
      const { releaseId, ...confined } = await this.ctx.ssh.request('sandbox', { argv, policy }, factsSchema, signal)
      signal?.throwIfAborted()
      return {
        ...confined,
        runnerFailureRules: confined.runnerFailureRules.map(rule => ({
          fatalSignatures: rule.fatalSignatures,
          ...(rule.allowedExitCodes === undefined ? {} : { allowedExitCodes: rule.allowedExitCodes }),
          ...(rule.informationalLines === undefined ? {} : { informationalLines: rule.informationalLines }),
        })),
        release: async () => {
          try { await this.ctx.ssh.request('sandbox.release', { releaseId }, z.null()) }
          catch (error) {
            // The helper releases every outstanding confinement when the connection closes.
            this.ctx.logger.warn(`sandbox-ssh: releasing remote confinement ${releaseId} failed: ${String(error)}`)
          }
        },
      }
    } catch (error) {
      signal?.throwIfAborted()
      throw new SandboxUnavailableError(policy.mode, error instanceof Error ? error.message : String(error))
    }
  }
}

export default SshSandboxProvider
