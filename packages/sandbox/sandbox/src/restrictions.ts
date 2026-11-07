/**
 * Read-deny, protected-write and network restrictions carried by a sandbox
 * policy, plus the built-in path lists that opting-in consumers pass in them.
 * Providers check requested restrictions against what their selected backend
 * enforces and refuse the rest; nothing is dropped silently.
 * @module dsh-sandbox/restrictions
 */

import { join } from 'node:path'
import { SandboxUnsupportedPolicyError } from './index.ts'
import type { SandboxExecutionPolicy } from './index.ts'

/** Hosts a confined process may reach through the provider's proxy. */
export interface SandboxNetworkPolicy {
  /**
   * Host patterns: `host`, `*.host`, an optional `:port`, or a bracketed IPv6
   * literal. An empty list denies all network.
   */
  allowedDomains: readonly string[]
}

/** Which restriction fields a policy requests, or a backend enforces. */
export interface SandboxRestrictions {
  /** Read denies ({@link SandboxExecutionPolicy.denyRead} with its `allowRead` exceptions). */
  denyRead: boolean
  /** Protected write paths ({@link SandboxExecutionPolicy.denyWrite}). */
  denyWrite: boolean
  /** A network host allowlist ({@link SandboxExecutionPolicy.network}). */
  network: boolean
}

/** A backend that enforces none of the restriction fields. */
export const NO_RESTRICTIONS: SandboxRestrictions = Object.freeze({ denyRead: false, denyWrite: false, network: false })

/**
 * Report which restriction fields a policy requests. Empty deny lists request
 * nothing; a present network policy is a request even with no hosts.
 * @param policy - the policy one confined execution runs under.
 * @returns the requested restriction fields.
 */
export function requestedRestrictions(policy: SandboxExecutionPolicy): SandboxRestrictions {
  return {
    denyRead: (policy.denyRead?.length ?? 0) > 0,
    denyWrite: (policy.denyWrite?.length ?? 0) > 0,
    network: policy.network !== undefined,
  }
}

/**
 * Refuse a policy that requests a restriction the selected backend cannot enforce.
 * @param policy - the policy one confined execution runs under.
 * @param supported - the restrictions the selected backend enforces.
 * @param backend - the backend name used in the refusal.
 * @throws SandboxUnsupportedPolicyError naming every unsupported field.
 */
export function assertRestrictionsSupported(policy: SandboxExecutionPolicy, supported: SandboxRestrictions, backend: string): void {
  const requested = requestedRestrictions(policy)
  const missing = (['denyRead', 'denyWrite', 'network'] as const).filter(field => requested[field] && !supported[field])
  if (missing.length === 0) return
  throw new SandboxUnsupportedPolicyError(`sandbox backend "${backend}" cannot enforce the requested ${missing.join(', ')} `
    + `restriction${missing.length === 1 ? '' : 's'}; refusing to run the command with weaker confinement than requested`)
}

/**
 * Entries, relative to each writable root, that make developer tools or DSH run
 * code or load instructions later: shell startup files, git hooks and config,
 * editor and agent configuration, and commit-hook managers.
 */
const PROTECTED_WRITE_ENTRIES = [
  '.bashrc', '.bash_profile', '.bash_login', '.zshrc', '.zprofile', '.zshenv', '.profile', '.envrc',
  '.gitconfig', '.gitmodules', '.git/hooks', '.git/config',
  '.vscode', '.idea', '.ripgreprc', '.npmrc', '.husky',
  'lefthook.yml', 'lefthook.yaml', '.pre-commit-config.yaml',
  '.mcp.json', '.claude', '.dsh', '.agents/skills',
  'AGENTS.md', 'AGENTS.local.md', 'CLAUDE.md', 'CLAUDE.local.md',
] as const

/**
 * Protected write paths under each writable root, for {@link SandboxExecutionPolicy.denyWrite}.
 * @param roots - the absolute writable roots of one confined execution.
 * @returns absolute paths, existing or not, that stay write-denied.
 */
export function protectedWritePaths(roots: readonly string[]): string[] {
  return roots.flatMap(root => PROTECTED_WRITE_ENTRIES.map(entry => join(root, entry)))
}

/** Credential stores relative to the OS home directory. */
const CREDENTIAL_HOME_ENTRIES = [
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', '.oci', '.terraform.d',
  '.config/gh', '.config/gcloud', '.config/hub', '.config/op', '.config/git/credentials',
  '.netrc', '_netrc', '.git-credentials', '.npmrc', '.pypirc', '.vault-token', '.pgpass',
  '.cargo/credentials', '.cargo/credentials.toml', '.claude', '.claude.json', '.codex',
  'AppData/Roaming/GitHub CLI', 'AppData/Roaming/gcloud', 'AppData/Roaming/Microsoft/Credentials',
  'AppData/Local/Microsoft/Credentials',
] as const

/**
 * Credential stores a confined process must not read, for {@link SandboxExecutionPolicy.denyRead}:
 * well-known tool credential locations under the OS home, and the whole DSH home,
 * which holds its credentials file and every Session log.
 * @param home - the absolute OS home directory.
 * @param dshHome - the absolute DSH home directory.
 * @returns absolute paths to deny; a consumer re-allows its own data beneath them with `allowRead` or a writable root.
 */
export function credentialReadDenyPaths(home: string, dshHome: string): string[] {
  return [...CREDENTIAL_HOME_ENTRIES.map(entry => join(home, entry)), dshHome]
}
