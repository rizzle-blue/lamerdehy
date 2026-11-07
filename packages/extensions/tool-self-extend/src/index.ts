/** Approval-free edits to the declaring agent preset's own self-extension group. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import {
  allRowIds, findGroup, readModuleRow, readModuleTools, readPresetDeclaration, ROW_ID, SANDBOXED_MODULE_PLUGIN,
  validatePackageSpecifier, withGroup, type ExtensionRow, type ModuleTool, type ModuleWrite,
} from './rows.ts'
import { presentSelfExtendCall } from './present.ts'

export const name = 'tool-self-extend'
export const inject = ['tools', 'configEditor', 'agentPresets', 'profileContext', 'ptcRuntime']

/** The preset entry, its sole approval-free editable group, and the packages it may add in-process. */
export interface Config {
  /** Loader id of the declaring preset row, such as preset-tidebloom. */
  presetEntry: string
  /** Top-level cordis:group row containing this preset's self-added plugins. */
  extensionGroup: string
  /** Installed plugin packages self_extend may add in-process; every other package is refused. */
  allowedPackages: string[]
}

export const Config: z<Config> = z.object({
  presetEntry: z.string().min(1).required().description('Loader id of the declaring preset row, such as preset-tidebloom.'),
  extensionGroup: z.string().min(1).required().description('Id of the cordis:group row inside that preset that holds self-added rows.'),
  allowedPackages: z.array(z.string()).default([]).description('Installed plugin packages self_extend may add in-process; every other package is refused.'),
})

interface Mutation {
  action: 'add' | 'update' | 'remove'
  id?: string
  package?: string
  module?: string
  write?: ModuleWrite
  config?: unknown
  enabled?: boolean
}

/** A requested row source; module tools are known only after the sandboxed manifest check. */
type Source = { kind: 'package'; name: string } | { kind: 'module'; module: string; tools: ModuleTool[] }

type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; error: unknown }

function describe(row: ExtensionRow): object {
  const disabled = row.disabled === undefined ? {} : { disabled: row.disabled }
  const module = readModuleRow(row)
  if (module !== undefined) {
    return { id: row.id, source: { module: fileURLToPath(module.module) }, write: module.write,
      tools: module.tools.map(tool => tool.name), dataDir: module.dataDir, ...disabled }
  }
  return { id: row.id, source: row.name.startsWith('file:') ? { module: fileURLToPath(row.name) } : { package: row.name },
    ...(row.config === undefined ? {} : { config: row.config }), ...disabled }
}

/** Register persistent edits confined to the configured preset group.
 * @param ctx Agent-scoped context with the profile's editor, preset registry, and a confining PTC runtime.
 * @param config Declaring preset row, editable group id, and package allowlist.
 */
