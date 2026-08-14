# Agent Note：TUI 上下文用量可视化

Status: implemented

[English](2026-08-14-tui-context-usage.md) | 中文

## 问题

恢复后的 TUI 会在紧凑 footer 中显示聚合上下文压力，并在 `/status` 内重复该数据，但没有专门回答所选模型窗口由什么占据。Claude Code 在其[命令参考](https://code.claude.com/docs/en/commands)中把 `/context [all]` 定义为长会话诊断命令。DeepSeek Harness 已经持有全部必要数据：可感知 replay 的当前请求压力、所选路由容量、持久三段组成 projection，以及按位置排列且已应用 replacement 的 surface 节点。在终端内重新组装或重新计价会制造第二套记账词汇，并可能让 compaction 对视图不可见。

## 决策

把 `/context [all]` 注册为 agent 作用域 TUI 命令，使其在轮次运行期间仍可立即执行。每次调用只向终端追加一张时间点卡片，不增加模型可见消息。未知参数以 `Usage: /context [all]` 失败。

主要占用行使用 `ctx.tokenMeter.measure(session).totalTokens` 除以当前所选模型解析出的上下文窗口。它会标记缺失容量，而非虚构分母；会说明 meter 是由提供方 usage 锚定还是估算所得；会报告精确的超容量压力，并在占用达到 80% 时建议 `/compact`。这与 footer 和 `/status` 保持相同的实时所选路由语义；它是建议性显示，不参与 compaction 决策。

挂载 `ctx.sessionProjections` 后，卡片读取其 `contextBreakdown` 值，渲染由 system prompt、工具 schema 与对话构成的分段 meter，并显示三行启发式 token 数据。固定启发式词汇与提供方锚定压力保持明确分离，不会为了凑成总数而缩放。没有 projection registry 的最小嵌入仍保留聚合占用，并把组成标为不可用。该实现复用 [Composer 上下文 meter 与启发式组成拆分](2026-08-05-composer-context-meter-breakdown.md)所确立的数据归属与三分类分辨率。

`/context all` 还会遍历 token meter 当前的有序节点。每个节点通过序列号连接到其持久事件，并标记为用户提示词、assistant 响应、注入上下文来源或关联后的工具结果。由于这些节点已经是应用 replacement 后的模型 surface，被压缩或裁剪的范围不会重新出现。来源标签会经过终端控制字符清理。普通形式省略逐消息行，避免长会话淹没 scrollback。

## 验证

挂载 channel 测试固定了提供方锚定占用、容量未知与 projection 缺失时的降级、分段组成数据、展开后的用户与 assistant 行、普通形式折叠，以及非法参数诊断。确定性的 headless 快照在仓库主题安全检查下固定完整彩色卡片。

built-lib keyless PTY 对话会启动已交付 profile，完成真实脚本模型轮次，运行 `/context all`，并要求组装后的终端在 `/status` 与干净退出前显示其保守估算压力来源、工具与对话组成，以及展开后的模型可见条目。fixture 故意提供的极小 provider usage 低于组装后的启发式锚点，因此 token-meter 会正确拒绝这个不安全的 provider 基线；挂载 channel 的测试则单独固定已接受 provider 锚点的路径。常规 TUI、文档、类型、lint、构建和 keyless e2e 门禁覆盖命令发现与产物行为。

## 考虑过的替代方案

**在 TUI 中重新计算 system 与工具 schema token。** 拒绝，因为 token-meter 已经持有固定估算器，其 projection 能跨日志分页、resume 与 compaction 存续。第二个估算器会发生漂移。

**把组成行缩放到提供方锚定总数。** 拒绝，因为提供方压力和固定启发式回答不同问题。缩放会虚构分类精度，并让未变化的组成随提供方样本移动。

**始终打印每个 surface 节点。** 拒绝，因为旧会话可能包含数百条模型可见消息。有界默认形式适合原生 scrollback；显式 `all` 才选择完整列表。

**把规则、skill、MCP server 与 memory 拆成独立行。** 在该层拒绝，因为这些贡献在请求 header 中已经组装进 system 文本或工具 schema。现有三类是最细的权威分辨率。

## 后果

终端用户现在无需离开会话或发送额外模型轮次，即可检查当前请求压力与真实的上下文组成。由于视图消费 token-meter 持有的数据而非 transcript 行，它能在 surface replacement 与 compaction 后保持正确。

容量解析仍是异步且路由建议性的，因此元数据到达前调用命令可能显示 `capacity unknown`；之后再次调用会反映已解析路由。提供方锚定总数与启发式组件数据按设计可能明显不同。在请求组装公开更细的权威分类前，TUI 仍无法提供更细拆分。
