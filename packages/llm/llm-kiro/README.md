---
description: "Use Kiro account models in DeepSeek Harness with AWS Builder ID or IAM Identity Center device authorization."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-kiro

English | [中文](README.zh.md)

## Summary

Use the models available to your Kiro account without an API key. Sign in with AWS Builder ID or IAM Identity Center, select a model from your account's catalog, and stream text, thinking, and tool calls. Device authorization and refreshed credentials stay in the Harness credential store. Your Kiro subscription determines which models and credits are available.

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

Base-backed profiles include this integration. It does not change the default model or contact Kiro during plugin loading.

### Sign in and select a model

In a Harness conversation, run `/kiro-login` for a personal AWS Builder ID account. Open the returned approval link and approve the device code. Run `/kiro-login status` to check completion, then refresh the model list and select a model under `kiro`.

For IAM Identity Center, run `/kiro-login https://<your-org>.awsapps.com/start <region>`. Omitting the region enables region discovery. Use `/kiro-login cancel` to withdraw an unfinished attempt. `/kiro-logout` cancels an unfinished attempt and deletes the saved credential; it does not revoke the AWS account's sessions elsewhere.

Run `/kiro-usage` to query the account plan, credit allowance, remaining credits, and reset date. Usage and catalog failures remain errors rather than an empty catalog or a zero balance. A free account can expose fewer models than a paid account.

### Custom compositions

Mount this plugin alongside the LLM, credential, and authorization services:

```yaml
- name: '@deepseek-ai/dsh-llm-kiro'
```

The conversation commands are available when the composition also mounts the commands service. Programmatic callers can use the authorization service directly; the owner-scoped record belongs to `llm-kiro`.

The `headless` profile disables stored credentials and authorization by default. To use the Kiro login saved by Web, enable both rows in its profile or invocation patch:

```yaml
- id: credentials
  disabled: false
- id: authorization
  disabled: false
```

### Deployment settings

Set these fields under the plugin row's `config`. All durations use milliseconds.

| Field | Default | Meaning |
|---|---|---|
| `requestTimeoutMs` | `15000` | Deadline for an authorization, catalog, or usage HTTP request |
| `firstEventTimeoutMs` | `180000` | Maximum wait for the first inference event |
| `idleTimeoutMs` | `300000` | Maximum idle interval during inference |
| `expiryMarginMs` | `300000` | Refresh credentials this long before expiry |

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The adapter translates Harness requests to Kiro conversation requests and decodes CRC-checked AWS EventStream frames into native content blocks. Account-scoped discovery supplies model capabilities instead of a static list. Credential refresh uses the Harness record mutation lock, so concurrent processes do not rotate the same refresh token independently. No OMP packages or OMP credential files are used.

The protocol implementation is adapted from [omp-kiro-provider](https://github.com/HoangNguyen17193/omp-kiro-provider), under its [MIT license](LICENSE). Every Kiro and AWS sign-in request identifies itself as `omp-kiro-provider/0.2.0` instead of the shared Harness `User-Agent`, because Kiro's runtime answers `403 User is not authorized to make this call.` for the Harness identity. AWS owns the account authorization, model catalog, and wire service. Transport and account behavior require a real Kiro account for live verification; local automated checks use recorded wire events and fake transports, not account credentials.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LLM service](../llm/README.md) — native model requests and stream events.
- [Authorization](../../credentials/authorization/README.md) — device-flow interaction and cancellation.
- [Credentials](../../credentials/credentials/README.md) — storage and cross-process record mutation.
- [Base bundle](../../bundle/base/README.md) — shipped profile composition.

-----

<a id="model-experience"></a>
## Model Experience

### Kiro conversation requests

#### What the model sees

Kiro receives the selected model, system instructions, conversation content, and active tool declarations through its native conversation protocol. Credentials, authorization notices, and usage-command output do not enter model requests. Turn normalization can insert the text below for empty input, interrupted or empty tool results, and historical tool declarations. Oversized results retain their head and tail around `[TRUNCATED <count> characters]`.

##### Normalization text

```markdown
Please proceed with the task.
Tool use was interrupted and did not produce a result.
(no output)
Tool no longer available.
```

#### Token effect

Conversation history and tool declarations consume the selected model's context. Thinking controls follow the capabilities returned for the account's model; Kiro manages the output limit. Account credits are separate from token usage.

#### KV Cache effect

Provider caching is controlled by Kiro. Conversation normalization and changed system instructions or tool declarations can change the request prefix; the adapter does not promise cache reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Account authentication and capabilities follow Kiro's supported device flow:

- Only one Kiro account is stored per Harness home. Signing in again replaces that credential.
- Google/GitHub social login and importing a `kiro-cli` login are not supported.
- Model availability and reasoning controls depend on the account catalog, not a bundled model list.
- Explicit `temperature`, `maxTokens`, `stop`, and deferred tool declarations are rejected because this Kiro protocol cannot honor them.
- Kiro does not accept reasoning in replayed assistant history. Earlier images use the Harness offload text instead of resending image bytes.
- Live authorization and inference require the user's Kiro account; deterministic tests do not establish current subscription access or service availability.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
