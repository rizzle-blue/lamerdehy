---
kind: upgrade-guide
description: "ProfileContext 现在要求提供 sourceCheckout 布尔值。"
---

# `ProfileContext` 要求提供 `sourceCheckout`

[English](guide.md) | 中文

## 变更

此前构造 `ProfileContext` 的代码无需提供源码检出信息。现在必须提供布尔值 `sourceCheckout`，供 Loader 表达式启用仅用于开发的条目。

## 迁移

1. 在启动器构造的每个 `ProfileContext` 对象中添加 `sourceCheckout`。对于 DSH CLI 安装，从 `@deepseek-ai/dsh-app-boot` 导入 `isSourceInstallation` 并将其设为 `isSourceInstallation(installAnchor)`；对于打包或非源码启动，将其设为 `false`。
2. 对启动器运行类型检查，并确认其 `ProfileContext` 对象包含该字段。
