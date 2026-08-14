# Agent Note：TUI 一键停止所有后台子代理

Status: implemented

[English](2026-08-14-tui-stop-background-subagents.md) | 中文

## 问题

Claude Code 把 Ctrl+X Ctrl+K 记录为会话级后台 agent 紧急停止键，并在其[按键绑定参考](https://code.claude.com/docs/en/keybindings)中将动作标为 `chat:killAgents`；[交互模式参考](https://code.claude.com/docs/en/interactive-mode)要求在三秒内按下两次该组合键。恢复后的 DeepSeek Harness TUI 已能取消前台轮次与 Shell，却没有无需逐个查找 id 即可停止后台委派的等价能力。

组装运行时存在两套独立持有的后台子代理生命周期。一次性委派在 `ctx.jobs` 中表现为 `kind: subagent`；可继续子项留在 `ctx.subagents` 中，空闲驻留时也可能没有 job 记录。只实现其中一个 registry，会让快捷键在某一种已交付 profile 中悄然残缺。

## 决策

同时识别拆分的终端 chunk（先 `Ctrl+X`、再 `Ctrl+K`）与合并的旧式 chunk，且不吞掉无关后继键。第一次完整组合键只进入一个终端本地的三秒确认态；窗口内第二次才执行停止操作。任何普通编辑器输入都会解除确认，同时仍进入草稿。TUI dispose 会清理 timer，并中止尚未完成的发现过程。

确认后的操作以当前 agent 作为精确权限，覆盖两套生命周期：

- 从 `ctx.jobs` 中只选择 `kind: subagent`、`status: running` 且 `ownerSession === agent.id` 的记录，再调用 registry 的授权 `kill` 操作。
- 从 `ctx.subagents.listChildren(agent.id)` 中只选择直接、`continuable`、报告为活跃且实时 Agent 状态仍为 `running` 的子项，再以精确 ancestor 权限调用 `interrupt`。

异步发现结束后还会再次检查实时状态，因此已经空闲或刚刚结算的 continuation 不会被计为已取消。Bash job、外部或无归属 job、已完成的一次性工作、诊断行、one-shot 子项 projection、更深层后代和驻留但空闲的 continuation 都会被有意排除。后代仍由其直接父项负责；顶层人工控制停止的是当前 chat 直接持有的工作，不会凭空制造遍历任意树的权限。

两个可选服务句柄都通过 Cordis 的安全 `ctx.get()` 查找取得。TUI 不会在探测后直接读取 `ctx.jobs` 或 `ctx.subagents`：这些受保护属性要求硬注入，即便可选服务实际存在，也会在组装 profile 中失败。

发现与取消都按来源和目标执行 best effort。单个故障会被保留并报告，但不会遮蔽兄弟项。已接受请求、竞态中已经结算的 job、没有活跃目标、可选服务不可用和部分失败都有明确的终端反馈。该操作不追加会话事件、不改变提示词，也不添加模型可见内容。

## 验证

纯测试固定拆分与合并组合键解码、无关按键透传、精确 job 归属、生命周期与活跃状态过滤、ancestor 权限、竞态结算、逐目标故障隔离、发现故障隔离，以及预先取消的发现。挂载式 TUI 测试固定双重确认窗口、普通输入解除确认、草稿保留、服务不可用反馈和已渲染结果通知。

确定性的 headless 快照固定已进入确认态的提示行。built-lib keyless PTY 对话会在完整组装的已交付 profile 上触发两次组合键，观察没有运行中子代理的结果，并继续执行 `/context all`、`/status` 和干净退出。类型、lint、文档、包构建、单测与组装 e2e 门禁覆盖可选服务边界。

## 考虑过的替代方案

**停止所有运行中 job。** 拒绝，因为 Ctrl+X Ctrl+K 是后台 agent 控制，不是 Shell job 总开关。用户持有的 bash 工作不能成为附带损失。

**递归中断每个后代。** 拒绝，因为归属与 ancestor 权限是明确的运行时不变量。当前 chat 持有的是直接子项；递归发现可能重复取消，或跨越子项自己的协调边界。

**把每个 continuable 子项都视为运行中。** 拒绝，因为 continuation 会有意跨轮次驻留。停止空闲驻留子项会破坏可恢复状态，却声称自己停止了活跃工作。

**无需确认，只按一次组合键。** 拒绝，因为官方交互带有保护，意外取消可能丢弃有价值的并行工作。

## 后果

终端用户现在拥有一个可发现、有保护的安全控制，可覆盖两种已交付委派模式，并可在主轮次活跃时使用。最小嵌入会明确降级，损坏的提供方也无法阻止健康兄弟项被取消。

该操作是时间点上的 best-effort 停止，而不是持久禁令：生产方可能在发现结束后创建新后台工作，已经结算的目标也可能赢得竞态。快捷键不会删除持久子记录或空闲 continuation；生命周期持有方继续负责清理与后续恢复语义。
