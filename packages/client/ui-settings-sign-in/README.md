---
description: "The subscription-account sign-in section on the Models page: sign in to ChatGPT, Kiro, and other offered accounts through a dialog, and sign out."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-settings-sign-in

## Summary

Open **Settings → Models** and use the **Subscription accounts** section below the provider list to sign in with an account plan instead of an API key. Each offered account, such as **OpenAI (ChatGPT Plus/Pro)** or **Kiro**, has a row showing whether it is signed in and a **Sign in** or **Sign out** button. Sign-in runs on the Host through the [authorization controller](../../api/authorization-controller/README.md); this package renders it.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

**Sign in** opens a dialog that shows the latest message from the sign-in flow. When the flow names a page to open, the dialog offers **Open sign-in page**, which opens it in a new tab, and **Copy link**. When the flow names a code to check on that page, the dialog shows it with **Copy code**. A question from the flow appears in the dialog: a choice shows one button per option, and typed answers use a text field, masked for secrets. ChatGPT asks whether to use browser login or device-code login and, for browser login, accepts the pasted redirect URL when the browser cannot reach the local callback. Kiro asks for an IAM Identity Center start URL, blank for AWS Builder ID, and then for its region.

**Cancel** withdraws the running sign-in. Once it ends, the dialog reports success, cancellation, or the failure, and offers **Try again** unless sign-in succeeded. Closing the dialog withdraws a running sign-in. Because the attempt lives on the Host, reloading the page and reopening the dialog shows the same attempt.

**Sign out** asks for confirmation, then deletes the saved credential on this computer. The list refreshes whenever a credential record changes or the connection resets, so a sign-in finished in another tab shows up here. The section is hidden while the Host offers no account.

<a id="model-experience"></a>
## Model Experience

### Account sign-in

#### What the model sees

Nothing. Account notices, questions, and credentials stay outside model prompts, Session logs, and tool results.

#### Token effect

This package adds no model input tokens.

#### KV Cache effect

This package does not change any model request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **English copy only** — the section registers the English dictionary alone, as Lam Hy ships English UI copy; other UI languages fall back to it.
- **No usage or plan details** — the rows show sign-in state only; plan, credit, and quota details are not displayed.

### Dev Note

None.
