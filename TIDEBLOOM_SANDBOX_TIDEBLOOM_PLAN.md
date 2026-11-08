# Tidebloom: review fixes and sandboxed, approval-free self-extension

## Context

Tidebloom mode (preset `tidebloom`, source checkouts only) ships `self_extend` (`packages/extensions/tool-self-extend`). Today `self_extend` adds plugin rows to the mode's `self-extensions` group without approval, and a `module` extension is arbitrary code loaded unconfined into the Host process.

Requested outcome:
1. Fix two review leftovers:
   - a module-cleanup failure can mask the real result;
   - the module-level queue has no owning service.
2. Keep self-extension **approval-free** ("YOLO"), but only inside a safe area with guardrails that protect user data:
   - model-written code never runs in the Host process;
   - it runs OS-sandboxed and writes only where an automatically granted, fixed permission allows;
   - in-process package rows are limited to a configured allowlist;
   - no approval prompt is ever shown.

The previous feature is adopted as uncommitted changes in the main checkout (`E:/Projects/lamerdehy`). This work builds on it.

## Approach

Develop in a new worktree, because the running harness loads this checkout (`.agents/skills/dsh-worktree-dev/SKILL.md`). Use Git Bash; WSL bash breaks this script's git paths. From `E:/Projects/lamerdehy`:

```sh
"C:/Program Files/Git/bin/bash.exe" scripts/worktree-dev.sh new tidebloom-sandbox --with-local --story "Tidebloom self-extension runs sandboxed without approval inside data-protecting guardrails; fix self_extend cleanup masking and queue ownership."
```

Steps 1 and 2 are independent. Step 3 creates the package that step 4 depends on. Step 5 depends on 3 and 4.

### 1. Cleanup failures never mask the outcome (`packages/extensions/tool-self-extend/src/index.ts`)

1. Replace the `try { … } finally { await sweep(declaration.id) }` block in `mutate()`:
   - Run the change body and capture its outcome as `{ ok: true; value: Record<string, unknown> } | { ok: false; error: unknown }`. The change body returns the success object; it is not stringified yet.
   - Then run `sweep` inside its own `try`. On failure, set `cleanupFailure = \`Removing unreferenced self-extension modules in ${modulesDir} failed: ${String(error)}; the files remain and the next self_extend change retries.\``.
2. Report the combined outcome:
   - Success without cleanup failure: return `JSON.stringify(value)`.
   - Success with cleanup failure: return `JSON.stringify({ ...value, cleanup: cleanupFailure })`. The change is saved, so it is never reported as failed.
   - Failure without cleanup failure: rethrow the original error unchanged.
   - Failure with cleanup failure: throw `new Error(\`${errorMessage}\n${cleanupFailure}\`, { cause: originalError })`. `errorMessage` is `originalError.message` for an `Error`, else `String(originalError)`. The rollback texts ("rolled back" / "rolling back failed") stay first.
3. `sweep` may still throw from `read()` (entry removed); the same guard covers it.

### 2. Per-preset serialization owned by the preset registry

1. In `packages/preset/agent-preset-registry/src/index.ts`, add a private field `private readonly changes = new Map<string, Promise<unknown>>()` and a public method:
   ```ts
   /**
    * Run one composition change for a preset after every earlier change to the same preset settles.
    * A failed change does not block later ones. Changes to different presets run independently.
    * @param id - Preset id whose composition the change edits.
    * @param change - The change; its result or rejection is returned unchanged.
    * @returns The change's result.
    */
   async serializeChange<T>(id: string, change: () => Promise<T>): Promise<T>
   ```
   Copy the existing `select()` pattern at lines 365-383:
   - chain on `this.changes.get(id) ?? Promise.resolve()`;
   - store `guard = run.catch(() => undefined)`;
   - in `finally`, delete the key when `this.changes.get(id) === guard`.
