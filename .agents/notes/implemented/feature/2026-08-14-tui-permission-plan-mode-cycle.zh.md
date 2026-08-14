# Agent Note: TUI 权限与 Plan 模式循环

Status: implemented

[English](2026-08-14-tui-permission-plan-mode-cycle.md) | 中文

## 问题

恢复后的 TUI 已公开现有 `/permission` 与 `/plan` 命令，但没有统一键盘控制，也没有始终可见的有效模式，因此主编码表层仍落后于目标交互。Claude Code 当前的[交互模式](https://code.claude.com/docs/en/interactive-mode)与[键绑定](https://code.claude.com/docs/en/keybindings)参考把 Shift+Tab 分配给模式循环，将 Alt+M 记录为 Windows 回退，并在状态栏保持当前模式。DeepSeek Harness 已有彼此独立且持久的权限 preset 与 Plan 服务；另造一份通用 mode 存储会重复权威状态，还可能把软性规划引导与强制沙箱策略耦合。

## 决策

TUI 在可选 `ctx.permissionPresets` 与 `ctx.planMode` 之上新增一个小型 `TuiModeController` 投影。它计算统一的终端视图，但每次转换都通过状态持有方的服务 setter 完成。权限仍使用已配置的 preset 词汇，并通过 `permission/preset`、`sandbox/mode` 与 `approval/policy` 持久化；Plan 仍是通过 `plan/mode` 持久化的独立 per-agent 状态。进入 Plan 不会改写权限；离开 Plan 后会显露或选择 preset 服务已经持有的权限目标。

在主编辑器中，Shift+Tab 与 Alt+M 会选择下一个已配置安全权限 preset，随后进入 Plan。派生的 `custom` 状态可见但不可选择。仅挂载 plan mode 时，控制器提供本地 `Normal` 视图；两个可选服务均未挂载时不提供 mode，按键会报告不可用。轮次中的待生效 Plan 意图会立即显示并标记 pending，但服务语义仍把持久提交推迟到下一个被接受的 pre-step。

权限 preset 是否危险取决于其解析后沙箱是否为 `danger-full-access`，与配置名称无关。危险目标不会进入普通循环。若某个危险目标已经生效，控制器会在本次 TUI 挂载的剩余期间解锁它，并把它放在 Plan 之后；这样，显式选择 full access 的用户可以离开后再返回，而惯用快捷键不会成为提权路径。

TUI 注册 `${mode}` 提示词值，并在默认右侧提示词模板中把它放在 `${queued}` 前。安全权限、Plan、待生效转换和 full access 使用不同紧凑标记；`/status` 包含同一有效目标，`/help` 记录这些按键，已有 session-event 流负责触发重绘。不会新增组合事件、Settings namespace 或模型侧提示词贡献。

## 验证

纯控制器测试覆盖安全顺序、危险项排除与后续解锁、custom 状态恢复、待生效进入与退出、仅 Plan 回退，以及服务缺失。TUI 集成测试挂载真实审批、权限 preset 与 Plan 服务，验证键盘转换、规范事件序列、`/status` 和开放轮次中的 pending 渲染。

一项 keyless 录制终端场景会渲染初始权限、Plan、安全回绕、显式 full access 与解锁后的返回循环，同时断言精确的 `plan/mode` 和 `permission/preset` 序列。第二项 keyless PTY smoke 通过 Windows ConPTY 或 POSIX PTY 启动构建后的发布 profile，发送 Shift+Tab 与 Alt+M，在 `/status` 中观察 Plan 和两个安全 preset，验证持久事件不含 `danger-full-access`，并通过普通终端恢复路径退出。

## 考虑过的替代方案

**新增通用 mode 服务与事件。** 未采用，因为权限 preset 与 Plan 的强制执行、时序、持久化、提示词和评审语义都不同。终端投影可以组合二者，无需成为另一个事实来源。

**把 Harness 状态重命名为 Claude Code 的 mode 词汇。** 未采用，因为 `acceptEdits`、`dontAsk` 和 `delegate` 等别名不能精确描述已配置的沙箱加审批组合或 Plan 的软引导。快捷键与状态交互保持兼容；状态词汇则诚实对应已挂载服务。

**让 full access 始终加入循环。** 未采用，因为意外按键绝不能移除限制与审批边界。规范权限表层仍可显式选择它；只有已经生效的危险 preset 才能经循环到达。

**让 Plan 隐含 read-only 权限。** 未采用，因为 Plan 有意保持软性协作引导，而沙箱与审批是独立强制机制。在一个 UI 内耦合二者会产生不属于任一服务的隐藏策略变化。

**只保留命令控制。** 未采用，因为命令对精确选择与自动化仍有用，但无法提供交互式终端目标所需的低摩擦循环与持久状态。

## 后果

构建后的 TUI 现在具备 Claude Code 风格的模式循环与可见状态，同时保留 DeepSeek Harness 现有服务所有权。键盘循环无法新授予 full access；轮次中的 Plan 请求会诚实显示其延期边界；custom 或只组合部分服务的部署也会退化，而不会伪造状态。

控制器的危险项解锁记忆有意只存在于终端本地：已经显式生效的 full-access 状态可以加入当前挂载的循环，但不会新增持久解锁事件。自定义右侧提示词模板可以省略 `${mode}`；`/status` 仍是显式诊断。Full access 目前仍通过通用 `/permission danger-full-access` 命令进入，而非 TUI 专用确认对话框；不受支持的 Claude Code mode 名称的精确对齐仍是未来产品工作。
