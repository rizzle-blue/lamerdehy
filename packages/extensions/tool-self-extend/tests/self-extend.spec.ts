import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import type * as FsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type { AgentPreset, AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { ConfigEditor } from '@deepseek-ai/dsh-config-editor'
import type { PtcProgramFormat, PtcRunRequest, PtcRunResult, PtcRunSpec, PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import * as SelfExtend from '../src/index.ts'
import { findGroup, SANDBOXED_MODULE_PLUGIN } from '../src/rows.ts'

const fsFault = vi.hoisted(() => ({ missingOnRemove: '' }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromises>()
  return {
    ...fs,
    async rm(path: Parameters<typeof fs.rm>[0], options?: Parameters<typeof fs.rm>[1]) {
      if (String(path) === fsFault.missingOnRemove) {
        fsFault.missingOnRemove = ''
        await fs.rm(path, options)
        throw Object.assign(new Error('removed concurrently'), { code: 'ENOENT' })
      }
      return fs.rm(path, options)
    },
  }
})

const presetEntry = 'preset-tidebloom'
const extensionGroup = 'self-extensions'
const allowedPackages = ['@scope/clock', 'other-clock', 'first-plugin', 'second-plugin', 'replacement-plugin', 'pkg', 'bad-pkg', 'pkg-one', 'pkg-two', 'pkg-three']
const initial = () => ({ id: 'tidebloom', plugins: [
  { id: 'base', name: 'base-package' },
  { id: 'nested-group', group: true, config: [{ id: 'nested', name: 'nested-package' }] },
  { id: extensionGroup, name: 'cordis:group', group: true, config: [] },
] })
const echoTool = { name: 'echo_tool', description: 'Echo a value.', parameters: { type: 'object' } }

type Config = Record<string, unknown>
type Change = (current: Config, inherited: Config) => Config

async function setup(options: { programFormat?: PtcProgramFormat } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'self-extend-'))
  const state = {
    config: initial() as Config,
    available: true,
    broken: [] as (string | undefined)[],
    edits: 0,
    failEdit: 0,
    editError: new Error('edit unavailable') as Error | string,
    beforeEdit: undefined as (() => Promise<void>) | undefined,
    probes: [] as PtcRunRequest[],
    probeResults: [] as PtcRunResult[],
  }
  const entry = { options: { id: presetEntry, config: state.config } } as Entry
  const editor = {
    entries() {
      entry.options.config = state.config
      return state.available ? [entry] : []
    },
    async edit(_entry: Entry, change: Change) {
      state.edits++
      if (state.beforeEdit !== undefined) await state.beforeEdit()
      if (state.edits === state.failEdit) throw state.editError
      state.config = change(state.config, initial())
      entry.options.config = state.config
    },
  } as ConfigEditor
  const changes = new Map<string, Promise<unknown>>()
  const registry = {
    async resolve() { return { broken: state.broken.shift() } as AgentPreset },
    async serializeChange<T>(id: string, change: () => Promise<T>): Promise<T> {
      const run = (changes.get(id) ?? Promise.resolve()).then(change)
      changes.set(id, run.catch(() => undefined))
      return await run
    },
  } as AgentPresetRegistry
  const runtime = {
    programFormat: options.programFormat ?? 'function-body',
    resolve(request: PtcRunRequest): PtcRunSpec {
      state.probes.push(request)
      return { ...request, cwd: request.cwd ?? '/', timeoutMs: null }
    },
    async run(spec: PtcRunSpec): Promise<PtcRunResult> {
      // The data directory exists before the module is probed.
      await stat(spec.cwd)
      return state.probeResults.shift() ?? { logs: [], value: [echoTool] }
    },
  } as PtcRuntime
  const contexts: Context[] = []
  async function revision() {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(NativeToolExecutor)
    ctx.provide('profileContext', { dir } as ProfileContext)
    ctx.provide('configEditor', editor)
    ctx.provide('agentPresets', registry)
    ctx.provide('ptcRuntime', runtime)
    await ctx.plugin(SelfExtend, { presetEntry, extensionGroup, allowedPackages })
    return ctx
  }
  const ctx = await revision()
  onTestFinished(async () => {
    fsFault.missingOnRemove = ''
    for (const context of contexts) await context.fiber.dispose()
    await rm(dir, { recursive: true, force: true })
  })
  const rows = () => findGroup(state.config.plugins as unknown[], extensionGroup, presetEntry)
  const modules = join(dir, 'self-extensions', 'tidebloom', 'modules')
  const data = (id: string) => join(dir, 'self-extensions', 'tidebloom', 'data', id)
  return { ctx, dir, state, rows, revision, modules, data }
}

