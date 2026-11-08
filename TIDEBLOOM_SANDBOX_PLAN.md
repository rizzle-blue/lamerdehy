# Tidebloom sandbox: one plan for macOS and Windows (supersedes the v1 and v2 plans)

## Context

Two plan files are in the repo root:
- `TIDEBLOOM_SANDBOX_TIDEBLOOM_PLAN.md` (v1) is fully implemented.
- `TIDEBLOOM_SANDBOX_V2_PLAN.md` (v2) is partly implemented.

This plan replaces both with one current-state plan. Scope is **macOS and Windows**; Linux is deferred.

**Already landed** (commits `0fb6e43fd1`, `deac6e721c`):
- **v1, complete:** `tool-sandboxed-module`, the `self_extend` module/package rows, the allowlist, `serializeChange`, and the cleanup-masking fix.
- **Seam v2:**
  - `SandboxExecutionPolicy` carries `denyRead` / `allowRead` / `denyWrite` / `network` (`packages/sandbox/sandbox/src/index.ts:49`).
  - `ConfinedArgv` carries `env` and `release()`.
  - `assertRestrictionsSupported`, `credentialReadDenyPaths(home, dshHome)` and `protectedWritePaths(roots)` live in `packages/sandbox/sandbox/src/restrictions.ts`.
  - PTC keeps the proxy variables (`ptc-runtime-node/src/environment.ts`).
- **srt rung:** `packages/sandbox/sandbox-local/src/srt.ts`, `SRT_PLATFORMS = ['linux','darwin']`. It is selected only for policies that request restrictions, and it requires `network` to be present.

**Gaps this plan closes:**
1. **Module processes don't use the restrictions yet.** `tool-sandboxed-module` (`src/index.ts:68-87`) sends mode and roots only, so module processes can still read `~/.ssh` and the DSH home, write `.git/hooks` under `write: workspace`, and reach any host.
2. **Windows enforces nothing beyond writes.** The `windows-acl` rung refuses every restriction field.
3. **Auto mode and the review gate are not done.** v2's D6–D8 (`dsh-action-review`, `dsh-auto-mode`, the `self_extend` review gate) have not started.

**Decisions (2026-11-08, from the user and the sandbox research):**
- **Windows runner.** Model-written module code runs under **Deno permissions** on Windows and macOS. Deno gives:
  - read and write allowlists and denies, and a per-host `--allow-net`;
  - no environment, subprocess, FFI or sys access;
  - no admin install and no machine-wide account;
  - its own TLS (no Schannel).

  Deno is the inner layer on both platforms. The outer OS layer is the srt rung on macOS (full restriction fields) and the `windows-acl` rung on Windows (writes only). srt-win and mxc are deferred.
- **Auto mode** (D6/D7) and the review gate (D8) stay in scope as the last phase. They are platform-neutral.
- **Windows verification** runs on the user's Windows machine (`E:/Projects/lamerdehy`, Git Bash). macOS verification runs locally (macOS 27), so macOS no longer depends on CI alone.

## Phase 0: housekeeping and spike

1. **Worktree.** Per `.agents/skills/dsh-worktree-dev/SKILL.md`, from the main checkout:
   ```sh
   scripts/worktree-dev.sh new tidebloom-sandbox-deno --with-local --story "Tidebloom module extensions run under Deno permissions inside the OS sandbox on macOS and Windows: credential reads denied, protected paths write-denied, network denied by default."
   ```
2. **Replace the plan files.**
   - Write this plan as `TIDEBLOOM_SANDBOX_PLAN.md` at the repo root.
   - Delete `TIDEBLOOM_SANDBOX_TIDEBLOOM_PLAN.md` and `TIDEBLOOM_SANDBOX_V2_PLAN.md`.
   - Repoint references in `.agents/notes/proposed/architecture/2026-11-07-sandbox-runtime-backend{.md,.zh.md}`. Those are the only references outside the plans.
3. **Agent Notes.**
   - Amend the srt note's Windows sections: srt-win is deferred, and module confinement on Windows uses the Deno runner. Keep `.i18n.yaml` aligned.
   - Add a proposed note `2026-11-08-deno-module-runner{.md,.zh.md,.i18n.yaml}`. It covers:
     - the decision and why: no admin install, a per-host network allowlist, no Schannel;
     - the alternatives: srt-win (elevated install, machine-wide account, Schannel), mxc (Win11 24H2 build 26100.9278+ floor, spawn-only API, MSYS2 crash), and Node `--permission` (not a security boundary);
     - the layering;
     - the spike results.