2. In `tool-self-extend/src/index.ts`:
   - Delete the module-level `queues` `WeakMap` and its comment.
   - In `execute`, compute the preset id before queueing: `readPresetDeclaration(entryForEdit().options.config, config.presetEntry).id`. A throw there returns as the tool error.
   - Run `ctx.agentPresets.serializeChange(presetId, () => mutate(mutation, exec))`.
3. Add a test to `packages/preset/agent-preset-registry/tests/registry.spec.ts`, using its existing `setup()` harness:
   - two changes on the same id run strictly in order: hold the first with a `Promise.withResolvers<undefined>()` gate and assert the second has not started;
   - a rejecting change does not block the next;
   - changes on different ids overlap.

### 3. New package `@deepseek-ai/dsh-tool-sandboxed-module` (`packages/extensions/tool-sandboxed-module`)

No equivalent exists: `dsh-cordis-host-runner` uses `node:vm`, which its README says is not a security boundary.

**Package scaffold.** Copy the manifest, tsconfig, and locale layout of `packages/extensions/tool-self-extend`, including:
- `files: ["locale/*.json", "lib/index.js", "lib/types/**/*.d.ts"]` (the constraints check rejects `lib/types/**/*.js`);
- exports `.`, `./src/*`, `./package.json`, `./locale/*.json`.

Dependencies:
- peers: `@deepseek-ai/cordis` (`workspace:~`), `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-ptc-runtime`, `@deepseek-ai/dsh-sandbox`, `@deepseek-ai/dsh-sandbox-policy`, `@deepseek-ai/dsh-app-boot`, `@deepseek-ai/dsh-agent` (`workspace:*`);
- dependency: `@deepseek-ai/schemastery` (`workspace:~`);
- devDependencies: the peers plus `@deepseek-ai/dsh-system-prompt`, `@deepseek-ai/dsh-tool-executor-native`, `@deepseek-ai/dsh-tool-testkit`, `@deepseek-ai/dsh-session`.

Registration:
- Add tsconfig `references` matching the imports.
- Add `{ "path": "./packages/extensions/tool-sandboxed-module" }` to `tsconfig.host.json` after `tool-self-extend`.
- Run `pnpm install --no-frozen-lockfile && pnpm run gen-tsconfig-paths`.

Locale `meta` files:

|file|title|description|
|---|---|---|
|en|`tool-sandboxed-module`|(none)|
|zh|沙箱模块工具|在沙箱进程中运行 Tidebloom 模式添加的扩展工具。|
|ja|サンドボックスモジュールツール|Tidebloom モードが追加した拡張ツールをサンドボックス化されたプロセスで実行します。|
|es|Herramienta de módulos aislados|Ejecuta en un proceso aislado las herramientas que agrega el modo Tidebloom.|
|fr|Outil de modules isolés|Exécute dans un processus isolé les outils ajoutés par le mode Tidebloom.|
|de|Sandbox-Modulwerkzeug|Führt die vom Tidebloom-Modus hinzugefügten Werkzeuge in einem isolierten Prozess aus.|
|ru|Инструмент изолированных модулей|Запускает инструменты, добавленные режимом Tidebloom, в изолированном процессе.|
|pt|Ferramenta de módulos isolados|Executa em um processo isolado as ferramentas adicionadas pelo modo Tidebloom.|

**`src/index.ts`, a function plugin.** It exports exactly `name`, `inject`, `Config`, and `apply`:
```ts
export const name = 'tool-sandboxed-module'
export const inject = ['tools', 'ptcRuntime', 'sandboxPolicy', 'profileContext']
export interface ModuleTool { name: string; description: string; parameters: Record<string, unknown> }
export interface Config { module: string; dataDir: string; write: 'none' | 'data' | 'workspace'; tools: ModuleTool[] }
```
Config schema:
- `module`: required string — `file:` URL of the stored module copy;
- `dataDir`: required string — absolute private data directory;
- `write`: union of the three literals, default `'data'`;
- `tools`: required array, min 1, of objects. Each has `name` with pattern `^[a-z][a-z0-9_]{0,63}$`, `description` with min length 1, and `parameters` as a dict.
- Confirm the schemastery `pattern`/`min` method names in `vendor/schemastery` before use.

