# Agent Note：Allin 风格多智能体工具

Status: implemented

[English](2026-08-16-allin-style-multi-agent-tool.md) | 中文

## 问题

一个大型目标通常跨越多个独立工作领域，但把它们全部放进同一个会话会让单个上下文不断增长、让无关工作彼此污染，也会让一个被阻塞的车道拖住全局。subagent seam 已经提供一次性与可延续子级，workflow seam 已经能运行由模型编写的扇出脚本，但两者都没有内建 All in Luna 的形态：由 pro 协调者编译目标，多个 flash 车道并行执行依赖就绪的顶层任务，再由同一个 pro 协调者汇总车道报告。

## 决策

新增 `@deepseek-ai/dsh-tool-allin`，位于 `packages/workflow/` 下，作为固定策略的消费方，形态与 `@deepseek-ai/dsh-tool-ralph` 相同。它注册 `allin({ goal, maxTasks? })`，拥有一份固定工作流脚本，只依赖 `ctx.tools`、`ctx.systemPrompt`、`ctx.workflowEngine` 与 `ctx.subagents`。随产品发布的 `dsh-base` bundle 以 `orchestratorModel: deepseek-v4-pro`、`workerModel: deepseek-v4-flash`、`maxTasks: 16`、`maxParallelWorkers: 8` 启用它。

脚本包含三个阶段。**Plan** 把一个分解提示词交给 pro 子级，并要求返回 `{ title, tasks }`；每个任务都带有唯一的规范化 id、自包含的 prompt 与显式依赖，重复 id、未知依赖、自依赖和循环都会使工作流失败。**Parallel task lanes** 把每个依赖就绪的任务作为全新 flash 子级运行。一个依赖波次最多通过 `parallel()` 启动 `maxParallelWorkers` 个车道，下一波等待上一波结算，因此无关车道不会排在被阻塞或失败的车道之后。每个车道返回结构化报告，包含 `done | blocked`、摘要、工件、证据、交接与阻塞项。未返回结构化报告的子级成为 `failed` 结果，且不会阻塞其他就绪车道。**Synthesis** 把每个车道结果交给 pro 子级，并要求返回 `{ complete | blocked | partial, summary, deliverables, remaining, blocker }`；脚本结合合成结果与车道结果确定终态，因此合成结果不能在存在失败车道时宣称完成。

模型只能提供目标和可选的任务上限。提供方路由、两种模型、并发度、schema 与校验都归部署侧所有。调用方 agent 是每个子级的父级，以保留 cwd 和谱系；工具等待整个运行完成，`exec.signal` 会取消工作流，每条路径都会等待 `run.dispose()`。规范结果为 `{ runId, agentsStarted, result }`；父级渲染器会标明完成由协调者报告，而非独立认证。计划与合成子级失败都是错误，格式错误的计划、报告或合成会使工作流失败，而不会被截断或接受。

## 验证

单元测试覆盖请求路由、模型与并发参数、complete/blocked/partial 结果、计划与合成失败包络、结果截断、提供方能力拒绝和直接配置校验。两个无密钥的真实栈集成测试通过 worker 线程引擎、spawn 提供方、结构化输出运行时和 agent loop 驱动固定脚本：一个证明 pro/flash/pro 模型顺序与彼此独立且无种子的子级，另一个证明两个彼此独立的 flash 车道在同一并行波次中运行。

## 曾考虑的替代方案

- **扩展通用 workflow 工具**：否决。固定的报告协议、模型路由与停止策略应当成为一个可评审的消费方，而不是扩宽由模型编写脚本的 API。
- **在 agent loop 或 goal 驱动中新增多智能体循环**：否决。编排应是在既有 seam 之上的可移除策略，而不是改动回合执行或目标状态。
- **移植 Python 版 All in Luna 运行时**：否决。DSH 已经拥有工作流执行、取消、静默与子级生命周期；原生固定脚本可以复用它们，而不需要外部运行时或中继协议。
- **把车道作为可延续后台子级运行**：否决。前台工作流能为父级工具调用提供一份有界的终态结果，并为整个运行提供取消静默。

## 后果

- 大型目标分解路径以一个插件的形式存在，包含 pro 计划与汇总，以及多个并发的 flash 车道。
- 车道报告有界（`maxPlanChars`、`maxReportChars`、`maxResultChars`），工作流引擎的子级总数上限仍是失控循环的后备闸门。
- 依赖按波次调度，因此一个被阻塞的车道只会推迟它的依赖方。
- 同会话目标领域、Ralph Round 与通用 workflow 工具仍然是彼此独立的产品。

## 已知限制与暂缓事项

- 完成与阻塞由协调者或 worker 报告；没有独立评估器认证结果。
- 运行只支持前台且进程内；持久任务状态、恢复、重试与跨进程恢复暂缓处理。
- 车道共享一个工作区与有界报告；没有工件存储、冲突管理器或晋升协议。
- 任务图是扁平的；车道可以使用自己的工具与子级，但不能递归扩展成新的顶层图。
- 只有任务数量与并发度受到上限约束；token、费用与耗时预算暂缓处理。
