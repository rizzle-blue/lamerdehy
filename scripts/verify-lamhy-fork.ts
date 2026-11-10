/**
 * Lam Hy fork drift check: reject tracked files that reintroduce telemetry,
 * Chinese documentation or locale data, or the user-visible upstream product
 * name. Each violation names the `lamhy-*` skill that removes it; LAMHY.md owns
 * the decisions.
 * @module scripts/verify-lamhy-fork
 */

import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')

/** Fork policy area a violation belongs to, keyed to the skill that fixes it. */
export type LamhyDriftCategory = 'telemetry' | 'english-only' | 'rebrand'

/** One tracked path or line that breaks a Lam Hy fork decision. */
export interface LamhyDriftViolation {
  /** Policy area, which selects the fixing skill. */
  category: LamhyDriftCategory
  /** Repository-relative tracked path. */
  file: string
  /** One-based source line, or null when the path itself is the violation. */
  line: number | null
  /** What was found. */
  reason: string
}

/** Skill that removes each category's violations. */
export const LAMHY_DRIFT_SKILLS: Readonly<Record<LamhyDriftCategory, string>> = {
  'telemetry': 'lamhy-no-telemetry',
  'english-only': 'lamhy-english-only',
  'rebrand': 'lamhy-rebrand',
}

/** Paths every check skips: pinned vendor copies, frozen notes, and the fork's own policy text. */
const EXCLUDED_PREFIXES = [
  'vendor/',
  '.agents/notes/archived/',
  '.agents/skills/lamhy-',
  'scripts/verify-lamhy-fork',
] as const

/** Package directories and files removed by the telemetry decision. */
const TELEMETRY_PATHS = [
  'packages/telemetry/',
  'packages/session/session-telemetry/',
  'packages/session/session-telemetry-otel/',
  'packages/host/product-telemetry-otel/',
  'packages/client/product-analytics/',
  'packages/identity/anonymous-user-id/',
  'packages/session/session-log-deepseek/',
  'packages/client/ui-settings-session-log/',
  'packages/feedback/command-feedback/',
  'packages/feedback/message-feedback/',
  'packages/client/ui-message-feedback/',
  'apps/desktop/src/update-coordinator.ts',
] as const

/** Source text that identifies an unrequested outbound data path. */
const TELEMETRY_TEXT: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /deepseeksvc\.com/u, reason: 'upstream telemetry collector host' },
  { pattern: /x-deepseek-harness-user-id/u, reason: 'anonymous user id request header' },
  { pattern: /\bDSH_(?:TELEMETRY|PRODUCT_ANALYTICS)_/u, reason: 'telemetry switch variable' },
  { pattern: /"(?:@opentelemetry\/[^"]+|electron-updater|@sentry\/[^"]+|posthog-[^"]+|mixpanel[^"]*)"\s*:/u, reason: 'reporting or updater dependency' },
]

/** Files the telemetry text scan reads: sources, manifests, and composition. */
const TELEMETRY_TEXT_FILE = /^(?:packages|apps|python)\/.*(?:\/src\/.*\.(?:ts|tsx|mts|js|mjs)|\/package\.json|\.ya?ml)$/u

/** Tracked paths that carry Chinese documentation, translation records, or Chinese locale data. */
const CHINESE_PATH = new RegExp([
  String.raw`\.zh\.md$`,
  String.raw`\.i18n\.yaml$`,
  String.raw`(?:^|/)locales?/zh\.(?:json|ts)$`,
  String.raw`[/._-]zh(?:-CN|_CN)?(?:-dark)?\.(?:png|svg|webp|json|txt|md)$`,
].join('|'), 'u')

/** User-visible files the rebrand scan reads; code comments and agent workflow files are out of scope. */
const REBRAND_FILE = /(?:\.md|(?:^|\/)locale\/[^/]+\.json|(?:^|\/)locales\.ts)$/u
const REBRAND_EXCLUDED_PREFIX = '.agents/'

/** Files that keep the upstream name on purpose: attribution and license text. */
const REBRAND_ALLOWED = new Set(['LAMHY.md', 'THIRD_PARTY_NOTICES.md'])