Every field gets JSDoc; `gen-config-catalog` rejects fields without it.

**`apply` load-time checks.** Each throws at load, so `self_extend`'s health check rolls the row back:
- `config.module` does not start with `file:` → `Error('Sandboxed module must be a file: URL')`;
- `config.dataDir` is not absolute → `Error('Sandboxed module dataDir must be absolute')`;
- `ctx.ptcRuntime.language !== 'typescript'` → `Error('tool-sandboxed-module requires a TypeScript ptcRuntime')`;
- `ctx.ptcRuntime.sandboxMode === undefined` → `Error('tool-sandboxed-module requires a confining ptcRuntime')`.

**Tool registration.** For each `config.tools` entry, register through `ctx.tools.register` with a raw `ToolDefinition` (`packages/core/tools/src/contracts.ts:26`). Pattern: `packages/preset/agent-preset-registry/tests/fixtures/plugins/contribute.js`.
- `name`, `description`, `parameters` come from config.
- `output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }`.
- `presentCall: args => ({ card: 'generic', kind: 'other', title: \`Run sandboxed ${tool.name}\`, rawInput: args })`.

**`execute(args, exec)` — the guardrails.** The policy is granted automatically; nothing ever calls `approveEscalation` or `ctx.approval`.

1. Resolve the session policy: `const session = ctx.sandboxPolicy.resolve(exec.agent === undefined ? {} : { session: exec.agent.session })`.
2. Compute `{ policy, cwd }`:
   - `write: 'none'` → `{ mode: 'read-only', workspaceRoot: dataDir }`, cwd `dataDir`.
   - `write: 'data'` → `{ mode: 'workspace-write', workspaceRoot: dataDir }`, cwd `dataDir`. This holds in every session mode, because the data directory is the extension's own area.
   - `write: 'workspace'` with session mode `read-only` → the `'data'` policy, but with cwd `session.workspaceRoot`. Workspace writes are then denied by the sandbox.
   - `write: 'workspace'` with session mode `workspace-write` or `danger-full-access`:
     - First apply the protected-root check. Throw when the resolved `session.workspaceRoot`:
       - is a filesystem root (`path.parse(root).root === root`);
       - equals `os.homedir()`;
       - is equal to, inside, or an ancestor of `ctx.profileContext.home` (`path.relative` checks).
     - The error text: `Error(\`Sandboxed extension tool "${tool.name}" refused workspace writes: ${root} is a protected directory (filesystem root, home directory, or DSH home). Use write "data", or run the session in a project directory.\`)`.
     - Otherwise use `{ mode: 'workspace-write', workspaceRoot: session.workspaceRoot, additionalWritableRoots: [...(session.additionalWritableRoots ?? []), dataDir], sessionId: session.sessionId }`, cwd `session.workspaceRoot`.
     - `danger-full-access` is never passed through.
3. Build the program. Branch on `ctx.ptcRuntime.programFormat`:
   - `'function-body'` → `return await (async () => { const m = await import(${JSON.stringify(config.module)}); return await m.execute(${JSON.stringify(tool.name)}, ${JSON.stringify(args)}) })()`;
   - otherwise → the same IIFE without `return`, as the final expression.
4. Run `const spec = ctx.ptcRuntime.resolve({ program, bindings: [], cwd, sandboxPolicy: policy, signal: exec.signal })`, then `const result = await ctx.ptcRuntime.run(spec)`.
   - Omit `stateOwner` so every call gets a fresh environment.
   - Pass no host bindings: extensions cannot call harness tools.
   - The Node runtime already strips the environment to an empty `process.env` (README "Launch and control").
