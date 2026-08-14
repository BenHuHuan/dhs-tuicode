# Agent Note：TUI transcript 步骤顺序

Status: implemented

[English](2026-08-14-tui-transcript-step-order.md) | 中文

## 问题

Agent loop 会先用 `step/start` 持久化开启模型步骤，随后才追加该步骤已接受的用户消息与所有注入上下文。恢复后的 TUI 把 `step/start` 直接当成创建 `Assistant` transcript 分组的许可，因此实时输出和回放都可能先渲染 `Assistant`，再渲染 `You` 或上下文；没有产生 assistant 正文的步骤还会留下空的 `Assistant`／`Model wait` 行。持久事件顺序本身有效，错误出在展示投影。

## 决策

`step/start` 现在只更新计时与重试状态，不创建 transcript 组件。首个 `assistant/chunk` 会先惰性创建流式 assistant 步骤，再应用增量。已提交的 `assistant/message` 仍是第二个惰性创建边界；只有现有完成路径需要时，`step/end` 才会创建并结束一个此前缺失的步骤。

TUI 仍从持久事件派生模型等待、reasoning、响应、工具、重试与完成计时。推迟可视分组既不改变日志，也不改变模型历史；它只让渲染出的对话符合语义归属：先显示已接受的用户与上下文消息，再显示它们所触发的 assistant 输出。只有 start、从未形成可见正文的步骤不会留下幽灵 transcript 行。

Transcript 重建与实时渲染共用同一个事件处理器，因此恢复会话以及通过 `/details reasoning off` 等显示设置重建后，规则完全相同。没有新增只供回放使用的排序逻辑或事件缓冲区。

## 验证

一项 TUI 集成测试按生产顺序追加 `step/start`、已接受的用户消息和 assistant chunk，随后强制完整重绘并断言 `You` 位于 `Assistant` 之前。测试再通过 `/details` 触发 transcript 重建并重复断言，以同一 fixture 覆盖实时与回放投影。

包内 25 个录制终端场景已在 built-lib 模式刷新并完成重放。流式场景现在先显示 `You`、后显示 `Assistant`；菜单与空闲表层不再包含虚构的空 assistant 分组。发布 profile 的模式控制快照与聚焦 built-profile PTY smoke 仍保持通过。

## 考虑过的替代方案

**重排核心会话事件。** 未采用，因为追加顺序是持久化与计时消费者使用的 agent-loop 生命周期契约；展示层应自行适配，而不应改写持久语义。

**把用户与上下文事件缓冲到 assistant chunk 出现。** 未采用，因为已接受输入应立即可见，而且工具或失败路径可能没有 assistant 文本。需要推迟的只有过早创建的 assistant 容器。

**为每个已开启步骤渲染空 assistant 行。** 未采用，因为这会错误暗示 assistant 已产生 transcript 内容，并使菜单、问题和被中断的 start 看起来包含模型输出。

**为实时与回放分别排序。** 未采用，因为重复投影容易漂移。统一使用一个追加来源事件处理器，才能让恢复、重绘与活动会话渲染保持一致。

## 后果

Transcript 现在会在实时轮次、恢复会话与完整重建后都保持对话顺序。空的已开启步骤不再占用终端行。阶段计时仍由事件派生，因此等待与重试诊断保留原有边界，只是 `Assistant` 标题会等到真正存在 assistant 内容时才创建。

这是一项展示不变量，而不是新的事件保证。需要生命周期顺序的消费者仍必须按写入顺序读取持久序列；只有 TUI 会把该序列映射为按角色分组的对话顺序。
