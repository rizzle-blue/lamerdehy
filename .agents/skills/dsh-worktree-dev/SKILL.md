---
name: dsh-worktree-dev
description: Use before changing DeepSeek Harness code that the running harness loads or builds from, such as packages, apps, vendor, profiles, build scripts, dependencies, or the lockfile, when the session itself runs on this checkout. Develops the change in an isolated Git worktree, takes it from raw idea or user story to acceptance criteria and checks, proves it there with an eval, and only then adopts it into the main checkout.
---

# DSH worktree development

The running harness loads `lib/`, client bundles, and `node_modules` from the main checkout. Editing, installing, or building there can break the session doing the work. Develop such changes in `.worktree/<name>` with [`scripts/worktree-dev.sh`](../../../scripts/worktree-dev.sh), and touch the main checkout only through `adopt`.

## Decide whether the change needs a worktree

Use a worktree when the change edits anything under `packages/`, `apps/`, `vendor/`, `native/`, `scripts/build*`, `tsconfig*.json`, `package.json`, `pnpm-lock.yaml`, or `pnpm-workspace.yaml`, or when it needs `pnpm install` or a build. Documentation, Agent Notes, and skill edits can go directly to the main checkout. When unsure, use a worktree.

## Run the lifecycle

Run commands from the main checkout. State lives in `.worktree/.state/<name>/`; the worktree's DSH home is `.worktree/.home/<name>/` and shares only the main credentials file.

1. **Idea to story.** Create the worktree with the user's request as the story:

   ```sh
   scripts/worktree-dev.sh new <name> --with-local --story "<user story>"
   ```

   `--with-local` commits the main checkout's uncommitted and untracked files as a baseline commit so the worktree starts from the code the user actually runs. Omit it to start from a clean ref with `--base <ref>`. The baseline commit is never adopted.

2. **Story to acceptance criteria.** Edit `story.md`: list each observable behavior, the check that proves it, and what in the running harness the change could break. Confirm the criteria with the user when the request is ambiguous.

3. **Criteria to checks.** Write one shell command per line in `checks`, run from the worktree root. Each criterion needs the narrowest check that fails without the change, chosen per [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md). Write the failing test before the implementation when practical.

4. **Implement in the worktree.** Edit only files under `.worktree/<name>`. Commit there; `eval` refuses uncommitted changes. Use `build <name>` and `smoke <name>` while iterating.

5. **Eval.** Run `scripts/worktree-dev.sh eval <name>`. It runs `build:artifacts`, every command in `checks`, then boots the worktree's `dsh web` with its own home and requires the launch URL to answer. A pass is recorded against the exact HEAD commit; any later commit makes it stale. Read `eval.log` on failure, fix, commit, and rerun. For GUI behavior, also run `scripts/worktree-dev.sh web <name>` as a background job and verify the printed URL in a browser before adopting.

6. **Adopt.** Run `scripts/worktree-dev.sh adopt <name> --build`. It refuses without a passing eval of the current HEAD, refuses if the patch does not apply cleanly, applies baseline..HEAD to the main checkout as uncommitted changes, installs when manifests changed, rebuilds, and smokes the main checkout. Then tell the user to refresh the GUI, or restart `dsh web` when Host code changed; do not start a replacement server unless asked.

7. **Roll back or clean up.** If the main checkout misbehaves after adoption, run `scripts/worktree-dev.sh unadopt <name>` and rebuild. Run `scripts/worktree-dev.sh rm <name>` only after the user accepts the adopted change; it keeps the `wt/<name>` branch.

Report to the user: the story, each criterion with the check that proved it, the eval commit, and what adoption changed (`git -C <main> apply --stat .worktree/.state/<name>/adopted.patch`).

## Rules

- Never run `pnpm install`, `build:artifacts`, or `clean` in the main checkout for a worktree change, except through `adopt --build`.
- Never copy files from the worktree to the main checkout by hand; adoption must be the evaluated patch.
- `status` lists every worktree with its eval and adoption state; check it before creating a second worktree for the same change.