let callCounter = 0
async function call(ctx: Context, args: object) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: `self-${++callCounter}` as ToolExecutionInput['callId'],
    name: 'self_extend', arguments: args,
  })
}
function text(result: ToolExecutionResult) {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}
interface Success { preset: string; action?: string; id?: string; extensions: object[]; next?: string; cleanup?: string }
async function success(ctx: Context, args: object) {
  const result = await call(ctx, args)
  expect(result.isError, text(result)).not.toBe(true)
  return JSON.parse(text(result)) as Success
}
async function failure(ctx: Context, args: object) {
  const result = await call(ctx, args)
  expect(result.isError).toBe(true)
  return text(result)
}
async function moduleFile(dir: string, name: string, content: string) {
  const path = join(dir, name)
  await writeFile(path, content)
  return path
}
function hashOf(content: string) {
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}
function dataUrl(content: string) {
  return `data:text/javascript;base64,${Buffer.from(content).toString('base64')}`
}

describe('self_extend', () => {
  it('lists rows and persists package adds, updates, and removal', async () => {
    const { ctx, rows } = await setup()
    expect(await success(ctx, { action: 'list' })).toEqual({ preset: 'tidebloom', extensions: [] })
    const added = await success(ctx, { action: 'add', id: 'clock', package: '@scope/clock', config: { zone: 'UTC' }, enabled: false })
    expect(added).toMatchObject({ preset: 'tidebloom', action: 'add', id: 'clock', extensions: [{ id: 'clock', source: { package: '@scope/clock' }, config: { zone: 'UTC' }, disabled: true }] })
    expect(added.next).toContain('tidebloom')
    expect(added).not.toHaveProperty('cleanup')
    await success(ctx, { action: 'update', id: 'clock', package: 'other-clock' })
    expect((await success(ctx, { action: 'list' })).extensions).toEqual([{ id: 'clock', source: { package: 'other-clock' }, config: { zone: 'UTC' }, disabled: true }])
    await success(ctx, { action: 'update', id: 'clock', config: { zone: 'GMT' }, enabled: true })
    expect((await success(ctx, { action: 'list' })).extensions).toEqual([{ id: 'clock', source: { package: 'other-clock' }, config: { zone: 'GMT' } }])
    await success(ctx, { action: 'update', id: 'clock', enabled: false })
    expect(rows()[0]?.disabled).toBe(true)
    await success(ctx, { action: 'remove', id: 'clock' })
    expect(rows()).toEqual([])
  })

  it('updates only the selected extension and retains sibling configuration', async () => {
    const { ctx, rows } = await setup()
    await success(ctx, { action: 'add', id: 'first', package: 'first-plugin' })
    await success(ctx, { action: 'add', id: 'second', package: 'second-plugin', config: { keep: true }, enabled: false })
    await success(ctx, { action: 'update', id: 'first', package: 'replacement-plugin' })
    expect(rows()).toEqual([
      { id: 'first', name: 'replacement-plugin' },
      { id: 'second', name: 'second-plugin', config: { keep: true }, disabled: true },
    ])
  })

  it('stores checked module rows, probes them read-only in their data directory, and sweeps obsolete copies', async () => {
    const { ctx, dir, state, rows, modules, data } = await setup()
    const first = 'export const tools = []\n'
    const source = await moduleFile(dir, 'plugin.js', first)
    const added = await success(ctx, { action: 'add', id: 'echo', module: source })
    const stored = join(modules, `echo-${hashOf(first)}.mjs`)
    expect(await readFile(stored, 'utf8')).toBe(first)
    expect(rows()).toEqual([{ id: 'echo', name: SANDBOXED_MODULE_PLUGIN,
      config: { module: pathToFileURL(stored).href, dataDir: data('echo'), write: 'data', tools: [echoTool] } }])
    expect(added.extensions).toEqual([{ id: 'echo', source: { module: stored }, write: 'data', tools: ['echo_tool'], dataDir: data('echo') }])
    expect(state.probes[0]).toMatchObject({
      program: `return await (async () => { const m = await import(${JSON.stringify(dataUrl(first))}); return m.tools })()`,
      bindings: [], cwd: data('echo'), sandboxPolicy: { mode: 'read-only', workspaceRoot: data('echo') },
    })
    expect(state.probes[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(state.probes[0]).not.toHaveProperty('stateOwner')
    const second = 'export const tools = [1]\n'
    await writeFile(source, second)
    await success(ctx, { action: 'update', id: 'echo', module: source, enabled: false })
    expect(await readdir(modules)).toEqual([`echo-${hashOf(second)}.mjs`])
    expect(rows()[0]).toMatchObject({ disabled: true, config: { write: 'data' } })
    await success(ctx, { action: 'update', id: 'echo', write: 'workspace' })
    expect(rows()[0]).toMatchObject({ disabled: true, config: { module: pathToFileURL(join(modules, `echo-${hashOf(second)}.mjs`)).href, write: 'workspace', tools: [echoTool] } })
    await success(ctx, { action: 'update', id: 'echo', module: source, enabled: true })
    expect(rows()[0]).not.toHaveProperty('disabled')
    expect(rows()[0]).toMatchObject({ config: { write: 'workspace' } })
    expect(state.probes).toHaveLength(3)
  })

  it('keeps data directories after removal and reuses them on re-add', async () => {
    const { ctx, dir, modules, data } = await setup()
    const source = await moduleFile(dir, 'plugin.mjs', 'export const tools = []\n')
    await success(ctx, { action: 'add', id: 'echo', module: source, write: 'none' })
    await writeFile(join(data('echo'), 'notes.txt'), 'kept')
    await success(ctx, { action: 'remove', id: 'echo' })
    expect(await readdir(modules)).toEqual([])
    expect(await readFile(join(data('echo'), 'notes.txt'), 'utf8')).toBe('kept')
    const readded = await success(ctx, { action: 'add', id: 'echo', module: source })
    expect(readded.extensions).toMatchObject([{ id: 'echo', write: 'data', dataDir: data('echo') }])
    expect(await readFile(join(data('echo'), 'notes.txt'), 'utf8')).toBe('kept')
  })

  it('probes with a final-expression program for REPL runtimes', async () => {
    const { ctx, dir, state } = await setup({ programFormat: 'repl' })
    const source = await moduleFile(dir, 'plugin.mjs', 'repl\n')
    await success(ctx, { action: 'add', id: 'echo', module: source })
    expect(state.probes[0]?.program).toBe(`(async () => { const m = await import(${JSON.stringify(dataUrl('repl\n'))}); return m.tools })()`)
  })

  it('converts between module and package rows', async () => {
    const { ctx, dir, rows, data } = await setup()
    const source = await moduleFile(dir, 'plugin.mjs', 'module\n')
    await success(ctx, { action: 'add', id: 'swap', module: source, write: 'none', enabled: false })
    await success(ctx, { action: 'update', id: 'swap', package: 'pkg' })
    expect(rows()).toEqual([{ id: 'swap', name: 'pkg', disabled: true }])
    await success(ctx, { action: 'update', id: 'swap', module: source })
    expect(rows()[0]).toMatchObject({ name: SANDBOXED_MODULE_PLUGIN, disabled: true, config: { write: 'data', dataDir: data('swap') } })
    await success(ctx, { action: 'update', id: 'swap', package: 'pkg', config: { mode: 'x' } })
    expect(rows()).toEqual([{ id: 'swap', name: 'pkg', config: { mode: 'x' }, disabled: true }])
  })

  it('rejects invalid mutations before copying, probing, or editing', async () => {
    const { ctx, state, dir, modules } = await setup()
    const source = await moduleFile(dir, 'x.mjs', 'x\n')
    const badCalls = [
      { action: 'add', package: 'pkg' }, { action: 'add', id: 'UPPER', package: 'pkg' },
      { action: 'add', id: 'nested', package: 'pkg' }, { action: 'add', id: 'base', package: 'pkg' },
      { action: 'add', id: 'empty' }, { action: 'add', id: 'both', package: 'pkg', module: source },
      { action: 'update', id: 'missing' }, { action: 'remove', id: 'missing' },
      { action: 'add', id: 'relative', module: 'x.mjs' }, { action: 'add', id: 'ts', module: join(dir, 'x.ts') },
      { action: 'add', id: 'path', package: './pkg' },
      { action: 'add', id: 'array', package: 'pkg', config: [] }, { action: 'add', id: 'null', package: 'pkg', config: null },
      { action: 'add', id: 'number', package: 'pkg', config: 1 },
    ]
    for (const args of badCalls) await failure(ctx, args)
    expect(await failure(ctx, { action: 'add', id: 'shell', package: '@deepseek-ai/dsh-tool-bash' })).toContain('Package "@deepseek-ai/dsh-tool-bash" is not on this mode\'s package allowlist')
    expect(await failure(ctx, { action: 'add', id: 'pw', package: 'pkg', write: 'data' })).toContain('write applies only to module extensions')
    expect(await failure(ctx, { action: 'add', id: 'mc', module: source, config: {} })).toContain('config applies only to package extensions')
    expect(state.edits).toBe(0)
    expect(state.probes).toEqual([])
    await expect(stat(modules)).rejects.toMatchObject({ code: 'ENOENT' })
    await success(ctx, { action: 'add', id: 'existing', package: 'pkg' })
    await success(ctx, { action: 'add', id: 'mod', module: source })
    expect(await failure(ctx, { action: 'update', id: 'existing', package: 'pkg', module: source })).toContain('accepts at most one')
    expect(await failure(ctx, { action: 'update', id: 'existing', write: 'none' })).toContain('write applies only to module extensions')
    expect(await failure(ctx, { action: 'update', id: 'mod', config: {} })).toContain('config applies only to package extensions')
    expect(await failure(ctx, { action: 'update', id: 'mod', package: 'pkg', write: 'none' })).toContain('write applies only to module extensions')
    expect(await failure(ctx, { action: 'update', id: 'existing', module: source, config: {} })).toContain('config applies only to package extensions')
    expect(state.edits).toBe(2)
    expect(state.probes).toHaveLength(1)
  })

  it('rejects modules that fail their sandboxed manifest check and removes the copy', async () => {
    const { ctx, state, dir, rows, modules } = await setup()
    const source = await moduleFile(dir, 'broken.mjs', 'throw new Error("broken")\n')
    state.probeResults.push({ logs: [], error: { kind: 'exception', message: 'broken' } })
    expect(await failure(ctx, { action: 'add', id: 'broken', module: source })).toContain('Self-extension module "broken" failed its sandboxed manifest check: exception: broken')
    state.probeResults.push({ logs: [], value: [{ ...echoTool, name: 'Bad Name' }] })
    expect(await failure(ctx, { action: 'add', id: 'broken', module: source })).toContain('failed its sandboxed manifest check: tools[0].name must match')
    expect(rows()).toEqual([])
    expect(state.edits).toBe(0)
    expect(await readdir(modules)).toEqual([])
  })

  it('rejects tool names already registered in the mode except the updated row\'s own', async () => {
    const { ctx, state, dir, rows } = await setup()
    const source = await moduleFile(dir, 'echo.mjs', 'echo\n')
    state.probeResults.push({ logs: [], value: [{ ...echoTool, name: 'self_extend' }] })
    expect(await failure(ctx, { action: 'add', id: 'clash', module: source })).toContain('Tool name "self_extend" is already registered in this mode')
    await success(ctx, { action: 'add', id: 'echo', module: source })
    expect(await failure(ctx, { action: 'add', id: 'copy', module: source })).toContain('Tool name "echo_tool" is already registered in this mode')
    ctx.tools.register({ name: 'echo_tool', description: 'Live copy.', parameters: { type: 'object' },
      output: { schema: { type: 'string' }, render: () => [] }, execute: () => Promise.resolve('') })
    await success(ctx, { action: 'update', id: 'echo', module: source })
    await success(ctx, { action: 'add', id: 'plain', package: 'pkg' })
    expect(await failure(ctx, { action: 'update', id: 'plain', module: source })).toContain('Tool name "echo_tool" is already registered in this mode')
    expect(rows().map(row => row.id)).toEqual(['echo', 'plain'])
  })

  it('lists, removes, but never updates retired in-process module rows', async () => {
    const { ctx, state, dir, rows } = await setup()
    const retired = pathToFileURL(join(dir, 'old.mjs')).href
    state.config = { id: 'tidebloom', plugins: [{ id: extensionGroup, group: true, config: [{ id: 'old', name: retired }] }] }
    expect((await success(ctx, { action: 'list' })).extensions).toEqual([{ id: 'old', source: { module: fileURLToPath(retired) } }])
    expect(await failure(ctx, { action: 'update', id: 'old', enabled: false })).toContain('Self-extension "old" uses the retired in-process module form; remove it and add it again as a module')
    await success(ctx, { action: 'remove', id: 'old' })
    expect(rows()).toEqual([])
  })

  it('rejects missing or malformed profile data', async () => {
    const { ctx, state } = await setup()
    state.available = false
    await failure(ctx, { action: 'list' })
    await failure(ctx, { action: 'add', id: 'x', package: 'pkg' })
    state.available = true
    state.config = { id: 'tidebloom', plugins: [] }
    await failure(ctx, { action: 'list' })
    state.config = { id: 'tidebloom', plugins: [{ id: extensionGroup, group: true, config: [null] }] }
    await failure(ctx, { action: 'list' })
    state.config = { id: 'tidebloom', plugins: [{ id: extensionGroup, group: true, config: [{ id: 'bad', name: SANDBOXED_MODULE_PLUGIN }] }] }
    expect(await failure(ctx, { action: 'list' })).toContain('malformed sandboxed module config')
    state.config = {}
    await failure(ctx, { action: 'add', id: 'x', package: 'pkg' })
    expect(state.edits).toBe(0)
  })

  it('allows existing health failures but rolls back new failure lines', async () => {
    const { ctx, state, rows } = await setup()
    state.broken = ['old\nunchanged', 'unchanged\nold']
    await success(ctx, { action: 'add', id: 'good', package: 'pkg' })
    state.broken = ['old', 'old\nnew failure']
    const error = await failure(ctx, { action: 'add', id: 'bad', package: 'bad-pkg' })
    expect(error).toContain('rolled back')
    expect(error).toContain('new failure')
    expect(rows().map(row => row.id)).toEqual(['good'])
    expect(state.edits).toBe(3)
    state.broken = [undefined, 'new failure']
    expect(await failure(ctx, { action: 'remove', id: 'good' })).toContain('rolled back')
    expect(rows().map(row => row.id)).toEqual(['good'])
  })

  it('reports a failed rollback and keeps the saved row', async () => {
    const { ctx, state, rows } = await setup()
    state.broken = [undefined, 'failure']
    state.failEdit = 2
    expect(await failure(ctx, { action: 'add', id: 'bad', package: 'bad-pkg' })).toContain('rolling back failed')
    expect(rows().map(row => row.id)).toEqual(['bad'])
  })

  it('cleans up an unreferenced copied module after rollback', async () => {
    const { ctx, state, dir, rows, modules } = await setup()
    const source = await moduleFile(dir, 'bad.mjs', 'broken')
    state.broken = [undefined, 'failure']
    expect(await failure(ctx, { action: 'add', id: 'bad', module: source })).toContain('rolled back')
    expect(rows()).toEqual([])
    expect(await readdir(modules)).toEqual([])
  })

  it('reports cleanup failures without masking a saved change or the original error', async () => {
    const { ctx, state, rows, modules } = await setup()
    await mkdir(join(modules, 'directory-not-file'), { recursive: true })
    const saved = await success(ctx, { action: 'add', id: 'saved', package: 'pkg' })
    expect(saved.cleanup).toMatch(new RegExp(`^Removing unreferenced self-extension modules in ${modules.replaceAll('\\', '\\\\')} failed: .+; the files remain and the next self_extend change retries\\.$`))
    expect(saved.extensions).toEqual([{ id: 'saved', source: { package: 'pkg' } }])
    state.broken = [undefined, 'new failure']
    const rolledBack = await failure(ctx, { action: 'add', id: 'bad', package: 'bad-pkg' })
    expect(rolledBack).toMatch(new RegExp('^Error: Plugin row "bad" failed to load in tidebloom; the change was rolled back:\nnew failure\n'
      + 'Removing unreferenced self-extension modules in .+ failed: '))
    state.failEdit = state.edits + 1
    state.editError = 'editor offline'
    expect(await failure(ctx, { action: 'add', id: 'other', package: 'pkg' })).toMatch(/^Error: editor offline\nRemoving unreferenced self-extension modules in /)
    expect(rows().map(row => row.id)).toEqual(['saved'])
  })

  it('serializes separate revisions and recovers after a failed queued mutation', async () => {
    const { ctx, revision, state, rows } = await setup()
    const other = await revision()
    const started = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<undefined>()
    state.beforeEdit = async () => { if (state.edits === 1) { started.resolve(undefined); await gate.promise } }
    const first = call(ctx, { action: 'add', id: 'one', package: 'pkg-one' })
    await started.promise
    const second = call(other, { action: 'add', id: 'two', package: 'pkg-two' })
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(state.edits).toBe(1)
    } finally {
      gate.resolve(undefined)
    }
    expect((await first).isError).not.toBe(true)
    expect((await second).isError).not.toBe(true)
    expect(rows().map(row => row.id)).toEqual(['one', 'two'])
    const failed = call(ctx, { action: 'add', id: 'one', package: 'pkg' })
    const recovered = call(other, { action: 'add', id: 'three', package: 'pkg-three' })
    expect((await failed).isError).toBe(true)
    expect((await recovered).isError).not.toBe(true)
    expect(rows().map(row => row.id)).toEqual(['one', 'two', 'three'])
  })

  it('reports filesystem errors and ignores an obsolete file removed during a sweep', async () => {
    const { ctx, dir, rows, modules } = await setup()
    await failure(ctx, { action: 'add', id: 'missing', module: join(dir, 'missing.js') })
    expect(rows()).toEqual([])
    await mkdir(modules, { recursive: true })
    const obsolete = join(modules, 'obsolete.mjs')
    await writeFile(obsolete, 'old')
    fsFault.missingOnRemove = obsolete
    await success(ctx, { action: 'add', id: 'kept', package: 'pkg' })
    expect(await readdir(modules)).toEqual([])
    await rm(modules, { recursive: true })
    await writeFile(modules, 'not a directory')
    expect((await success(ctx, { action: 'add', id: 'saved', package: 'pkg' })).cleanup).toContain('failed')
    await rm(modules)
    expect(rows().map(row => row.id)).toEqual(['kept', 'saved'])
  })
})
