import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { protectedWritePaths } from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import { LocalSandboxProvider } from '@deepseek-ai/dsh-sandbox-local'

/**
 * Keyless integration through `confine()` and the real srt runtime on Linux: read denies,
 * protected writes, writes outside the roots and the per-call host list. Skips when srt's
 * bubblewrap, socat or ripgrep dependencies are missing, or off Linux. Network probes need
 * outbound access to example.com and example.org, so the network cases skip when it is absent.
 */

const supported = process.platform === 'linux'

let ctx: Context | undefined
const tempDirs: string[] = []

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** A HOME-based directory: srt's own temp handling would otherwise hide the workspace-root bind. */
async function homeDir(): Promise<string> {
  const dir = await mkdtemp(join(homedir(), 'dsh-srt-e2e-'))
  tempDirs.push(dir)
  return dir
}

async function provider(): Promise<LocalSandboxProvider> {
  ctx = new Context()
  await ctx.plugin(LocalSandboxProvider, {})
  return ctx.sandbox as LocalSandboxProvider
}

/** Spawn a confined argv and collect its output; spawn asynchronously so the in-process proxy keeps serving. */
async function runConfined(confined: ConfinedArgv, cwd: string) {
  const child = spawn(confined.argv[0] as string, confined.argv.slice(1), { cwd, env: { ...process.env, ...confined.env } })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  const timer = setTimeout(() => { child.kill('SIGKILL') }, 30_000)
  const status = await new Promise<number | null>((resolve) => { child.on('exit', resolve) })
  clearTimeout(timer)
  await confined.release()
  return { status, output }
}

async function confine(sandbox: LocalSandboxProvider, command: string, policy: SandboxPolicy) {
  return sandbox.confine(['bash', '-c', command], policy)
}

const fetchJs = (url: string): string =>
  `node -e "fetch('${url}').then(r=>console.log('STATUS',r.status)).catch(e=>{console.log('FAIL');process.exit(3)})"`

describe.skipIf(!supported)('sandbox-local: real srt confinement', () => {
  it('denies reading a credential file but not the workspace', async () => {
    const root = await homeDir()
    const workspace = join(root, 'ws')
    const secrets = join(root, 'secrets')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(secrets)
    writeFileSync(join(secrets, 'id_test'), 'PRIVATE')
    writeFileSync(join(workspace, 'notes.txt'), 'PUBLIC')
    const sandbox = await provider()
    const policy: SandboxPolicy = {
      mode: 'workspace-write', workspaceRoot: workspace, denyRead: [secrets], network: { allowedDomains: [] },
    }

    const secret = await runConfined(await confine(sandbox, `cat '${join(secrets, 'id_test')}'`, policy), workspace)
    expect(secret.output).not.toContain('PRIVATE')
    expect(secret.status).not.toBe(0)

    const open = await runConfined(await confine(sandbox, `cat '${join(workspace, 'notes.txt')}'`, policy), workspace)
    expect(open).toEqual({ status: 0, output: 'PUBLIC' })
  })

  it('keeps a workspace readable when its parent is read-denied', async () => {
    const root = await homeDir()
    const workspace = join(root, 'ws')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'notes.txt'), 'PUBLIC')
    const sandbox = await provider()
    const policy: SandboxPolicy = {
      mode: 'workspace-write', workspaceRoot: workspace, denyRead: [root], network: { allowedDomains: [] },
    }
    const read = await runConfined(await confine(sandbox, `cat '${join(workspace, 'notes.txt')}'`, policy), workspace)
    expect(read).toEqual({ status: 0, output: 'PUBLIC' })
  })

  it('writes inside the workspace, and refuses protected paths and paths outside the roots', async () => {
    const root = await homeDir()
    const workspace = join(root, 'ws')
    const outside = join(root, 'outside')
    mkdirSync(join(workspace, '.git', 'hooks'), { recursive: true })
    writeFileSync(join(workspace, '.git', 'config'), '[core]\n')
    mkdirSync(outside)
    const sandbox = await provider()
    const policy: SandboxPolicy = {
      mode: 'workspace-write', workspaceRoot: workspace, denyWrite: protectedWritePaths([workspace]), network: { allowedDomains: [] },
    }

    const ok = await runConfined(await confine(sandbox, 'echo ok > src.txt && cat src.txt', policy), workspace)
    expect(ok).toEqual({ status: 0, output: 'ok\n' })

    const attempts = await runConfined(await confine(sandbox, [
      'echo bad > .git/hooks/pre-commit', 'echo bad >> .git/config', 'echo bad > AGENTS.md', 'echo bad > .bashrc',
      `echo bad > '${join(outside, 'x.txt')}'`,
    ].map(line => `${line} 2>/dev/null; echo "exit=$?"`).join('; '), policy), workspace)
    expect(attempts.output.match(/exit=\d+/g)).toEqual(Array<string>(5).fill('exit=1'))

    expect(existsSync(join(workspace, '.git', 'hooks', 'pre-commit'))).toBe(false)
    expect(readFileSync(join(workspace, '.git', 'config'), 'utf8')).toBe('[core]\n')
    expect(existsSync(join(workspace, 'AGENTS.md'))).toBe(false)
    expect(existsSync(join(workspace, '.bashrc'))).toBe(false)
    expect(existsSync(join(outside, 'x.txt'))).toBe(false)
  })

  it('reaches only the hosts of each concurrent call, and an empty list reaches none', async () => {
    const root = await homeDir()
    const sandbox = await provider()
    const base = { mode: 'workspace-write', workspaceRoot: root } as const
    const calls = await Promise.all([
      confine(sandbox, fetchJs('https://example.com'), { ...base, network: { allowedDomains: ['example.com'] } }),
      confine(sandbox, fetchJs('https://example.com'), { ...base, network: { allowedDomains: ['example.org'] } }),
      confine(sandbox, fetchJs('https://example.org'), { ...base, network: { allowedDomains: ['example.org'] } }),
      confine(sandbox, fetchJs('https://example.com'), { ...base, network: { allowedDomains: [] } }),
    ])
    const [allowed, wrongHost, otherAllowed, none] = await Promise.all(calls.map(call => runConfined(call, root)))
    if (allowed?.output.includes('FAIL') === true && otherAllowed?.output.includes('FAIL') === true) return // No outbound network on this host.
    expect(allowed?.output).toContain('STATUS 200')
    expect(otherAllowed?.output).toContain('STATUS 200')
    expect(wrongHost?.output).not.toContain('STATUS')
    expect(none?.output).not.toContain('STATUS')
    expect(wrongHost?.output).toContain('FAIL')
  })
})
