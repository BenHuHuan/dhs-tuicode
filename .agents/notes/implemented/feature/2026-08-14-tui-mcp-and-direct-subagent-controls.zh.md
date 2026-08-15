# Agent Note: 终端 MCP 与直接子 agent 控制面

Status: implemented

[English](2026-08-14-tui-mcp-and-direct-subagent-controls.md) | 中文

## Problem

终端 TUI 已能组合 MCP client 和持久化的可继续子 agent，但人类没有聚焦的终端视图来查看两种生命周期。直接读取 MCP 原始 Loader 配置会有暴露 endpoint 和凭证的风险。把完整子 agent 树作为人类控制目标，也会绕过持久 continuation 操作所强制的直接父级权限。

## Decision

[`McpConnectionRegistry`](../../../../packages/mcp/mcp-client/src/registry.ts) 是由 TUI profile 在用户配置的 MCP client 之前挂载的可选、进程本地投影。存活 client 只登记其配置的服务器名称、传输方式、生命周期状态、重连尝试次数和公开工具名称。注册表绝不接收 endpoint URL、命令、环境变量值、请求头或失败文本。client dispose 后，连接清理完成才会移除其记录。专用的 `registry` 包导出会构建为 host 产物，因此纯 Node Loader profile 无需源代码 TypeScript loader 也能解析它。

源代码启动会把 TUI 与 MCP registry 的包 specifier 直接映射到各自的 `src` 入口，因此 `tsx` Loader 运行不会把 TUI 源代码与已编译的包副本混用。

`/mcp` 只读取该投影。它列出服务器、通过 `/mcp <server>` 收窄显示，并把 `/mcp reload` 委托给既有的 Loader 刷新。此命令不编辑配置、不泄露私有连接数据，也不创建模型可见消息。

`/agents` 使用[可继续子 agent 会话](2026-07-28-continuable-subagent-conversations.md)所定义的既有持久化目录和 continuation API。裸 `/agents` 渲染完整的持久化后代树，但不加载子 agent 的提示词或 transcript。`/agents start <task>` 通过本地 `spawn` provider，以 TUI 已选择的 provider/model 路由创建可继续子 agent。`/agents send <id> <message>` 和 `/agents stop <id>` 只解析直接子项；发送使用 `user` 消息来源，停止使用直接的人类父级权限。停止命令报告已被接受的取消请求，而不是立即完成。这补充而不扩大[停止全部后台子 agent](2026-08-14-tui-stop-background-subagents.md)中的受保护会话级快捷键。

## Verification

注册表和重连测试固定脱敏、状态转换、过期 dispose 与记录移除。已挂载的 TUI 命令测试和终端快照固定 `/mcp` 与 `/agents` 输出、用法失败、直接子项检查、带用户归属的 follow-up 和停止权限。真实 MCP fixture 卸载证明记录会随 client fiber 消失。已构建 lib 的无密钥 TUI PTY 冒烟测试通过 Loader 启动随附 profile，并抵达两个目录。

## Alternatives considered

**渲染原始 MCP 配置。** 未采用，因为 URL、命令、环境、请求头和失败数据不属于终端目录，并可能含有凭证或部署内部信息。

**让 `/agents` 递归控制每个列出的后代。** 未采用，因为持久化列出提供的是可见性而非权限。直接子项仍负责自己的后代，递归的人类控制可能跨越存活的协调边界。

**只把 `/tasks` 作为子 agent UI。** 未采用，因为它表示 job，而可继续子 agent 可以持久化且空闲、没有 job 记录；它也不能启动或恢复直接对话。

**用这个命令实现 agent teams。** 未采用，因为共享任务板、点对点消息、领导者和多会话渲染引入了不同的产品和权限模型。直接子项操作仍是一个小型终端控制面。

## Consequences

随附终端 profile 提供安全、可无密钥检查的 MCP 和多 agent 基础能力，不依赖桌面端或 Web。MCP 配置和按服务器恢复仍由 Loader 持有。子 agent 视图有意不是 agent-team dashboard，并且直接人类命令不能控制孙级 agent；用户仍可使用既有的模型侧委派工具完成更深层的协调。
