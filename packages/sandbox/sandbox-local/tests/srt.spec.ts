import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '../src/index.ts'
import type { SrtManager } from '../src/srt.ts'

const WS = '/ws'
const policy = (extra: Partial<SandboxPolicy> = {}): SandboxPolicy => ({
  mode: 'workspace-write', workspaceRoot: WS, network: { allowedDomains: ['example.com'] }, ...extra,
})

/** A manager double that records every call; `errors` makes the dependency check fail. */
function fakeManager(errors: string[] = []) {
  const manager = {
    initialize: vi.fn<SrtManager['initialize']>(() => Promise.resolve()),
    checkDependencies: vi.fn<SrtManager['checkDependencies']>(() => ({ errors, warnings: [] })),
    wrapWithSandboxArgv: vi.fn<SrtManager['wrapWithSandboxArgv']>(command => Promise.resolve({ argv: ['/bin/bash', '-c', `wrapped: ${command}`], env: {} })),
    registerCommandNetworkLists: vi.fn<SrtManager['registerCommandNetworkLists']>(),
    unregisterCommandNetworkLists: vi.fn<SrtManager['unregisterCommandNetworkLists']>(),
    cleanupAfterCommand: vi.fn<SrtManager['cleanupAfterCommand']>(),
    reset: vi.fn<SrtManager['reset']>(() => Promise.resolve()),
  } satisfies SrtManager
  return manager
}

const contexts: Context[] = []

async function setup(manager: SrtManager, platform = 'linux') {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LocalSandboxProvider, {})
  const sandbox = ctx.sandbox as LocalSandboxProvider
  sandbox.internals = { platform, srtManager: () => Promise.resolve(manager) }
  return { ctx, sandbox }
}

