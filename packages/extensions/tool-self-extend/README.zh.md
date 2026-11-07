---
description: "无需审批即可编辑 Tidebloom 模式自身的插件组成。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-self-extend

[English](README.md) | 中文

## 概述

无需审批即可在固定防护范围内列出、添加、更新或移除 Tidebloom 模式自身扩展组中的插件：模块代码只在全新的操作系统沙箱进程中运行，进程内加载的包必须在该模式的允许列表中。变更持久化到 profile，并应用于新的 Tidebloom 会话和显式指定 `agent_preset: "tidebloom"` 启动的子 agent；当前会话保留原有工具。其他模式和 profile 级插件请使用 Plugin Manager。

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

从源码检出运行 DSH 时，Tidebloom 模式包含 `self_extend`。可以让 agent 列出其扩展，或在自身扩展组中添加、更新或移除一行。

添加时，提供以小写字母或数字开头且仅含小写字母、数字和连字符的唯一行 id，以及且仅有一个来源：允许列表中的插件包或模块绝对路径。更新可以改变来源、启用状态、模块扩展的写入权限，或包扩展的完整配置对象；省略的字段保留当前值。添加时默认启用该行。

模块来源必须是自包含的 ESM `.js` 或 `.mjs` 文件，导出 `tools`（1 到 16 个 `{ name, description, parameters }` 声明组成的数组）和 `execute(name, args)`。工具将文件复制到 profile，因此编辑原文件后需要再次更新。保存前，工具在只读沙箱进程中导入副本并检查声明的工具：名称匹配 `^[a-z][a-z0-9_]{0,63}$` 且不与该模式已有的工具冲突，描述为 1 到 2000 个字符，参数为 object schema。保存的行加载 [`@deepseek-ai/dsh-tool-sandboxed-module`](../tool-sandboxed-module/README.zh.md)，它在环境为空、没有 harness 工具的全新沙箱 Node 进程中运行每次调用。

`write` 参数决定模块调用可写入的位置：`none`、`data`（默认值；只有扩展的私有数据目录）或 `workspace`（会话工作区和数据目录，从不超过会话自身的模式，也从不是文件系统根目录、主目录或 DSH 目录）。包来源必须出现在 `allowedPackages` 中，并在进程内加载。已停用的进程内模块形式的行只能列出或移除。

### 配置

preset 挂载本包时使用以下字段：

| 字段 | 默认值 | 含义 |
|---|---|---|
| `presetEntry` | 必填 | 声明该 preset 的行的 Loader id。 |
| `extensionGroup` | 必填 | preset 中可编辑的 `cordis:group` 行的 id。 |
| `allowedPackages` | `[]` | `self_extend` 可在进程内添加的已安装插件包。 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-self-extend)描述受支持的配置。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

preset 注册表按 preset 串行执行变更，每次变更只替换指定的组。注册表在编辑后检查新报告的加载失败；发现失败时工具会恢复此前的组。复制的模块存放在 `self-extensions/<preset>/modules` 下，名称包含内容哈希，每次变更后会移除不再引用的副本；移除失败会与变更结果一并报告，从不取代结果。每个模块扩展的数据目录 `self-extensions/<preset>/data/<id>` 从不删除，因此移除后再添加同一 id 会复用其数据。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Plugin Manager](../../boot/plugin-manager/README.zh.md)——管理 profile 级插件和其他模式。
- [Cordis 检查工具](../tool-cordis/README.zh.md)——发现插件开发所需的运行时 API。
- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-self-extend)——`self_extend` 的 schema。

-----

<a id="model-experience"></a>
## 模型体验

### 自我扩展

#### 模型所见

模型收到一个 `self_extend` 工具 schema，用于列出和修改自身扩展组。结果描述已保存的扩展；变更结果还会说明何时可以使用该变更。

#### Token 影响

工具可见时，一个工具 schema 进入请求。工具结果追加到转录中；其大小取决于扩展列表和返回的错误。

#### KV Cache 影响

未改变的工具 schema 保持前缀稳定，结果追加到历史中。自我变更不会改变当前会话的工具；后续 Tidebloom 会话和显式选择 `tidebloom` 的子 agent 可能具有不同的工具 schema。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

该工具只操作配置指定的 preset 组。

- Tidebloom 仅在源码检出中可用；其他模式和 profile 级插件不在此工具的范围内。
- 新报告的插件加载失败会触发回滚。如果回滚失败，错误会报告新会话可能保持损坏状态，直到移除导致问题的行。
- 加载检查比较编辑前后报告的失败行；它不保证插件加载后的行为。
- 沙箱模式只管控文件写入；模块代码可以读取文件并访问网络。

<a id="dev-note"></a>
### 开发备注

无。
