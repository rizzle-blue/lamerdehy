import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ProfileContext } from '@deepseek-ai/dsh-app-boot'
import type { PtcProgramFormat, PtcRunRequest, PtcRunResult, PtcRunSpec, PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import type { SandboxExecutionPolicy, SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyRequest, SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, onTestFinished } from 'vitest'
import * as SandboxedModule from '../src/index.ts'

const moduleSource = 'export const tools = []\nexport function execute() { return "ok" }\n'
const moduleData = `data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`
const tool = { name: 'echo_tool', description: 'Echo a value.', parameters: { type: 'object', properties: { value: { type: 'string' } } } }

interface Options {
  language?: string
  sandboxMode?: SandboxMode | undefined
  programFormat?: PtcProgramFormat
  config?: Partial<SandboxedModule.Config>
}

async function setup(options: Options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'sandboxed-module-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  const home = join(root, 'dsh-home')
  const modulePath = join(root, 'echo-123.mjs')
  await writeFile(modulePath, moduleSource)
  const dataDir = join(home, 'profiles', 'spec', 'self-extensions', 'tidebloom', 'data', 'echo')
  const state = {
    session: { mode: 'workspace-write', workspaceRoot: join(root, 'project') } as SandboxExecutionPolicy,
    policyRequests: [] as SandboxPolicyRequest[],
    requests: [] as PtcRunRequest[],
    results: [] as PtcRunResult[],
  }
  const runtime = {
    language: options.language ?? 'typescript',
    sandboxMode: 'sandboxMode' in options ? options.sandboxMode : 'workspace-write',
    programFormat: options.programFormat ?? 'function-body',
    resolve(request: PtcRunRequest): PtcRunSpec {
      state.requests.push(request)
      return { ...request, cwd: request.cwd ?? '/', timeoutMs: null }
    },
    run(spec: PtcRunSpec): Promise<PtcRunResult> {
      void spec
      return Promise.resolve(state.results.shift() ?? { logs: [], value: 'ok' })
    },
  } as PtcRuntime
  const policy = {
    resolve(request: SandboxPolicyRequest = {}): SandboxExecutionPolicy {
      state.policyRequests.push(request)
      return state.session
    },
  } as SandboxPolicyService
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(NativeToolExecutor)
  ctx.provide('ptcRuntime', runtime)
  ctx.provide('sandboxPolicy', policy)
  ctx.provide('profileContext', { home } as ProfileContext)
  const config = { module: pathToFileURL(modulePath).href, dataDir, write: 'data', tools: [tool], ...options.config } satisfies SandboxedModule.Config
  const load = () => ctx.plugin(SandboxedModule, config)
  return { ctx, root, home, dataDir, modulePath, state, load }
}

let callCounter = 0
function call(ctx: Context, args: object, agent?: Agent, name = tool.name) {
  return executeToolFixture(ctx, {
    signal: new AbortController().signal,
    callId: `sandboxed-${++callCounter}` as ToolExecutionInput['callId'],
    name, arguments: args,
    ...(agent === undefined ? {} : { agent }),
  })
}
function text(result: ToolExecutionResult) {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}
const session = { id: SessionId('sandboxed-session') } as Session
const agent = { session } as Agent

describe('tool-sandboxed-module', () => {
  it('registers every declared tool with a generic call presentation', async () => {
    const { ctx, load } = await setup({ config: { tools: [tool, { ...tool, name: 'second_tool' }] } })
    await load()
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(expect.arrayContaining(['echo_tool', 'second_tool']))
    expect(ctx.tools.schemas().find(schema => schema.name === 'echo_tool')).toMatchObject({ description: tool.description, parameters: tool.parameters })
    const definition = ctx.tools.get('echo_tool')
    expect(definition?.presentCall?.({ value: 'x' })).toEqual({ card: 'generic', kind: 'other', title: 'Run sandboxed echo_tool', rawInput: { value: 'x' } })
  })

  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)('write "none" stays read-only in the data directory under a %s session', async (mode) => {
    const { ctx, dataDir, state, load } = await setup({ config: { write: 'none' } })
    state.session = { ...state.session, mode }
    await load()
    expect((await call(ctx, { value: 'a' }, agent)).isError).not.toBe(true)
    expect(state.requests[0]).toMatchObject({ cwd: dataDir, sandboxPolicy: { mode: 'read-only', workspaceRoot: dataDir }, bindings: [] })
    expect(state.requests[0]).not.toHaveProperty('stateOwner')
  })

  it.each(['read-only', 'workspace-write', 'danger-full-access'] as const)('write "data" writes only the data directory under a %s session', async (mode) => {
    const { ctx, dataDir, state, load } = await setup()
    state.session = { ...state.session, mode }
    await load()
    expect((await call(ctx, {}, agent)).isError).not.toBe(true)
    expect(state.requests[0]).toMatchObject({ cwd: dataDir, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: dataDir } })
    expect(state.requests[0]?.sandboxPolicy).not.toHaveProperty('additionalWritableRoots')
  })

  it('write "workspace" under a read-only session keeps writes in the data directory but runs in the workspace', async () => {
    const { ctx, dataDir, state, load } = await setup({ config: { write: 'workspace' } })
    state.session = { ...state.session, mode: 'read-only' }
    await load()
    expect((await call(ctx, {}, agent)).isError).not.toBe(true)
    expect(state.policyRequests).toEqual([{ session }])
    expect(state.requests[0]).toMatchObject({ cwd: state.session.workspaceRoot, sandboxPolicy: { mode: 'workspace-write', workspaceRoot: dataDir } })
  })

  it.each(['workspace-write', 'danger-full-access'] as const)('write "workspace" under a %s session grants the workspace and data directory, never full access', async (mode) => {
    const { ctx, root, dataDir, state, load } = await setup({ config: { write: 'workspace' } })
    const extra = join(root, 'extra')
    state.session = { mode, workspaceRoot: join(root, 'project'), additionalWritableRoots: [extra], sessionId: session.id }
    await load()
    expect((await call(ctx, {}, agent)).isError).not.toBe(true)
    expect(state.requests[0]).toMatchObject({ cwd: join(root, 'project') })
    expect(state.requests[0]?.sandboxPolicy).toEqual({
      mode: 'workspace-write', workspaceRoot: join(root, 'project'), additionalWritableRoots: [extra, dataDir], sessionId: session.id,
    })
  })

  it('write "workspace" without an agent resolves the deployment policy and omits a session id', async () => {
    const { ctx, root, dataDir, state, load } = await setup({ config: { write: 'workspace' } })
    await load()
    expect((await call(ctx, {})).isError).not.toBe(true)
    expect(state.policyRequests).toEqual([{}])
    expect(state.requests[0]?.sandboxPolicy).toEqual({ mode: 'workspace-write', workspaceRoot: join(root, 'project'), additionalWritableRoots: [dataDir] })
  })

  it('refuses workspace writes in protected directories', async () => {
    const { ctx, root, home, state, load } = await setup({ config: { write: 'workspace' } })
    await load()
    const protectedRoots = [parse(root).root, homedir(), home, join(home, 'profiles'), dirname(home)]
    for (const workspaceRoot of protectedRoots) {
      state.session = { mode: 'workspace-write', workspaceRoot }
      const result = await call(ctx, {}, agent)
      expect(result.isError).toBe(true)
      expect(text(result)).toContain(`Sandboxed extension tool "echo_tool" refused workspace writes: ${workspaceRoot} is a protected directory`)
    }
    expect(state.requests).toEqual([])
  })

  it.each([
    ['function-body', `return await (async () => { const m = await import("${moduleData}"); return await m.execute("echo_tool", {"value":"a"}) })()`],
    ['repl', `(async () => { const m = await import("${moduleData}"); return await m.execute("echo_tool", {"value":"a"}) })()`],
  ] as const)('builds a %s program that imports the module and runs the tool', async (programFormat, program) => {
    const { ctx, state, load } = await setup({ programFormat })
    await load()
    await call(ctx, { value: 'a' })
    expect(state.requests[0]?.program).toBe(program)
    expect(state.requests[0]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('passes the stored module source by value and reports a missing module without running it', async () => {
    const { ctx, modulePath, state, load } = await setup()
    await load()
    await rm(modulePath)
    const outcome = await call(ctx, {})
    expect(outcome.isError).toBe(true)
    expect(text(outcome)).toContain('ENOENT')
    expect(state.requests).toEqual([])
  })

  it.each([
    [{ logs: [], value: 'plain' }, 'plain'],
    [{ logs: [], value: { n: 1 } }, '{"n":1}'],
    [{ logs: [] }, 'null'],
    [{ logs: ['one', 'two'], value: 'plain' }, 'plain\nLogs:\none\ntwo'],
    [{ logs: ['log'], value: [1] }, '[1]\nLogs:\nlog'],
  ] satisfies [PtcRunResult, string][])('renders a successful result %#', async (result, expected) => {
    const { ctx, state, load } = await setup()
    await load()
    state.results.push(result)
    const outcome = await call(ctx, {})
    expect(outcome.isError).not.toBe(true)
    expect(text(outcome)).toBe(expected)
  })

  it('reports failures with logs and the sandbox denial marker', async () => {
    const { ctx, state, load } = await setup()
    await load()
    state.results.push({ logs: [], error: { kind: 'exception', message: 'boom' } })
    let outcome = await call(ctx, {})
    expect(outcome.isError).toBe(true)
    expect(text(outcome)).toContain('Sandboxed extension tool "echo_tool" failed (exception): boom')
    expect(text(outcome)).not.toContain('Logs:')
    state.results.push({ logs: ['trace'], error: { kind: 'exception', message: 'EPERM' }, sandbox: { mode: 'workspace-write', denied: true } })
    outcome = await call(ctx, {})
    expect(text(outcome)).toContain('failed (exception): EPERM\n[sandbox: file access denied under workspace-write mode]\nSelf-extension tools cannot request wider access; use self_extend update to change this extension\'s write permission within its guardrails.\nLogs:\ntrace')
    state.results.push({ logs: [], error: { kind: 'timeout', message: 'late' }, sandbox: { mode: 'read-only', denied: false } })
    outcome = await call(ctx, {})
    expect(text(outcome)).toContain('failed (timeout): late')
    expect(text(outcome)).not.toContain('[sandbox:')
  })

  it.each([
    ['a non-file module URL', { config: { module: '/extensions/echo.mjs' } }, 'Sandboxed module must be a file: URL'],
    ['a relative data directory', { config: { dataDir: 'data/echo' } }, 'Sandboxed module dataDir must be absolute'],
    ['a non-TypeScript runtime', { language: 'python' }, 'tool-sandboxed-module requires a TypeScript ptcRuntime'],
    ['an unconfined runtime', { sandboxMode: undefined }, 'tool-sandboxed-module requires a confining ptcRuntime'],
  ] satisfies [string, Options, string][])('rejects %s at load', async (_case, options, message) => {
    const { ctx, load } = await setup(options)
    await expect(load()).rejects.toThrow(message)
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('echo_tool')
  })
})
