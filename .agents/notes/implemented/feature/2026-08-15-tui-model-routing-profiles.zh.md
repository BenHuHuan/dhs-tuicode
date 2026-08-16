# Agent Note: TUI 模型路由配置

Status: implemented

[English](2026-08-15-tui-model-routing-profiles.md) | 中文

## Problem

DeepSeek 编码会话需要多种独立的首轮请求行为，且不能与权限模式耦合。精简请求必须保留官方 Minimal 的工具与提示词结构；routing-suite 配置需要两种实测首轮形态：v0.2.0 的 RL 接口还原（单句 RL 训练句 + shell/editor）与深度思考优先的分类 persona 面。Windows 必须提供相同的 Bash 请求，不能改变模型可见的工具描述，也不能因为私有临时目录位于用户主目录工作区内而失败。

## Decision

TUI 的 `/mode` 命令使用 `minimal`、`router`（Router Standard）或 `spec`（Router Spec）创建新会话。Minimal 是默认显示名称，使用标准预设的锚定首轮请求；Router Standard 选择 `routing-suite` 预设，Router Spec 选择 `routing-suite-spec` 预设。Build、Flow、Inspect、Plan 和 bypass 等权限模式保持独立，不负责选择模型路由配置。

锚定请求使用官方 Minimal 系统提示词以及 `bash`、`str_replace_editor` schema。Agent 指令与 skill 目录不会进入该请求。首次持久工具调用或助手结果后，普通编码工具目录恢复，因此后续轮次仍具备完整的产品工具集。

Router Standard 原样移植 dsh-router-standard v0.2.0：首轮只携带 RL 训练句（`You are a helpful software engineer assistant.`）和 shell + `str_replace_editor` 工具面，唯一保留的边界是 plan-mode section。Router Spec 保留分类 persona（`spec`/`react`/weak，按 Pro/Flash 自动匹配）、其余已装配的 prompt sections，以及旧版首轮核心工具。两个 Router 配置都只在真实工具调用后提升，保留 weak 带近场引导，并提供 `dev_router_status` / `dev_router_mode` / `dev_mode_subagent` 自优化工具；Router 调优工具会从所有非 Router 目录中过滤掉。

Windows 为锚定请求挂载持久 Git Bash，并使用位于工作区之外、可配置的 ACL 沙箱临时目录。提升后可使用 PowerShell 和其余 Windows 工具；Router 配置在提升后仍只保留单一 Bash 方言。

## Alternatives considered

**使用权限模式选择模型路由。** 未采用，因为文件系统权限与模型可见工具是两个独立的用户决策。将两者合并会导致 Shift+Tab 意外改变会话配置并强制开启新会话。

**生成后改写隐藏推理的开头。** 未采用，因为替换显示文本不会改变规划或工具使用。实现对齐真实系统提示词、工具 schema 与 Shell 行为，而不是遮盖模型输出。

**Windows 锚定首轮直接暴露 PowerShell。** 未采用，因为平台专用 schema 会改变 Minimal 配置需要保留的请求。Git Bash 提供稳定的模型可见 Shell 约定，提升后的工具目录仍包含 Windows 原生工具。

## Consequences

用户可以在稳定的 Minimal、Router Standard 与 Router Spec 之间切换，而不改变工作区权限。配置切换会创建新会话，因为系统提示词和初始工具目录无法在已有对话中安全替换。对齐会提高轨迹稳定性，但不会保证隐藏推理使用某个固定短语；Router Spec 会按不同任务带保留不同推理风格，Router Standard 则有意还原实测的 think-act RL 接口。

定向 bootstrap、Windows Shell、runner、sandbox 和 TUI 测试固定分类、配置选择、Shell 组合、临时目录位置、weak 引导，以及编辑器上方的运行状态显示。
