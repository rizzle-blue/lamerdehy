---
kind: upgrade-guide
description: "ConfinedArgv gains required env and release fields, and the SSH helper protocol advances to version 4."
---

# `ConfinedArgv` carries `env` and `release`; SSH helper protocol 4

English | [中文](guide.zh.md)

## Change

`SandboxProvider.confine` results previously held only the wrapped argv and its classification facts. `ConfinedArgv` now also requires `env`, variables the consumer overlays on the child's environment, and `release()`, which the consumer awaits once after the child ends, fails to spawn, or is abandoned. Sandbox providers outside this repository must return both fields; consumers must apply them. Policies may also request `denyRead`, `denyWrite`, and `network`; a provider that cannot enforce a requested field must reject with `SandboxUnsupportedPolicyError`.

The SSH helper protocol is now version 4. It adds the `sandbox.release` request, and `sandbox` results carry a `releaseId`. A client and a helper built from different versions refuse to connect.

## Migration

1. In each `SandboxProvider` subclass, return `env: {}` and `release: () => Promise.resolve()` from `confine` when the backend keeps no per-call state, and call `assertRestrictionsSupported(policy, NO_RESTRICTIONS, '<backend>')` from `@deepseek-ai/dsh-sandbox` before wrapping.
2. In each code path that spawns a confined argv, merge `confined.env` into the child's environment last and await `confined.release()` when the child ends or fails to start.
3. Rebuild and reinstall the SSH helper artifact together with the client; confirm the `hello` exchange no longer reports a protocol mismatch.
4. Run your provider's tests and confirm a policy with `network: { allowedDomains: [] }` rejects with code `SANDBOX_UNSUPPORTED_POLICY` unless the backend enforces it.