export function apply(ctx: Context, config: Config): void {
  const editor = ctx.configEditor
  const allowed = new Set(config.allowedPackages)
  const entryForEdit = () => {
    const entry = editor.entries().find(row => row.options.id === config.presetEntry)
    if (entry === undefined) throw new Error(`Self-extension target "${config.presetEntry}" is not an editable profile entry`)
    return entry
  }
  const read = () => {
    const entry = entryForEdit()
    const declaration = readPresetDeclaration(entry.options.config, config.presetEntry)
    return { entry, declaration, rows: findGroup(declaration.plugins, config.extensionGroup, config.presetEntry) }
  }
  const storage = (preset: string) => join(ctx.profileContext.dir, 'self-extensions', preset)

  async function sweep(modulesDir: string): Promise<void> {
    const referenced = new Set(read().rows.map(row => readModuleRow(row)?.module ?? row.name))
    let files: string[]
    try { files = await readdir(modulesDir) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return
    }
    for (const file of files) {
      const path = join(modulesDir, file)
      if (referenced.has(pathToFileURL(path).href)) continue
      try { await rm(path) }
      catch (error) {
        // Another cleanup may have already removed this unreferenced module.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }

  const program = (body: string) => ctx.ptcRuntime.programFormat === 'function-body'
    ? `return await (async () => { ${body} })()`
    : `(async () => { ${body} })()`

  // Same data: URL form as the sandboxed-module plugin's calls, so the probe imports exactly what calls run.
  async function probe(id: string, bytes: Buffer, dataDir: string, exec: ToolRunContext): Promise<ModuleTool[]> {
    const source = `data:text/javascript;base64,${bytes.toString('base64')}`
    const spec = ctx.ptcRuntime.resolve({
      program: program(`const m = await import(${JSON.stringify(source)}); return m.tools`),
      bindings: [], cwd: dataDir, sandboxPolicy: { mode: 'read-only', workspaceRoot: dataDir }, signal: exec.signal,
    })
    const result = await ctx.ptcRuntime.run(spec)
    if (result.error !== undefined) {
      throw new Error(`Self-extension module "${id}" failed its sandboxed manifest check: ${result.error.kind}: ${result.error.message}`)
    }
    return readModuleTools(result.value, id)
  }

  async function mutate(args: Mutation, exec: ToolRunContext): Promise<string> {
    const { entry, declaration, rows } = read()
    const id = args.id
    if (id === undefined || !ROW_ID.test(id)) throw new Error('id must use lowercase letters, digits, and hyphens')
    if (args.package !== undefined && args.module !== undefined) {
      throw new Error(args.action === 'add'
        ? 'add needs exactly one of package or module'
        : `${args.action} accepts at most one of package or module`)
    }
    if (args.config !== undefined && (typeof args.config !== 'object' || args.config === null || Array.isArray(args.config))) {
      throw new Error('config must be a JSON object')
    }
    if (args.package !== undefined) {
      validatePackageSpecifier(args.package)
      if (!allowed.has(args.package)) throw new Error(`Package "${args.package}" is not on this mode's package allowlist`)
    }
    if (args.module !== undefined && (!isAbsolute(args.module) || !/\.(?:js|mjs)$/.test(args.module))) {
      throw new Error('module must be an absolute path to a .js or .mjs file')
    }
    const modulesDir = join(storage(declaration.id), 'modules')
    const dataDir = join(storage(declaration.id), 'data', id)
    const rowConfig = args.config as Record<string, unknown> | undefined

    const next = (current: ExtensionRow[], plugins: unknown[], source: Source | undefined): ExtensionRow[] => {
      const disabledOnAdd = args.enabled === false ? { disabled: true } : {}
      if (args.action === 'add') {
        if (allRowIds(plugins).has(id)) throw new Error(`Row id "${id}" already exists in ${declaration.id}`)
        if (source === undefined) throw new Error('add needs exactly one of package or module')
        if (source.kind === 'package') {
          if (args.write !== undefined) throw new Error('write applies only to module extensions')
          return [...current, { id, name: source.name, ...(rowConfig === undefined ? {} : { config: rowConfig }), ...disabledOnAdd }]
        }
        if (rowConfig !== undefined) throw new Error('config applies only to package extensions')
        return [...current, { id, name: SANDBOXED_MODULE_PLUGIN,
          config: { module: source.module, dataDir, write: args.write ?? 'data', tools: source.tools }, ...disabledOnAdd }]
      }
      const existing = current.find(row => row.id === id)
      if (existing === undefined) throw new Error(`No self extension "${id}" in ${declaration.id}`)
      if (args.action === 'remove') return current.filter(row => row !== existing)
      if (existing.name.startsWith('file:')) {
        throw new Error(`Self-extension "${id}" uses the retired in-process module form; remove it and add it again as a module`)
      }
      const module = readModuleRow(existing)
      const row: ExtensionRow = { ...existing }
      delete row.config
      delete row.disabled
      if (args.enabled === false) row.disabled = true
      else if (args.enabled === undefined && existing.disabled !== undefined) row.disabled = existing.disabled
      const stored = source?.kind === 'module' ? source : source === undefined ? module : undefined
      if (stored !== undefined) {
        if (rowConfig !== undefined) throw new Error('config applies only to package extensions')
        row.name = SANDBOXED_MODULE_PLUGIN
        row.config = { module: stored.module, dataDir, write: args.write ?? module?.write ?? 'data', tools: stored.tools }
      } else {
        if (args.write !== undefined) throw new Error('write applies only to module extensions')
        if (source?.kind === 'package') row.name = source.name
        const kept = rowConfig ?? (module === undefined ? existing.config : undefined)
        if (kept !== undefined) row.config = kept
      }
      return current.map(old => old === existing ? row : old)
    }

    // Validation uses a provisional module source; the edit stores the copied module and its checked tools.
    const requested: Source | undefined = args.package !== undefined ? { kind: 'package', name: args.package }
      : args.module === undefined ? undefined : { kind: 'module', module: args.module, tools: [] }
    next(rows, declaration.plugins, requested)

    const change = async (): Promise<Record<string, unknown>> => {
      let source = requested
      if (args.module !== undefined) {
        const bytes = await readFile(args.module)
        const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 12)
        const target = join(modulesDir, `${id}-${hash}.mjs`)
        await mkdir(modulesDir, { recursive: true })
        await writeFileAtomic(target, bytes, { mode: 0o600 })
        await mkdir(dataDir, { recursive: true, mode: 0o700 })
        const tools = await probe(id, bytes, dataDir, exec)
        const existingRow = rows.find(row => row.id === id)
        const own = new Set(existingRow === undefined ? [] : readModuleRow(existingRow)?.tools.map(tool => tool.name))
        const taken = new Set([
          ...ctx.tools.schemas(exec.agent).map(schema => schema.name).filter(name => !own.has(name)),
          ...read().rows.filter(row => row.id !== id).flatMap(row => readModuleRow(row)?.tools.map(tool => tool.name) ?? []),
        ])
        const collision = tools.find(tool => taken.has(tool.name))
        if (collision !== undefined) throw new Error(`Tool name "${collision.name}" is already registered in this mode`)
        source = { kind: 'module', module: pathToFileURL(target).href, tools }
      }
      const before = (await ctx.agentPresets.resolve(declaration.id)).broken
      let previous: ExtensionRow[] = []
      await editor.edit(entry, (current) => {
        const currentDeclaration = readPresetDeclaration(current, config.presetEntry)
        const currentRows = findGroup(currentDeclaration.plugins, config.extensionGroup, config.presetEntry)
        previous = structuredClone(currentRows)
        return withGroup(current, config.extensionGroup, next(currentRows, currentDeclaration.plugins, source))
      })
      const after = (await ctx.agentPresets.resolve(declaration.id)).broken
      const oldLines = new Set(before?.split('\n') ?? [])
      const newLines = after?.split('\n').filter(line => !oldLines.has(line)) ?? []
      if (newLines.length > 0) {
        try {
          const fresh = entryForEdit()
          await editor.edit(fresh, current => withGroup(current, config.extensionGroup, previous))
        } catch (cause) {
          throw new Error(`Plugin row "${id}" failed to load in ${declaration.id}, and rolling back failed; new ${declaration.id} sessions stay broken until self_extend removes "${id}": ${String(cause)}`, { cause })
        }
        throw new Error(`Plugin row "${id}" failed to load in ${declaration.id}; the change was rolled back:\n${newLines.join('\n')}`)
      }
      return { preset: declaration.id, action: args.action, id, extensions: read().rows.map(describe),
        next: `Start a subagent with agent_preset "${declaration.id}" or a new ${declaration.id} session to use this change.` }
    }

    let outcome: Outcome
    try { outcome = { ok: true, value: await change() } }
    catch (error) { outcome = { ok: false, error } }
    let cleanupFailure: string | undefined
    try { await sweep(modulesDir) }
    catch (error) {
      cleanupFailure = `Removing unreferenced self-extension modules in ${modulesDir} failed: ${String(error)}; the files remain and the next self_extend change retries.`
    }
    if (outcome.ok) return JSON.stringify(cleanupFailure === undefined ? outcome.value : { ...outcome.value, cleanup: cleanupFailure })
    if (cleanupFailure === undefined) throw outcome.error
    const errorMessage = outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
    throw new Error(`${errorMessage}\n${cleanupFailure}`, { cause: outcome.error })
  }

  ctx.tools.register(defineTool({
    name: 'self_extend',
    description: 'Extend this mode\'s own plugin composition without approval, inside fixed guardrails: list, add, update, or remove rows in its self-extension group. A module extension is a self-contained ESM file that exports tools (an array of { name, description, parameters }) and execute(name, args); every call runs in a fresh OS-sandboxed Node process with an empty environment and no harness tools, and may write only where its write permission allows. A package extension must be on this mode\'s package allowlist and loads in-process. Changes persist in the profile and apply to new sessions of this mode and to subagents started with agent_preset set to this mode; this session keeps its current tools. A change that fails to load is rolled back and reported. Other modes and profile-wide plugins are out of scope; use plugin_manager for those.',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'add', 'update', 'remove'], description: 'Operation.' },
      id: { type: 'string', description: 'Extension row id: lowercase letters, digits, and hyphens. Required except for list.' },
      package: { type: 'string', description: 'For add or update: an installed plugin package on this mode\'s allowlist, such as @deepseek-ai/dsh-tool-str-replace-editor; it loads in-process. Mutually exclusive with module.' },
      module: { type: 'string', description: 'For add or update: absolute path to a self-contained ESM file (.js or .mjs) that exports tools and execute(name, args). The file is copied, so later edits need another update. Mutually exclusive with package.' },
      write: { type: 'string', enum: ['none', 'data', 'workspace'], description: 'For module extensions: where its sandboxed calls may write. none: nowhere; data: only its private data directory; workspace: the session workspace and its data directory, never wider than the session\'s own mode and never a home, root, or DSH directory. Defaults to data on add; omitted on update keeps the current value.' },
      config: { type: 'json', description: 'For package extensions: the row\'s complete config object. Omitted on update keeps the current config.' },
      enabled: { type: 'boolean', description: 'For add or update: false saves the row disabled. Defaults to true on add; omitted on update keeps the current state.' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      if (args.action === 'list') {
        const { declaration, rows } = read()
        return JSON.stringify({ preset: declaration.id, extensions: rows.map(describe) })
      }
      const mutation: Mutation = { ...args, action: args.action }
      const presetId = readPresetDeclaration(entryForEdit().options.config, config.presetEntry).id
      return await ctx.agentPresets.serializeChange(presetId, () => mutate(mutation, exec))
    },
    presentCall: presentSelfExtendCall,
  }))
}
