---
name: lamhy-rebrand
description: Replace the user-visible "DeepSeek Harness" product name with "Lam Hy" in docs, UI copy, CLI help, and window titles while keeping internal identifiers (package scope, DSH_* env vars, manifest keys, wire names) unchanged so upstream syncs stay cheap. Use after every upstream sync, when writing any new user-facing text in this fork, and whenever someone asks to rename, rebrand, or replace DeepSeek Harness or dsh naming; stop and ask the user before touching any surface in the decision list.
---

# Lam Hy: rebrand

Lam Hy renames only what a user reads. Read [LAMHY.md](../../../LAMHY.md#rebrand-depth-user-visible-only) for the decision; this skill is the procedure.

## What changes

| Upstream text | Lam Hy text | Where |
| --- | --- | --- |
| `DeepSeek Harness` (the product) | `Lam Hy` | Markdown prose, README titles, website, UI copy in `locales.ts` and `locale/*.json`, CLI help text, Desktop menu and window titles |
| `dsh` as the command a user types | `lamhy` | user-facing docs and CLI help, once the `lamhy` binary exists |

Apply the rename in every remaining UI locale. Use "Lam Hy" untranslated.

## What does not change

- `@deepseek-ai/dsh-*` package names and import paths.
- `DSH_*` environment variables, `$DSH_HOME` layout, and `dsh.bundle` manifest keys.
- Session event types, persistence formats, SQLite schemas, wire methods, and RPC names.
- Type, function, and file names such as `DshHome` or `dsh-base`.
- "DeepSeek" meaning the model vendor: DeepSeek API, DeepSeek account, `llm-deepseek`, `DEEPSEEK_API_KEY`, `api.deepseek.com`.
- The upstream copyright line in `LICENSE` files, and attributions to upstream in [LAMHY.md](../../../LAMHY.md) and `THIRD_PARTY_NOTICES.md`.
- Archived Agent Notes and vendored code.
- Code comments and JSDoc. They are developer-facing, and rewording them causes conflicts on most upstream edits.

## Ask the user first

Each of these touches a foundation or has effects beyond text. Stop and ask with the trade-off before changing any of them:

| Surface | Why it needs a decision |
| --- | --- |
| `You are an AI agent powered by DeepSeek Harness.` in `packages/core/system-prompt/src/index.ts` | Model-visible; changes every recorded snapshot's `system-prompt.expected.md` and model behavior. |
| Desktop `applicationName`, Electron app id, `productName`, publisher name | Changes the OS data directory, keychain entries, code-signing identity, and installer upgrade path. |
| Brand artwork in `packages/client/ui-brand-official` and website wordmark/favicon | Needs new artwork; upstream artwork rules require designer approval. |
| `repository.url`, `homepage`, and `bugs` in upstream `package.json` files | Hundreds of files; affects published metadata. Fork-owned packages always point at the Lam Hy repository. |
| Request headers or user agents naming the harness (for example `x-deepseek-harness-*`) | Provider-visible; a provider may rely on them. |
| Python SDK distribution names (`deepseek-harness-sdk-*`) | Breaks installs and imports for existing users. |

## Procedure

1. **Find candidates.**

   ```sh
   git grep -nE 'DeepSeek Harness|DeepSeek-Harness' -- '*.md' '*.json' '*.yml' 'packages/**/locales.ts' 'apps/**/src/**' 'website/**' \
     ':!.agents/notes/archived/**' ':!vendor/**' ':!**/LICENSE' ':!LAMHY.md' ':!THIRD_PARTY_NOTICES.md'
   ```

2. **Classify each hit** as change, keep, or ask, using the tables above. Text inside a code identifier, URL, or path is keep. Skip hits in `.zh.md` and `.i18n.yaml`; [lamhy-english-only](../lamhy-english-only/SKILL.md) deletes those.

3. **Edit.** Change prose and UI strings in place. Keep sentence case for UI copy. Do not rewrite surrounding sentences.

4. **Regenerate.** Rerun generators whose output contains the name, such as CLI help references and the website build, instead of editing generated files.

5. **Update tests.** Update expected outputs that contain the changed copy (UI snapshot `*.expected.md`, Desktop `*.expected.txt`). Do not edit model-visible snapshots unless the user approved the system-prompt change.

6. **Verify.** From [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md), run `verify-client-ui-i18n`, `doc-sync`, `typecheck`, and the unit and snapshot tests for touched packages.

7. **Record.** Commit as `chore(lamhy-brand): rename user-visible product name`. Note in the commit body which "ask" surfaces were left unchanged.
