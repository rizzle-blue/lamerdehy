---
name: lamhy-no-telemetry
description: Remove every Lam Hy outbound data path that the user did not request, including OpenTelemetry, product analytics, anonymous user ids, Session-log uploads, crash or usage reporting, update checks, and feedback upload surfaces. Use after every upstream sync, before landing any new package or dependency, and whenever a change adds an HTTP endpoint, identifier, collector URL, or reporting SDK, even when the data is described as anonymous, opt-in, or disabled by default.
---

# Lam Hy: no telemetry

Lam Hy sends data only to the services the user configured: model providers, web search and fetch providers, MCP servers, SSH hosts, and package registries during explicit plugin installs. Everything else that leaves the machine is removed. Read [LAMHY.md](../../../LAMHY.md#outbound-data-delete-do-not-disable) for the decision; this skill is the procedure.

## Rule

Delete the code and its composition rows. Do not disable through configuration, environment variables, or a default of `false`: an upstream sync can flip a default without a merge conflict. "Anonymous", "aggregate", "opt-in", "feedback-gated", and "off by default" do not exempt a path.

A path is in scope when it sends any of these to a host the user did not choose as a service: identifiers (installation, device, user, account, Session ids), environment facts (OS, CPU, versions, locale), usage events, errors and crash reports, Session content, ratings and feedback, or a periodic check that reveals the installation exists.

Local-only features stay. Crash report files written to disk, local Session stats, and the locally stored `/feedback` record are not telemetry. Remove a local feature only when its only purpose is to feed a removed upload.

## Removal inventory

Remove these and keep them removed. When a sync reintroduces any of them, delete again.

| Target | What it sends |
| --- | --- |
| `packages/telemetry/` (`@deepseek-ai/dsh-otel`) | OTLP log export to `dsh-otel-collector.deepseeksvc.com` |
| `packages/session/session-telemetry`, `packages/session/session-telemetry-otel` | Session-log prefixes after feedback |
| `packages/host/product-telemetry-otel` | Desktop product events |
| `packages/client/product-analytics` | Desktop interaction events with device, user, OS, and CPU fields |
| `packages/identity/anonymous-user-id` | Per-home UUID attached to telemetry, feedback, and DeepSeek requests |
| `packages/session/session-log-deepseek`, `packages/client/ui-settings-session-log` | Session-log suffix uploaded inside DeepSeek API requests |
| `packages/feedback/command-feedback`, `packages/feedback/message-feedback`, `packages/client/ui-message-feedback` | Feedback that releases Sessions for telemetry upload |
| `x-deepseek-harness-user-id` header in `packages/llm/llm-deepseek` | Anonymous id on every DeepSeek request |
| `electron-updater` and `apps/desktop/src/update-coordinator.ts` | Feed checks that reveal version and platform |
| `resolveTelemetryPatch` in `packages/boot/app-boot` and `DSH_TELEMETRY_*`, `DSH_PRODUCT_ANALYTICS_*` handling | Switches for the removed exporters |

Check the inventory against the live tree first; package paths can move upstream.

## Procedure

1. **Scan.** Run these from the repository root and read every hit outside `.agents/notes/archived/`, `vendor/`, and `pnpm-lock.yaml`:

   ```sh
   git grep -nE -i 'telemetry|analytics|otlp|opentelemetry|collector|anonymous[-_ ]?user|device_id|crash[-_ ]?report|beacon|sendBeacon|posthog|sentry|mixpanel|amplitude|segment|gtag|plausible|umami|electron-updater|autoUpdater'
   git grep -nE 'https?://[^ "'"'"'`)]+' -- 'packages/**/src/**' 'apps/**/src/**' 'packages/bundle/**' 'apps/**/*.yml'
   git grep -nE 'DSH_(TELEMETRY|PRODUCT_ANALYTICS)'
   ```

   For each URL, decide: user-configured service (keep), test fixture host such as `*.test` or `*.invalid` (keep), or unrequested destination (remove). Also check new `dependencies` in changed `package.json` files for reporting SDKs.

2. **Find consumers.** For each removal target, list dependents before deleting:

   ```sh
   git grep -l '"@deepseek-ai/<package>"' -- '*package.json'
   git grep -l '@deepseek-ai/<package>' -- '*.ts' '*.tsx' '*.yml' '*.md'
   ```

3. **Cut consumers.** Remove each import, bundle row, `package.json` dependency, tsconfig path, settings field, UI entry, and doc link. In `cordis.patch.yml`, delete the row and its comment block. Where a consumer only forwarded an id or event (for example, product-analytics calls in client UI packages), delete the call, not the surrounding feature.

4. **Retire durable events.** Session logs written before the removal contain `feedback/record`, `feedback/message-put`, `feedback/message-delete`, and `session-log-deepseek/delivery-accepted`. The reader refuses unknown non-ignorable events, so keep these names known:
   - Keep one fork-owned declaration file, `packages/core/session/src/lamhy-retired-events.ts`, that declares the four types in `SessionEventMap` through `declare module '@deepseek-ai/dsh-session/types'` with `unknown` payloads and JSDoc stating they are retired, log-only, and never model-visible.
   - Regenerate with `pnpm run gen-persistence-catalog` and confirm the four names remain in `known-event-types.ts`.
   - Follow [reviewing persistence-type changes](../../../docs/cookbook/reviewing-persistence-type-changes.md) for the acknowledgement. Do not bump `SESSION_FORMAT_VERSION`.

5. **Delete packages.** `git rm -r` each package directory after its consumers are gone. Remove its row from group READMEs, `apps/cli/composition.md`, `docs/module-graph.md`, `docs/config-catalog.md`, and other generated docs by rerunning their generators rather than hand-editing.

6. **Desktop updates.** Remove `electron-updater`, the update coordinator, its IPC and settings UI, and the update-channel scripts and tests. Updates become manual downloads. Keep the version display.

7. **Kiro.** Confirm `packages/llm/llm-kiro/src/adapter.ts` still sends `x-amzn-codewhisperer-optout: true` and that the Kiro package sends nothing beyond the Kiro and AWS sign-in endpoints its README lists.

8. **Install and regenerate.** Run `pnpm install` to update `pnpm-lock.yaml`, then the generators the affected gates name (`gen-persistence-catalog`, doc graph and config catalog generators).

9. **Verify.** Run the smallest set from [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md) that covers the diff: `typecheck`, `lint`, `hygiene`, affected unit tests, `test:snapshot` for touched profiles, and `doc-sync`. Then rerun the step 1 scan and confirm the only hits are allowed ones.

10. **Record.** Commit as `chore(lamhy-strip): remove <targets>`. Removing settings keys, env vars, or Session events is externally perceptible; add an [upgrade guide](../dsh-create-upgrade-guide/SKILL.md) entry.

## Reviewing a new package or dependency

Before landing, answer in the PR description: which hosts does this code contact, who chose each host, and what does each request carry beyond the user's task? Any host without a user choice behind it fails review.

## When to ask the user

Ask before removing a path that also delivers user value they may rely on, such as a cloud sync or remote-access relay, or when a model provider sends extra identifying headers that might be required for authentication.
