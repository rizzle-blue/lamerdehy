/** Tools declared by a Tidebloom module extension, each call run in a fresh OS-sandboxed PTC process. */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, parse, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { sandboxDenialMarker, type SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { PtcRunResult } from '@deepseek-ai/dsh-ptc-runtime'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-app-boot'

export const name = 'tool-sandboxed-module'
export const inject = ['tools', 'ptcRuntime', 'sandboxPolicy', 'profileContext']

/** One model-visible tool declared by the module's `tools` export. */
export interface ModuleTool {
  /** Tool name; lowercase letters, digits, and underscores. */
  name: string
  /** Model-visible tool description. */
  description: string
  /** JSON Schema of the tool's arguments. */
  parameters: Record<string, unknown>
}

/** Stored module, its private data directory, write permission, and declared tools. */
export interface Config {
  /** `file:` URL of the stored module copy; it exports `execute(name, args)`. */
  module: string
  /** Absolute private data directory of this extension. */
  dataDir: string
  /** Where sandboxed calls may write: nowhere, the data directory, or the session workspace plus the data directory. */
  write: 'none' | 'data' | 'workspace'
  /** Tools the module declared in its manifest check. */
  tools: ModuleTool[]
}

export const Config: z<Config> = z.object({
  module: z.string().required().description('file: URL of the stored module copy; it exports execute(name, args).'),
  dataDir: z.string().required().description('Absolute private data directory of this extension.'),
  write: z.union(['none', 'data', 'workspace']).default('data')
    .description('Where sandboxed calls may write: none, only the data directory, or the session workspace plus the data directory.'),
  tools: z.array(z.object({
    name: z.string().pattern(/^[a-z][a-z0-9_]{0,63}$/).required().description('Tool name; lowercase letters, digits, and underscores.'),
    description: z.string().min(1).required().description('Model-visible tool description.'),
    parameters: z.dict(z.any()).required().description('JSON Schema of the tool arguments.'),
  })).min(1).required().description('Tools the module declared in its manifest check.'),
})

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!path.startsWith('..') && !isAbsolute(path))
}

/** Register the module's tools; every call runs it in a fresh confined process under an automatically granted policy.
 * @param ctx Context providing the tool registry, a confining TypeScript PTC runtime, sandbox policy, and profile facts.
 * @param config Stored module, data directory, write permission, and declared tools.
 */
export function apply(ctx: Context, config: Config): void {
  if (!config.module.startsWith('file:')) throw new Error('Sandboxed module must be a file: URL')
  if (!isAbsolute(config.dataDir)) throw new Error('Sandboxed module dataDir must be absolute')
  const runtime = ctx.ptcRuntime
  if (runtime.language !== 'typescript') throw new Error('tool-sandboxed-module requires a TypeScript ptcRuntime')
  if (runtime.sandboxMode === undefined) throw new Error('tool-sandboxed-module requires a confining ptcRuntime')
  const { dataDir } = config

  const placement = (tool: ModuleTool, exec: ToolRunContext): { policy: SandboxExecutionPolicy; cwd: string } => {
    if (config.write === 'none') return { policy: { mode: 'read-only', workspaceRoot: dataDir }, cwd: dataDir }
    const data: SandboxExecutionPolicy = { mode: 'workspace-write', workspaceRoot: dataDir }
    if (config.write === 'data') return { policy: data, cwd: dataDir }
    const session = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })
    const root = session.workspaceRoot
    if (session.mode === 'read-only') return { policy: data, cwd: root }
    if (parse(root).root === root || relative(root, homedir()) === ''
      || inside(ctx.profileContext.home, root) || inside(root, ctx.profileContext.home)) {
      throw new Error(`Sandboxed extension tool "${tool.name}" refused workspace writes: ${root} is a protected directory (filesystem root, home directory, or DSH home). Use write "data", or run the session in a project directory.`)
    }
    return {
      policy: {
        mode: 'workspace-write', workspaceRoot: root,
        additionalWritableRoots: [...(session.additionalWritableRoots ?? []), dataDir],
        ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }),
      },
      cwd: root,
    }
  }

  // The source travels as a data: URL, so the sandbox needs no read access to the profile; Linux
  // workspace-write confinement hides /tmp, where a profile may live.
  const program = async (tool: ModuleTool, args: unknown): Promise<string> => {
    const source = `data:text/javascript;base64,${(await readFile(fileURLToPath(config.module))).toString('base64')}`
    const body = `(async () => { const m = await import(${JSON.stringify(source)}); return await m.execute(${JSON.stringify(tool.name)}, ${JSON.stringify(args)}) })()`
    return runtime.programFormat === 'function-body' ? `return await ${body}` : body
  }

  const report = (tool: ModuleTool, result: PtcRunResult): string => {
    const logs = result.logs.length === 0 ? '' : `\nLogs:\n${result.logs.join('\n')}`
    if (result.error !== undefined) {
      const denial = result.sandbox?.denied === true
        ? `\n${sandboxDenialMarker(result.sandbox.mode)}\nSelf-extension tools cannot request wider access; use self_extend update to change this extension's write permission within its guardrails.`
        : ''
      throw new Error(`Sandboxed extension tool "${tool.name}" failed (${result.error.kind}): ${result.error.message}${denial}${logs}`)
    }
    const value = typeof result.value === 'string' ? result.value : JSON.stringify(result.value ?? null)
    return value + logs
  }

  for (const tool of config.tools) {
    ctx.effect(() => ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value as string }] },
      presentCall: args => ({ card: 'generic', kind: 'other', title: `Run sandboxed ${tool.name}`, rawInput: args }),
      async execute(args, exec) {
        const { policy, cwd } = placement(tool, exec)
        const spec = runtime.resolve({ program: await program(tool, args), bindings: [], cwd, sandboxPolicy: policy, signal: exec.signal })
        return report(tool, await runtime.run(spec))
      },
    }))
  }
}
