# Agent Note：TUI assistant 回复复制

Status: implemented

[English](2026-08-14-tui-assistant-response-copy.md) | 中文

## 问题

恢复后的 TUI 能显示持久 assistant 回复，却不能把其中一条送入桌面剪贴板。Claude Code 将 `/copy [N]` 记录为复制最新或倒数第 N 条 assistant 回复；回复包含代码块时，还可在交互式选择器中选择完整回复或单个 block。若直接基于模型 surface 实现会得到错误语义：压缩和重新生成产生的仅供模型使用 replacement 可能包含终端从未显示的 assistant 文本，而 reasoning 与工具调用 block 也不是回复正文。把 assistant 内容放入 Shell 命令字符串还会引入不必要的注入与引号边界。目标行为以 Claude Code 的[交互模式命令参考](https://code.claude.com/docs/en/commands)为准。

## 决策

`visibleAssistantResponses()` 按从新到旧遍历已提交会话事件。它只接受 `surfaceOp` 为 `append` 的 `assistant/message`，在不规范化所选值的前提下拼接文本 block，并在结果只有空白时排除该消息。因此 reasoning、工具调用、图像、replacement-origin 消息与非 assistant 事件都不占用序号。外部编辑器的可选上一条回复上下文也改用同一选择器，使两个人类界面对“最新可见 assistant 回复”的定义一致。

`/copy` 选择序号 1；`/copy N` 要求 N 是正的安全整数。序号不存在时会报告可用的可见回复数量。回复没有非空 fenced code block 时会直接进入剪贴板 writer；存在可复制的反引号或波浪号 fence 时，会打开居中的 `CopyResponseDialog`，其中先列出完整回复，再按源顺序列出各代码正文。Up／Down 移动，Enter 复制，`w` 开始把高亮目标写入文件，Escape 或 Ctrl+C 取消且不写入。解析器支持更长的闭合 fence，并把未闭合的最终 fence 视为拥有已完成回复的剩余尾部；空 fence 仍可被识别，但不会成为候选。

`TuiRuntime.writeClipboardText` 是可替换的宿主边界。它接收精确文本、会话工作目录与 abort signal。随附 `writeTextToClipboard` 以 `shell: false` 启动精确 argv，并且只通过 stdin 发送 UTF-8 文本。原生 Windows 与 WSL 使用非交互 STA PowerShell 和 `System.Windows.Forms.Clipboard`；Linux 依次尝试 `wl-copy` 与 `xclip`；macOS 使用 `pbcopy`。`clipboardTextCommand` 会用一条精确 argv 替换平台选择，以支持远程桌面和自定义桥接。stderr 保留有界；启动失败与非零退出会明确报告；自定义命令失败后绝不会回退到其他 helper。

`TuiRuntime.writeTextFile` 持有对应的宿主文件系统边界。按下 `w` 后，一个获得焦点的单行对话框要求非空路径；相对路径按会话工作目录解析。第一次尝试采用带私有权限意图的独占创建，因此已有目标会逐字节保持不变，并触发第二个确认对话框。只有明确按下 `y` 才会带覆盖许可重试；`n`、Escape、Ctrl+C 或关闭任一对话框都会取消。Writer 不会把路径或文本交给 shell，会写入精确 UTF-8，不会自行创建父目录，并把解析后的目标返回给完成通知。

任一选择器、路径输入或覆盖保护打开期间，命令都会一直持有命令生命周期 abort signal；剪贴板工作还会关联到五秒子进程操作超时。剪贴板或文件 I/O 期间会冻结编辑器提交和其他全局动作，状态行会标明当前操作。TUI dispose 会在移除 overlay 和释放终端所有权前同时中止命令与传输控制器。所选文本和文件路径绝不会成为模型输入；显式斜杠调用本身仍保留普通、只进入日志的 TUI 命令生命周期。

## 验证

纯测试固定从新到旧的 append-origin 选择、多 block 拼接、空白／reasoning／工具／replacement 排除、正整数序号，以及反引号、波浪号、更长 fence、CRLF、无效、空和未闭合 fence。进程边界测试固定平台剪贴板 argv 选择、通过 stdin 传递精确 Unicode 与终端控制字节、空输入、有界失败诊断、缺失可执行文件和取消。文件系统边界测试固定相对路径解析、精确 UTF-8 内容、独占创建、已有内容不变、明确覆盖、无效父目录与取消。已挂载 channel 测试固定 `/copy`、`/copy 2`、参数与范围失败、缺少 writer 时的降级、完整回复／代码块选择器、复制与写文件取消、路径校验、拒绝与接受覆盖、不发送或 steer 模型、可见进行中状态，以及 dispose 时中止 writer。记录的终端输出固定选择器与命令清单。

Keyless built-lib PTY 冒烟会启动随附 profile、选择 scripted 模型并完成真实流式回复。其中一项调用 `/copy` 并驱动已配置的无 Shell stdin 剪贴板 writer；另一项打开 fenced 回复选择器、高亮代码块、按下 `w`、输入相对路径，并驱动随附文件 writer。运行后检查要求两个文件都包含逐字节等价的 UTF-8 文本；PTY 输出还必须包含各自的完成通知与 bracketed-paste 释放。由此可在无 API key 的情况下覆盖生产配置、已构建包、CLI、Loader 树、ProcessTerminal 与两个宿主边界。

## 考虑过的替代方案

**复制当前模型 surface。** 未采用，因为 replacement 会有意改变模型可见性而不改写人类 transcript。剪贴板命令应描述用户看见的内容，而非后续请求看见的内容。

**把 reasoning 或已渲染工具卡片与 assistant 文本一起复制。** 未采用，因为 `/copy` 指向 assistant 回复。Reasoning 可见性属于展示设置，工具卡片还可能包含 presenter 生成的摘要，而非 assistant 创作的正文。

**把文本作为命令行参数或 Shell 插值传递。** 未采用，因为 assistant 文本不受信任，可能包含控制字符和任意引号语法，也可能超过命令行长度限制。UTF-8 stdin 提供单一、精确的字节边界，并让进程 argv 不承载数据。

**依赖一个跨平台剪贴板包。** 未采用，因为随附 profile 同时运行在原生 Windows、WSL、Linux 桌面与 macOS 上。小型平台 argv 候选加 override 可让所有权与失败行为保持可检查。

## 后果

TUI 用户现在无需 API key 即可复制稳定的可见回复或其中一段 fenced code；`N` 不受压缩 replacement 和私有 reasoning 影响。剪贴板文本是会暴露给操作系统剪贴板及任何已配置 writer 的明文，因此 `clipboardTextCommand` 属于受信任的部署配置。默认桌面 helper 仍是可选宿主依赖；嵌入方可省略该边界，并会收到明确错误。

选择器现在也覆盖 Claude Code 面向 SSH 的 `w` 动作，既不会静默选择文件名，也不会静默覆盖已有目标。这是一项位于 agent 工具策略路径之外的显式宿主文件系统 mutation：由人类选择内容与路径，而破坏性重试拥有独立确认。嵌入方可省略文件边界；选择 `w` 后会收到明确错误。