5. Map the result:
   - `result.error` present → throw `Error(\`Sandboxed extension tool "${tool.name}" failed (${result.error.kind}): ${result.error.message}${logsSuffix}\`)`.
     - When `result.sandbox?.denied` is true, insert `\n${sandboxDenialMarker(result.sandbox.mode)}\nSelf-extension tools cannot request wider access; use self_extend update to change this extension's write permission within its guardrails.` before `logsSuffix`. Import `sandboxDenialMarker` from `@deepseek-ai/dsh-sandbox`.
     - `logsSuffix` = `\nLogs:\n${result.logs.join('\n')}` when `logs` is non-empty, else `''`.
   - Success → `valueText` = `result.value` when it is a string, else `JSON.stringify(result.value ?? null)`. Return `valueText + logsSuffix`.

**Tests: `tests/sandboxed-module.spec.ts`.** Boot `SystemPrompt`, `ToolRegistry`, `NativeToolExecutor`, as in `packages/extensions/tool-self-extend/tests/self-extend.spec.ts`. Provide:
- a fake `ptcRuntime` that records `resolve`/`run` arguments and returns scripted results; its `language`, `sandboxMode`, and `programFormat` are test-controlled;
- a fake `sandboxPolicy` whose `resolve` returns a test-controlled policy;
- `profileContext: { home }`.

Cases, all through `executeToolFixture`; together they must reach per-file 100% coverage:
- the policy and cwd for each `write` value across all three session modes;
- each protected-root refusal;
- both program formats;
- success with string, JSON, and absent values, with and without logs;
- the failure text, including the denial marker;
- all four load-time errors.

### 4. `self_extend` runs model-written code only through the sandbox, and in-process packages only from an allowlist

Files: `packages/extensions/tool-self-extend/src/{index.ts,rows.ts}` and its tests.

1. `rows.ts`:
   - Add `export const SANDBOXED_MODULE_PLUGIN = '@deepseek-ai/dsh-tool-sandboxed-module'`.
   - Add `readModuleTools(value: unknown, id: string): ModuleTool[]`. It requires an array of 1–16 objects with:
     - `name` matching `^[a-z][a-z0-9_]{0,63}$`, unique within the array;
     - `description`, a non-empty string of at most 2000 characters;
     - `parameters`, a non-null non-array object whose `type === 'object'`.
   - Otherwise it throws `Error(\`Self-extension module "${id}" failed its sandboxed manifest check: <reason>\`)`.
   - Define `ModuleTool` locally with the same fields as step 3. Plugin entries may export only the Loader four, so the type cannot be imported from there.
2. `Config` changes:
   - add `allowedPackages: string[]` with schema `z.array(z.string()).default([])` and JSDoc `Installed plugin packages self_extend may add in-process; every other package is refused.`;
   - add `'ptcRuntime'` to `inject`.
3. Storage layout:
   - module copies move to `join(profileContext.dir, 'self-extensions', presetId, 'modules', \`${id}-${hash}.mjs\`)`;
   - each module extension gets the data directory `join(profileContext.dir, 'self-extensions', presetId, 'data', id)`, created with `mkdir(dataDir, { recursive: true, mode: 0o700 })` before the probe;
   - `sweep` scans only the `modules` directory;
   - data directories are never deleted (user data protection). Removing and re-adding the same id reuses the directory.
4. Parameters (model-visible; exact strings):
   - `description`: `Extend this mode's own plugin composition without approval, inside fixed guardrails: list, add, update, or remove rows in its self-extension group. A module extension is a self-contained ESM file that exports tools (an array of { name, description, parameters }) and execute(name, args); every call runs in a fresh OS-sandboxed Node process with an empty environment and no harness tools, and may write only where its write permission allows. A package extension must be on this mode's package allowlist and loads in-process. Changes persist in the profile and apply to new sessions of this mode and to subagents started with agent_preset set to this mode; this session keeps its current tools. A change that fails to load is rolled back and reported. Other modes and profile-wide plugins are out of scope; use plugin_manager for those.`
   - `package`: `For add or update: an installed plugin package on this mode's allowlist, such as @deepseek-ai/dsh-tool-str-replace-editor; it loads in-process. Mutually exclusive with module.`
   - `module`: `For add or update: absolute path to a self-contained ESM file (.js or .mjs) that exports tools and execute(name, args). The file is copied, so later edits need another update. Mutually exclusive with package.`
   - new `write`: string, enum `['none', 'data', 'workspace']`, description `For module extensions: where its sandboxed calls may write. none: nowhere; data: only its private data directory; workspace: the session workspace and its data directory, never wider than the session's own mode and never a home, root, or DSH directory. Defaults to data on add; omitted on update keeps the current value.`
   - `config`: `For package extensions: the row's complete config object. Omitted on update keeps the current config.`
   - `action`, `id`, `enabled`: unchanged.
