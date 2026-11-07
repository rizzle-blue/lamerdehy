/** Startup variables required by native executables before model evaluation. */
import { syncBuiltinESMExports } from 'node:module'

/** Native executable search, Windows system paths, and sandbox temporary paths retained in the OS environment. */
export const STARTUP_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP'])

/**
 * Network settings a confining sandbox supplies. The host spawn strips every inherited
 * variable outside {@link STARTUP_ENVIRONMENT_NAMES}, so only the confinement's own values
 * reach the child; the child keeps them so Node networking still reaches the sandbox proxy.
 */
const CONFINEMENT_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY',
  'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO',
])

/**
 * Clear inherited credentials while preserving native child-process startup paths and the
 * network settings of the confining sandbox.
 * With the native child process, preloaded node:process exports observe the replacement.
 * Isolated state objects only replace their own environment; they do not replace the native process.
 * @param state - Native child process in production, or isolated state in in-process tests.
 */
export function clearProgramEnvironment(state: { env: NodeJS.ProcessEnv }): void {
  const kept: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv
  for (const key of Object.keys(state.env)) {
    const name = key.toUpperCase()
    if (CONFINEMENT_ENVIRONMENT_NAMES.has(name)) kept[key] = state.env[key]
    if (!STARTUP_ENVIRONMENT_NAMES.has(name)) Reflect.deleteProperty(state.env, key)
  }
  state.env = kept
  syncBuiltinESMExports()
}
