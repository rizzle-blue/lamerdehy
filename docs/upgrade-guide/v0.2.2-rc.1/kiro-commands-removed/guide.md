---
kind: upgrade-guide
description: "The /kiro-login, /kiro-logout, and /kiro-usage commands are removed; Kiro sign-in moves to the Models page."
---

# Kiro sign-in moves from slash commands to the Models page

## Change

Lam Hy no longer registers the `/kiro-login`, `/kiro-logout`, and `/kiro-usage` conversation commands. Typing one of them now reports an unknown command. Kiro sign-in and sign-out now live in **Settings → Models → Subscription accounts**, next to the ChatGPT subscription sign-in. The plan and credit report that `/kiro-usage` printed has no replacement.

A saved Kiro sign-in keeps working: the credential record `llm-kiro/kiro` is unchanged, so models under `kiro` stay available without signing in again.

Error messages that told users to run `/kiro-login` now point to the Models page.

## Migration

1. Replace any `/kiro-login`, `/kiro-login <start-url> <region>`, or `/kiro-logout` in notes, scripts, or onboarding docs with the **Kiro** row under **Settings → Models → Subscription accounts**. Enter the IAM Identity Center start URL and region when the dialog asks; leave the start URL blank for AWS Builder ID.
2. A composition that mounts `@deepseek-ai/dsh-llm-kiro` without the Web app bundle must also mount `@deepseek-ai/dsh-api-authorization-controller` and `@deepseek-ai/dsh-client-ui-settings-sign-in` to offer the sign-in, or start it programmatically through `ctx.authorization.begin({ key: 'llm-kiro/kiro', … })`.
3. Confirm the migration: open **Settings → Models**. The **Kiro** row shows **Signed in** when a saved sign-in exists.
