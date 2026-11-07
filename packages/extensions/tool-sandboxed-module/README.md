---
description: "Runs Tidebloom module extension tools in fresh OS-sandboxed processes."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-sandboxed-module

English | [中文](README.zh.md)

## Summary

Registers the tools that a Tidebloom module extension declares and runs every call in a fresh OS-sandboxed Node process. The process has an empty environment and no harness tools, and it writes only where the extension's write permission allows. No call asks for approval.

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

[`self_extend`](../tool-self-extend/README.md) adds one row of this package for each module extension; do not add rows by hand. The module is a self-contained ESM file, importing only `node:` builtins, that exports `tools`, an array of `{ name, description, parameters }`, and `execute(name, args)`. A call returns the value of `execute`; a string is returned unchanged, and other values are returned as JSON.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `module` | required | `file:` URL of the stored module copy. |
| `dataDir` | required | Absolute private data directory of the extension. |
| `write` | `data` | Where calls may write: `none`, `data`, or `workspace`. |
| `tools` | required | Tools from the module's manifest check: a name matching `^[a-z][a-z0-9_]{0,63}$`, a description, and a parameter schema. |

The row fails to load unless `module` is a `file:` URL, `dataDir` is absolute, and the `ctx.ptcRuntime` service runs TypeScript with confinement support.

The write permission sets the policy for each call:

| `write` | Session mode | Writable area | Working directory |
|---|---|---|---|
| `none` | any | nothing | data directory |
| `data` | any | data directory | data directory |
| `workspace` | `read-only` | data directory | session workspace |
| `workspace` | `workspace-write` or `danger-full-access` | session workspace, its additional writable roots, and the data directory | session workspace |

A `workspace` call is refused when the session workspace is a filesystem root, the home directory, or equal to, inside, or an ancestor of the DSH home. Full access is never passed to a module.

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-sandboxed-module) describes the accepted configuration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Each call resolves the session's sandbox policy through `ctx.sandboxPolicy`, derives the policy in the table above, reads the stored module, and runs a program that imports its source as a `data:` URL and calls `execute` through `ctx.ptcRuntime` without a state owner or host bindings. The sandboxed process therefore needs no read access to the profile directory, which Linux `workspace-write` confinement hides when it lies under `/tmp`. The policy is granted automatically; the package never requests escalation or approval. A sandbox denial adds the denial marker and states that self-extension tools cannot request wider access.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Self-extension tool](../tool-self-extend/README.md) — adds, updates, and removes module extensions.
- [Node PTC runtime](../../ptc-runtime/ptc-runtime-node/README.md) — process launch, environment, and confinement.
- [Sandbox subsystem](../../../docs/subsystems/sandbox.md) — what each sandbox mode governs.
- [Tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-sandboxed-module) — the example tool schema.

-----

<a id="model-experience"></a>
## Model Experience

### Sandboxed module tools

#### What the model sees

Each declared tool appears with the name, description, and parameters from the module manifest, as the catalog example [`example_sandboxed_tool`](../../../docs/tool-catalog.md#deepseek-aidsh-tool-sandboxed-module) shows. Results are the module's return value, followed by captured logs; failures name the failure kind and, after a sandbox denial, the denial marker.

#### Token effect

Each declared tool adds one schema to requests of sessions that load the extension. Results append to the transcript; their size depends on the module's output and logs.

#### KV Cache effect

Tool schemas stay fixed for a session; a self-extension change affects only later Tidebloom sessions and subagents. Results append to history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Sandbox modes govern file writes only.

- Network access and file reads by module code are not confined; the empty environment keeps harness credentials out of the process.
- On Windows, the ACL sandbox runner reports partial enforcement.

<a id="dev-note"></a>
### Dev Note

None.
