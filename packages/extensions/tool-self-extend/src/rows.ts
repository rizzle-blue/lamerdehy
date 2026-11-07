/** Raw preset composition edits that preserve Loader expressions and sibling rows. */
import { isAbsolute } from 'node:path'

/** An editable plugin row inside the declaring preset's extension group. */
export interface ExtensionRow {
  id: string
  name: string
  config?: Record<string, unknown>
  disabled?: unknown
}

/** Durable preset identity and its raw Loader rows. */
export interface PresetDeclaration {
  id: string
  plugins: unknown[]
}

/** Read a durable preset declaration, rejecting missing identity or plugin rows.
 * @param config Raw entry configuration.
 * @param presetEntry Loader id used in diagnostics.
 * @returns The validated preset identity and rows.
 */
export function readPresetDeclaration(config: unknown, presetEntry: string): PresetDeclaration {
  if (typeof config !== 'object' || config === null || !('id' in config) || typeof config.id !== 'string'
    || config.id.trim() === '' || !('plugins' in config) || !Array.isArray(config.plugins)) {
    throw new Error(`Self-extension target "${presetEntry}" is not an agent preset declaration`)
  }
  return { id: config.id, plugins: config.plugins }
}

/** Read the configured top-level group and validate its durable rows.
 * @param plugins Raw preset rows.
 * @param groupId Extension group id.
 * @param presetEntry Loader id used in diagnostics.
 * @returns The group's plugin rows; malformed or missing groups throw.
 */
export function findGroup(plugins: unknown[], groupId: string, presetEntry: string): ExtensionRow[] {
  const group = plugins.find((row): row is { id: string; group: true; config: unknown[] } =>
    typeof row === 'object' && row !== null && 'id' in row && row.id === groupId
      && 'group' in row && row.group === true && 'config' in row && Array.isArray(row.config))
  if (group === undefined) throw new Error(`Preset entry "${presetEntry}" has no "${groupId}" group row`)
  return group.config.map((row) => {
    if (typeof row !== 'object' || row === null || !('id' in row) || typeof row.id !== 'string'
      || !('name' in row) || typeof row.name !== 'string') {
      throw new Error(`Self-extension group "${groupId}" contains a malformed row`)
    }
    return row as ExtensionRow
  })
}

/** Replace only the extension group's contents, retaining sibling object identities.
 * @param config Validated preset configuration.
 * @param groupId Existing top-level extension group.
 * @param rows Complete replacement group contents.
 * @returns A shallow configuration copy with a copied plugins array.
 */
export function withGroup(config: Record<string, unknown>, groupId: string, rows: ExtensionRow[]): Record<string, unknown> {
  return { ...config, plugins: (config.plugins as unknown[]).map(row =>
    typeof row === 'object' && row !== null && 'id' in row && row.id === groupId
      && 'group' in row && row.group === true ? { ...row, config: rows } : row) }
}

/** Collect ids across the whole preset, including nested groups.
 * @param plugins Raw Loader rows.
 * @returns Every declared string row id.
 */
export function allRowIds(plugins: unknown[]): Set<string> {
  const ids = new Set<string>()
  for (const row of plugins) {
    if (typeof row !== 'object' || row === null) continue
    if ('id' in row && typeof row.id === 'string') ids.add(row.id)
    if ('group' in row && row.group === true && 'config' in row && Array.isArray(row.config)) {
      for (const id of allRowIds(row.config)) ids.add(id)
    }
  }
  return ids
}

/** Self-added row ids cannot address paths or other patch syntax. */
export const ROW_ID = /^[a-z0-9][a-z0-9-]*$/

/** Reject path and URL sources where an installed package specifier is required.
 * @param spec Model-supplied package source.
 */
export function validatePackageSpecifier(spec: string): void {
  if (spec.trim() === '' || spec.startsWith('.') || spec.startsWith('/') || isAbsolute(spec) || spec.includes(':')) {
    throw new Error('package must be an installed plugin package specifier such as @deepseek-ai/dsh-time-context')
  }
}

/** Plugin package that runs module extensions in fresh OS-sandboxed processes. */
export const SANDBOXED_MODULE_PLUGIN = '@deepseek-ai/dsh-tool-sandboxed-module'

/** Where a module extension's sandboxed calls may write. */
export type ModuleWrite = 'none' | 'data' | 'workspace'

const MODULE_WRITES: readonly unknown[] = ['none', 'data', 'workspace'] satisfies ModuleWrite[]
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/

/** One tool a module declares; mirrors the sandboxed-module plugin config, whose entry exports only Loader members. */
export interface ModuleTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Config of a sandboxed-module row. */
export type ModuleRowConfig = {
  module: string
  dataDir: string
  write: ModuleWrite
  tools: ModuleTool[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate a module's declared tools.
 * @param value The module's `tools` export, as returned from its sandboxed manifest check or stored in a row.
 * @param id Self-extension row id used in diagnostics.
 * @returns Copies of 1 to 16 uniquely named tool declarations.
 */
export function readModuleTools(value: unknown, id: string): ModuleTool[] {
  const fail = (reason: string): never => {
    throw new Error(`Self-extension module "${id}" failed its sandboxed manifest check: ${reason}`)
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return fail('tools must be an array of 1 to 16 tool declarations')
  const names = new Set<string>()
  return value.map((tool: unknown, index): ModuleTool => {
    if (!isRecord(tool)) return fail(`tools[${index}] must be an object`)
    const { name, description, parameters } = tool
    if (typeof name !== 'string' || !TOOL_NAME.test(name)) return fail(`tools[${index}].name must match ${TOOL_NAME.source}`)
    if (names.has(name)) return fail(`tool name "${name}" is declared more than once`)
    names.add(name)
    if (typeof description !== 'string' || description === '' || description.length > 2000) {
      return fail(`tools[${index}].description must be a non-empty string of at most 2000 characters`)
    }
    if (!isRecord(parameters) || parameters.type !== 'object') return fail(`tools[${index}].parameters must be a JSON Schema object whose type is "object"`)
    return { name, description, parameters }
  })
}

/** Read a sandboxed-module row's stored config.
 * @param row Self-extension row.
 * @returns The validated config, or undefined for rows of other plugins; malformed module configs throw.
 */
export function readModuleRow(row: ExtensionRow): ModuleRowConfig | undefined {
  if (row.name !== SANDBOXED_MODULE_PLUGIN) return undefined
  const config = row.config
  if (config === undefined || typeof config.module !== 'string' || typeof config.dataDir !== 'string' || !MODULE_WRITES.includes(config.write)) {
    throw new Error(`Self-extension "${row.id}" has a malformed sandboxed module config`)
  }
  return {
    module: config.module, dataDir: config.dataDir, write: config.write as ModuleWrite, tools: readModuleTools(config.tools, row.id),
  }
}
