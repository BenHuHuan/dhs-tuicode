# Agent Note: Built E2E Default and Windows Source PTY Deadline

Status: implemented

[English](2026-08-14-built-e2e-default-and-windows-source-pty-deadline.md) | 中文

## Problem

真实 API e2e 配置允许启动 mode 未设置，但其面向消费者的 CI lane 会构建 host 产物并选择 `DSH_EXAMPLE_MODE=lib`。在 Windows 上，显式 source-plane TUI smoke 会通过 `tsx` 加载并转换完整工作区；其冷 ConPTY 启动会在原先 25 秒 PTY 截止时间之后才到达输入提示符，因此应用能够渲染之前测试已超时。

## Decision

仅当进程环境和 `.env` 都未提供 mode 时，`vitest.e2e.config.ts` 才提供 `DSH_EXAMPLE_MODE=lib`。因此 `pnpm run test:e2e` 会在普通 Node 下运行构建后的 `lib` bin，而 `DSH_EXAMPLE_MODE=src` 仍是显式的零构建诊断 mode。e2e 配置外的调用方继续使用共享启动解析器的 source 默认值。Windows source-plane TUI smoke 的内部 PTY 期限为 90 秒、每项 Vitest 期限为 105 秒；产物路径仍分别为 60 秒和 75 秒。

## Verification

无密钥 `pnpm run test:e2e` 运行构建后的产物；聚焦的显式 source MCP 和 subagent 目录 PTY smoke 在 Windows 上到达标记并干净退出。

## Alternatives considered

**让每个 loader-smoke 调用方默认使用 `lib`。** 共享解析器还服务于零构建开发诊断，因此改变其默认值会移除 e2e 验收外有意保留的 source-plane 路径。

**保留 25 秒 source PTY 截止时间。** 经测量，Windows 冷启动超过该期限但仍会完成正常终端初始化，因此它会把有效 source 启动变为误失败。

**将延迟视为 Cordis reload 循环。** 采样进程在启动期间的时间花在 `tsx` 模块与文件系统解析上，且 TUI 无需 reload 干预即可到达提示符。

## Consequences

标准 e2e 命令需要最新 host 构建产物，并与已安装消费者的执行模型一致。source-plane TUI 诊断仍可通过 opt-in 使用，并会报告实际缺少的标记而非 Windows 冷启动的计时假象。更长的 source 期限只会延长显式选择的 source e2e 运行。