const REBRAND_TEXT = [{ pattern: /DeepSeek[ -]Harness/u, reason: 'upstream product name in user-visible text' }] as const

/** File and text that must keep Kiro's data-use opt-out header. */
const KIRO_ADAPTER = 'packages/llm/llm-kiro/src/adapter.ts'
const KIRO_OPT_OUT = /'x-amzn-codewhisperer-optout':\s*'true'/u

function isExcluded(file: string): boolean {
  return EXCLUDED_PREFIXES.some(prefix => file.startsWith(prefix))
}

function lineViolations(
  category: LamhyDriftCategory,
  file: string,
  source: string,
  tests: readonly { pattern: RegExp; reason: string }[],
): LamhyDriftViolation[] {
  const violations: LamhyDriftViolation[] = []
  for (const [index, text] of source.split(/\r?\n/u).entries()) {
    for (const { pattern, reason } of tests) {
      if (pattern.test(text)) violations.push({ category, file, line: index + 1, reason })
    }
  }
  return violations
}

/**
 * Find fork-policy violations in one tracked file.
 * @param file - Repository-relative tracked path.
 * @param read - Returns the file's text, or undefined when it is absent or not a regular file.
 * @returns violations in path order then line order; an empty list when the file is allowed.
 */
export function findLamhyFileDrift(file: string, read: () => string | undefined): LamhyDriftViolation[] {
  if (isExcluded(file)) return []
  const violations: LamhyDriftViolation[] = []
  const removed = TELEMETRY_PATHS.find(path => path.endsWith('/') ? file.startsWith(path) : file === path)
  if (removed !== undefined) violations.push({ category: 'telemetry', file, line: null, reason: `removed telemetry path ${removed}` })
  if (CHINESE_PATH.test(file)) violations.push({ category: 'english-only', file, line: null, reason: 'Chinese documentation or locale file' })
  const scanTelemetry = removed === undefined && TELEMETRY_TEXT_FILE.test(file)
  const scanRebrand = REBRAND_FILE.test(file) && !file.startsWith(REBRAND_EXCLUDED_PREFIX)
    && !REBRAND_ALLOWED.has(file) && !CHINESE_PATH.test(file)
  if (!scanTelemetry && !scanRebrand) return violations
  const source = read()
  if (source === undefined) return violations
  if (scanTelemetry) violations.push(...lineViolations('telemetry', file, source, TELEMETRY_TEXT))
  if (scanRebrand) violations.push(...lineViolations('rebrand', file, source, REBRAND_TEXT))
  return violations
}

/**
 * Find fork-policy violations across the tracked tree, including invariants that span files.
 * @param files - Repository-relative tracked paths.
 * @param read - Returns one path's text, or undefined when it is absent or not a regular file.
 * @returns every violation, grouped by file in the given order.
 */
export function findLamhyDrift(files: readonly string[], read: (file: string) => string | undefined): LamhyDriftViolation[] {
  const violations = files.flatMap(file => findLamhyFileDrift(file, () => read(file)))
  if (files.includes(KIRO_ADAPTER) && !KIRO_OPT_OUT.test(read(KIRO_ADAPTER) ?? '')) {
    violations.push({ category: 'telemetry', file: KIRO_ADAPTER, line: null, reason: 'Kiro requests must send x-amzn-codewhisperer-optout: true' })
  }
  return violations
}

/**
 * Keep only violations absent from a baseline. Violations compare by category,
 * file, and reason with occurrence counts, so line shifts are not new drift.
 * @param current - Violations in the checked tree.
 * @param baseline - Violations at the comparison ref.
 * @returns the current violations beyond each key's baseline count, in input order.
 */
export function newLamhyDrift(current: readonly LamhyDriftViolation[], baseline: readonly LamhyDriftViolation[]): LamhyDriftViolation[] {
  const key = (violation: LamhyDriftViolation) => `${violation.category}\0${violation.file}\0${violation.reason}`
  const remaining = new Map<string, number>()
  for (const violation of baseline) remaining.set(key(violation), (remaining.get(key(violation)) ?? 0) + 1)
  return current.filter((violation) => {
    const left = remaining.get(key(violation)) ?? 0
    if (left === 0) return true
    remaining.set(key(violation), left - 1)
    return false
  })
}

