# Agent Note: 采用 sandbox-runtime 作为 DSH 沙箱后端

Status: proposed

[English](2026-11-07-sandbox-runtime-backend.md) | 中文

## Problem

`ctx.sandbox` seam 只管控文件写入。受限进程可以读取 `~/.ssh`、`~/.dsh/.credentials.yaml` 等凭据存储，可以访问任意主机，还可以在可写根目录内写入之后会在沙箱外运行的文件，例如 `.git/hooks`。Tidebloom 模块扩展无需审批即可运行模型编写的代码，因此其防护需要在 Linux、macOS 和 Windows 上提供读取拒绝、受保护写入路径和网络允许列表。自行实现过滤代理、bubblewrap 挂载配置和 Windows 专用主体模型，会增加大量需要自行维护的安全代码。

## Proposal

按照 `TIDEBLOOM_SANDBOX_V2_PLAN.md`，采用 `@anthropic-ai/sandbox-runtime`（srt，Apache-2.0，精确锁定版本；spike 时为 0.0.81）作为 `dsh-sandbox-local` 的一个 rung：

- seam 的策略新增 `denyRead`、`denyWrite` 和 `network.allowedDomains`；provider 报告自身能强制执行的字段，`ConfinedArgv` 新增 `env` 和 `release()`。
- **Linux 和 macOS：** 每个进程用空的网络允许列表初始化一次 `SandboxManager`。每次调用向 `wrapWithSandboxArgv` 传入 `customConfig.filesystem`（`allowWrite`、`denyRead`、`denyWrite`），并以 128 位随机 `commandId` 通过 `registerCommandNetworkLists` 注册其主机。该 rung 先服务请求这些能力的策略，验证后成为默认 rung，取代 bwrap 和 Seatbelt 配置代码。
- **Windows：** 使用同一包中的 srt-win，需先执行一次需要提权的 `windows-install`。由于 `SandboxManager` 只在 `initialize()` 时接受可写根目录，每次调用的可写根目录改用 `srt-win exec --write-root`，这些根目录预先通过 `acl grant --persistent` 授权一次。代理设置来自 `SandboxManager` 的网络层。
- DSH 的受保护路径和凭据列表在每次调用的策略中显式传入。

### Spike 结果

Spike 在 WSL Ubuntu（bubblewrap 0.11.1、socat、ripgrep、Node 24.21.0）以及以 `--skip-profile-grant` 安装 srt-win 的 Windows 11（Node 24.19.0）上运行 srt 0.0.81。

| 探测 | Linux | Windows |
|---|---|---|
| 对机密文件 `denyRead` | 拒绝（路径被隐藏） | 拒绝（`EPERM`） |
| 在可写根目录内写入 | 允许 | 允许 |
| 在可写根目录外写入 | 拒绝（`EROFS`） | 拒绝（`EPERM`） |
| 对已存在的 `.git/hooks`、`.git/config` 显式 `denyWrite` | 拒绝 | 拒绝 |
| 对不存在的 `AGENTS.md`、`.bashrc` 显式 `denyWrite` | 拒绝；占位文件由 `reset()` 移除 | 拒绝；`reset()` 后**主机上仍留有**空的 `AGENTS.md` |
| srt 内置的强制拒绝列表 | 只相对主机进程的 cwd 生效 | 未测试 |
| 允许的主机 / 未列出的主机 | 200 / 被拒绝并附 `<sandbox_violations>` 原因 | 200 / 以相同原因被拒绝 |
| 不同主机列表的并发调用 | 互不串用 | 互不串用 |
| 经代理的 Node `fetch` | 需要 `NODE_USE_ENV_PROXY=1`（srt 只在 Windows 上设置） | 可用 |
| 运行时清空 `process.env` 后的 Node `fetch` | 可用 | **失败**（`ENOTFOUND`） |
| `data:` URL 模块导入 | — | 可用 |
| 通过 `SandboxManager` 按调用设置 `allowWrite` | 可用 | **抛出错误**（只支持会话级） |
| `srt-win exec --write-root A` 写入根目录 B | — | 拒绝；不带根目录的启动也无法写入 |
| 启动开销 | 约 30 ms | 约 230 ms |

设计影响：

1. srt 相对主机进程的 `process.cwd()` 解析其内置强制拒绝列表。一个 DSH 进程服务多个工作区，因此 DSH 必须在每次调用的 `denyWrite` 中传入受保护路径，而不能依赖该列表。
2. 在 Linux 上，consumer 为 Node 子进程添加 `NODE_USE_ENV_PROXY=1`。在 Windows 上，PTC runtime 清空程序环境时必须保留代理变量。
3. 在 Windows 上，对不存在的路径设置 `denyWrite` 会创建该路径。DSH 在那里只拒绝已存在的路径；受保护文件不存在时拒绝其父目录，或者对不存在本身没有意义的路径接受该空文件。
4. `cleanupAfterCommand()` 作用于整个进程。DSH 通过 rung 中的引用计数，只在没有受限命令运行时调用它。

## Alternatives considered

**扩展现有的 bwrap、Landlock、Seatbelt 和 Windows-ACL rung。** 这样所有代码都由自己维护，但需要编写并加固过滤 HTTP/SOCKS 代理、解析地址检查、不存在拒绝路径的挂载点处理，以及带网络阻断的 Windows 主体。srt 已经具备这些能力及其已知限制记录。

**按照 srt 的设计构建 DSH 自有的 Windows 主体后端。** 这是 srt-win 未通过 spike 时的备选方案。它通过了：`--write-root` 提供按调用的写入隔离，读取拒绝、写入拒绝和网络拒绝均可用。重新实现账户、网络过滤器和 ACE 引用计数会与 srt-win 重复。

**Windows AppContainer。** 它默认拒绝网络且无需安装，但回环访问主机代理需要管理员豁免，文件读取还需要在每个可读目录树上授予容器 SID。

**在 Windows 上只使用 `SandboxManager`。** 它只在 `initialize()` 时支持可写根目录。不同会话的并发调用会共享所有根目录的并集，从而破坏按调用的写入隔离。

## Acceptance criteria

- 在 Linux、macOS（CI）和安装了 srt-win 的 Windows 上，带能力策略的受限调用无法读取 `denyRead` 路径、写入 `denyWrite` 路径、写入自身根目录之外的位置或访问未列出的主机。允许的主机可用，并发调用各自保持自己的根目录和主机。
- 缺少 srt 依赖的主机，或未执行安装的 Windows 主机，会以 `SandboxUnsupportedPolicyError` 和安装提示拒绝能力策略；不带能力字段的策略行为不变。
- 除 srt-win 已记录的持久根目录授权外，为某次调用创建的占位文件或授权不会在调用结束后残留。

## Risks

- srt 是 beta 研究预览版，其配置语义会在版本间变化。精确锁定版本和升级检查清单可以控制这一风险。
- Windows：基于 Schannel 的客户端（`curl.exe`、PowerShell web cmdlet、.NET `HttpClient`）在写入受限令牌下无法使用 TLS。经由 `Dnscache` 的 DNS 查询以及匿名或派生令牌的 socket 不受网络阻断。`srt-sandbox` 账户作用于整台机器。持久根目录授权可被机器上任何沙箱会话读取。
- 直接调用 `srt-win exec` 会让 DSH 除了依赖 srt-win 的库 API 外，还依赖其命令行接口；上游若提供按调用设置根目录的 API，即可消除这一耦合。
