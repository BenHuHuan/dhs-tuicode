# DeepSeek Code TUI

[![Release](https://img.shields.io/badge/release-v0.1.0-2563eb)](https://github.com/BenHuHuan/dhscode-tui/releases) [![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-8b5cf6)](#platform-support) [![License](https://img.shields.io/badge/license-MIT-111827)](LICENSE)

[English](README.md) | 中文

<p align="center">
  <img src="docs/assets/dhscode-tui-v0.1.0-preview-20260816.png" alt="DeepSeek Code TUI v0.1.0 预览">
</p>

**DeepSeek Code TUI v0.1.0** 是基于官方 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建的终端原生 Coding Agent。它保留 Harness 的 Cordis 插件架构，并为 DeepSeek V4 Pro/Flash 加入适用于 Windows、Linux、服务器与 SSH 的类 Claude Code 工作流。

在项目目录输入 `deepseek`，即可获得包含极简首轮提示、按需工具、权限模式、MCP、可继续 Agent、检查点和持久会话的纯终端编码工作区。

> 本项目是独立社区发行版，不是 DeepSeek 官方产品，也与 Anthropic 无关。文中提到 Claude Code 仅用于说明交互体验。

## v0.1.0 亮点

- **一条命令启动：** `deepseek` 或 `dsh` 默认打开当前目录。
- **DeepSeek 优先：** V4 Pro、max 推理强度、Minimal 极简首轮工具目录，随后按需恢复完整工具。
- **两种模型 Profile：** `/mode minimal` 保留面向 V4 Pro 的锚定路径；`/mode router` 提供任务感知的首轮工具路由，主要面向 V4 Flash。
- **Windows + Linux：** Windows 下 Minimal/Router 的 Agent 工具自动使用 Git Bash，Linux/服务器直接使用 Bash；Windows 安全操作仍可使用 PowerShell。
- **中文等宽显示：** Git Bash 配合 Sarasa Mono SC 等真正的 CJK 等宽字体时，中英文字符可保持列宽一致。
- **持久登录：** `/login` 安全保存或替换 API Token，无需每次设置环境变量。
- **四种可视模式：** Build、Flow、Inspect、Blueprint/Plan 拥有不同颜色、提示符与权限。
- **快速完整权限：** `/bypass` 或 `--dangerously-skip-permissions`。
- **完整编码循环：** 文件读写/搜索、Shell、后台任务、Todo、压缩、模型和推理控制。
- **持久会话：** resume、continue、rename、clear、export 与历史搜索。
- **工作区安全：** 交互式 diff、命名 checkpoint、rewind 与会话分支。
- **MCP 与多 Agent：** 可直接在 TUI 中查看、重载和管理。
- **Skills：** 浏览可用技能目录并通过 `/skill:<name>` 调用。
- **图片与粘贴：** 剪贴板图片、终端图片、Windows ANSI 像素回退、多段长文本粘贴块。
- **终端交互：** 鼠标滚动、回到底部、蓝色拖选、OSC 52 复制和行宽防崩溃。

## 环境要求

- Node.js `22.19+` 或 `24+`，推荐 Node 24
- pnpm `11.7+`
- Git 与 DeepSeek API Key
- Windows Terminal、WezTerm、Kitty、iTerm2 等现代终端
- Windows 推荐安装 Git for Windows；Minimal 与 Router 的 Bash 后端需要它

<a id="run"></a><a id="run-from-source"></a>

## 从源码安装

```bash
git clone https://github.com/BenHuHuan/dhscode-tui.git
cd dhscode-tui
corepack enable
pnpm install
pnpm run build:lib:host
pnpm --filter @deepseek-ai/dsh link --global
```

重新打开终端，在任意项目中运行：

```bash
cd your-project
deepseek
```

不安装全局命令也可以：

```bash
pnpm --dir /path/to/dhscode-tui deepseek
```

Windows 仓库内直接启动：

```powershell
node .\apps\cli\lib\bin.js
```

## 第一次使用

1. 在项目目录运行 `deepseek`。
2. 输入 `/login` 并粘贴 API Key；本地凭据存储会长期保存。
3. 用 `/model` 确认或切换模型。
4. 输入编码任务并按 Enter。
5. Shift+Tab 切换工作模式，也可直接使用 `/permission`、`/plan`。

一次性无确认完整权限：

```bash
deepseek --dangerously-skip-permissions
```

仅在可信工作区使用 bypass，它允许 Agent 不经确认执行命令和修改文件。

## 模型 Profile、极简首轮与工具恢复

标准 Agent 以小型稳定提示词和最小工具集合（`shell` + `read`）开始。第一次持久工具调用或助手回复后，完整编码工具目录立即恢复。这样首轮尽量接近 DeepSeek Harness Minimal Mode，后续又保留完整 Coding Agent 能力。

默认推理强度为 max，DeepSeek Profile 支持 `temperature=1.0`、`top_p=0.95` 等采样配置。提示锚定可以提高一致性，但不能保证隐藏思维链固定以某个单词开头。

- **Minimal（V4 Pro 推荐）：** 保留锚定的 Minimal system prompt，第一次持久动作后才恢复完整工具目录。
- **Router（主要面向 V4 Flash）：** 适配 [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite) 的任务感知路由思路，按任务缩小首轮可见工具面，之后再恢复完整目录。Routing Suite 作者说明该 Profile 主要为 Flash 设计；Pro 用户除非专门评估路由行为，否则建议保持 Minimal。

使用 `/mode minimal` 或 `/mode router` 切换。它与 Build、Flow、Inspect、Plan 这些权限/工作模式相互独立。

### Windows Git Bash 行为

v0.1.0 的 Windows 后端会让 Agent 工具调用使用真实的 Git Bash/MSYS 命令语义，不再把 PowerShell 包装成 Bash。Minimal 是 V4 Pro 的默认 Profile；Router 使用同一个 Bash 后端，但主要针对 V4 Flash。本机 V4 Pro max-effort Minimal 实测中，规划语言更常出现协作式的 `We could`、`Should we` 与 `We should`，同时保留自然的 `Let's` 过渡。以下是实际观察截图，不代表每次模型响应都能固定使用某个开头。

<p align="center">
  <img src="docs/assets/gitbash-reasoning-before-v2.png" alt="V4 Pro 使用 Git Bash 的推理样例" width="100%"><br>
  <img src="docs/assets/gitbash-reasoning-we-could-v2.png" alt="V4 Pro 使用 We could 的推理样例" width="100%"><br>
  <img src="docs/assets/gitbash-reasoning-we-should-v2.png" alt="V4 Pro 使用 Should we 与 We should 的推理样例" width="100%">
</p>

## 主要命令

| 命令 | 用途 |
| --- | --- |
| `/login` | 持久保存或替换 API Token |
| `/model`、`/effort` | 模型与推理强度 |
| `/permission`、`/bypass`、`/plan` | 权限与工作模式 |
| `/workdir [path]` | 在新会话切换项目目录 |
| `/diff` | 查看未提交变更 |
| `/checkpoint [label]` | 创建工作区/会话检查点 |
| `/rewind` | 恢复检查点并可分支会话 |
| `/resume`、`/continue` | 恢复持久会话 |
| `/new`、`/clear` | 保留旧会话并开始新会话 |
| `/compact`、`/context` | 管理与查看上下文 |
| `/agents` | 管理可继续子 Agent |
| `/mcp` | 查看 MCP 连接与工具 |
| `/skills`、`/skill:<name>` | 查看并加载技能 |
| `/tasks` | 查看后台与委派任务 |
| `/copy`、`/export` | 复制回复或导出对话 |
| `/config`、`/status`、`/help` | 设置、诊断与帮助 |

输入 `/` 打开可滚动命令补全；Skill 命令会从活动目录异步加载。

## 常用快捷键

- Enter 发送；Shift+Enter 或 Alt+Enter 换行。
- Shift+Tab 切换模式；Alt+P 选模型；Alt+T 开关 Thinking。
- Ctrl+V 或 Alt+V 在可用时粘贴剪贴板图片。
- 长/多行文本显示为 `[Paste #N ...]` 块，多个块之间仍可输入普通文字。
- 鼠标滚轮浏览；Ctrl+End 回到底部。
- Ctrl+O 切换工具卡片；Ctrl+R 搜索历史。
- Ctrl+S 暂存/恢复输入；Ctrl+G 打开外部编辑器。
- `! command` 流式执行 Shell，并把结果交给模型。
- Ctrl+C 取消或清空；空输入连续按两次退出。

<a id="platform-support"></a>

## 平台支持

### Windows

Windows Terminal 是 v0.1.0 的主要桌面目标。Minimal 与 Router 请求使用独立的 Git Bash 进程，不再进入 Windows 不支持的持久 PTY 路径。DeepSeek Code 会依次探测 `DSH_BASH_PATH`、`GIT_BASH`、Git for Windows 常见安装目录与 `PATH`。由于 MSYS 无法在 Windows 受限令牌沙箱中创建信号管道，Bash 调用需要单次完整权限批准或 `/bypass on`；安全模式仍保留 PowerShell 来执行受限命令。

中英文混合会话建议在 Windows Terminal 的 Git Bash Profile 中选择 **Sarasa Mono SC（更纱黑体等宽 SC）** 或其他经过验证的 CJK 等宽字体。若终端回退到比例中文字体，即使 TUI 的列宽计算正确，中文字符看起来仍可能大小不一或错列。

```powershell
$env:DSH_BASH_PATH = 'C:\Program Files\Git\bin\bash.exe'
deepseek
```

### Linux 与服务器

在 Bash 兼容终端和 SSH 中直接运行同一条 `deepseek` 命令。图片能力取决于终端；不支持位图协议时会退化为 ANSI 像素图或文本元数据。

## 数据与安全

- 会话和凭据保存在配置的 DSH 本地目录。
- API Key 不会在 `/status` 或普通日志中明文展示。
- Workspace Write 是常规编辑模式；Inspect 与 Plan 限制修改；bypass 关闭审批提示。
- 大范围修改前建议 `/checkpoint`；Rewind 不能替代 Git 提交和备份。
- 不要给不可信项目完整权限。

## 架构与文档

DeepSeek Code 仍是 DeepSeek Harness 的发行形态，而非单体 CLI。模型、工具、会话、权限、凭据、MCP、Skills、Agents 与 UI 都由 Cordis 插件提供；缺少可选服务时对应能力独立降级。

- [TUI 子系统](docs/subsystems/tui.md)
- [MCP 子系统](docs/subsystems/mcp.md)
- [架构](docs/architecture.md)
- [开发指南](docs/development.md)
- [测试](docs/testing.md)

## v0.1.0 已知限制

- 当前仅源码发布，暂无 npm、MSI、Homebrew 或独立二进制。
- 不同终端对鼠标、OSC 52 剪贴板与图片协议的支持不同。
- MCP 与 Agent 已有 TUI 管理命令，但还不是图形化市场。
- Checkpoint 支持本地工作流，但不是事务存储。
- v1.0 前可能发生破坏兼容性的配置变化。

## 开发与验证

```bash
pnpm install
pnpm run build:lib:host
pnpm run test
pnpm run test:e2e
```

Keyless E2E 不需要真实 API Key；真实模型请求需要。请通过 [GitHub Issues](https://github.com/BenHuHuan/dhscode-tui/issues) 报告问题，并附系统、终端、Node 版本、启动命令和最小复现。

## 发布状态

**v0.1.0 — 第一个公开版本。** 核心终端编码循环已可供早期用户使用；API 与配置仍在 1.0 前快速迭代。

## 许可证

[MIT](LICENSE)，第三方许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
