# Agent Note: TUI 实时用户设置

Status: implemented

[English](2026-08-14-tui-live-user-settings.md) | 中文

## 问题

TUI 原先只通过 Cordis 条目公开显示相关字段。调整 reasoning 块可见性或[外部编辑器的上一条回复上下文](2026-08-14-tui-external-editor.md)需要编辑组合 patch，也没有 Claude Code 文档所述的交互式 `/config` 路径。把所有 TUI 字段都当成实时用户配置并不准确：宽度、资源上限、提示词模板和终端构造选项都会在组件树创建时被消费。

## 决定

TUI 注册一个只包含 `showReasoning` 和 `externalEditorContext` 的 `ui-tui` 用户 settings namespace。它的 schema 与 `TuiConfig` 使用相同默认值；Cordis 条目是组合 base，settings 提供方文档是用户层。其余 TUI 配置仍由部署持有，因为更改它们需要重建组件或资源控制器。

不带参数的 `/config` 会打开居中的双条目选择器。Up/Down 选择行，Enter 或 Space 写入相反值，Escape 或 Ctrl+C 关闭。`SettingsProvider.update()` 验证并持久化稀疏 patch 时，当前行显示保存中状态。只有写入返回已提交快照后，已挂载 channel 才会变更；写入拒绝会保留原值，并在对话框中渲染错误。没有 settings 提供方的嵌入方可以查看组合值，但写入会显式失败。

生产宿主通过 `installSettingsSection` 安装 namespace。它的 source thunk 读取最新提供方快照，并在可选服务脱离时回退到条目。提供方提交（包括外部编辑 `$DSH_HOME/settings.yaml`）会转发到当前 mount；全新或恢复的 mount 在构建 transcript 状态前会读取同一 source。`TuiRuntime.readSettings` 和 `updateSettings` 让嵌入方与测试可以替换这份宿主所有权，`TuiController.updateSettings` 则把提供方通知应用到现有 channel。

Reasoning 可见性更新会从持久会话日志重建 transcript，但不会改变该日志。外部编辑器上下文在编辑开始时读取，因此已提交开关无需 remount 即可影响下一次调用。`/details reasoning` 仍是临时 transcript 控制；`/config` 持有持久默认值，后续 settings 提交或 remount 会重新应用它。`settingsDialogWidth` 仍是 Cordis 配置，因为它决定选择器布局而不是用户行为。

## 验证

包测试钉住 schema 默认值、成功持久化、缺少 writer 时不发生乐观变更的失败、外部编辑器对已提交值的消费，以及 provider 风格的 reasoning 更新在已挂载控制器上的应用。一份终端快照记录已提交的选择器状态。built-lib 无密钥 PTY 冒烟通过 `/config` 切换外部编辑器上下文，核实隔离 `settings.yaml` 中的 `ui-tui` 分节，跨越 fresh-session remount，然后要求前台编辑器 fixture 收到最新 assistant 回复。PTY 驱动器可在 Escape 后强制输入轮次边界，避免 ConPTY 把 overlay 关闭与之后的全局快捷键合并为同一字节块。

## 备选方案

**把完整 `TuiConfig` 注册为一个实时 settings namespace。** 未采用，因为大多数字段是构造时值。把它们声明为 live 会承诺已挂载树无法应用的行为；把整个 namespace 标记为仅重启生效，又会拒绝两个真正实时字段的即时更新。

**在 `/config` 中修改 Loader 提供的 config 对象。** 未采用，因为这只在进程内有效，会绕过 settings 验证与原子持久化、忽略外部编辑，并在新进程中丢失该值。

**乐观应用所选值，写入失败后再回滚。** 未采用，因为 settings 提供方只发布已提交状态。渲染未提交值会让 transcript 或外部编辑器观察到最终未能进入用户文档的配置。

## 后果

随附 TUI 为两个可即时履行的设置提供了持久交互式配置路径。同一份 `$DSH_HOME/settings.yaml` 值会跨全新和恢复的 TUI channel 生效，没有提供方的部署则仍以组合为回退。写入失败可见，且不改变运行时行为。

这些 settings 属于终端展示状态。它们不创建会话事件，也不添加模型可见内容；编辑后的提示词文本仍只会通过普通提交进入日志。为 `/config` 新增条目时，必须证明该字段可以应用于已挂载 channel；否则应定义独立的 restart-scoped 界面，而不是扩大这个 live namespace。
