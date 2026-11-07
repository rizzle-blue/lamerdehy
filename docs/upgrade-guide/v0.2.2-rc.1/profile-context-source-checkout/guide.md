---
kind: upgrade-guide
description: "ProfileContext now requires a sourceCheckout boolean."
---

# `ProfileContext` requires `sourceCheckout`

English | [中文](guide.zh.md)

## Change

Code constructing `ProfileContext` previously supplied no source-checkout fact. It must now provide `sourceCheckout`, a boolean that Loader expressions can use to enable development-only rows.

## Migration

1. In each `ProfileContext` object your launcher constructs, add `sourceCheckout`. For the DSH CLI installation, import `isSourceInstallation` from `@deepseek-ai/dsh-app-boot` and set it to `isSourceInstallation(installAnchor)`; for a packaged or non-source launch, set it to `false`.
2. Typecheck your launcher and confirm its `ProfileContext` objects include the field.
