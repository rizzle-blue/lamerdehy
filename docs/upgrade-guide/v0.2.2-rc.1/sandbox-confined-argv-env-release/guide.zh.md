---
kind: upgrade-guide
description: "ConfinedArgv 新增必填的 env 与 release 字段，SSH helper 协议升级到版本 4。"
---

# `ConfinedArgv` 携带 `env` 与 `release`；SSH helper 协议 4

[English](guide.md) | 中文

## 变更

`SandboxProvider.confine` 的结果此前只包含包装后的 argv 及其分类信息。`ConfinedArgv` 现在还要求 `env`（消费方叠加到子进程环境上的变量）和 `release()`（消费方在子进程结束、spawn 失败或被放弃后恰好 await 一次）。本仓库之外的沙箱提供方必须返回这两个字段，消费方必须应用它们。策略还可以请求 `denyRead`、`denyWrite` 和 `network`；无法强制执行所请求字段的提供方必须以 `SandboxUnsupportedPolicyError` 拒绝。

SSH helper 协议现为版本 4。它新增 `sandbox.release` 请求，`sandbox` 结果携带 `releaseId`。由不同版本构建的客户端与 helper 会拒绝连接。

## 迁移

1. 在每个 `SandboxProvider` 子类中，当后端不保留逐调用状态时，让 `confine` 返回 `env: {}` 和 `release: () => Promise.resolve()`，并在包装前调用 `@deepseek-ai/dsh-sandbox` 的 `assertRestrictionsSupported(policy, NO_RESTRICTIONS, '<backend>')`。
2. 在每个会 spawn 受限 argv 的代码路径中，把 `confined.env` 最后合并到子进程环境，并在子进程结束或启动失败时 await `confined.release()`。
3. 将 SSH helper 构件与客户端一起重新构建并重新安装；确认 `hello` 交换不再报告协议不匹配。
4. 运行提供方的测试，确认带 `network: { allowedDomains: [] }` 的策略会以代码 `SANDBOX_UNSUPPORTED_POLICY` 被拒绝，除非该后端能强制执行它。
