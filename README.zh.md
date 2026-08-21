# DeepSeek Code TUI

[![Source](https://img.shields.io/badge/source-v0.2.0-2563eb)](https://github.com/BenHuHuan/dhs-tuicode/tree/v0.2.0) [![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-8b5cf6)](https://github.com/BenHuHuan/dhs-tuicode) [![License](https://img.shields.io/badge/license-MIT-111827)](LICENSE)

[English](README.md) | 中文

<p align="center">
  <img src="docs/assets/dhscode-tui-v0.2.0-preview-20260817.png" alt="DeepSeek Code TUI v0.2.0 在 Windows Terminal 中运行">
</p>

**DeepSeek Code TUI** 是基于官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建的终端原生 coding agent（编程智能体）。它把 DeepSeek V4 Pro/Flash、持久化 TUI、真实编码工具、可恢复会话、权限控制、MCP、skill 和可续接 subagent 集成到一套 Shell 优先的工作流中。

在项目目录输入 `deepseek` 即可启动，不需要浏览器。

> 这是独立的社区发行版，不是 DeepSeek 官方产品，也与 Anthropic 无关。文中提到 Claude Code 仅用于说明终端交互体验。

## 为什么做这个版本

- **DeepSeek 原生默认值：** 默认使用 V4 Pro、max 推理强度和 Minimal 首轮请求，完整编码工具目录会在需要时恢复。默认模型目录还包含支持图像输入的 `deepseek-v4-flash-vision-exp`。
- **Windows 上使用真实 Bash 语义：** 面向模型的 Shell 调用使用 Git Bash/MSYS，不再把 PowerShell 伪装成 Bash；安全的 Windows 操作仍可使用 PowerShell。
- **完整终端闭环：** 无需离开 TUI 即可检查、搜索、编辑、运行命令、审查 diff、创建检查点、回退、恢复会话和导出内容。
- **明确的安全状态：** 权限与规划模式具有不同颜色、输入栏、图标和页脚；无限制访问始终需要显式选择。
- **可扩展架构：** MCP server、skill、持久 subagent 和 `allin` 多智能体工具直接复用 Cordis 插件架构，而不是运行在另一套包装层中。
- **适合 Windows 终端：** 支持 CJK 列宽、鼠标滚动、回到底部、选择复制、多行黏贴块、剪贴板图片和宽度安全渲染。

<a id="run"></a>

## 快速开始

### 环境要求

- Node.js `22.19+` 或 `24+`（推荐 Node 24）
- pnpm `11.7+`
- Git 和 DeepSeek API key
- Windows Terminal、WezTerm、Kitty、iTerm2 或其他现代终端
- Windows 使用 Bash 后端 Profile 时需要 Git for Windows

<a id="run-from-source"></a>

### 从源码安装

当前源码线为 **v0.2.0**，暂未提供安装包或 npm 发行版。

```bash
git clone https://github.com/BenHuHuan/dhs-tuicode.git
cd dhs-tuicode
corepack enable
pnpm install
pnpm run build:lib:host
pnpm --filter @deepseek-ai/dsh link --global
```

打开一个新终端，进入项目并启动：

```bash
cd your-project
deepseek
```

如果不创建全局链接，可直接从仓库运行：

```bash
pnpm --dir /path/to/dhs-tuicode dsh
```

Windows 下已经构建的仓库本地入口为：

```powershell
node .\apps\cli\lib\bin.js
```

### 第一次会话

1. 在希望 agent 修改的目录中运行 `deepseek`。
2. 输入 `/login` 并黏贴 DeepSeek API key，凭据提供方会为后续会话保存它。
3. 使用 `/model` 确认或切换模型。
4. 输入编码请求并按 Enter。
5. 按 Shift+Tab 切换当前权限/规划状态。

单次无限制启动：

```bash
deepseek --dangerously-skip-permissions
```

只在可信工作区使用 bypass，它会移除 Shell 命令和文件修改的批准提示。

## 两套相互独立的模式

DeepSeek Code 明确区分**模型/工具路由**与**工作区权限**，切换其中一项不会暗中改变另一项。

### 路由 Profile：`/mode`

| Profile | 适用模型 | 首轮行为 |
| --- | --- | --- |
| `minimal` | V4 Pro（默认） | 使用锚定的 Minimal 提示词和精简的 `shell` + `read` 工具面；第一次持久动作或 assistant 结果后恢复完整目录 |
| `router` | 主要面向 V4 Flash | 还原 routing suite 的紧凑 RL 接口，首轮提供单句 persona 和 Shell/编辑器工具面，第一次工具调用后开放完整目录 |
| `spec` | 主要面向 V4 Flash | 使用任务分类、深度思考优先引导和 spec/react/weak 首轮工具面，适合更审慎的规划 |

Router Profile 移植了 [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) 的可复现行为，包括短聊天降压、后续新任务重新分类、按复杂度调整引导，以及只对非 Flash 模型使用的收束后缀。Minimal 采用 [dsh-anchored-standard](https://github.com/xiaobright/dsh-anchored-standard) 的锚定思路。

默认推理强度为 max。提示词和 Shell 锚定可以提高行为一致性，但不能保证隐藏推理采用固定开头。

可随时切换：

```text
/mode minimal
/mode router
/mode spec
```

### 权限与规划状态

Shift+Tab 会在已配置的安全状态和 Plan 之间循环。当前主题使用不同色系和权限展示 Build、Flow、Inspect、Plan 等状态，也可用 `/permission`、`/plan` 和 `/bypass` 直接控制。

只有在用户显式选择后，危险的完整访问才会进入模式循环。

## 已包含的功能

| 范围 | 功能 |
| --- | --- |
| 编码 | 文件读取/搜索/编辑、Shell 执行、后台任务、任务列表、工具卡片、外部编辑器和直接执行 `! command` |
| 会话 | 持久日志、恢复/继续、重命名、清空/新建、提示词历史、上下文压缩、复制和导出 |
| 审查与恢复 | 交互式 diff、命名的工作区/会话检查点、回退和会话分支 |
| 模型 | 提供方/模型选择、推理强度、思考显示、token 用量、图像输入、图像 token 估算和上下文压力 |
| 扩展 | MCP 状态/重载、skill 发现与调用、持久 subagent 管理和 Cordis 插件 |
| 多智能体 | `allin` 编排：一个 V4 Pro 协调者配合并行 V4 Flash 执行通道 |
| 终端体验 | 鼠标滚动、回到底部、OSC 52 选择复制、行内黏贴块、剪贴板图片、终端图片、ANSI 像素回退和 CJK 列宽处理 |

## 主要命令

| 命令 | 用途 |
| --- | --- |
| `/login` | 保存或替换 DeepSeek API token |
| `/model`、`/effort` | 选择模型与推理强度 |
| `/mode` | 切换 Minimal、Router 或 Spec 模型/工具路由 |
| `/permission`、`/plan`、`/bypass` | 控制工作区权限与规划状态 |
| `/workdir [path]` | 在新会话中打开另一个项目 |
| `/diff` | 审查未提交的工作区改动 |
| `/checkpoint [label]`、`/rewind` | 创建和恢复可逆的工作区/会话节点 |
| `/resume`、`/continue` | 恢复持久化会话 |
| `/new`、`/clear`、`/rename` | 管理会话标识与生命周期 |
| `/compact`、`/context` | 管理并查看上下文压力 |
| `/agents`、`/tasks` | 管理可续接 subagent 与后台工作 |
| `/mcp` | 查看 MCP 连接状态和公开工具 |
| `/skills`、`/skill:<name>` | 发现并加载 skill |
| `/copy [N]`、`/export [file]` | 复制 assistant 输出或导出会话 |
| `/config`、`/status`、`/help` | 编辑设置、查看诊断和打开帮助 |

输入 `/` 可打开可滚动命令面板。skill 命令会从已激活的目录中异步加载。

## 常用快捷键

- Enter 发送；Shift+Enter 或 Alt+Enter 换行。
- Shift+Tab 切换权限/规划状态；Alt+P 选择模型；Alt+T 切换思考。
- Up/Down 浏览提示词历史；Ctrl+R 搜索历史。
- 剪贴板中存在图片时，Ctrl+V 或 Alt+V 可黏贴图片。
- 长文本或多行文本会显示为紧凑的 `[Paste #N ...]` 块，可与普通文字和更多块组合。
- 鼠标滚轮滚动 transcript（文本记录）；Ctrl+End 跳到最新输出。
- Ctrl+O 切换工具卡片详情；Ctrl+T 切换任务清单。
- Ctrl+S 暂存或恢复当前草稿；Ctrl+G 打开外部编辑器。
- Ctrl+C 取消或清空；输入为空时连按两次退出。
- 输入为空时按 `?` 查看完整快捷键说明。

## Windows Git Bash 集成

在 Windows 上，Minimal 和 Router 面向模型的 Shell 工具会启动独立的 Git Bash 进程，提供真实 Bash/MSYS 命令语义。DeepSeek Code 依次检查 `DSH_BASH_PATH`、`GIT_BASH`、Git for Windows 标准安装位置和 `PATH`，同时保留 PowerShell 处理 Windows 限定操作。

由于 MSYS 信号管道无法在 Windows 安全执行所用的受限令牌沙箱中工作，Git Bash 工具调用可能需要一次完整访问批准或 `/bypass on`。这是 Windows 运行时限制，与 API key 无关。

需要时可覆盖 Bash 探测结果：

```powershell
$env:DSH_BASH_PATH = 'C:\Program Files\Git\bin\bash.exe'
deepseek
```

中英文混合使用时，建议在终端 Profile 中选择 **Sarasa Mono SC（更纱黑体等宽 SC）**或其他经过验证的 CJK 等宽字体。比例 CJK 回退字体可能导致视觉错列，即使 TUI 的终端列宽计算正确。

## Linux、服务器与 SSH

在兼容 Bash 的终端中运行同一个 `deepseek` 命令即可。编码循环、会话、权限、MCP、skill 和 subagent 都不依赖桌面环境。位图协议取决于终端能力；不支持时仍可使用 ANSI 像素或文本元数据回退。

## 本地数据与安全

- 会话、配置和托管凭据保存在配置的 DSH home 目录中。
- `/status` 和正常日志不会打印已保存的 API key。
- Workspace Write 是常规编辑权限；Inspect 与 Plan 会减少修改权限；bypass 会移除批准提示。
- 大范围重构前建议使用 `/checkpoint`，但仍需使用 Git 和备份：rewind 不是事务存储。
- 不要向不可信仓库授予无限制访问权限。

## 架构与扩展点

DeepSeek Code 仍然是 DeepSeek Harness 发行版，而不是单体包装 CLI。模型路由、工具、会话、权限、凭据、MCP、skill、agent 和 TUI 均由 Cordis 插件提供；可以增删可选功能，而不需要替换核心 agent loop（智能体循环）。

- [架构](docs/architecture.md)
- [TUI 子系统](docs/subsystems/tui.md)
- [MCP 子系统](docs/subsystems/mcp.md)
- [Skills 子系统](docs/subsystems/skills.md)
- [开发指南](docs/development.md)
- [测试指南](docs/testing.md)

## 当前限制

- 当前只能从源码安装，尚无 npm、MSI、Homebrew 或独立二进制发行版。
- 不同终端对鼠标上报、OSC 52 剪贴板、颜色、字体和图片协议的支持不同。
- MCP、skill 和 agent 提供可用的终端管理界面，而不是图形化市场。
- 检查点支持本地编码恢复，但不能替代 commit、worktree 或备份。
- v1.0 前配置与兼容性可能发生变化。

## 开发

```bash
pnpm install
pnpm run build:lib:host
pnpm run test
pnpm run test:e2e
```

无 key e2e fixture（测试前置数据）不需要 API key，真实模型请求需要。请通过 [GitHub Issues](https://github.com/BenHuHuan/dhs-tuicode/issues) 报告问题，并附上操作系统、终端、Node 版本、启动命令和最小复现。

## 项目状态

仓库源码和标签当前为 **v0.2.0**。这是面向早期用户与贡献者的 pre-1.0 社区发行版。

DeepSeek Harness 以及引入的 routing/minimal 项目保留各自的历史、作者与声明。GitHub Contributor 列表根据 commit 历史自动生成，并不代表本 README 对项目所有权的声明。

## 许可证

[MIT](LICENSE)。打包的第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
