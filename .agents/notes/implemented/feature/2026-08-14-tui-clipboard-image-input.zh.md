# Agent Note：TUI 剪贴板图像输入

状态：已实现

[English](2026-08-14-tui-clipboard-image-input.md) | 中文

## 问题

恢复后的 TUI 没有多模态提示词的原生摄取路径。仓库已经具备持久附件 seam、与角色无关的 `ImageBlock`、模型能力元数据、provider 转换，以及[多模态图像输入与持久附件](2026-07-22-web-multimodal-image-input-and-durable-attachments.md)所记录的 Web 准入规则，但终端用户无法创建这些 block。Claude Code 的[交互模式参考](https://code.claude.com/docs/en/interactive-mode)记录了 Ctrl+V、Cmd+V 与 Alt+V 剪贴板图像输入，以及草稿中的 `[Image #N]` chip。TUI 不能通过把宿主路径或 base64 放进追加式会话日志、在提示词被接受前持久化图像，或让陈旧模型选择与能力检查竞态来填补这一缺口。

## 决策

`TuiRuntime.readClipboardImage` 是可替换的宿主边界。它接收 abort signal、字节上限与会话工作目录，并返回临时编码字节及声明的图像媒体类型。随附的 `readImageFromClipboard` 实现不经过 shell，直接启动精确 argv，捕获有界二进制 stdout，只为失败保留有界 stderr，在取消时终止子进程，并把退出码 3 解释为“没有图像”。主 channel 增加五秒超时，并在 dispose 时中止所有 reader。

平台选择在 Windows 与 WSL 上使用 Windows PowerShell，在 Linux 上依次使用 `wl-paste` 与 `xclip`，在 macOS 上使用 `pngpaste`。Windows reader 会依次检查 Chromium／Electron 注册的 PNG 流、位图截图和从资源管理器复制的图像文件，并把后两类规范化为 PNG。因此每条默认路径都产生 PNG。部署持有的 `clipboardImageCommand` 会用一条同样产生原始 PNG 的精确 argv 替换候选列表；它支持远程桌面与自定义剪贴板桥接，同时不把 shell 命令字符串引入运行时契约。

Windows 上的 Alt+V，以及终端会转发该按键时的 Ctrl+V，会从主编辑器调用 reader。Windows Terminal 的原生 Ctrl+V 绑定会在 TUI 观察到按键前吞掉它，因此可见快捷键提示采用与 Claude Code 一致且可靠的 Windows Alt+V 约定。若终端改为转发括号粘贴替代文本，输入边界会在转发此类粘贴前探测图像 reader，把可用图像转换为 `[Image #N]`，并原样重放纯文本内容。异步读取期间，提交与其他全局按键操作会冻结，确保结果落在激活时的光标位置。成功摄取会复制返回字节，把任何所提供路径缩减为显示 basename，应用当前媒体类型、数量、单图字节与聚合字节快速检查，并插入 `[Image #N]`。字节保存在挂载本地的 `ClipboardImageDraft` registry 中，而不进入编辑器文本。后续摄取前会清理已经删除的未保存条目；暂存 marker 会保留其字节，dispose 则释放整个 registry。

提交只识别本 channel 持有的 marker id。Shell、skill 或斜杠命令中的图像 marker 会被拒绝，并完整保留草稿。普通提示词会快照已选 provider／model、禁用输入，并解析精确模型元数据。显式 modality 列表缺少 `image` 时，会在验证或存储前拒绝；能力未知时继续交给 adapter guard。会话 reference 会在持久化前准备。随后草稿按当前附件限制检查，先验证每一张唯一临时图像、再保存任何图像，按 marker 顺序保存，并且只有全部保存成功后才把已识别 marker 替换为持久图像 block 并派发消息。重复 marker 会在模型内容中重复同一持久引用，但底层对象只保存一次。允许只包含图像的消息。

派发前的任何失败都会恢复包含 marker 的精确编辑器值，并追加终端错误。成功条目保留其持久引用，因此当前挂载中的提示词历史恢复可以重新发送而无需保留原始字节。跨挂载后，旧 `[Image #N]` 没有 registry owner，会成为普通字面文本，而不是隐式附件。用户与 assistant 图像 block 都渲染为包含格式、尺寸、编码字节数与可选显示名称的紧凑 marker；终端栅格协议不在本次范围内。

## 验证

进程边界测试固定平台命令选择、二进制 stdout、无图像退出码、字节上限、非零诊断与 abort 传播。草稿测试固定光标 marker 词汇、basename 清理、有序混合内容、纯图像投影、重复引用复用、数量与聚合限制、未知 marker 的字面行为、已删除字节清理，以及“全部验证后再保存”的规则。

已挂载 channel 测试通过 headless terminal 驱动 Alt+V、原始 Ctrl+V 与 Windows Terminal 风格的括号粘贴替代文本。它们证明图像替代文本转换、纯文本原样重放、混合与纯图像派发、显式纯文本模型在写入前拒绝、完整草稿恢复、双图验证失败时零保存，以及 reader、store 或剪贴板图像缺失时的可见降级。常规 TUI 单测、快照、lint 与类型 gate 覆盖随之变化的帮助与渲染表层。

一个无 key 的 built-lib PTY smoke 会启动随附 TUI profile，选择显式支持图像的 scripted 模型，调用输出有效单像素 PNG 的自定义剪贴板子进程，提交已插入 marker，并要求 adapter 观测到图像 block。运行后检查证明 JSONL 只包含 `sha256:` 附件引用和显示元数据，不包含 base64；在终端干净释放前，精确 PNG 字节已经存在于 `$DSH_HOME/attachments/v1/objects`。

## 考虑过的替代方案

**粘贴时立即持久化。** 拒绝，因为未发送或已删除草稿会产生持久的无 owner 对象，并需要 quota 与垃圾回收策略。提示词接受仍是与 Web 共用的持久化边界。

**在 marker 或会话中保存临时文件路径。** 拒绝，因为路径会泄露宿主布局，无法跨恢复或 fork 移植，并可能独立于事件过期或被替换。原生 bridge 可以私下暂存字节，但运行时会复制它们，每个已接受对象都由附件 store 持有。

**在编辑器文本或用户事件中内联 base64。** 拒绝，因为这会把二进制暴露给历史、渲染、压缩、token 计量与每份会话副本。Marker 只用于展示，规范消息携带小型不可变引用。

**不重新解析能力，只信任已选模型标签。** 拒绝，因为 catalog 行只是建议性数据，模型选择也可能变化。提交会解析精确的快照路由；能力元数据未知时，adapter 仍是权威边界。

**使用一个跨平台剪贴板依赖。** 拒绝，因为随附终端 profile 同时运行在原生 Windows、WSL、Linux 桌面与 macOS，其剪贴板所有权模型不同。小型、无 shell 的平台候选加 argv override 能保持失败明确且集成可替换。

## 后果

TUI 现在无需 API key 或 Web 入口即可创建仓库规范的多模态提示词表示。未发送字节是临时的；已接受字节会先于其 owner 事件持久化；失败绝不会记录原始数据或本地路径。纯文本部署保留普通 TUI chat，并在尝试图像摄取时得到明确通知。

Linux 与 macOS 默认路径依赖可用的桌面 helper，WSL 依赖 Windows PowerShell interop；`clipboardImageCommand` 是其他环境的逃生口。终端历史使用文本元数据而非内联像素。草稿图像不会跨挂载存活，持久存储仍有仓库级 reference-aware 垃圾回收债务；即使经过 TUI preflight，adapter 能力强制仍然不可省略。
