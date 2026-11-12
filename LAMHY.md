# Lam Hy

Lam Hy is a fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It uses the existing `dsh` CLI and profiles and adds model access through Kiro and ChatGPT subscriptions.

Agents working in this checkout read this file before [AGENTS.md](AGENTS.md). Where the two disagree, this file wins for Lam Hy decisions; AGENTS.md still governs code quality, testing, and documentation style.

## Purpose

- Track upstream DeepSeek Harness closely to bring in features and fixes with little merge work.
- Keep fork-owned abilities in fork-owned packages and the `lamhy-base` bundle. The Kiro model provider is the first.
- Keep useful diagnostics and usage measurements while protecting personal information and Session content.
- Ship English-only documentation and use English as the UI fallback.

## Relationship to upstream

| Ref | Meaning |
| --- | --- |
| `upstream/master` | `deepseek-ai/deepseek-harness`, the source of truth for `dsh`. |
| `origin/master` | Pure mirror of `upstream/master`. Never commit fork changes here. |
| `origin/main` | `origin/master` plus Lam Hy commits. This is the branch Lam Hy is built from. |
| `epic/experiment` | Frozen backup of the pre-reset fork work, including the sandbox seam and Tidebloom plans. Read-only reference. |

### Fork change classes

Every Lam Hy commit belongs to exactly one class. Name the class in the commit subject scope so a sync can find it.

| Class | Scope | Example | Sync cost |
| --- | --- | --- | --- |
| Addition | `feat(<package>)` | `packages/llm/llm-kiro` | None; upstream never touches these files. |
| Wiring | `chore(lamhy-wiring)` | workspace lists, tsconfig paths, lockfile, generated docs | Low; regenerate on conflict. |
| Removal | `chore(lamhy-strip)` | telemetry packages, Chinese docs | Medium; rerun the removal skill after every sync. |
| Rebrand | `chore(lamhy-brand)` | user-visible "DeepSeek Harness" copy | Medium; rerun the rebrand skill after every sync. |
| Upstream patch | `fix(<package>)` | a behavior change inside an upstream file | High; propose upstream, then drop the local commit once it lands. |

### Sync procedure

Run the [lamhy-sync-upstream](.agents/skills/lamhy-sync-upstream/SKILL.md) skill. It fetches `upstream`, fast-forwards `master`, merges `master` into `main` with a merge commit, resolves conflicts by fork change class, then runs the policy skills in this order:

