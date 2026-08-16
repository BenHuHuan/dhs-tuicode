# DeepSeek Code TUI

[![Release](https://img.shields.io/badge/release-v0.2.0-2563eb)](https://github.com/BenHuHuan/dhscode-tui/releases) [![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-8b5cf6)](#platform-support) [![License](https://img.shields.io/badge/license-MIT-111827)](LICENSE)

English | [中文](README.zh.md)

<p align="center">
  <img src="docs/assets/dhscode-tui-v0.1.0-preview-20260816.png" alt="DeepSeek Code TUI preview">
</p>

**DeepSeek Code TUI v0.2.0** is a terminal-native coding agent built on the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It keeps Harness's Cordis plugin architecture and adds an opinionated, Claude-Code-style workflow for DeepSeek V4 Pro/Flash on Windows, Linux, servers, and SSH sessions.

Enter `deepseek` in a project to get a persistent coding workspace with a compact first prompt, tools on demand, permission modes, MCP visibility, continuable agents, checkpoints, and a TUI that does not require a browser.

> Independent community distribution; not an official DeepSeek product and not affiliated with Anthropic. Claude Code is referenced only as a UX comparison.

## v0.2.0 highlights

- **One-command TUI:** bare `deepseek` or `dsh` opens the current directory.
- **DeepSeek-first defaults:** V4 Pro, max reasoning effort, and a Minimal first request that promotes the full coding tool catalog on demand.
- **Three model profiles:** `/mode minimal` keeps the anchored V4 Pro path; `/mode router` restores the RL interface (one-sentence persona + shell/editor surface); `/mode spec` enables deep-think-first task-aware routing, primarily for V4 Flash.
- **Adaptive Router follow-ups:** the reproducible mode-boost v0.1 behavior lets greetings stand down, reclassifies new tasks from round three, varies guidance by task complexity, and omits the extra closure constraint for Flash models.
- **Windows + Linux:** automatic Git Bash execution for Minimal/Router agent tools on Windows, with native Bash on Linux and servers; PowerShell remains available for Windows-safe operations.
- **CJK-friendly terminal text:** Chinese and Latin glyphs stay column-aligned in Git Bash when using a true CJK monospace font such as Sarasa Mono SC.
- **Persistent authentication:** `/login` securely saves or replaces the DeepSeek API token.
- **Visible work modes:** Build, Flow, Inspect, and Blueprint/Plan each have distinct colors, prompt glyphs, permissions, and footer state.
- **Permission control:** `/bypass` and `--dangerously-skip-permissions` enable full access without preconfiguring an environment variable.
- **Coding workflow:** file reads/search/edits, shell execution, background jobs, task lists, context compaction, model selection, and reasoning control.
- **Durable sessions:** resume, continue, rename, clear, export, and history search.
- **Workspace safety:** interactive diff, named checkpoints, and rewind/fork.
- **MCP and agents:** inspect/reload MCP and manage durable subagents in the TUI.
- **Skills:** discover skill catalogs and invoke `/skill:<name>`.
- **Multi-agent orchestration (`allin`):** one V4 Pro coordinator plans and synthesizes while parallel V4 Flash lanes execute dependency-ready tasks, allinluna-style.
- **Terminal media:** clipboard-image input and inline rendering, with an ANSI pixel fallback for Windows Terminal.
- **Polished interaction:** mouse scrolling, jump-to-bottom, blue selection, OSC 52 copy, width-safe rendering, and composable multiline paste blocks.

## Requirements

- Node.js `22.19+` or `24+` (Node 24 recommended)
- pnpm `11.7+`
- Git and a DeepSeek API key
- A modern terminal such as Windows Terminal, WezTerm, Kitty, or iTerm2
- Recommended on Windows: Git for Windows; required for the Bash-backed Minimal and Router profiles

<a id="run"></a><a id="run-from-source"></a>

## Install from source

v0.2.0 is currently distributed from source:

```bash
git clone https://github.com/BenHuHuan/dhscode-tui.git
cd dhscode-tui
corepack enable
pnpm install
pnpm run build:lib:host
pnpm --filter @deepseek-ai/dsh link --global
```

Open a new terminal, enter a project, and launch:

```bash
cd your-project
deepseek
```

Without a global link:

```bash
pnpm --dir /path/to/dhscode-tui deepseek
```

Repository-local Windows entry:

```powershell
node .\apps\cli\lib\bin.js
```

## First run

1. Start `deepseek` in the project directory.
2. Run `/login` and paste a DeepSeek API key. The local credential provider persists it for later sessions.
3. Run `/model` to confirm or switch the model.
4. Enter a coding request and press Enter.
5. Press Shift+Tab to cycle work modes, or use `/permission` and `/plan`.

One-off unrestricted launch:

```bash
deepseek --dangerously-skip-permissions
```

Use bypass only in a trusted workspace: it permits shell commands and file changes without approval prompts.

## Model profiles and minimal-first bootstrap

The standard agent begins with a small stable prompt and minimal catalog (`shell` + `read`). After the first durable tool call or assistant reply, the complete coding catalog becomes available. This keeps the initial request near the official DeepSeek Harness minimal-mode shape while preserving a full coding agent for the rest of the session.

The default effort is max. DeepSeek profiles support sampling values such as `temperature=1.0` and `top_p=0.95`. Prompt anchoring improves consistency, but cannot guarantee a particular hidden chain-of-thought prefix.

- **Minimal (recommended for V4 Pro):** preserves the anchored Minimal system prompt and promotes the complete catalog only after the first durable action.
- **Router Standard (`/mode router`):** ports the reproducible v0.2.0 RL-interface restoration from [dsh-routing-suite](https://github.com/yjh051108/dsh-routing-suite): the first request carries only the RL training sentence plus the shell/str_replace_editor surface, then the complete catalog opens after the first tool call.
- **Router Spec (`/mode spec`):** ports the v0.2.0 deep-think-first preset: the classified persona and the spec/react/weak first-turn core tool surface stay visible together with the full prompt sections; the long first-turn reasoning chain is the intended behavior. Both Router profiles are primarily intended for V4 Flash; Pro users should keep Minimal unless they specifically want to evaluate routing behavior.

Both Router profiles also include the suite's reproducible mode-boost v0.1 refinements: short conversational messages do not receive routing pressure; a new task at round three or later is classified afresh; simple tasks receive a commit-and-act nudge while complex tasks receive architecture and integration guidance; the explicit reasoning-closure suffix is reserved for non-Flash models.

Switch profiles with `/mode minimal`, `/mode router`, or `/mode spec`. This profile selector is independent from Build/Flow/Inspect/Plan permission modes.

### Windows Git Bash behavior

The v0.2.0 Windows backend gives agent tool calls real Git Bash/MSYS command semantics instead of presenting PowerShell as Bash. Minimal is the default V4 Pro profile; Router Standard and Router Spec keep the same Bash backend but are tuned mainly for V4 Flash. In local V4 Pro max-effort Minimal runs, planning language became more collaborative (`We could`, `Should we`, and `We should`) while retaining natural `Let's` transitions. These screenshots are observed samples, not a guarantee that every model response will use a fixed prefix.

<p align="center">
  <img src="docs/assets/gitbash-reasoning-before-v2.png" alt="V4 Pro reasoning sample using Git Bash" width="100%"><br>
  <img src="docs/assets/gitbash-reasoning-we-could-v2.png" alt="V4 Pro reasoning sample beginning with We could" width="100%"><br>
  <img src="docs/assets/gitbash-reasoning-we-should-v2.png" alt="V4 Pro reasoning sample using Should we and We should" width="100%">
</p>

## Main commands

| Command | Purpose |
| --- | --- |
| `/login` | Persist or replace the DeepSeek API token |
| `/model`, `/effort` | Select the model and reasoning effort |
| `/permission`, `/bypass`, `/plan` | Control safety and work mode |
| `/workdir [path]` | Open another project in a fresh session |
| `/diff` | Review uncommitted workspace changes |
| `/checkpoint [label]` | Save a reversible workspace/conversation point |
| `/rewind` | Restore a checkpoint and optionally branch the conversation |
| `/resume`, `/continue` | Resume a persisted session |
| `/new`, `/clear` | Start fresh while preserving the previous session |
| `/compact`, `/context` | Manage and inspect context pressure |
| `/agents` | List and manage durable continuable subagents |
| `/mcp` | Show MCP connection state and public tools |
| `/skills`, `/skill:<name>` | Discover and load skills |
| `/tasks` | Inspect background and delegated tasks |
| `/copy`, `/export` | Copy a response or export the conversation |
| `/config`, `/status`, `/help` | Settings, diagnostics, and documentation |

Type `/` for scrollable command completion. Skill commands load asynchronously from active catalogs.

## Keyboard essentials

- Enter sends; Shift+Enter or Alt+Enter inserts a newline.
- Shift+Tab cycles work modes; Alt+P selects a model; Alt+T toggles thinking.
- Ctrl+V or Alt+V pastes a clipboard image when available.
- Long/multiline text appears as compact `[Paste #N ...]` blocks; normal text can be composed before, between, and after multiple blocks.
- Mouse wheel scrolls; Ctrl+End jumps to the latest output.
- Ctrl+O cycles tool-card detail; Ctrl+R searches history.
- Ctrl+S stashes/restores a draft; Ctrl+G opens the external editor.
- `! command` streams a shell command and offers its result to the model.
- Ctrl+C cancels/clears; press twice on empty input to exit.

## Platform support

### Windows

Windows Terminal is the primary v0.2.0 desktop target. Minimal and Router requests use fresh Git Bash processes instead of the unsupported Windows persistent-PTY path. DeepSeek Code detects `DSH_BASH_PATH`, `GIT_BASH`, standard Git for Windows installations, and then `PATH`. Because the MSYS runtime cannot create its signal pipes inside the Windows restricted-token sandbox, Bash calls require a one-call full-access approval or `/bypass on`; safe modes retain PowerShell for confined commands.

For mixed Chinese/English sessions, select **Sarasa Mono SC** (or another verified CJK monospace font) in the Windows Terminal Git Bash profile. A proportional CJK fallback can make Chinese glyphs appear at inconsistent widths even when the TUI's terminal-column calculations are correct.

```powershell
$env:DSH_BASH_PATH = 'C:\Program Files\Git\bin\bash.exe'
deepseek
```

### Linux and servers

Run the same `deepseek` command in Bash-compatible terminals and SSH sessions. Inline bitmap support depends on the terminal; ANSI pixels and text metadata remain available as fallbacks.

## Data and security

- Sessions and credentials remain local under the configured DSH home.
- API keys are not printed by `/status` or normal logs.
- Workspace Write is the normal editing mode; Inspect and Plan reduce mutation authority; bypass removes approval prompts.
- Use `/checkpoint` before broad refactors. Rewind is not a replacement for Git commits or backups.
- Never grant unrestricted access to an untrusted repository.

## Architecture

DeepSeek Code remains a DeepSeek Harness distribution, not a monolithic CLI. Cordis plugins provide the model route, tools, sessions, permissions, credentials, MCP, skills, agents, and UI. Optional capabilities degrade independently when their service is not mounted.

- [TUI subsystem](docs/subsystems/tui.md)
- [MCP subsystem](docs/subsystems/mcp.md)
- [Architecture](docs/architecture.md)
- [Development guide](docs/development.md)
- [Testing](docs/testing.md)

## Known v0.2.0 limitations

- Source release only; no npm, MSI, Homebrew, or standalone binary yet.
- Terminals differ in mouse reporting, OSC 52 clipboard, and image protocols.
- MCP and agents have functional commands, not graphical marketplaces.
- Checkpoints support the local workflow but are not transactional storage.
- Compatibility-breaking configuration changes may occur before v1.0.

## Development

```bash
pnpm install
pnpm run build:lib:host
pnpm run test
pnpm run test:e2e
```

Keyless E2E fixtures need no API key; real model calls do. Report bugs through [GitHub Issues](https://github.com/BenHuHuan/dhscode-tui/issues) with the OS, terminal, Node version, launch command, and smallest reproduction.

## Release status

**v0.2.0 — second public release.** The terminal coding loop is usable for early adopters; APIs and configuration remain pre-1.0.

## License

[MIT](LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
