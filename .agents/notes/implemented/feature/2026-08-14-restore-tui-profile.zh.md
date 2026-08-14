# Agent Note: 恢复已交付的 TUI profile

Status: implemented

[English](2026-08-14-restore-tui-profile.md) | 中文

## 问题

2026-08-04 移除没有任何已交付组合的 TUI 包在当时是正确的，但产品方向已经变化：DeepSeek Harness 现在需要一个具名、类似 Claude Code 的交互式终端入口。仅从历史中恢复代码包并不能形成真实产品。其 API 已经漂移，旧的启动器假设不再适配 profile bundle，而源码模式的 `tsx` 解析会掩盖一些问题；这些问题会在官方 CI 使用的 CommonJS 构建产物由普通 Node 加载时暴露。在 Windows 上，ConPTY 输入模式、原生 PowerShell 执行和无特权 symlink 行为还会带来平台专属的验收失败。

## 决策

恢复 `@deepseek-ai/dsh-tui`，让它成为已交付 `tui` profile 的交互式前端，并提供 `dsh tui` profile 别名。这是一个产品组合，而不是未挂载的可复用包：profile 会把 agent、持久化、工具、模型适配器、交互服务和 TUI 包组合在一起。该包的 README 持有渲染、命令、扩展 overlay、恢复会话和终端安全的详细契约。

Profile 本地的 `tui-runner` 会等待 Loader 树完成结算，通过 `AgentRegistry` 创建或恢复一个交互式 agent，将其发布为 `ctx.tuiAgent`，并在每次提交完成后发出 `tui-agent/ready`。TUI channel 是实时模型选择引用的唯一所有者；runner 仅在创建 agent 时读取一次 `agentDefaultModel.currentSelection()`。初始结算失败时会报告错误、处置应用，并请求在处置后强制退出，避免残留进程句柄把启动失败变成静默挂起。恢复会话的 swap 会先提交成功，再处置旧 handle，因此失败的恢复不会破坏当前会话。

组装后的 keyless 验收以宿主库构建路径为准：`DSH_EXAMPLE_MODE=lib` 让 CLI 通过普通 Node 加载 `lib` 产物。Scripted LLM fixture 在安装到临时 profile 的 `node_modules` 前会由 esbuild 编译；Node 明确拒绝在该位置对 TypeScript 做 type stripping。另一个 late-failure fixture 会先启动 renderer 再拒绝，从而证明终端恢复，而不依赖兄弟插件的挂载时序。对于在获取终端前就失败的无效配置，契约则要求终端保持未触碰。

Windows 使用平台原生 PowerShell executor，并从可移植 transcript 断言中滤除仅 ConPTY 会产生的输入模式序列。需要目录别名的测试会创建 junction；测试主题明确是文件 symlink 的用例会在 Windows 跳过，因为普通 checkout 不具备 `SeCreateSymbolicLinkPrivilege`。Windows ACL runner 会收到已解析的 PowerShell 绝对可执行路径，因为受限 token 不能被假定能够通过调用方环境解析裸命令。工作区 catalog 扫描会容忍临时 lint 探针在 glob 枚举与文件检查之间消失；派生 lint-fix 探针使用显式有界超时，因此全量套件并发不会把 fixture 清理或 Windows 进程启动变成假失败。

本决策逆转了[移除 TUI 包](../simplification/2026-08-04-remove-tui-package.md)的决定。具名 profile、显式包边界、具体终端交互提供方以及组装后的生命周期与 transcript 验收，已经满足该记录提出的重新引入门槛。M4 建立了可靠基线，但并不声称已经具备 Claude Code 的每一项功能。

## 验证

Windows 上的完整单测套件通过：781 个文件通过、5 个按平台跳过，其中 13,071 个测试通过、75 个跳过。构建库模式的 keyless e2e 通过：28 个文件通过、33 个跳过，其中 134 个测试通过、88 个跳过。聚焦的 TUI PTY 套件中，23 个可运行用例全部通过，另有 2 个不适用于当前平台的用例跳过。它在无 API key 的前提下覆盖首次启动渲染、创建与恢复流程、个人 overlay、模型切换、命令、直接 Shell 执行、工具卡片、延迟失败后的终端恢复和启动失败时的 fail-loud 行为。

## 考虑过的替代方案

**继续只把 Web 作为交互式前端。** 不予采纳，因为当前产品目标明确要求一等的终端工作流，而且现有提供方无关的命令、问题、审批、呈现、会话和 PTY seam 可以支持它，无需把这些能力耦合到 Web。

**恢复代码包，但不实际交付。** 不予采纳，原因与移除记录拒绝该状态时相同：未挂载的前端没有组装后的生命周期来证明其公共表面可用。具名 `tui` profile 是部署和验收所有者。

**把源码模式 `tsx` 作为验收路径。** 不予采纳，因为官方 CI 和安装后的消费方会通过 Node 加载构建完成的 CommonJS 产物。源码模式可能把 workspace 包解析为不同模块图，也无法执行安装在 `node_modules` 下的 TypeScript fixture，因此源码测试为绿不能证明发布形态。

**让启动器持有交互式 agent 与所选模型。** 不予采纳，因为这会在启动器、runner 和 channel 之间复制前端状态，并使 overlay 替换能够丢失 identity 或 selection 字段。Runner 持有 agent 结算；TUI 持有会话本地的选择与呈现。

## 后果

DeepSeek Harness 再次在 macOS、Linux 和 Windows 上交付仅限 TTY 的交互式终端前端。管道与自动化必须使用 headless 或协议 profile。TUI 是可发布的 release member，其显式发布载荷包含 startup、runner、prompt、profile 补丁、运行时入口、invariant companion 与声明文件，不包含源码或声明映射。仓库再次承担 TUI 源码、快照、`pi-tui` 补丁、PTY harness、服务目录表面及其持续维护成本；由于现在有真实产品 profile 和跨平台组装测试消费这些能力，这项成本可以接受。

构建库行为是发布权威，源码模式行为只是开发便利，而不是 M4 门禁。Windows 的文件 symlink 语义没有在生产代码中被削弱；只有依赖特权的测试会在该平台排除，而兼容 junction 的目录 containment 行为仍有覆盖。后续 Claude Code 对齐工作会建立在这一全绿基线上，并必须增加各自的产品契约与验收覆盖。
