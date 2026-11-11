---
description: "Settings pages sign in to subscription accounts through authenticated Remote calls. The controller runs registered authorization flows on the Host and never returns credential values."
kind: "package-reference"
---

# @deepseek-ai/dsh-api-authorization-controller

## Summary

Settings pages sign in to subscription accounts, such as a ChatGPT Plus/Pro plan or Kiro, through authenticated Remote calls. The controller runs flows registered on [`ctx.authorization`](../../credentials/authorization/README.md) on the Host, relays their notices and questions to the page, and never returns a credential value or a prompt answer.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The `authorization` namespace exposes `list`, `start`, `answer`, `cancel`, `signOut`, and the `watch` stream.

| Method | Contract |
|---|---|
| `list()` | Offered flows that are registered right now, in configured order, each with its label, methods, and whether a credential record is stored. |
| `start(key, method?)` | Starts an attempt, or returns the one already running for the key. Later changes arrive on `watch`. |
| `answer(attemptId, promptId, value)` | Settles the pending question. A question that was replaced, withdrawn, or already answered raises `authorization/stale-prompt`. |
| `cancel(attemptId)` | Withdraws a running attempt and declines its pending question; a settled attempt is left as it is. |
| `signOut(key)` | Withdraws any running attempt, then deletes the stored record. It forgets the sign-in locally and does not revoke it at the issuer. |
| `watch(key, signal)` | Yields `{ attempt }` with the latest attempt for the key, or `null`, then one frame per change. Aborting stops observation, not the attempt. |

An attempt view carries its status (`running`, `authorized`, `cancelled`, or `failed`), every notice the flow sent, and the pending question while one exists. A question the flow withdraws through its own signal, such as a pasted-URL prompt after the browser callback arrived, disappears from the view. A failure shows the `HarnessError` message when the flow raised one and a generic message otherwise, because other errors may quote a provider response.

Keys outside `flows` raise `authorization/unknown-flow` on every method that takes a key. The default offers the ChatGPT subscription and Kiro sign-ins:

```yaml
- name: '@deepseek-ai/dsh-api-authorization-controller'
  config:
    flows: [llm-pi-ai/openai-codex, llm-kiro/kiro]
```

A flow key that is not `<scope>/<id>` fails plugin loading. A listed flow whose plugin is not mounted is left out of `list()`.

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

- **Attempts live in Host memory** — a Host restart abandons a running attempt, and only the latest attempt per key is kept.
- **One question at a time** — a flow that asks a second question before the first is answered gets a rejection; the shipped flows ask sequentially.

### Dev Note

None.
