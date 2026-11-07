/**
 * The `srt` rung: Linux and macOS confinement of read denies, protected write
 * paths and network host allowlists through `@anthropic-ai/sandbox-runtime`.
 * The runtime's `SandboxManager` is process-global, so one provider owns it
 * for the process lifetime and every call is wrapped under its own command id.
 * @module @deepseek-ai/dsh-sandbox-local/srt
 */

import { randomBytes } from 'node:crypto'
import { isAbsolute, relative } from 'node:path'
import type { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import {
  SandboxUnsupportedPolicyError, requestedRestrictions, writableRoots,
} from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, RunnerFailureRule, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'

/** The `SandboxManager` operations the rung uses; tests substitute a fake. */
export type SrtManager = Pick<
  typeof SandboxManager,
  | 'initialize' | 'checkDependencies' | 'wrapWithSandboxArgv' | 'registerCommandNetworkLists'
  | 'unregisterCommandNetworkLists' | 'cleanupAfterCommand' | 'reset'
>

/** Platforms the srt rung confines; Windows needs the srt-win principal install. */
export const SRT_PLATFORMS = ['linux', 'darwin'] as const

/** A platform the srt rung confines. */
export type SrtPlatform = typeof SRT_PLATFORMS[number]

/**
 * Whether the srt rung confines `platform`.
 * @param platform - a `process.platform` value.
 * @returns true for Linux and macOS, narrowing the type.
 */
export function isSrtPlatform(platform: string): platform is SrtPlatform {
  return (SRT_PLATFORMS as readonly string[]).includes(platform)
}

/** Denial text each platform's srt profile produces for a denied file effect. */
const SRT_DENIAL_SIGNATURES: Record<SrtPlatform, readonly string[]> = {
  linux: ['read-only file system'],
  darwin: ['operation not permitted'],
}

/** Runner-owned fatal diagnostics: bubblewrap on Linux, `sandbox-exec` on macOS. */
const SRT_RUNNER_FAILURE_RULES: Record<SrtPlatform, readonly RunnerFailureRule[]> = {
  linux: [{ fatalSignatures: ['bwrap: '] }],
  darwin: [{ fatalSignatures: ['sandbox-exec: '] }],
}

/** Token of the rung that owns the process-global `SandboxManager`; a second rung cannot initialize it. */
let owner: symbol | undefined

/** Quote one argv element for a POSIX shell command line. */
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", "'\\''")}'`
}

/** Whether `path` is `parent` or lies beneath it. */
function isWithin(parent: string, path: string): boolean {
  const rel = relative(parent, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/* v8 ignore start -- the real runtime import is exercised by tests/srt.e2e.ts, which the unit coverage lane does not run */
/**
 * Load the pinned srt runtime's process-global manager.
 * @returns the manager.
 */
async function loadSandboxRuntime(): Promise<SrtManager> {
  return (await import('@anthropic-ai/sandbox-runtime')).SandboxManager
}
/* v8 ignore stop */

/**
 * Loads and drives srt for one provider. All state lives in the runtime's
 * process-global manager; this class owns its initialization, the per-call
 * registrations and the reference count that gates host-mount cleanup.
 */
export class SrtRung {
  private manager: Promise<SrtManager> | undefined
  private readonly token = Symbol('srt-rung')
  /** Confined commands wrapped and not yet released. */
  private inFlight = 0

  /**
   * @param platform - the `process.platform` value this rung confines for.
   * @param load - resolves the runtime's manager; defaults to the pinned package.
   */
  constructor(
    private readonly platform: SrtPlatform,
    private readonly load: () => Promise<SrtManager> = loadSandboxRuntime,
  ) {}

  /**
   * Wrap `argv` under `policy`'s read denies, write denies and network list.
   * @param argv - the exact argv the caller will spawn.
   * @param policy - a policy requesting at least one restriction field.
   * @param signal - cancellation while the runtime resolves paths and starts its proxy.
   * @returns the wrapped argv, the variables to merge, and the release hook for this call.
   * @throws SandboxUnsupportedPolicyError when the policy lacks a network list, a dependency is
   *   missing, or the process-global manager is owned by another provider.
   */
  async confine(argv: readonly string[], policy: SandboxPolicy, signal?: AbortSignal): Promise<ConfinedArgv> {
    if (policy.network === undefined) {
      throw new SandboxUnsupportedPolicyError(
        'sandbox backend "srt" routes every confined call through its proxy, so read and write denies need '
        + 'a network policy; add network.allowedDomains (an empty list denies all network)',
      )
    }
    const requested = requestedRestrictions(policy)
    const manager = await this.ready(signal)
    const roots = writableRoots(policy)
    const denyRead = [...(policy.denyRead ?? [])]
    // A root beneath a denied path (the workspace inside a denied DSH home) stays readable.
    const rootsBeneathDenies = roots.filter(root => denyRead.some(denied => isWithin(denied, root)))
    const commandId = randomBytes(16).toString('base64url')
    const { argv: wrapped } = await manager.wrapWithSandboxArgv(
      argv.map(shellQuote).join(' '),
      undefined,
      {
        filesystem: {
          allowWrite: roots,
          denyRead,
          ...(requested.denyRead ? { allowRead: [...(policy.allowRead ?? []), ...rootsBeneathDenies] } : {}),
          denyWrite: [...(policy.denyWrite ?? [])],
        },
      },
      signal,
      policy.workspaceRoot,
      { commandId },
    )
    this.inFlight++
    let released = false
    const release = (): Promise<void> => {
      if (released) return Promise.resolve()
      released = true
      try { manager.unregisterCommandNetworkLists(commandId) }
      finally {
        this.inFlight--
        if (this.inFlight === 0) manager.cleanupAfterCommand()
      }
      return Promise.resolve()
    }
    try {
      manager.registerCommandNetworkLists(commandId, { allowedDomains: [...policy.network.allowedDomains] })
    } catch (error) {
      await release()
      throw error
    }
    return {
      argv: wrapped,
      enforcement: 'full',
      denialSignatures: SRT_DENIAL_SIGNATURES[this.platform],
      runnerFailureRules: SRT_RUNNER_FAILURE_RULES[this.platform],
      // Node 22.21+ and 24.5+ read the proxy variables baked into the wrapped command only when this is set.
      env: { NODE_USE_ENV_PROXY: '1' },
      release,
    }
  }

  /**
   * Release the process-global manager when this provider is disposed.
   * @returns resolves once the runtime has stopped its proxies and removed mount points.
   */
  async dispose(): Promise<void> {
    if (this.manager === undefined) return
    const pending = this.manager
    this.manager = undefined
    owner = undefined
    let manager: SrtManager
    try { manager = await pending }
    catch { return } // The start already failed and reported its error to the caller that awaited it.
    await manager.reset()
  }

  /** Initialize the manager once, with an empty allowlist that per-call lists extend; a failed start is retried by the next call. */
  private ready(signal?: AbortSignal): Promise<SrtManager> {
    signal?.throwIfAborted()
    this.manager ??= this.start().catch((error: unknown) => {
      this.manager = undefined
      throw error
    })
    return this.manager
  }

  private async start(): Promise<SrtManager> {
    if (owner !== undefined && owner !== this.token) {
      throw new SandboxUnsupportedPolicyError('sandbox backend "srt" is already owned by another sandbox-local provider in this process')
    }
    owner = this.token
    try {
      const manager = await this.load()
      const { errors } = manager.checkDependencies()
      if (errors.length > 0) {
        throw new SandboxUnsupportedPolicyError(
          `sandbox backend "srt" is unavailable on ${this.platform}: ${errors.join('; ')}. `
          + 'Install bubblewrap, socat and ripgrep (Linux) to enforce read denies, write denies and network allowlists',
        )
      }
      await manager.initialize({
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      })
      return manager
    } catch (error) {
      owner = undefined
      throw error
    }
  }
}