afterEach(async () => {
  // Disposing each provider releases the process-global manager owner.
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('srt rung', () => {
  it('wraps the shell-quoted argv with the call\'s deny lists, roots and per-call host list', async () => {
    const manager = fakeManager()
    const { sandbox } = await setup(manager)
    const confined = await sandbox.confine(['node', '-e', "console.log('hi')"], policy({
      denyRead: ['/home/u/.ssh'], denyWrite: [`${WS}/.git/hooks`],
    }))

    expect(manager.initialize).toHaveBeenCalledOnce()
    expect(manager.initialize.mock.calls[0]?.[0]).toMatchObject({ network: { allowedDomains: [] } })
    const [command, binShell, custom, , cwd, options] = manager.wrapWithSandboxArgv.mock.calls[0] ?? []
    expect(command).toBe(String.raw`'node' '-e' 'console.log('\''hi'\'')'`)
    expect(binShell).toBeUndefined()
    expect(custom?.filesystem).toMatchObject({ denyRead: ['/home/u/.ssh'], denyWrite: [`${WS}/.git/hooks`] })
    expect(custom?.filesystem?.allowWrite).toContain(WS)
    expect(cwd).toBe(WS)
    expect(options?.commandId).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(manager.registerCommandNetworkLists).toHaveBeenCalledWith(options?.commandId, { allowedDomains: ['example.com'] })
    expect(confined).toMatchObject({
      argv: ['/bin/bash', '-c', expect.stringContaining('wrapped:')], enforcement: 'full',
      env: { NODE_USE_ENV_PROXY: '1' }, denialSignatures: ['read-only file system'],
      runnerFailureRules: [{ fatalSignatures: ['bwrap: '] }],
    })
  })

  it('uses the macOS denial dialect and runner on darwin', async () => {
    const { sandbox } = await setup(fakeManager(), 'darwin')
    const confined = await sandbox.confine(['true'], policy())
    expect(confined).toMatchObject({
      denialSignatures: ['operation not permitted'], runnerFailureRules: [{ fatalSignatures: ['sandbox-exec: '] }],
    })
  })

  it('re-allows only writable roots that sit beneath a read-denied path', async () => {
    const manager = fakeManager()
    const { sandbox } = await setup(manager)
    await sandbox.confine(['true'], policy({ denyRead: ['/'], allowRead: ['/opt/data'] }))
    const allowRead = manager.wrapWithSandboxArgv.mock.calls[0]?.[2]?.filesystem?.allowRead
    expect(allowRead).toContain('/opt/data')
    expect(allowRead).toContain(WS)

    await sandbox.confine(['true'], policy({ denyRead: ['/home/u/.ssh'] }))
    expect(manager.wrapWithSandboxArgv.mock.calls[1]?.[2]?.filesystem?.allowRead).toEqual([])
  })

  it('passes no allowRead when the policy denies no reads', async () => {
    const manager = fakeManager()
    const { sandbox } = await setup(manager)
    await sandbox.confine(['true'], policy({ denyWrite: [`${WS}/AGENTS.md`] }))
    expect(manager.wrapWithSandboxArgv.mock.calls[0]?.[2]?.filesystem).not.toHaveProperty('allowRead')
  })

  it('grants no writable roots under read-only mode', async () => {
    const manager = fakeManager()
    const { sandbox } = await setup(manager)
    await sandbox.confine(['true'], policy({ mode: 'read-only' }))
    expect(manager.wrapWithSandboxArgv.mock.calls[0]?.[2]?.filesystem?.allowWrite).toEqual([])
  })

  it('releases once: unregisters the call\'s list and cleans mount points only when no call is in flight', async () => {
    const manager = fakeManager()
    const { sandbox } = await setup(manager)
    const first = await sandbox.confine(['true'], policy())
    const second = await sandbox.confine(['true'], policy())
    const firstId = manager.wrapWithSandboxArgv.mock.calls[0]?.[5]?.commandId
    const secondId = manager.wrapWithSandboxArgv.mock.calls[1]?.[5]?.commandId
    expect(firstId).not.toBe(secondId)

    await first.release()
    await first.release()
    expect(manager.unregisterCommandNetworkLists.mock.calls).toEqual([[firstId]])
    expect(manager.cleanupAfterCommand).not.toHaveBeenCalled()

    await second.release()
    expect(manager.unregisterCommandNetworkLists.mock.calls).toEqual([[firstId], [secondId]])
    expect(manager.cleanupAfterCommand).toHaveBeenCalledOnce()
  })

  it('leaves no registration or in-flight count when the host list is rejected', async () => {
    const manager = fakeManager()
    manager.registerCommandNetworkLists.mockImplementationOnce(() => { throw new Error('invalid allowedDomains entry') })
    const { sandbox } = await setup(manager)
    await expect(sandbox.confine(['true'], policy({ network: { allowedDomains: ['bad host'] } }))).rejects.toThrow('invalid allowedDomains entry')
    expect(manager.unregisterCommandNetworkLists).toHaveBeenCalledOnce()
    expect(manager.cleanupAfterCommand).toHaveBeenCalledOnce()
  })

  it('refuses a restriction policy without a network list, naming the fix', async () => {
    const manager = fakeManager()
    const { sandbox } = await setup(manager)
    const refused = sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: WS, denyRead: ['/home/u/.ssh'] })
    await expect(refused).rejects.toMatchObject({ name: 'SandboxUnsupportedPolicyError' })
    await expect(refused).rejects.toThrow('network.allowedDomains')
    expect(manager.initialize).not.toHaveBeenCalled()
  })

  it('refuses with an install hint when srt dependencies are missing, and initializes after they appear', async () => {
    const manager = fakeManager(['ripgrep (rg) not found'])
    const { sandbox } = await setup(manager)
    await expect(sandbox.confine(['true'], policy()))
      .rejects.toThrow(/ripgrep \(rg\) not found.*Install bubblewrap, socat and ripgrep/)
    expect(manager.initialize).not.toHaveBeenCalled()

    manager.checkDependencies.mockReturnValue({ errors: [], warnings: [] })
    await expect(sandbox.confine(['true'], policy())).resolves.toMatchObject({ enforcement: 'full' })
    expect(manager.initialize).toHaveBeenCalledOnce()
  })

  it('fails loud when another provider in the process already owns the runtime, and works once it is disposed', async () => {
    const first = await setup(fakeManager())
    await first.sandbox.confine(['true'], policy())
    const second = await setup(fakeManager())
    await expect(second.sandbox.confine(['true'], policy()))
      .rejects.toThrow('already owned')

    await first.ctx.fiber.dispose()
    await expect(second.sandbox.confine(['true'], policy())).resolves.toMatchObject({ enforcement: 'full' })
  })

  it('resets the runtime when the provider is disposed', async () => {
    const manager = fakeManager()
    const { ctx, sandbox } = await setup(manager)
    await sandbox.confine(['true'], policy())
    await ctx.fiber.dispose()
    expect(manager.reset).toHaveBeenCalledOnce()
  })

  it('disposes without touching the runtime when it never started or failed to start', async () => {
    const idle = fakeManager()
    const never = await setup(idle)
    await never.ctx.fiber.dispose()
    expect(idle.reset).not.toHaveBeenCalled()

    const failing = fakeManager(['bwrap not found'])
    const failed = await setup(failing)
    await expect(failed.sandbox.confine(['true'], policy())).rejects.toThrow('bwrap not found')
    await failed.ctx.fiber.dispose()
    expect(failing.reset).not.toHaveBeenCalled()
  })

  it('refuses before starting the runtime when the caller already cancelled', async () => {
    const manager = fakeManager()
    const { sandbox } = await setup(manager)
    const controller = new AbortController()
    const reason = new Error('cancelled')
    controller.abort(reason)
    await expect(sandbox.confine(['true'], policy(), controller.signal)).rejects.toBe(reason)
    expect(manager.checkDependencies).not.toHaveBeenCalled()
  })

  it('does not take restriction policies on Windows, where the srt-win install is required', async () => {
    const manager = fakeManager()
    const { sandbox } = await setup(manager, 'win32')
    await expect(sandbox.confine(['cmd'], policy({ denyRead: ['C:\\secrets'] })))
      .rejects.toMatchObject({ name: 'SandboxUnsupportedPolicyError', code: 'SANDBOX_UNSUPPORTED_POLICY' })
    expect(manager.initialize).not.toHaveBeenCalled()
  })

  it('keeps policies without restriction fields on the legacy chain', async () => {
    const manager = fakeManager()
    const { sandbox } = await setup(manager)
    sandbox.internals = { platform: 'linux', srtManager: () => Promise.resolve(manager), probeBwrap: () => true }
    const confined = await sandbox.confine(['true'], { mode: 'workspace-write', workspaceRoot: WS })
    expect(confined.argv[0]).toBe('bwrap')
    expect(manager.initialize).not.toHaveBeenCalled()
    await expect(confined.release()).resolves.toBeUndefined()
  })

  it('disposes cleanly while a start that will fail is still pending', async () => {
    const manager = fakeManager(['socat not found'])
    const gate = Promise.withResolvers<SrtManager>()
    const { ctx, sandbox } = await setup(manager)
    sandbox.internals = { platform: 'linux', srtManager: () => gate.promise }
    const pending = sandbox.confine(['true'], policy())
    const settled = expect(pending).rejects.toThrow('socat not found')
    const disposed = ctx.fiber.dispose()
    gate.resolve(manager)
    await settled
    await disposed
    expect(manager.reset).not.toHaveBeenCalled()
  })

  it('selects the rung from the process platform when no test platform is set', async () => {
    const manager = fakeManager()
    const { sandbox } = await setup(manager)
    sandbox.internals = { srtManager: () => Promise.resolve(manager) }
    const run = sandbox.confine(['true'], policy())
    if (process.platform === 'linux' || process.platform === 'darwin') await expect(run).resolves.toMatchObject({ enforcement: 'full' })
    else await expect(run).rejects.toMatchObject({ name: 'SandboxUnsupportedPolicyError' })
  })
})