5. Validation, added to the existing pre-disk checks:
   - `package` given and not in `config.allowedPackages` → `Error(\`Package "${pkg}" is not on this mode's package allowlist\`)`. Keep `validatePackageSpecifier`.
   - `write` given with `package` on add, or on update of a row whose result is a package row → `Error('write applies only to module extensions')`.
   - `config` given with `module` on add, or on update of a row whose result is a module row → `Error('config applies only to package extensions')`.
   - Validation always runs before any file copy, probe, or edit.
6. Module probe. It runs inside `mutate`, after validation and before `editor.edit`, for every add/update that supplies `module`:
   - Copy the file as today.
   - Run `ctx.ptcRuntime.resolve({ program, bindings: [], cwd: dataDir, sandboxPolicy: { mode: 'read-only', workspaceRoot: dataDir }, signal: exec.signal })`, then `run`. The program uses the same format branch as step 3, with body `const m = await import(${JSON.stringify(fileUrl)}); return m.tools`.
   - When `result.error` is present, throw `Error(\`Self-extension module "${id}" failed its sandboxed manifest check: ${result.error.kind}: ${result.error.message}\`)`.
   - Otherwise validate `result.value` with `readModuleTools`.
   - Name collisions: reject when any declared name is already in `ctx.tools.schemas(exec.agent).map(s => s.name)` or among other module rows' `config.tools` names in the group. On update, exclude the updated row's own current tool names. Error: `Error(\`Tool name "${name}" is already registered in this mode\`)`.
   - The copied file stays until the shared `sweep` removes it as unreferenced.
7. Row construction:
   - **Module row:** `{ id, name: SANDBOXED_MODULE_PLUGIN, config: { module: fileUrl, dataDir, write, tools }, ...(disabled) }`.
     - `write` = argument, else the existing module row's value, else `'data'`.
     - Updating a module row without `module` keeps `module` and `tools` and changes only `write`/`enabled`.
   - **Package row:** unchanged shape.
     - Updating a module row with `package` produces a package row (`config` from args or none).
     - Updating a package row with `module` produces a module row.
   - **Rows without a recognized shape:** a `name` starting with `file:` (old in-process modules) may only be listed or removed. `update` on it throws `Error(\`Self-extension "${id}" uses the retired in-process module form; remove it and add it again as a module\`)`.
8. `list` / result `describe(row)`:
   - module rows → `{ id, source: { module: fileURLToPath(config.module) }, write, tools: tools.map(t => t.name), dataDir, ...disabled }`;
   - other rows → unchanged.
9. `execute`/`mutate` now receive `exec` (agent and signal) for the probe and the collision check.
10. Tidebloom preset (`packages/bundle/web-app/presets/tidebloom.patch.yml`): add `allowedPackages: ['@deepseek-ai/dsh-tool-str-replace-editor', '@deepseek-ai/dsh-time-context']` to the `tool-self-extend` row config.
11. Add `"@deepseek-ai/dsh-tool-sandboxed-module": "workspace:*"` in sorted position to the `dependencies` of `packages/bundle/web-app/package.json`, `apps/cli/package.json`, and `python/sdk-runtime/package.json` (the same three places that list `@deepseek-ai/dsh-tool-self-extend`).
12. Update `tests/self-extend.spec.ts` and `tests/rows.spec.ts`:
    - add `ptcRuntime` and `serializeChange` to the fakes; the fake `serializeChange` must really chain;
    - move the module paths to `modules/`;
    - cover allowlist refusal, `write`/`config` misuse, probe failure, manifest validation errors, collisions, conversion between module and package rows, the retired-row refusal, both cleanup-failure outcomes from step 1, and data-directory retention;
    - keep 100% coverage of `src/*`.

