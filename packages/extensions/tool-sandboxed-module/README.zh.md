---
description: "在全新的操作系统沙箱进程中运行 Tidebloom 模块扩展的工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-sandboxed-module

[English](README.md) | 中文

## 概述

注册 Tidebloom 模块扩展声明的工具，并在全新的操作系统沙箱 Node 进程中运行每次调用。该进程的环境为空、没有 harness 工具，只能写入扩展写入权限允许的位置。任何调用都不会请求审批。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[`self_extend`](../tool-self-extend/README.zh.md) 为每个模块扩展添加一行本包；不要手动添加行。模块是只导入 `node:` 内置模块的自包含 ESM 文件，导出 `tools`（由 `{ name, description, parameters }` 组成的数组）和 `execute(name, args)`。调用返回 `execute` 的值；字符串原样返回，其他值以 JSON 返回。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `module` | 必填 | 已存储模块副本的 `file:` URL。 |
| `dataDir` | 必填 | 扩展的私有数据目录的绝对路径。 |
| `write` | `data` | 调用可写入的位置：`none`、`data` 或 `workspace`。 |
| `tools` | 必填 | 模块清单检查得到的工具：名称匹配 `^[a-z][a-z0-9_]{0,63}$`，并带有描述和参数 schema。 |

除非 `module` 是 `file:` URL、`dataDir` 是绝对路径，且 `ctx.ptcRuntime` 服务运行 TypeScript 并支持隔离，否则该行加载失败。

写入权限决定每次调用的策略：

| `write` | 会话模式 | 可写区域 | 工作目录 |
|---|---|---|---|
| `none` | 任意 | 无 | 数据目录 |
| `data` | 任意 | 数据目录 | 数据目录 |
| `workspace` | `read-only` | 数据目录 | 会话工作区 |
| `workspace` | `workspace-write` 或 `danger-full-access` | 会话工作区、其附加可写根目录和数据目录 | 会话工作区 |

当会话工作区是文件系统根目录、主目录，或等于、位于或包含 DSH home 时，`workspace` 调用会被拒绝。完全访问权限从不传给模块。

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-sandboxed-module)描述受支持的配置。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

每次调用通过 `ctx.sandboxPolicy` 解析会话的沙箱策略，按上表得出策略，读取已存储的模块，再通过 `ctx.ptcRuntime` 运行一个以 `data:` URL 导入其源码并调用 `execute` 的程序，不使用 state owner 或宿主绑定。因此沙箱进程无需读取 profile 目录；当该目录位于 `/tmp` 下时，Linux 的 `workspace-write` 隔离会将其隐藏。策略自动授予；本包从不请求提权或审批。沙箱拒绝时会附加拒绝标记，并说明自我扩展工具不能请求更宽的权限。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [自我扩展工具](../tool-self-extend/README.zh.md)——添加、更新和移除模块扩展。
- [Node PTC 运行时](../../ptc-runtime/ptc-runtime-node/README.zh.md)——进程启动、环境和隔离。
- [沙箱子系统](../../../docs/subsystems/sandbox.zh.md)——各沙箱模式管控的内容。
- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-sandboxed-module)——示例工具 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 沙箱模块工具

#### 模型所见

每个声明的工具以模块清单中的名称、描述和参数出现，如目录示例 [`example_sandboxed_tool`](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-sandboxed-module) 所示。结果是模块的返回值，后跟捕获的日志；失败会说明失败类型，沙箱拒绝时还会附加拒绝标记。

#### Token 影响

每个声明的工具会在加载该扩展的会话请求中增加一个 schema。结果追加到转录中；其大小取决于模块的输出和日志。

#### KV Cache 影响

工具 schema 在会话内保持不变；自我扩展变更只影响之后的 Tidebloom 会话和子 agent。结果追加到历史中。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

沙箱模式只管控文件写入。

- 模块代码的网络访问和文件读取不受限制；空环境使 harness 凭据不进入该进程。
- 在 Windows 上，ACL 沙箱运行器报告部分强制执行。

<a id="dev-note"></a>
### 开发备注

无。
