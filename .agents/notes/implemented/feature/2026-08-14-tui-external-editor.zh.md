# Agent Note: TUI 前台外部编辑器

Status: implemented

[English](2026-08-14-tui-external-editor.md) | 中文

## 问题

恢复后的 TUI 只能在 pi-tui 内编辑提示词。它缺少 Claude Code 文档所述的 Ctrl+G 和 readline 原生 Ctrl+X Ctrl+E 外部编辑器入口，无法用该入口编写用户问题的自定义回答，也没有与 `externalEditorContext` 等价的设置，不能把上一条 assistant 回复作为用后即弃的注释上下文放在文件开头。前台编辑器还需要独占继承的终端；如果 ProcessTerminal 仍持有 raw mode、bracketed paste 与光标状态时就启动编辑器，两个界面会消费同一批字节，失败后还可能破坏用户的 Shell。目标行为以 Claude Code 的[交互模式](https://code.claude.com/docs/en/interactive-mode)、[按键绑定](https://code.claude.com/docs/en/keybindings)和[配置](https://code.claude.com/docs/en/configuration)参考为准。

## 决策

`TuiRuntime.editText` 是可替换的宿主边界。channel 会传入已展开的草稿，并在配置启用时传入最新一条已提交的 assistant 文本。随附宿主提供 `editTextInExternalEditor`；嵌入方省略该边界时会收到明确错误，草稿保持不变。已附着的前台直接 Shell 会阻止该操作，因为它已经占用同一终端；活动模型轮次则不会阻止用户编写之后用于 steering 的提示词。

生产 helper 依次选择首个非空的 `VISUAL` 或 `EDITOR`，然后在 Windows 上回退到 `notepad.exe`，在其他平台回退到 `vi`。普通可执行文件的传统引号命令与参数会在不经过 Shell 的情况下解析。Windows `.cmd` 或 `.bat` 编辑器，以及直接 spawn 报告 `EINVAL` 或 `ENOENT` 的裸命令，会通过 `ComSpec` 运行；编辑器命令属于用户持有的配置，而生成文件路径通过专用环境变量传递，不插入命令字符串。子进程继承 stdio，helper 只在子进程退出后返回。因此，默认会脱离的编辑器需要使用其常规等待选项，例如 `code --wait`。

每次调用都会创建私有 `dsh-tui-editor-*` 目录与 UTF-8 `prompt.md`，等待子进程、读取已保存文件、规范化换行符和 UTF-8 BOM，然后在 `finally` 中移除该精确目录。spawn 错误、信号或非零退出会拒绝操作，且不改变实时草稿。清理失败会向外报告；编辑器失败后又发生清理失败时，会同时报告两项原因，而不掩盖第一项失败。

当 `externalEditorContext` 为 true 且存在已提交的 assistant 文本时，helper 会把该文本转换为 `#` 注释行，并放在固定的起止哨兵之间。读回时只会移除同时具备两个哨兵的生成前导块。缺少或被修改的结束哨兵会让文档保持完整，避免静默删除内容；以 Markdown 标题开头的用户草稿绝不会被当作生成上下文。除非用户主动破坏哨兵约定并把该块保留为草稿文本，否则上下文不会成为会话事件或模型输入。

channel 会设置进行中 guard、禁止主编辑器提交、排空终端输入、调用 `TUI.stop()`、等待宿主，然后调用 `TUI.start()`、使组件树失效并请求强制渲染。交接期间到达 fake 或存在异常缓冲行为的终端输入会被消费。只有成功返回后才会替换草稿；失败时则在恢复终端所有权后追加可见错误。编辑器打开期间发生 dispose 时，不会在之后重新启动 TUI。

两个编辑界面共用一个 `ExternalEditorShortcut` 识别器。Ctrl+G 会立即调用；Ctrl+X 会启动 readline 组合键，随后 Ctrl+E 调用，第二次 Ctrl+X 重新启动组合键，其他后续输入会解除前缀并继续正常传递。组合到同一分片内的传统 `\x18\x05` 也能识别。overlay 优先级保持不变，因此用户问题处于活动状态时，只有 `QuestionDialog` 会处理该快捷键。

自定义回答控件现在使用 pi-tui 的多行 `Editor`，不再使用单行 `Input`。在选项模式下按 Ctrl+G 或 Ctrl+X Ctrl+E 会切换到自定义模式，并打开同一个宿主边界；保存的多行文本可以继续在对话框中编辑，并作为自定义回答无损返回。控件图例会公开 Ctrl+G，且不会扩张主 transcript。

## 验证

纯单元测试固定命令解析、`VISUAL`／`EDITOR` 优先级、平台回退、注释块构造与移除、最新 assistant 选择、两种快捷键、真实前台 Node 编辑、非零退出、精确临时目录清理、BOM 与换行符规范化，以及带引号的 Windows `.cmd` 编辑器路径。channel 测试固定可选上下文、终端排空与 stop／start 次数、进行中输入消费、多行主草稿、无关组合键后续输入、组合分片、失败回滚、缺少宿主时的退化行为，以及多行自定义问题回答。记录的终端输出会固定返回后的两行草稿和 `started=2 stopped=1` 生命周期。

一项 keyless built-lib PTY 冒烟测试把 `VISUAL` 设为 fixture 编辑器。完成新会话交换和两个真实脚本轮次后，fixture 会要求文件中同时存在当前草稿与最新 assistant 回复，打印启动标记，并保存替换提示词。该冒烟测试会等到第三次启用 bracketed paste 后再提交，观察脚本模型的回复，并检查两份 JSONL 日志：替换提示词已持久化，原草稿与上下文哨兵均不存在。由此可在不使用 API key 的情况下，验证 Windows ConPTY 或 POSIX PTY 上的 ProcessTerminal 释放与重新接管。

## 考虑过的替代方案

**通过操作系统默认应用 API 打开文件。** 未采用，因为默认应用启动器有意采用 fire-and-forget 模式。TUI 无法得知何时重新接管 raw mode，也无法得知用户何时完成保存。

**让编辑器子进程继承 stdio 时保持 ProcessTerminal 运行。** 未采用，因为两个输入所有方会争用同一终端，bracketed-paste 状态会继续对编辑器生效，失败时还可能遗留 raw mode。

**让所有已配置编辑器都通过 Shell 运行。** 未在 POSIX 和普通 Windows 可执行文件上采用，因为直接 argv spawn 可以避免新增一层引号与展开规则。Windows 命令包装层保留一条狭窄的 Shell 路径，因为 Node 无法直接执行 `.cmd` 或 `.bat` 文件。

**保存后移除开头的所有 `#` 行。** 未采用，因为 Markdown 标题和带注释的提示词材料都可能是有效用户草稿。成对哨兵只标识生成块，并在该块被修改时采用封闭式失败。

**把多行外部自定义回答压平回旧的单行 `Input`。** 未采用，因为这会静默改变用户保存的回答。复用 pi-tui 多行编辑器可让提示词与自定义回答保持一致语义。

## 后果

TUI 现在为提示词与自定义回答提供两种文档所述的外部编辑器快捷键，会先恢复终端状态再显示结果，并确保失败编辑可安全回滚。可选的上一条回复上下文对人类编辑者可见，但按构造不会进入提交的提示词。外部编辑器操作本身只存在于终端；保存结果会成为普通草稿文本，并且只有用户提交后才进入会话。

已配置编辑器属于可信的用户配置，会收到一份包含草稿和可选上一条回复的临时明文副本。编辑器退出后会删除该副本，但编辑器自身可能保留备份或历史。会脱离的编辑器需要等待参数，已附着的前台直接 Shell 必须先转入后台或取消。`externalEditorContext` 默认为 false，因此既有部署只有显式选择后，才会把先前回复暴露给外部进程。
