---
name: lamhy-sync-upstream
description: Bring the latest upstream DeepSeek Harness into Lam Hy. Fetches upstream, fast-forwards the master mirror, merges it into main, resolves conflicts by the fork's rules, runs lamhy-no-telemetry, lamhy-english-only, and lamhy-rebrand in order, and verifies with the verify-lamhy-fork drift check before anything is pushed. Use whenever the user asks to sync, update, pull, merge, or adopt upstream, catch up with deepseek-harness, or take a new dsh release, and when the pre-push "lamhy fork drift" hook fails after a merge.
---

# Lam Hy: sync upstream

This skill is the single entry point for adopting upstream. The three policy skills are its steps, and the drift check is its exit condition. Read [LAMHY.md](../../../LAMHY.md#sync-procedure) for the branch roles.

## Drift check

[`scripts/verify-lamhy-fork.ts`](../../../scripts/verify-lamhy-fork.ts) reports tracked files that break a fork decision. It groups violations by the skill that fixes them:

| Category | Fixing skill |
| --- | --- |
| `telemetry` | [lamhy-no-telemetry](../lamhy-no-telemetry/SKILL.md) |
| `english-only` | [lamhy-english-only](../lamhy-english-only/SKILL.md) |
| `rebrand` | [lamhy-rebrand](../lamhy-rebrand/SKILL.md) |

```sh
pnpm run verify-lamhy-fork                       # whole tree
pnpm run verify-lamhy-fork -- --since=origin/main  # only drift beyond origin/main
pnpm run verify-lamhy-fork -- --only=telemetry     # one category
```

`--since` compares by file and reason, not line number, so upstream edits inside an existing violating file do not count as new drift; a new violating file or a new occurrence does. The pre-push hook in [lefthook.yml](../../../lefthook.yml) runs `--since=origin/main`, so a merge that brings in new telemetry, Chinese files, or upstream-name copy cannot be pushed until the policy skills have run. Until the first full run of each skill, the whole-tree mode reports the existing backlog; that is expected.

## Procedure

1. **Preflight.** Require a clean tree on `main` and the expected remotes. Stop and ask if `main` has unpushed commits that are not yours to merge over, or if a merge or rebase is already in progress.

   ```sh
   git status --short --branch
   git remote get-url upstream   # git@github.com:deepseek-ai/deepseek-harness.git
   git remote get-url origin
   ```

2. **Fetch and mirror.** Fast-forward only; `master` never carries fork commits. If the fast-forward fails, stop and report: someone committed to the mirror.

   ```sh
   git fetch upstream --tags
   git fetch origin
   git switch master && git merge --ff-only upstream/master
   git switch main
   ```

3. **Read what is coming.** Summarize the incoming range before merging, so conflicts and policy work are expected rather than discovered:

   ```sh
   git log --oneline main..master | wc -l
   git diff --stat main...master -- packages/telemetry packages/session/session-telemetry* packages/host packages/client/product-analytics packages/identity packages/feedback
   git diff --name-only --diff-filter=A main...master | grep -E '\.zh\.md$|\.i18n\.yaml$|/locale/zh\.json$' | wc -l
   ```

   Also look for new packages that send data out (new `fetch` or HTTP clients, collector URLs, reporting SDKs) and for upgrade guides under `docs/upgrade-guide/` that affect fork packages.

4. **Merge.** Use a merge commit, not a rebase: Removal commits delete thousands of files, and a rebase replays every conflict per commit.

   ```sh
   git merge --no-ff --no-commit master
   ```

5. **Resolve conflicts** with these rules, in order:
   - Modify/delete on a file Lam Hy removed (Chinese docs, sidecars, telemetry packages): keep the deletion. The batch command is in [lamhy-english-only](../lamhy-english-only/SKILL.md#after-an-upstream-sync); use the same pattern for telemetry paths.
   - Fork-owned files (`packages/llm/llm-kiro/**`, `.agents/skills/lamhy-*`, `scripts/verify-lamhy-fork*`, `LAMHY.md`): keep ours, then check whether upstream changed an API they use.
   - Wiring files (`pnpm-lock.yaml`, generated docs, `apps/cli/composition.md`, `docs/module-graph.md`, `docs/config-catalog.md`): take upstream, then regenerate after the merge. For the lockfile, take theirs and run `pnpm install`.
   - Rebrand edits: take upstream, then let [lamhy-rebrand](../lamhy-rebrand/SKILL.md) reapply the rename.
   - Upstream-patch files: take upstream if upstream already contains an equivalent change; otherwise keep ours and note it for the report.
   - Anything else: stop and ask the user. Show both sides and say which rule almost applied.

   Commit the merge once `git diff --name-only --diff-filter=U` is empty: `git commit --no-edit`.

6. **Install and build.** `pnpm install`, then `pnpm run build:artifacts`. Fix fork-package breakage caused by upstream API changes in a separate `fix(<package>)` commit.

7. **Run the policy skills** in this order, each as its own commit as the skill describes. The order matters: telemetry removal deletes packages whose Chinese READMEs and upstream-name text the later skills would otherwise edit.
   1. [lamhy-no-telemetry](../lamhy-no-telemetry/SKILL.md)
   2. [lamhy-english-only](../lamhy-english-only/SKILL.md)
   3. [lamhy-rebrand](../lamhy-rebrand/SKILL.md)

   Each skill's "ask the user" rules still apply. A pending decision does not block the other skills.

8. **Exit condition.** The drift check must pass for every change since the pre-sync `origin/main`:

   ```sh
   pnpm run verify-lamhy-fork -- --since=origin/main
   ```

   If it fails, rerun the skill the output names. Do not weaken the check to pass; if a violation is a deliberate exception, add it to the check's allow list with a reason and a spec case in [verify-lamhy-fork.spec.ts](../../../scripts/verify-lamhy-fork.spec.ts), and tell the user.

9. **Verify.** Select checks with [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md) for the merged diff. At minimum run `typecheck`, `lint`, `hygiene`, `doc-sync`, the Kiro unit tests, and `pnpm run test:snapshot -t kiro-provider`.

10. **Report and push.** Report the upstream range (`old..new` SHAs), conflicts and how each was resolved, what each policy skill removed or renamed, decisions waiting on the user, and the checks run. Push `master` and `main` to `origin` only after the user confirms; never force-push either branch.

## Recovering

Before step 4 commits, `git merge --abort` returns `main` to its pre-sync state. After the merge commit, keep it and fix forward; do not reset `main` without the user's explicit request.
