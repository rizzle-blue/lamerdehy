---
description: "通过 AWS Builder ID 或 IAM Identity Center 设备授权，在 DeepSeek Harness 中使用 Kiro 账号模型。"
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-kiro

[English](README.md) | 中文

## 概述

无需 API key 即可使用 Kiro 账号可用的模型。通过 AWS Builder ID 或 IAM Identity Center 登录，从账号目录选择模型，并以流式方式接收文本、思考和工具调用。设备授权和刷新的凭据保存在 Harness 凭据存储中。Kiro 订阅决定可用的模型与额度。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [继续探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

基于 base 的 profile 包含此集成。插件加载时不会改变默认模型，也不会联系 Kiro。

### 登录并选择模型

在 Harness 对话中运行 `/kiro-login`，使用个人 AWS Builder ID 账号。打开返回的批准链接并批准设备代码。运行 `/kiro-login status` 检查完成状态，再刷新模型列表并选择 `kiro` 下的模型。

使用 IAM Identity Center 时，运行 `/kiro-login https://<your-org>.awsapps.com/start <region>`。省略 region 将启用区域发现。使用 `/kiro-login cancel` 撤销未完成的尝试。`/kiro-logout` 取消未完成的尝试并删除保存的凭据；不会撤销 AWS 账号在其他位置的会话。

运行 `/kiro-usage` 查询账号套餐、额度上限、剩余额度和重置日期。用量与目录查询失败时保留错误，不会返回空目录或零余额。免费账号可用的模型可能少于付费账号。

### 自定义组合

将此插件与 LLM、凭据和授权服务一起挂载：

```yaml
- name: '@deepseek-ai/dsh-llm-kiro'
```

组合同时挂载 commands 服务时，可以使用这些对话命令。程序调用方可直接使用授权服务；按拥有者划分的凭据记录属于 `llm-kiro`。

`headless` profile 默认禁用凭据存储和授权。要使用 Web 保存的 Kiro 登录，请在其 profile 或逐次调用 patch 中启用这两个条目：

```yaml
- id: credentials
  disabled: false
- id: authorization
  disabled: false
```

### 部署设置

在插件条目的 `config` 下设置这些字段。所有时长均以毫秒为单位。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `requestTimeoutMs` | `15000` | 授权、目录或用量 HTTP 请求的截止时长 |
| `firstEventTimeoutMs` | `180000` | 首个推理事件的最长等待时间 |
| `idleTimeoutMs` | `300000` | 推理过程中的最长空闲间隔 |
| `expiryMarginMs` | `300000` | 在到期前提前此时长刷新凭据 |

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

适配器将 Harness 请求转换为 Kiro 对话请求，并把经过 CRC 校验的 AWS EventStream 帧解码为原生内容块。按账号查询的模型目录提供模型能力，而非使用静态列表。凭据刷新使用 Harness 记录修改锁，因此并发进程不会各自轮换同一个 refresh token。不使用 OMP 包或 OMP 凭据文件。

协议实现改编自 [omp-kiro-provider](https://github.com/HoangNguyen17193/omp-kiro-provider)，遵循其 [MIT 许可证](LICENSE)。所有 Kiro 与 AWS 登录请求都以 `omp-kiro-provider/0.2.0` 标识自身，而不是使用共享的 Harness `User-Agent`，因为 Kiro 运行时对 Harness 标识返回 `403 User is not authorized to make this call.`。AWS 负责账号授权、模型目录和协议服务。传输与账号行为需要真实 Kiro 账号进行在线验证；本地自动化检查使用记录的协议事件和模拟传输，不使用账号凭据。

</details>

-----

<a id="further-exploration"></a>
## 继续探索

- [LLM 服务](../llm/README.zh.md)——原生模型请求与流事件。
- [授权](../../credentials/authorization/README.zh.md)——设备流程交互与取消。
- [凭据](../../credentials/credentials/README.zh.md)——存储与跨进程记录修改。
- [Base bundle](../../bundle/base/README.zh.md)——随产品提供的 profile 组合。

-----

<a id="model-experience"></a>
## 模型体验

### Kiro 对话请求

#### 模型看到什么

Kiro 通过原生对话协议接收选定模型、系统指令、对话内容和当前工具声明。凭据、授权通知和用量命令输出不会进入模型请求。轮次规范化可能为输入为空、中断或为空的工具结果，以及历史工具声明插入以下文本。过大的结果在 `[TRUNCATED <count> characters]` 两侧保留头部与尾部。

##### 规范化文本

```markdown
Please proceed with the task.
Tool use was interrupted and did not produce a result.
(no output)
Tool no longer available.
```

#### Token 影响

对话历史与工具声明占用所选模型的上下文。思考控制遵循账号模型返回的能力；Kiro 管理输出限制。账号额度与 token 用量分开计算。

#### KV Cache 影响

提供方缓存由 Kiro 控制。对话规范化、系统指令变化或工具声明变化可能改变请求前缀；适配器不保证缓存复用。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

账号认证与能力遵循 Kiro 支持的设备流程：

- 每个 Harness home 仅保存一个 Kiro 账号。再次登录会替换该凭据。
- 不支持 Google/GitHub 社交登录和导入 `kiro-cli` 登录。
- 模型可用性与思考控制取决于账号目录，而非内置模型列表。
- 此 Kiro 协议无法遵循显式 `temperature`、`maxTokens`、`stop` 或延迟工具声明，因此会拒绝这些选项。
- Kiro 不接受回放的助手历史中的思考内容。较早的图像使用 Harness 卸载文本，而非重新发送图像字节。
- 在线授权和推理需要用户的 Kiro 账号；确定性测试不能证明当前订阅权限或服务可用性。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
