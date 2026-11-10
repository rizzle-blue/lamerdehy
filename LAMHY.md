# Lam Hy

Lam Hy is a fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It ships its own CLI, `lamhy`, which inherits everything `dsh` does and adds capabilities that upstream does not carry.

## Purpose

- Track upstream DeepSeek Harness closely, so `lamhy` gets upstream features and fixes with little merge work.
- Keep fork-specific abilities in fork-owned packages (the Kiro model provider is the first) and bundles, not in upstream files.
- Give `lamhy` its own state, so it never reads or overwrites `dsh` profiles, settings, or credentials.

## Relationship to upstream

| Ref | Meaning |
| --- | --- |
| `upstream/master` | `deepseek-ai/deepseek-harness`, the source of truth for `dsh`. |
| `origin/master` | Pure mirror of `upstream/master`. Never commit fork changes here. |
| `origin/main` | `origin/master` plus Lam Hy commits. This is the branch `lamhy` is built from. |
| `epic/experiment` | Frozen backup of the pre-reset fork work, including the sandbox seam and Tidebloom plans. Read-only reference. |

Sync procedure: fetch `upstream`, fast-forward `master`, then rebase or merge `master` into `main`. Resolve conflicts in favor of upstream unless a Lam Hy commit intentionally changes the file.

## `lamhy` CLI

`lamhy` is `dsh` with Lam Hy defaults. It does not reimplement profile launch, plugin management, or config inspection. It calls the same `runCli()` entry that `apps/cli` exports and accepts the same flags, profiles, and `--patch` overlays.

Target differences from `dsh`:

- **Own home.** State lives in `~/.lamhy`, selected by `LAMHY_HOME`. The launcher maps it to the `DSH_HOME` that upstream code reads. `dsh` keeps using `~/.dsh`.
- **Own bundle.** A `lamhy-base` bundle layers over `@deepseek-ai/dsh-base`. It adds the Lam Hy plugins, so the base bundle stays identical to upstream.
- **Own binary name.** `package.json` `bin` exposes `lamhy`. The `dsh` binary is untouched.

## Fork-owned packages

Lam Hy owns a growing set of packages that upstream does not have. Each is a normal workspace package under `packages/`, enabled through the `lamhy-base` bundle.

| Package | Path | Purpose |
| --- | --- | --- |
| `@deepseek-ai/dsh-llm-kiro` | `packages/llm/llm-kiro` | Kiro model provider. |

Add new rows here as packages land. A fork-owned package keeps its Kiro-style footprint small: its own directory, its own tests and snapshot under `snapshots/session/<name>/`, and a bundle entry. Edits to upstream files are limited to unavoidable wiring (workspace lists, tsconfig paths, `pnpm-lock.yaml`, generated docs).

## Extending Lam Hy

Add an ability as a plugin package, then enable it from the `lamhy-base` bundle patch. Follow the upstream rules in [AGENTS.md](AGENTS.md): plugins register through `ctx.effect()`, configuration lives in validated `Config` fields, and every change ships with docs and tests.

When a hook is missing upstream, prefer a small upstream-compatible change that can be proposed back over a Lam Hy-only patch.

## Current state

Implemented:

- Fork-owned packages: the Kiro provider (see the table above). It is currently enabled in `packages/bundle/base/cordis.patch.yml`, which is an upstream file.

Not yet implemented:

- The `lamhy` binary and its `apps/lamhy` package.
- The `lamhy-base` bundle, and moving fork-owned registrations such as Kiro out of the upstream base bundle into it.
- The `~/.lamhy` home mapping.

A fresh clone needs `pnpm install` and a build (`pnpm run dev:desktop`, or `pnpm run build:artifacts` before `pnpm start:desktop`) before fork-owned packages are available.
