---
name: lamhy-english-only
description: Keep the Lam Hy checkout English-only by deleting Chinese documentation, translation sidecars and tooling, the Chinese website locale, and the Chinese UI locale, then repairing every gate, link, and generator that expected them. Use after every upstream sync, when a diff adds any .zh.md, .i18n.yaml, locale/zh.json, zh locale dictionary entry, or zh-CN expected output, and whenever writing new docs in this fork, which must not get a Chinese pair.
---

# Lam Hy: English only

Lam Hy serves English documentation and an English-baseline UI. Chinese documents, translation sidecars, translation tooling, and Chinese UI copy are removed. Other UI locales stay. Read [LAMHY.md](../../../LAMHY.md#english-only-including-the-ui) for the decision; this skill is the procedure.

This skill overrides the bilingual rules in [docs/AGENTS.md](../../../docs/AGENTS.md), [docs/i18n](../../../docs/i18n/README.md), and [dsh-doc](../dsh-doc/SKILL.md): write English only, do not create `.zh.md` pairs or `.i18n.yaml` sidecars, and do not run `dsh-translate-docs`.

## Removal inventory

| Target | Files |
| --- | --- |
| Chinese docs | every `*.zh.md`, including `.agents/notes/` (archived notes too: the frozen-archive rule does not protect a language Lam Hy no longer ships) |
| Translation sidecars | every `*.i18n.yaml` |
| Translation tooling | `docs/i18n/`, `.agents/skills/dsh-translate-docs/`, `scripts/translation-*.ts`, `scripts/gen-translation-brief.ts`, `scripts/verify-translation-*.ts`, `scripts/translation-pairing.manifest.json`, their specs and `package.json` scripts, and their `run-gates.ts` rows |
| Chinese images | `*.zh.png`, `*.zh.svg`, `*-zh.webp`, `*-zh-dark.webp` |
| Chinese UI locale | `locale/zh.json`, `src/**/locales/zh.ts`, `zh:` entries in `locales.ts` dictionaries, `zh` in `LOCALE_IDS` and the locale label table in `packages/client/locale` |
| Chinese expected outputs | test expectations named `*zh*` / `*zh-CN*`, and the test cases that produce them |
| Website zh locale | the `zh-*` sidebars, `contentLocale: 'zh-CN'`, and the `.zh.md` sibling lookup in `website/docs.ts` |
| Desktop installer | `apps/desktop/installer/locales/zh_CN.json` and its registration |

Non-documentation Chinese text that is product data rather than translation stays, such as test fixtures that check CJK width handling or search tokenization. Ask when unsure.

## Procedure

1. **Inventory.** List what this run will delete:

   ```sh
   git ls-files | grep -E '\.zh\.md$|\.i18n\.yaml$|(^|/)locale/zh\.json$|/locales/zh\.ts$|[._-]zh([._-]|-CN)'
   git grep -lnE "\bzh(-CN)?\b\s*[:=]|'zh'|\"zh\"" -- 'packages/**/src/**' 'apps/**/src/**' 'website/**' 'scripts/**'
   ```

2. **Docs and sidecars.** `git rm` every `*.zh.md` and `*.i18n.yaml`. Then remove the `English | [中文](README.zh.md)` language switch line from every English doc that has one; a scripted edit of that exact line is safe because the line is uniform.

3. **Translation gates.** Delete the translation tooling listed above. Remove its rows from `scripts/run-gates.ts` (search for `translation`) and its entries in `package.json`. In gates that list both languages, such as `scripts/verify-md-wrap.ts` and `scripts/verify-md-links.ts`, drop the `README.zh.md` patterns. Remove the `zh` renderer argument in generators that emit pairs, such as `scripts/gen-persistence-catalog.ts`, so they stop writing `.zh.md` output. Search `scripts/` for `zh` and `.zh.md` and fix every remaining reader.

4. **Website.** Make English the root locale in `website/docs.ts` and `website/build.ts`, remove the Chinese sidebars and sibling lookup, and rebuild with `pnpm run website:build`.

5. **UI locale.** This changes a typed contract, so do it as one coherent edit:
   - Set `LOCALE_IDS = ['en'] as const` in `packages/client/locale/src/locale-settings.ts` and remove the `zh` row and `zh-CN` mapping in `packages/client/locale/src/client/index.ts`.
   - Delete every `locale/zh.json` and `locales/zh.ts`, and remove `zh` keys from dictionary objects in `locales.ts` files. Typecheck finds the rest.
   - Keep `ja`, `es`, `fr`, `de`, `ru`, `pt`.
   - Saved user settings may contain `preference: 'zh'`. The locale pattern still accepts it and the chain falls back to English; confirm this with a unit test instead of adding migration code.
   - Run `verify-client-ui-i18n`, `typecheck`, and the client tests for `packages/client/locale`.

6. **Expected outputs.** Delete Chinese expected files and the test cases or parameter rows that produce them. Do not leave a test that writes a missing expectation.

7. **Links and budgets.** Run `pnpm run verify-md-links` and `pnpm run doc-sync`. Fix links that pointed to `.zh.md` files. Lower or keep doc budgets; do not raise them for this change.

8. **Rules text.** Update [AGENTS.md](../../../AGENTS.md) and [docs/AGENTS.md](../../../docs/AGENTS.md) to say docs are English-only and drop references to bilingual pairs, so agents stop recreating them. Keep the edit small to limit sync conflicts.

9. **Verify.** From [dsh-pre-push-checks](../dsh-pre-push-checks/SKILL.md), run `test:docs`, `doc-sync`, `typecheck`, `lint`, `website:build`, and the affected client and Desktop unit tests. Rerun the step 1 inventory and confirm it is empty except for allowed fixtures.

10. **Record.** Commit as `chore(lamhy-strip): remove Chinese docs and locale`. Removing a UI language is user-visible; add an [upgrade guide](../dsh-create-upgrade-guide/SKILL.md) entry.

## After an upstream sync

Upstream edits Chinese files in most commits, so a merge produces many modify/delete conflicts on `.zh.md` and `.i18n.yaml`. Resolve them all as deletions:

```sh
git status --porcelain | awk '$1 ~ /^(DU|UD)$/ && $2 ~ /\.zh\.md$|\.i18n\.yaml$|locale\/zh\.json$/ {print $2}' | xargs -r git rm --quiet
```

Then run the procedure from step 1 to catch newly added Chinese files that did not conflict.