### 5. Shipped composition proof, catalogs, and snapshot

1. Rewrite the test `describe('the development-only Tidebloom preset')` in `apps/cli/tests/web-agent-presets.e2e.ts`. It keeps the boot through `bootWeb(home, [], [], undefined, 'spec', true)` and the existing assertions on tool presence and revision isolation. Changed and added behavior:
   1. **Echo module.** Write `join(home, 'tidebloom-echo.mjs')`:
      ```js
      import { writeFile } from 'node:fs/promises'
      export const tools = [{ name: 'tidebloom_echo', description: 'Write the Tidebloom sentinel to a file.', parameters: { type: 'object', properties: { target: { type: 'string' } }, additionalProperties: false } }]
      export async function execute(_name, args) { await writeFile(args.target ?? 'echo.txt', 'TIDEBLOOM_ECHO_OK'); return 'TIDEBLOOM_ECHO_OK' }
      ```
   2. Add it with `self_extend add { id: 'echo', module }`. Assert the agent created before the change still lacks `tidebloom_echo`, and a new `tidebloom` agent has it.
   3. **Data write.** Call `tidebloom_echo` with `{}` on the new agent. Its value is `TIDEBLOOM_ECHO_OK`, and `join(home, 'profiles', 'spec', 'self-extensions', 'tidebloom', 'data', 'echo', 'echo.txt')` contains `TIDEBLOOM_ECHO_OK`.
   4. **Outside write denied.** Call it with `{ target: join(home, 'outside.txt') }`:
      - `isError` is true;
      - the content contains `[sandbox: file access denied under workspace-write mode]`;
      - `outside.txt` does not exist.
   5. **Broken module.** A module containing `throw new Error('TIDEBLOOM_BROKEN')` added as `broken`:
      - `isError` is true;
      - the content contains `failed its sandboxed manifest check`;
      - `self_extend list` still shows only `echo`.
   6. **Allowlist.** `add { id: 'shell', package: '@deepseek-ai/dsh-tool-bash' }` fails with `not on this mode's package allowlist`.
   7. **Remove.** `remove echo`:
      - the profile `cordis.patch.yml` no longer contains `preset-tidebloom`;
      - `self-extensions/tidebloom/modules` holds no `.mjs`;
      - the data file from item 3 still exists.
   8. **Package add.** `add { id: 'editor', package: '@deepseek-ai/dsh-tool-str-replace-editor' }`; a new agent has `str_replace_editor`.
2. Register the new package in `scripts/gen-tool-catalog.ts`. Add a `TOOL_PACKAGES` entry after the `@deepseek-ai/dsh-tool-self-extend` entry:
   - `pkg: '@deepseek-ai/dsh-tool-sandboxed-module'`, `dir: 'tool-sandboxed-module'`, `source: 'packages/extensions/tool-sandboxed-module/src/index.ts'`;
   - `requires: ['ctx.tools', 'ctx.ptcRuntime', 'ctx.sandboxPolicy', 'ctx.profileContext']`;
   - `writes: ['tool/call', 'tool/result', 'files in the extension data directory or session workspace, per its write permission']`.
   - `mount` comment: `// Schema harvest never runs a module.` It provides stubs, then mounts the plugin:
     - `ptcRuntime` as `{ language: 'typescript', sandboxMode: 'workspace-write', programFormat: 'function-body' } as PtcRuntime`;
     - `sandboxPolicy` as `{} as SandboxPolicyService`;
     - `profileContext` as `{} as ProfileContext`;
     - plugin config `{ module: 'file:///catalog/example.mjs', dataDir: '/catalog/data', write: 'data', tools: [{ name: 'example_sandboxed_tool', description: 'Example tool declared by a sandboxed Tidebloom module.', parameters: { type: 'object', properties: {} } }] }`.
   - `note: 'Registered by Tidebloom self_extend for module extensions; tool names, descriptions and parameters come from the module manifest. Every call runs the module in a fresh OS-sandboxed Node process with an empty environment, no harness tools and no approval prompts.'`