4. **Spike** with Deno pinned exactly to the npm `deno` 2.9.x release. Record each result in the note.
   - **Binary resolution.** Resolve the binary from the `@deno/<platform>-<arch>` optional package, so `deno`'s postinstall can be denied with `allowBuilds: { deno: false }` in `pnpm-workspace.yaml`. If the release-age policy blocks it, add a `minimumReleaseAgeExclude` entry.
   - **Entry and permissions.** A host-written entry file dynamically imports the module's `data:` URL. Check:
     - `--no-remote --no-npm --no-config --no-lock --no-prompt` work together;
     - `NotCapable` message text for reads, writes and net;
     - a static import inside the module is still checked.
   - **macOS under srt.** Deno runs under the srt rung. Check:
     - Deno honors srt's `HTTP(S)_PROXY`;
     - an allowed host works and an unlisted host is refused at both layers;
     - a read of `~/.ssh` is denied.
   - **Windows under windows-acl.** Deno starts under the windows-acl Low-IL write-restricted token, with `DENO_DIR` in the token's private temp directory. Check:
     - HTTPS `fetch` to an allowed host works (rustls);
     - reads and writes outside the grants are denied.
   - Measure startup overhead on both platforms.
   - Run the existing `packages/sandbox/sandbox-local/tests/srt.e2e.ts` on macOS locally. It has only run in CI so far.

## Phase 1: Deno module runner, deny lists and network denied by default (macOS and Windows)

### 1a. New package `@deepseek-ai/dsh-sandboxed-module-runner` (`packages/extensions/sandboxed-module-runner`)

The Service Definition and its only provider (Deno) live in one package until a second provider exists.

**Scaffold** like `packages/extensions/tool-sandboxed-module`:
- manifest, tsconfig, references, `tsconfig.host.json` entry, locales (8 `meta` files);
- run `pnpm install --no-frozen-lockfile && pnpm run gen-tsconfig-paths`.

**Service** `ctx.sandboxedModules`, default-exported service class:
```ts
run(request: {
  source: Uint8Array                                   // module bytes; imported as a data: URL
  call: { kind: 'manifest' } | { kind: 'execute'; tool: string; args: unknown }
  policy: SandboxPolicy                                // mode, roots, denyRead/allowRead/denyWrite, network
  readRoots: readonly string[]                         // Deno --allow-read list
  cwd: string
  signal?: AbortSignal
}): Promise<{ value: unknown; logs: string[] } | { error: { kind: string; message: string }; denied?: { layer: 'runtime' | 'os'; mode: ConfinedSandboxMode }; logs: string[] }>
```

**Config.** Validated; each field has JSDoc.
- `executable?: string`. When omitted, an explicit `resolve` step finds the `@deno/*` binary.
- `timeoutMs`, `maxOutputBytes`, `maxHeapMb`.
- `osEnforced: { denyRead: boolean; denyWrite: boolean; network: boolean }`. These are the restriction fields the OS layer must also enforce. It defaults to all `true` (fail closed).

**Argv.**
- Command: `deno run --no-prompt --no-remote --no-npm --no-config --no-lock --cached-only --v8-flags=--max-old-space-size=<maxHeapMb>`.
- Read: `--allow-read=<entry dir, readRoots…>`.
- Write: `--allow-write=<writable roots>` (none under `read-only`).
- Denies: `--deny-read=<policy.denyRead>` and `--deny-write=<policy.denyWrite>`.
- Network: `--allow-net=<policy.network.allowedDomains>`; omit the flag when the list is empty.
- No `--allow-env/run/ffi/sys`.

**Process.**
- The entry file goes in a private temp directory and is removed after the call.
- The child gets an empty environment plus `DENO_DIR` and `DENO_NO_UPDATE_CHECK=1`. Merge `ConfinedArgv.env`.
- Output is framed by a per-call nonce line, so a module that writes to stdout cannot fake the result.