1. [lamhy-no-telemetry](.agents/skills/lamhy-no-telemetry/SKILL.md) inventories outbound reporting. Apply the [telemetry and privacy policy](#telemetry-and-privacy) to each data path.
2. [lamhy-english-only](.agents/skills/lamhy-english-only/SKILL.md) deletes new or reintroduced Chinese docs and UI locale data.
3. [lamhy-rebrand](.agents/skills/lamhy-rebrand/SKILL.md) renames new user-visible "DeepSeek Harness" copy.

The sync is done when `pnpm run verify-lamhy-fork -- --since=origin/main` passes. [verify-lamhy-fork](scripts/verify-lamhy-fork.ts) reports tracked files that break a fork decision and names the skill that fixes each one. The `lamhy fork drift` pre-push hook in [lefthook.yml](lefthook.yml) runs the same check, so a half-finished sync cannot be pushed.

## Design decisions

These choices were debated before implementation. Each records the rejected alternative so it is not reopened without new information.

### Rebrand depth: user-visible only

"LamHy Harness" replaces "DeepSeek Harness" in READMEs, docs, UI strings, and window titles. Internal identifiers stay: the `@deepseek-ai/dsh-*` package scope, `DSH_*` environment variables, `dsh.bundle` manifest keys, `$DSH_HOME` internals, Session format names, and wire method names. Renaming those touches more than 6,000 files and turns every sync into a full-tree conflict. The [lamhy-rebrand](.agents/skills/lamhy-rebrand/SKILL.md) skill lists the surfaces that need a user decision before they change, such as the model-visible system-prompt identity and the Desktop application id.

"DeepSeek" as the name of the model vendor (DeepSeek API, DeepSeek account, `llm-deepseek`) is not the harness brand and does not change. The MIT copyright notice in [LICENSE](LICENSE) stays; Lam Hy may add its own line but never removes upstream's.

The local Desktop shell displays LamHy Harness in its welcome window, application menu, tray, and dialogs. It retains the upstream Electron application ID, packaging product name, and Electron data directory.

### Fork-owned packages: upstream scope, upstream groups

Fork packages use the `@deepseek-ai/dsh-<name>` scope and live in the matching upstream group directory, such as `packages/llm/llm-kiro`. This passes the existing naming, hygiene, and license gates without changing them. The cost is a possible name collision if upstream ships a package with the same name; check `upstream/master` before naming a new package. A separate `@lamhy/*` scope was rejected because it requires changing several upstream gate scripts.

Each fork package sets `repository.url` to the Lam Hy repository, not to `deepseek-ai/deepseek-harness`.

### Kiro: the first fork-owned package

`@deepseek-ai/dsh-llm-kiro` at [packages/llm/llm-kiro](packages/llm/llm-kiro/README.md) gives Kiro account model access with AWS device authorization. It is the reference shape for later additions: its own directory, unit tests, a recorded Session snapshot under [snapshots/session/kiro-provider](snapshots/session/kiro-provider/snapshot.yml), and one bundle row.

The `llm-kiro` row is in [the base bundle patch](packages/bundle/base/cordis.patch.yml) and its dependency is in `packages/bundle/base/package.json`. Both are slated to move to `lamhy-base`.

Lam Hy keeps the `chatViewDefinition.isActive` change locally. It opens Chat when a visible command row exists before the first Turn.

Kiro talks to Kiro and AWS endpoints because the user selected Kiro as a model provider; that traffic is the requested service, not telemetry. The adapter sends `x-amzn-codewhisperer-optout: true` to opt out of CodeWhisperer data use, and the telemetry skill checks that the header stays.

### Subscription sign-in on the Models page

ChatGPT Plus/Pro and Kiro sign in from **Settings → Models → Subscription accounts**, which [`ui-settings-sign-in`](packages/client/ui-settings-sign-in/README.md) renders over the [`authorization` Remote](packages/api/authorization-controller/README.md). The controller runs the existing `ctx.authorization` flows on the Host, offers only an allowlist (`llm-pi-ai/openai-codex` and `llm-kiro/kiro` by default), and keeps attempt state on the Host so a reload rejoins it. The `/kiro-login`, `/kiro-logout`, and `/kiro-usage` commands were removed in favor of this section; slash commands were rejected as the sign-in surface because they cannot open a browser tab, mask a pasted secret, or show a code to check.

ChatGPT uses pi-ai's `openai-codex` provider and its OAuth flow, which offers browser login with a pasted-URL fallback and device-code login. pi-ai's "Sign in with ChatGPT" on the `openai` provider stays withheld: it requires a stable installation UUID sent to OpenAI, which the [no-telemetry decision](#outbound-data-delete-do-not-disable) rules out. The base bundle ships the `openai-codex` route with no key; `llm-pi-ai` lists no models for a keyless subscription-only route and fails its requests with `MISSING_CREDENTIAL` until a sign-in is stored, so the picker stays clean for users who never sign in. Traffic to `auth.openai.com` and `chatgpt.com` is the service the user requested. pi-ai sends `originator: pi` with Codex requests; that header is protocol identification, not telemetry.

<a id="outbound-data-delete-do-not-disable"></a>

### Telemetry and privacy

Keep local diagnostics, Session statistics, and feedback records that help users understand their work. Review outbound measurements individually for a useful purpose, a known recipient, and a payload that protects personal information. Keep Session content, credentials, account details, private paths, and persistent installation identifiers out of reporting. Remove collection paths that cannot meet these requirements and keep their historical Session events readable.

### English only, including the UI

Lam Hy deletes Chinese documentation, translation sidecars, translation gates and tooling, the Chinese website locale, and the Chinese UI locale. Other UI locales (Japanese, Spanish, French, German, Russian, Portuguese) stay, because removing them is a separate decision. Deleting the `zh` baseline locale changes the typed dictionary contract in `packages/client/locale`; the [lamhy-english-only](.agents/skills/lamhy-english-only/SKILL.md) skill covers that change.

### Trade-off with "track upstream closely"

Removal and Rebrand commits edit or delete upstream files, which raises merge cost. Lam Hy accepts that cost for these two goals only. The skills keep the cost repeatable: each sync reruns them instead of hand-resolving every conflict. Any other change to an upstream file is either Wiring or an Upstream patch with a plan to propose it back.

## Launch and composition

Lam Hy launches through `dsh` and uses the existing `DSH_HOME` configuration and `~/.dsh` default. The planned `lamhy-base` bundle will layer fork-owned provider configuration over `@deepseek-ai/dsh-base` through the existing profile bundle lists. Subscription sign-in mounts on the Web and Desktop surfaces.

## Fork-owned packages

| Package | Path | Purpose |
| --- | --- | --- |
| `@deepseek-ai/dsh-llm-kiro` | `packages/llm/llm-kiro` | Kiro model provider. |
| `@deepseek-ai/dsh-api-authorization-controller` | `packages/api/authorization-controller` | `authorization` Remote: run allowlisted sign-in flows for a settings page. |
| `@deepseek-ai/dsh-client-ui-settings-sign-in` | `packages/client/ui-settings-sign-in` | Subscription-account sign-in section on the Models page. |

Add a row when a package lands. Edits to upstream files for a new package are limited to Wiring.

## Extending Lam Hy

Add an ability as a plugin package, then enable it from the `lamhy-base` bundle patch. Follow the upstream rules in [AGENTS.md](AGENTS.md): plugins register through `ctx.effect()`, configuration lives in validated `Config` fields, and every change ships with docs and tests. Write fork docs in English only; Lam Hy does not keep `.zh.md` pairs or `.i18n.yaml` sidecars.

When a hook is missing upstream, prefer a small upstream-compatible change that can be proposed back over a Lam Hy-only patch.

Before landing a new package, inventory the services it contacts and review any reporting against the [telemetry and privacy policy](#telemetry-and-privacy).

## Current state

Implemented:

- Fork-owned packages: the Kiro provider and the Models page subscription sign-in. Kiro and the ChatGPT `openai-codex` route are enabled in `packages/bundle/base/cordis.patch.yml`, and the sign-in rows in `packages/bundle/web-app/cordis.patch.yml`; both are upstream files.
- Fork skills: [lamhy-sync-upstream](.agents/skills/lamhy-sync-upstream/SKILL.md), [lamhy-no-telemetry](.agents/skills/lamhy-no-telemetry/SKILL.md), [lamhy-english-only](.agents/skills/lamhy-english-only/SKILL.md), and [lamhy-rebrand](.agents/skills/lamhy-rebrand/SKILL.md).
- The [verify-lamhy-fork](scripts/verify-lamhy-fork.ts) drift check and its pre-push hook.

Not yet implemented:

- The telemetry privacy audit, removal of Chinese documentation and locale data, and the remaining user-visible rename. `pnpm run verify-lamhy-fork` reports the current backlog.
- The `lamhy-base` bundle, and moving the Kiro, `openai-codex`, and sign-in rows out of the upstream bundles into it.

A fresh clone needs `pnpm install` and a build (`pnpm run dev:desktop`, or `pnpm run build:artifacts` before `pnpm start:desktop`) before fork-owned packages are available.