3. Run the generators: `pnpm run gen-tool-catalog`, `gen-config-catalog`, `gen-plugin-packages`, `gen-cordis-catalog`.
   - `docs/tool-catalog.zh.md` is hand-paired. Add the new package's summary-table row and section, and update the `self_extend` section and row, mirroring the English structure line for line.
   - Then run `pnpm run verify-translation-pairing --write docs/tool-catalog.md`.
4. Refresh the `snapshots/session/tidebloom-self-extend` snapshot on Linux (procedure in Verification).
   - Expected diff: only `tool-schemas.expected.json` (the `self_extend` description and the new `write` parameter) and the rewritten `session.v4.jsonl`.
   - The tool result must still be `{"preset":"tidebloom","extensions":[{"id":"greeting","source":{"package":"@deepseek-ai/dsh-persona"},"config":{"prefix":"You are a Tidebloom snapshot agent."}}]}`.

## Critical files & anchors

- `packages/extensions/tool-self-extend/src/index.ts`: `mutate()`, `sweep()`, `queues`, the `execute` queue site. Steps 1, 2, and 4 all edit it; apply them in order.
- `packages/preset/agent-preset-registry/src/index.ts:65,365-383`: the `switches` / `select()` serialization pattern copied by `serializeChange`.
- `packages/ptc-runtime/ptc-runtime/src/types.ts:76-174`: `PtcRunRequest`/`PtcRunSpec`/`PtcRunResult`/`PtcRunFailure`. `packages/ptc-runtime/ptc-runtime-node/src/execution.ts:74-78`: `resolve` accepts an explicit `sandboxPolicy` and defaults cwd to its `workspaceRoot`.
- `packages/sandbox/sandbox-policy/src/index.ts:197-205`: `resolve({ session })` returns the session's `mode`, `workspaceRoot`, `additionalWritableRoots`, `sessionId`.
- `packages/bundle/base/cordis.patch.yml:405-406`: Host `ptc-runtime` row (`@deepseek-ai/dsh-ptc-runtime-node`, default `per-call`), which preset rows inject.

## Verification

All commands run in the worktree `E:/Projects/lamerdehy/.worktree/tidebloom-sandbox` unless stated otherwise.

1. Unit tests, with per-file 100% coverage:
   ```sh
   pnpm exec vitest run packages/extensions/tool-self-extend packages/extensions/tool-sandboxed-module packages/preset/agent-preset-registry/tests/registry.spec.ts --coverage --coverage.include="packages/extensions/tool-self-extend/src/**/*.ts" --coverage.include="packages/extensions/tool-sandboxed-module/src/**/*.ts"
   ```
2. Real-sandbox proof on Windows:
   ```sh
   pnpm run build:artifacts
   pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/web-agent-presets.e2e.ts -t "development-only Tidebloom|supplies both shipped presets"
   ```
   Expected: data write succeeds, outside write is denied with the marker, broken module rejected, allowlist enforced, data kept after remove.