function git(repoRoot: string, args: readonly string[]): string {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

function nulList(output: string): string[] {
  return output.split('\0').filter(file => file !== '')
}

function requireCorpus(files: readonly string[], where: string): readonly string[] {
  if (!files.some(file => file.startsWith('packages/'))) {
    throw new Error(`verify-lamhy-fork: file discovery at ${where} found no packages/ files`)
  }
  return files
}

function readRegularFile(repoRoot: string, file: string): string | undefined {
  const path = resolve(repoRoot, file)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  return stat?.isFile() === true ? readFileSync(path, 'utf8') : undefined
}

/** Read every blob of `ref` in one `git cat-file --batch` call. */
function readTree(repoRoot: string, ref: string): { files: readonly string[]; read: (file: string) => string | undefined } {
  const files = requireCorpus(nulList(git(repoRoot, ['ls-tree', '-r', '-z', '--name-only', ref])), ref)
  const output = execFileSync('git', ['cat-file', '--batch'], {
    cwd: repoRoot, maxBuffer: 1024 * 1024 * 1024, input: files.map(file => `${ref}:${file}`).join('\n') + '\n',
  })
  const contents = new Map<string, string>()
  let offset = 0
  for (const file of files) {
    const end = output.indexOf(0x0a, offset)
    const [, type, size] = output.subarray(offset, end).toString('utf8').split(' ')
    if (type === undefined || size === undefined) throw new Error(`verify-lamhy-fork: cannot read ${ref}:${file}`)
    const length = Number(size)
    if (type === 'blob') contents.set(file, output.subarray(end + 1, end + 1 + length).toString('utf8'))
    offset = end + 1 + length + 1
  }
  return { files, read: file => contents.get(file) }
}

/** Most violations listed per category; the rest are counted. */
const LISTED_PER_CATEGORY = 20

function report(violations: readonly LamhyDriftViolation[]): void {
  for (const category of Object.keys(LAMHY_DRIFT_SKILLS) as LamhyDriftCategory[]) {
    const rows = violations.filter(violation => violation.category === category)
    if (rows.length === 0) continue
    console.error(`\n${category}: ${String(rows.length)} violation(s); run the ${LAMHY_DRIFT_SKILLS[category]} skill.`)
    for (const row of rows.slice(0, LISTED_PER_CATEGORY)) {
      console.error(`  ${row.line === null ? row.file : `${row.file}:${String(row.line)}`}  ${row.reason}`)
    }
    if (rows.length > LISTED_PER_CATEGORY) console.error(`  … and ${String(rows.length - LISTED_PER_CATEGORY)} more`)
  }
}

function option(name: string): string | undefined {
  return process.argv.slice(2).find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const only = option('only')
  if (only !== undefined && !(only in LAMHY_DRIFT_SKILLS)) {
    throw new Error(`verify-lamhy-fork: --only must be one of ${Object.keys(LAMHY_DRIFT_SKILLS).join(', ')}, got ${JSON.stringify(only)}`)
  }
  const since = option('since')
  const files = requireCorpus(nulList(git(root, ['ls-files', '-z'])), 'the working tree')
  let violations = findLamhyDrift(files, file => readRegularFile(root, file))
  if (since !== undefined) {
    const baseline = readTree(root, git(root, ['rev-parse', '--verify', `${since}^{commit}`]).trim())
    violations = newLamhyDrift(violations, findLamhyDrift(baseline.files, baseline.read))
  }
  violations = violations.filter(violation => only === undefined || violation.category === only)
  const scope = since === undefined ? 'tracked files' : `changes since ${since}`
  if (violations.length === 0) {
    console.log(`verify-lamhy-fork: no ${only ?? 'telemetry, Chinese, or upstream-name'} drift in ${scope}.`)
  } else {
    console.error(`verify-lamhy-fork: ${scope} break Lam Hy fork decisions (LAMHY.md):`)
    report(violations)
    process.exitCode = 1
  }
}