**OS layer.**
- Call `ctx.sandbox.confine(argv, osPolicy)`, then spawn through `ctx.subprocess.spawn` (pattern: `ptc-runtime-node/src/worker.ts:300`).
- Always `await release()`: on success, failure, spawn error and abort.
- `osPolicy` is `policy` with every restriction field removed whose `osEnforced` flag is false. Deno still enforces all of them. This is an explicit configured choice, not a silent drop: with the default config, a provider that cannot enforce a field still refuses with `SANDBOX_UNSUPPORTED_POLICY`.

**Denials.**
- Deno `NotCapable` → `denied.layer = 'runtime'`.
- A match against `ConfinedArgv.denialSignatures` → `'os'`.
- Timeout or overflow → kill, then `error.kind` `timeout` or `output-limit`.

**Tests** (`tests/runner.spec.ts`): fake `sandbox` and `subprocess` services, 100% per-file coverage. They cover:
- the argv mapping per mode;
- the `osEnforced` stripping;
- release on every path;
- nonce framing;
- denial classification;
- limits.

A real-Deno test (`tests/runner.e2e.ts`) runs the spike probes on the host platform.

### 1b. `tool-sandboxed-module` uses the runner and the deny lists

File: `packages/extensions/tool-sandboxed-module/src/index.ts`.

- **Inject and checks.** `inject`: replace `'ptcRuntime'` with `'sandboxedModules'`. Delete the TypeScript and confining-runtime load checks.
- **Policy built by `placement()`.** Keep v1's mode, roots, cwd and the protected-root refusal, and add:
  - `denyRead: credentialReadDenyPaths(os.homedir(), ctx.profileContext.home)` and `allowRead: [dataDir]`;
  - `denyWrite: protectedWritePaths(writableRoots(policy))`;
  - `network: { allowedDomains: [] }`, i.e. denied until phase 2.
- **`readRoots`.** `[dataDir]`, plus the session workspace when it passes the protected-root check.
- **Call.** `runner.run({ source, call: { kind: 'execute', … }, … })`, then map the result with the existing `report()` text.
  - The denial suffix keeps `sandboxDenialMarker(mode)`.
  - A runtime-layer denial names the blocked path or host from Deno's message.
- **Tests.** Update `tests/sandboxed-module.spec.ts` with a fake `sandboxedModules`. Cover the deny lists, `allowRead`, and both denial layers.

### 1c. `self_extend` probes through the runner

File: `packages/extensions/tool-self-extend/src/index.ts:103-117`.

- Replace the `ptcRuntime` probe with `runner.run({ call: { kind: 'manifest' }, policy: read-only on dataDir with the same deny lists, network: [] })`.
- `inject`: replace `'ptcRuntime'` with `'sandboxedModules'`.
- Model-visible description (line 248): change "every call runs in a fresh OS-sandboxed Node process …" to:

  > every call runs in a fresh sandboxed Deno process (Node built-ins via node: imports) with an empty environment, no network, no harness tools and no access to credential stores, and may read only its data directory and the session workspace and write only where its write permission allows.

  Keep the rest of the text.
- Update `tests/self-extend.spec.ts` fakes. Keep 100% coverage of `src/*`.

### 1d. Composition, catalogs and snapshot

- **`packages/bundle/web-app/presets/tidebloom.patch.yml`:** add a `sandboxed-module-runner` row in the preset. Its `osEnforced` config:
  ```yaml
  osEnforced: !!js "process.platform === 'win32' ? { denyRead: false, denyWrite: false, network: false } : { denyRead: true, denyWrite: true, network: true }"
  ```
- **Dependencies.** Add the runner where v1 added `tool-sandboxed-module`: `packages/bundle/web-app`, `apps/cli`, `python/sdk-runtime`.
  - Tidebloom is for source checkouts only. If a packaging or size gate objects to the Deno binary in `python/sdk-runtime`, keep the runner out of that deploy root and record why.
  - If `hygiene` flags the package, classify it in `scripts/product-package-policy.ts` as optional, reachable only through the Tidebloom preset.