3. POSIX proof and snapshot refresh in WSL (Ubuntu, user `lmdh`). Node: `/home/lmdh/.local/share/mise/installs/node/24.21.0/bin`. pnpm: `node <worktree>/node_modules/.pnpm/pnpm@11.28.5/node_modules/pnpm/bin/pnpm.cjs`.
   1. Mirror the worktree to `/home/lmdh/dsh-tidebloom-posix`: `tar` with `--exclude=node_modules --exclude=lib --exclude=dist --exclude=.git --exclude=.playwright-mcp --exclude=.cache --exclude=coverage`.
   2. Recreate the six tracked symlinks that Windows flattened:
      - `apps/cli/tests/profiles/acp/cordis.yml`;
      - `snapshots/acp/escalation-approved/{system-prompt.expected.md,tool-schemas.expected.json}`;
      - `snapshots/acp/image-compaction/system-prompt.expected.md`;
      - `snapshots/sdk/account-provider-signout/{system-prompt.expected.md,tool-schemas.expected.json}`.
      Each file's text content is its link target.
   3. Run `git init -q && git add -A && git -c user.name=verify -c user.email=verify@localhost commit -q --no-verify -m mirror`; `build:artifacts` reads `git rev-parse HEAD`.
   4. Run `pnpm install --no-frozen-lockfile`, then `pnpm run build:artifacts`.
   5. Run:
      - `DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.snapshot.config.ts -t tidebloom-self-extend`;
      - the same without `DSH_SNAPSHOT` (replay);
      - `pnpm exec vitest run --config vitest.snapshot.config.ts scripts/session-snapshot-corpus.corpus.ts`;
      - `pnpm run verify-cordis-config`;
      - `pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/web-agent-presets.e2e.ts` (all 40+ pass).
   6. Copy `snapshots/session/tidebloom-self-extend/` back into the worktree and review the diff described in step 5.4.
   7. Delete the mirror afterwards.
4. Gates:
   - Windows: `pnpm run typecheck`, `pnpm run lint`, `pnpm run doc-sync`, `pnpm run hygiene`, `pnpm run build:check` after the latest `build:artifacts`.
   - Failures that already exist in the main checkout are not caused by this change: `rescope-vendor:check` and the `verify-doc-budgets` `AGENTS.md` word count.
5. Worktree lifecycle:
   - Set `checks` to the step 1 command, the step 2 e2e command, and `pnpm run build:check`.
   - Commit, then run `"C:/Program Files/Git/bin/bash.exe" scripts/worktree-dev.sh eval tidebloom-sandbox`.
   - Then `… adopt tidebloom-sandbox --build`.
6. Manual surface check. Run `pnpm dsh web --patch apps/web/tests/pin-browse-picker.overlay.yml --no-open --port 0` with `DSH_HOME` set to the worktree home. Confirm Tidebloom mode still appears in the new-task picker and in Settings › Agent presets. A real-model `self_extend` run needs credentials (see Assumptions).

## Assumptions & contingencies

- **"Safe area" means the data protections below.** Sandbox modes govern file writes only (`docs/subsystems/sandbox.md:11`). Network access and file reads by extension code are not confined; the empty environment keeps harness credentials out of the process. If the user later wants network denial, that needs a backend capability that does not exist today.
- **Windows confinement.** Windows confinement uses the ACL runner, whose enforcement is `partial`. If the e2e denial assertion (step 5.1, item 4) fails on win32 only:
  - wrap just that assertion with `it.skipIf(process.platform === 'win32')` in a separate test, with comment `// The Windows ACL runner reports partial enforcement; the POSIX lanes prove outside-write denial.`;
  - keep the Linux run as the proof.
  - If PTC runs report `sandbox-unavailable` on Windows, apply the same win32 skip to the whole sandboxed-module e2e section, and record that Tidebloom module extensions fail closed on that host.
- **Old rows.** Old in-process `file:` module rows exist only in temporary test homes. If the user's real profile has any, `self_extend remove <id>` clears them (step 4.7).
- **Package policy.** If `pnpm run hygiene` reports `packages/extensions/tool-sandboxed-module` unclassified or unreachable, add `'packages/extensions/tool-sandboxed-module': { category: 'optional', reason: 'Sandboxed runner for Tidebloom module extensions; reachable only through the development-only tidebloom preset.' }` to `PRODUCT_PACKAGE_POLICY` in `scripts/product-package-policy.ts`.
- **Real-model run and GIF.** These remain blocked until a DeepSeek API key (environment variable, root `.env`, or `~/.dsh/.credentials.yaml`) and `ffmpeg`/`ffprobe` are available. With them, record per `.agents/skills/record-browser-gif/SKILL.md`. Without them, report it as the only unverified item.
