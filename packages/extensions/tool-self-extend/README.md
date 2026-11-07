---
description: "Approval-free edits to Tidebloom mode's own plugin composition."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-self-extend

English | [中文](README.zh.md)

## Summary

List, add, update, or remove plugins in Tidebloom mode's own extension group without approval, inside fixed guardrails: module code runs only in fresh OS-sandboxed processes, and in-process packages must be on the mode's allowlist. Changes persist in the profile and apply to new Tidebloom sessions and subagents explicitly started with `agent_preset: "tidebloom"`; the current session keeps its existing tools. Use Plugin Manager for other modes and profile-wide plugins.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Tidebloom mode includes `self_extend` when DSH runs from a source checkout. Ask the agent to list its extensions or to add, update, or remove a row in its own extension group.

For an add, supply a unique row id that starts with a lowercase letter or digit and contains only lowercase letters, digits, and hyphens, and exactly one source: an allowlisted plugin package or an absolute module path. An update can change the source, the enabled state, the write permission of a module extension, or the complete config object of a package extension; omitted fields retain their current values. An add enables the row by default.

A module source must be a self-contained ESM `.js` or `.mjs` file that exports `tools`, an array of 1 to 16 `{ name, description, parameters }` declarations, and `execute(name, args)`. The tool copies the file into the profile, so editing the original file requires another update. Before saving, it imports the copy in a read-only sandboxed process and checks the declared tools: names match `^[a-z][a-z0-9_]{0,63}$` and do not collide with tools already in the mode, descriptions are 1 to 2000 characters, and parameters are object schemas. The saved row loads [`@deepseek-ai/dsh-tool-sandboxed-module`](../tool-sandboxed-module/README.md), which runs each call in a fresh sandboxed Node process with an empty environment and no harness tools.

The `write` argument sets where a module's calls may write: `none`, `data` (the default; only the extension's private data directory), or `workspace` (the session workspace and the data directory, never wider than the session's own mode and never a filesystem root, home, or DSH directory). A package source must appear in `allowedPackages` and loads in-process. Rows of the retired in-process module form can only be listed or removed.

### Configuration

The preset mounts this package with these fields:

| Field | Default | Meaning |
|---|---|---|
| `presetEntry` | required | Loader id of the declaring preset row. |
| `extensionGroup` | required | Id of the preset's editable `cordis:group` row. |
| `allowedPackages` | `[]` | Installed plugin packages `self_extend` may add in-process. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-self-extend) describes the accepted configuration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The preset registry serializes changes per preset, and each change replaces only the configured group. The registry checks for newly reported load failures after an edit; the tool restores the previous group when it detects one. Copied modules are stored under `self-extensions/<preset>/modules` with a content hash in the name, and unreferenced copies are removed after each change; a removal failure is reported beside the change result and never replaces it. Each module extension's data directory, `self-extensions/<preset>/data/<id>`, is never deleted, so removing and adding the same id reuses its data.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Plugin Manager](../../boot/plugin-manager/README.md) — manage profile-wide plugins and other modes.
- [Cordis inspection tools](../tool-cordis/README.md) — discover runtime APIs for plugin development.
- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-self-extend) — the `self_extend` schema.

-----

<a id="model-experience"></a>
## Model Experience

### Self extension

#### What the model sees

The model receives one `self_extend` tool schema for listing and changing its own extension group. Results describe the saved extensions and, for mutations, when the change becomes available.

#### Token effect

One tool schema enters requests while the tool is visible. Tool results append to the transcript; their size depends on the extension list and returned errors.

#### KV Cache effect

The unchanged tool schema remains prefix-stable, and results append to history. A self-change does not change the current session's tools; later Tidebloom sessions and explicitly selected `tidebloom` subagents can have different tool schemas.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The tool operates only on its configured preset group.

- Tidebloom is available only in source checkouts; other modes and profile-wide plugins remain outside this tool's scope.
- A newly reported plugin load failure triggers rollback. If rollback fails, the error reports that new sessions may remain broken until the offending row is removed.
- The load check compares reported failure lines before and after the edit; it does not guarantee plugin behavior beyond loading.
- Sandbox modes govern file writes only; module code can read files and use the network.

<a id="dev-note"></a>
### Dev Note

None.