- **Catalog entry** in `scripts/gen-tool-catalog.ts`: update the `tool-sandboxed-module` entry's `requires` to `ctx.sandboxedModules`, and update its note. Then run `gen-tool-catalog`, `gen-config-catalog`, `gen-plugin-packages`, `gen-cordis-catalog`.
- **Chinese catalog.** Mirror the changes by hand into `docs/tool-catalog.zh.md`, then run `pnpm run verify-translation-pairing --write docs/tool-catalog.md`.
- **Docs.** Update the READMEs (en+zh): the new package, `tool-sandboxed-module`, `tool-self-extend`, `packages/extensions/README`. Update `docs/subsystems/sandbox.md` only where it describes module confinement.
- **Snapshot.** Refresh `snapshots/session/tidebloom-self-extend` **on macOS**: `DSH_SNAPSHOT=refresh pnpm exec vitest run --config vitest.snapshot.config.ts -t tidebloom-self-extend`, then replay it. The expected diff is only `tool-schemas.expected.json` (the `self_extend` description) and `session.v4.jsonl`. The tool result stays the existing `greeting` row.

### 1e. e2e: `apps/cli/tests/web-agent-presets.e2e.ts`, `describe('the development-only Tidebloom preset')`

Keep the v1 assertions: the data write, the outside write denied with its marker, the broken module rejected, the allowlist, remove keeps the data, the package add.

Add a guardrails module that tries each blocked action, each one asserted denied, with nothing created on disk:
- read `join(home-under-test, '.ssh', 'id_test')`;
- read the profile's `.credentials.yaml`;
- with `write: workspace`, write `<workspace>/.git/hooks/pre-commit`;
- `fetch('https://example.com')`.

The test home's `os.homedir()` is overridden per the existing harness; the credential list follows `homedir()`. If the harness cannot redirect it, assert the DSH-home denial alone.

## Phase 2: action review seam, `self_extend` review gate, declared network hosts

Carried over from v2 D1, D5 and D8. Platform-neutral.

1. **New `@deepseek-ai/dsh-action-review`** (`ctx.actionReview`), extracted from `packages/experimental/auto-review`. It brings over:
   - request building, `REVIEW_POLICY`, the strict JSON verdict, the cache-stable message layout, and the session-authority rules.

   API: `review(request, signal) → { decision: 'allow' } | { decision: 'deny', rule, reason? }`.
   - Request kinds: `tool-call`, `sandbox-escalation`, `self-extension`. A `self-extension` request carries the module source, manifest, `write` and `network`, or a package plus its config.
   - Policy tiers: `environment` / `allow` / `soft_deny` / `hard_deny`, with `"$defaults"`. They are read from profile and user settings only; repository files are never read.
2. **Manifest.** `rows.ts`: `readModuleTools` becomes `readModuleManifest` = `tools` + optional `network: string[]`.
   - At most 32 entries, in the seam's host syntax: `host`, `*.host`, optional `:port`, bracketed IPv6.
   - Both Deno's `--allow-net` and srt accept this syntax; the spike confirms it.
   - `tool-sandboxed-module` Config gains `network: string[]` (default `[]`), written by `self_extend` and shown by `list`.
3. **Gate.** `self_extend` add/update runs in this order: validation → copy → manifest probe → `ctx.actionReview.review({ kind: 'self-extension', … })` → edit.
   - A denial throws `Self-extension "<id>" was refused by action review (<rule>): <reason>`.
   - A missing reviewer or a reviewer failure refuses the change.
   - It never shows a prompt.
4. **Tests and evidence.** Unit tests, plus an e2e test with a mocked reviewer:
   - a module declaring `network: ['example.com']` reaches it and is refused elsewhere;
   - a reviewer denial refuses the add.

   Refresh the snapshot on macOS.

## Phase 3: DSH-wide auto mode

Carried over from v2 D6 and D7.

- **`@deepseek-ai/dsh-auto-mode`:** the `auto` permission preset (`permission/preset:auto`), offered in every bundle and agent preset. Its order:
  1. guard and deny rules, then ask rules;
  2. fast path: read-only calls, workspace-local edits outside `protectedWritePaths`, and confined shell/PTC calls with no escalation;
  3. the classifier;
  4. the block reason goes to the model.
- **Behavior:**
  - The sandbox stays `workspace-write`.
  - The classifier answers `ctx.approval` sandbox escalations; Full access after an allow is removed.
  - After 3 consecutive or 20 total blocks it falls back to prompting, counted by a projection over `AUTO_REVIEW_DENIED` results.
  - In headless runs a block stays final.
  - The Web UI gains a "Recently blocked" list.
