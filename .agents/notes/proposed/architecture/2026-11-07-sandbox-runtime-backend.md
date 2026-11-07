# Agent Note: Adopt sandbox-runtime as the DSH sandbox backend

Status: proposed

English | [中文](2026-11-07-sandbox-runtime-backend.zh.md)

## Problem

The `ctx.sandbox` seam governs file writes only. Confined processes can read credential stores such as `~/.ssh` and `~/.dsh/.credentials.yaml`, reach any host, and write files inside writable roots that later run unsandboxed, such as `.git/hooks`. Tidebloom module extensions run model-written code without approval, so their guardrails need read denies, protected write paths, and a network allowlist on Linux, macOS, and Windows. Hand-rolling a filtering proxy, bubblewrap mount profiles, and a Windows principal model would add a large owned security surface.

## Proposal

Adopt `@anthropic-ai/sandbox-runtime` (srt, Apache-2.0, pinned exactly; 0.0.81 at the time of the spike) as a rung of `dsh-sandbox-local`, following the plan in `TIDEBLOOM_SANDBOX_V2_PLAN.md`:

- The seam's policy gains `denyRead`, `denyWrite`, and `network.allowedDomains`; providers report which they enforce, and `ConfinedArgv` gains `env` and `release()`.
- **Linux and macOS:** `SandboxManager` is initialized once per process with an empty network allowlist. Each call passes `customConfig.filesystem` (`allowWrite`, `denyRead`, `denyWrite`) to `wrapWithSandboxArgv` and registers its hosts with `registerCommandNetworkLists` under a 128-bit random `commandId`. The rung serves capability policies first and becomes the default rung once proven, replacing the bwrap and Seatbelt profile code.
- **Windows:** srt-win, from the same package, after its one-time elevated `windows-install`. Per-call writable roots use `srt-win exec --write-root` on roots granted once with `acl grant --persistent`, because `SandboxManager` accepts writable roots only at `initialize()`. Proxy settings come from `SandboxManager`'s network layer.
- The DSH protected-path and credential lists are passed explicitly in each call's policy.

### Spike findings

Spikes ran srt 0.0.81 on WSL Ubuntu (bubblewrap 0.11.1, socat, ripgrep, Node 24.21.0) and on Windows 11 with srt-win installed with `--skip-profile-grant` (Node 24.19.0).

| Probe | Linux | Windows |
|---|---|---|
| `denyRead` of a secret file | Denied (path hidden) | Denied (`EPERM`) |
| Write inside the writable root | Allowed | Allowed |
| Write outside the writable roots | Denied (`EROFS`) | Denied (`EPERM`) |
| Explicit `denyWrite` on an existing `.git/hooks`, `.git/config` | Denied | Denied |
| Explicit `denyWrite` on an absent `AGENTS.md`, `.bashrc` | Denied; placeholder removed by `reset()` | Denied; an empty `AGENTS.md` **remains on the host** after `reset()` |
| srt's built-in mandatory denies | Applied only relative to the host process cwd | Not tested |
| Allowed host / unlisted host | 200 / refused with a `<sandbox_violations>` reason | 200 / refused with the same reason |
| Concurrent calls with different host lists | No crossover | No crossover |
| Node `fetch` through the proxy | Needs `NODE_USE_ENV_PROXY=1` (srt sets it only on Windows) | Works |
| Node `fetch` after clearing `process.env` at runtime | Works | **Fails** (`ENOTFOUND`) |
| `data:` URL module import | — | Works |
| Per-call `allowWrite` through `SandboxManager` | Works | **Throws** (session-wide only) |
| `srt-win exec --write-root A` writing to root B | — | Denied; a launch without roots cannot write either |
| Launch overhead | about 30 ms | about 230 ms |

Design consequences:

1. srt resolves its built-in mandatory deny list against `process.cwd()` of the host process. One DSH process serves many workspaces, so DSH must pass protected paths in `denyWrite` for every call instead of relying on that list.
2. On Linux the consumer adds `NODE_USE_ENV_PROXY=1` for Node children. On Windows the PTC runtime must keep the proxy variables when it clears the program environment.
3. On Windows, a `denyWrite` entry for a path that does not exist creates that path. DSH denies only existing paths there, and denies the parent directory for a protected file that is absent, or accepts the empty file for paths whose absence carries no meaning.
4. `cleanupAfterCommand()` is process-global. DSH calls it only when no confined command is in flight, through a reference count in the rung.

## Alternatives considered

**Extend the existing bwrap, Landlock, Seatbelt, and Windows-ACL rungs.** This keeps every byte owned, but means writing and hardening a filtering HTTP and SOCKS proxy, a resolved-address check, mount-point handling for absent deny paths, and a Windows principal with a network block. srt already carries those, along with their known-limitation records.

**Build a DSH-owned Windows principal backend following srt's design.** This was the fallback if srt-win failed the spike. It passed: per-call write isolation exists through `--write-root`, and read denies, write denies, and network denial work. Reimplementing the account, the network filters, and the ACE refcounting would duplicate srt-win.

**Windows AppContainer.** It denies network by default and needs no install, but loopback access to a host proxy needs an administrator exemption, and file reads require granting the container SID on every readable tree.

**Use `SandboxManager` alone on Windows.** It supports writable roots only at `initialize()`. Concurrent calls from different sessions would share the union of all roots, which breaks per-call write isolation.

## Acceptance criteria

- On Linux, macOS (CI), and Windows with srt-win installed, a confined call with a capability policy is denied reading `denyRead` paths, writing `denyWrite` paths, writing outside its own roots, and reaching unlisted hosts. Allowed hosts work, and concurrent calls keep their own roots and hosts.
- A host without srt's dependencies, or a Windows host without the install, refuses capability policies with `SandboxUnsupportedPolicyError` and an install hint; policies without capability fields behave as before.
- No placeholder or grant created for a call outlives the call, except srt-win's documented persistent root grants.

## Risks

- srt is a beta research preview; its configuration semantics change between releases. The exact pin and an upgrade checklist bound this.
- Windows: Schannel-based clients (`curl.exe`, PowerShell web cmdlets, .NET `HttpClient`) cannot use TLS under the write-restricted token. DNS lookups through `Dnscache` and anonymous- or derived-token sockets are not fenced. The `srt-sandbox` account is machine-wide. Persistent root grants are readable by any sandboxed session on the machine.
- Driving `srt-win exec` directly couples DSH to srt-win's command-line interface as well as its library API; an upstream per-call roots API would remove that coupling.
