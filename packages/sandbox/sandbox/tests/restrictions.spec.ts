import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  NO_RESTRICTIONS, SandboxUnsupportedPolicyError, assertRestrictionsSupported, credentialReadDenyPaths,
  protectedWritePaths, requestedRestrictions,
} from '../src/index.ts'
import type { SandboxExecutionPolicy } from '../src/index.ts'

const base: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: '/work' }

describe('sandbox restrictions', () => {
  it('requests only non-empty deny lists and any present network policy', () => {
    expect(requestedRestrictions(base)).toEqual(NO_RESTRICTIONS)
    expect(requestedRestrictions({ ...base, denyRead: [], denyWrite: [], allowRead: ['/x'] })).toEqual(NO_RESTRICTIONS)
    expect(requestedRestrictions({ ...base, denyRead: ['/s'], denyWrite: ['/w'], network: { allowedDomains: [] } }))
      .toEqual({ denyRead: true, denyWrite: true, network: true })
  })

  it('refuses every requested restriction the backend lacks and accepts the rest', () => {
    const policy = { ...base, denyRead: ['/s'], network: { allowedDomains: ['example.com'] } }
    expect(() => { assertRestrictionsSupported(base, NO_RESTRICTIONS, 'bwrap') }).not.toThrow()
    expect(() => { assertRestrictionsSupported(policy, { denyRead: true, denyWrite: false, network: true }, 'srt') }).not.toThrow()
    expect(() => { assertRestrictionsSupported(policy, NO_RESTRICTIONS, 'bwrap') })
      .toThrow(new SandboxUnsupportedPolicyError('sandbox backend "bwrap" cannot enforce the requested denyRead, network restrictions; refusing to run the command with weaker confinement than requested'))
    expect(() => { assertRestrictionsSupported({ ...base, denyWrite: ['/w'] }, NO_RESTRICTIONS, 'seatbelt') })
      .toThrow('cannot enforce the requested denyWrite restriction;')
  })

  it('protects git hooks, shell startup files and agent configuration under every writable root', () => {
    const paths = protectedWritePaths(['/work', '/data'])
    for (const root of ['/work', '/data']) {
      for (const entry of ['.git/hooks', '.git/config', '.bashrc', '.vscode', '.mcp.json', '.dsh', 'AGENTS.md']) {
        expect(paths).toContain(join(root, entry))
      }
    }
    expect(protectedWritePaths([])).toEqual([])
  })

  it('denies tool credential stores and the whole DSH home', () => {
    const paths = credentialReadDenyPaths('/home/u', '/home/u/.dsh')
    for (const entry of ['.ssh', '.aws', '.config/gh', '.netrc', '.git-credentials']) expect(paths).toContain(join('/home/u', entry))
    expect(paths.at(-1)).toBe('/home/u/.dsh')
  })
})