- **Removals and docs:**
  - Remove `packages/experimental/auto-review`.
  - Write an upgrade guide at `docs/upgrade-guide/v0.2.2-rc.1/auto-review-graduation/`.
  - Add an Agent Note that supersedes `2026-08-28-auto-review.md`.
- **Evidence:**
  - unit tests for tier precedence, `$defaults`, settings scope and the threshold projection;
  - an e2e test with a mocked reviewer across native, PTC, escalation and subagent spawn;
  - keyless snapshots;
  - TypeScript and Python SDK expected outputs if session lifecycle output changes;
  - a real-model run, which needs `DEEPSEEK_API_KEY`.

## Deferred (Linux and later Windows work)

- **Linux:**
  - Prove the runner under srt on Linux (needs `socat` and `ripgrep`).
  - Set `osEnforced` for Linux in the preset; until then Linux keeps the strict default.
  - v2 phase F: srt becomes the default rung, and the bwrap and Seatbelt profile code is deleted. The macOS Seatbelt deletion waits for that soak too.
- **Windows OS-layer restrictions for bash and PTC:**
  - an mxc rung once srt ships its argv-compatible mxc path, or the OS floor is acceptable;
  - otherwise srt-win.
  - Today no bash or PTC consumer requests restriction fields, so nothing is blocked.

## Verification

All commands run in the worktree unless stated otherwise.

1. **Unit tests**, per-file 100% coverage:
   ```sh
   pnpm exec vitest run packages/extensions/sandboxed-module-runner packages/extensions/tool-sandboxed-module packages/extensions/tool-self-extend --coverage --coverage.include="packages/extensions/{sandboxed-module-runner,tool-sandboxed-module,tool-self-extend}/src/**/*.ts"
   ```
2. **macOS (local).**
   - `pnpm run build:artifacts`.
   - `pnpm exec vitest run --config vitest.e2e.config.ts packages/sandbox/sandbox-local/tests/srt.e2e.ts packages/extensions/sandboxed-module-runner/tests/runner.e2e.ts`.
   - `pnpm exec vitest run --config vitest.e2e.config.ts apps/cli/tests/web-agent-presets.e2e.ts -t "development-only Tidebloom|supplies both shipped presets"`.
   - The snapshot refresh and replay from 1d.
   - `pnpm exec vitest run --config vitest.snapshot.config.ts scripts/session-snapshot-corpus.corpus.ts`.
   - `pnpm run verify-cordis-config`.
3. **Windows (user's machine, `E:/Projects/lamerdehy`, Git Bash).**
   - Fetch the worktree branch, then run `pnpm install`, `pnpm run build:artifacts`, the runner e2e, and the Tidebloom e2e filter above.
   - Expect a data write that succeeds, and denials for outside writes, credential reads, `.git/hooks` writes and unlisted hosts.
4. **Gates (macOS):** `pnpm run typecheck`, `lint`, `doc-sync`, `hygiene`, and `build:check` after the latest `build:artifacts`. Failures that already exist are not caused by this change: `rescope-vendor:check`, and the `verify-doc-budgets` AGENTS.md word count.
5. **Worktree lifecycle.**
   - Set `checks` to items 1, 2 and `build:check`.
   - Commit per phase.
   - Run `scripts/worktree-dev.sh eval tidebloom-sandbox-deno`, then `adopt … --build`.
6. **Manual check.** Run `pnpm dsh web --patch apps/web/tests/pin-browse-picker.overlay.yml --no-open --port 0`. Tidebloom should appear in the new-task picker and in Settings › Agent presets. A real-model `self_extend` run and a GIF need a DeepSeek key and `ffmpeg`; report them as unverified if either is missing.

## Contingencies

- **Deno fails under the windows-acl token** (spike 0.4). Stop and bring the options to the user:
  - run Deno without the OS layer, reported as `enforcement: 'partial'`;
  - or adopt srt-win for modules.

  Do not pick one silently.
- **`HTTP(S)_PROXY` breaks Deno's network checks on macOS.** If srt's proxy variables stop Deno's `--allow-net` from applying by host, set `osEnforced.network: false` on macOS and record that network is enforced by Deno alone there.
- **A Deno advisory affects a permission in use.** Update the exact pin before adopting.
