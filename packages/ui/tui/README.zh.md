# @deepseek-ai/dsh-tui

[English](README.md) | 中文

DeepSeek Harness agent（智能体）的交互式终端入口，基于 [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui) 构建。它要求 stdin 和 stdout 均为 TTY；脚本和 Loader pipe 应改用 [headless agent profile](../../../examples/headless-agent/README.md)。

[恢复 TUI profile 的 Agent Note](../../../.agents/notes/implemented/feature/2026-08-14-restore-tui-profile.md)持有终端入口、受支持平台、生命周期和组装验证决策。本 README 持有下文的详细交互契约。

支持 macOS、Linux 和 Windows 上的交互式终端。Windows 使用 pi-tui 原生控制台 VT 输入处理和 ConPTY 进程验证。

本包（package）只持有交互式终端展示和输入。它注入 `agents`、[`commands`](../../interaction/commands/README.md)、`llm`、`systemPrompt`、`tokenMeter`、`tools` 和 `userInteraction`；当组合已挂载相应服务时，它还会可选读取 `skills`、`shell`、`shellEnv`、`sandboxPolicy`、`jobs`、`mcpConnections` 和 `subagents`，然后驱动由 app 或开发者代码创建或恢复的 agent。Agent 生命周期、持久化与模型侧 [`ask_user_question`](../../interaction/tool-ask-user/README.md) 工具仍是独立组合项。

终端成功启动后，本包会提供终端本地的 `ctx.tui` 扩展服务。注入该服务的插件可以使用组件工厂和受限布局选项调用 `openOverlay()`；宿主会公开 viewport、语义化主题（包括终端安全的 DeepSeek `brand` 样式）、显示文本转义、重绘、关闭和生命周期信号，但不公开 pi-tui 树、终端、焦点控制器或 overlay 句柄。插件 overlay、模型选择器和用户问题共用一个 FIFO 模态队列。每个请求都是调用方插件 fiber 的 effect，因此卸载会移除排队工作，或在清理结算前关闭可见工作；终端关闭会先卸载依赖项，再停止 pi-tui。Overlay 状态不会记录或回放。组件代码受信任，可以渲染 ANSI 样式，但必须通过 `host.display()` 处理不受信任文本。

TUI 以 Claude Code 的视觉语言从追加来源的会话事件重建已恢复历史：已接受提示词带加粗陶土色 `❯` 轨道，assistant 输出以终端默认色无标题渲染，reasoning 以暗色 `✻ Reasoning` 开头，每次工具调用渲染为按家族着色的 `Verb(argument)` 卡片，带有状态字形（`⠋` 进行中、`›` 成功、`✗` 错误）、`⎿` 前缀正文和达到一秒后的有界耗时。它渲染 Markdown 响应与 reasoning，将每个工具的 `presentCall` / `presentResult` 意图应用到终端、diff 或通用卡片，把站立的 `todo/write` 计划保留在编辑器上方（下一个 `turn/start` 时清空），并在 transcript／状态区域与编辑器之间内联展示 `ctx.userInteraction` 问题。问题面板会显示进度、编号选项、换行标签和另行缩进的描述；它同时遵守 `maxQuestionOptions` 和 `questionDialogMaxHeight`，用 `↑ N more`／`↓ N more` 标记隐藏选项，并在保持编辑器可见的同时，通过 Page Up 和 Page Down 先分页浏览过长的问题／详情内容，再分页浏览单个超大的选中块。最新记录的会话标题成为 header 副标题；标题不存在时使用 `welcome`，终端窗口标题则变为 `<session title> — <configured title>`。持久 `llm/retry` 事件会撤回失败步骤的实时 chunk，并在 transcript（文本记录）中渲染计划重试次数、延迟和失败；成功、耗尽与取消随后通过普通会话事件结算。Footer 会对每个已记录模型步骤的用量只计一次，包括失败尝试；对于没有用量 chunk 的日志，以已提交消息的用量回退。其空闲视图会将 token-meter 压力与 `ctx.llm.resolveModelInfo()` 为当前路由返回的上下文容量进行比较；适配器没有容量元数据时显示 `context unknown`，并显示工具卡片模式、当前模型，以及任何显式选择的推理强度。Agent 运行时，这些摘要会替换为已经过工作时间指示器和 `esc interrupt`。表层替换从不重写已渲染的 transcript：被它遮蔽的对话仍可阅读，而已落地的压缩（compaction）检查点会在其日志位置添加一行暗色 `… earlier context was compacted …` 标记，因此终端报告的是模型从何处起不再看到那段历史，而不是把它抹掉。仅供模型使用的替换副本——被裁剪的工具结果、重新生成的 assistant 消息——不渲染任何内容。

持久日志会先记录 `step/start`，随后才记录该步骤已接受的用户消息与注入上下文消息。因此 TUI 只把 start 当作计时状态，直至首个 assistant chunk 或已提交 assistant 消息出现时才创建无标题 assistant 块；空步骤可以在 `step/end` 结算而不留下幽灵行。实时渲染与回放都会保持先 `❯` 用户／上下文、后无标题 assistant 块的对话顺序。

如果逻辑工作区标签与会话宿主目录不同，嵌入方可以提供 `TuiRuntime.formatCwd`。该覆盖只改变 footer 标签；工具仍使用会话 `cwd`。

在模型输出、会话事件、工具 presenter、问题、配置或诊断到达 pi-tui 的 ANSI 感知 renderer 或终端标题前，TUI 会把换行之外的 C0 和 C1 控制字符渲染为可见 `\xNN` 文本。这些来源无法添加终端控制序列；终端渲染与样式仍由 TUI 和 pi-tui 持有。

在 token 边界输入 `@` 会搜索会话工作目录下的文件和目录。没有路径的模糊查询使用可复用的有界工作区索引；包含 `/` 的查询直接列出该目录，选择文件夹后会保持补全开启以继续深入。含空白的路径会插入为 `@"path with spaces"`。选择文件只会插入其路径和一个尾随空格：TUI 不会读取文件、附加隐藏上下文，也不会把路径替换为引用对象。注册模型侧 `read` 工具后，TUI 会添加一条固定系统提示词指令，要求模型在需要显式路径内容时读取该路径。

挂载可选的 `ctx.sessionReferences` 后，同一个 `@` 菜单还会提供仅含元数据的会话候选项，插入 `@[label](dsh-session:<payload>)`，并在分派前准备所选快照。会话引用保持结构化，因为模型没有类似文件系统的工具可在稍后检索会话快照。准备期间会禁止重复提交，并在失败时恢复编辑器输入。TUI 会在异步准备后根据状态选择 `agent.steer()` 或 `agent.followup()`，因此空闲 followup 仍会分派 `agent/prompt-submit`，而轮次中的 steering 会在检查点加入且不触发该 hook。

Agent 运行时，普通编辑器提交会调用 `agent.steer()`；其他时候调用 `agent.followup()`。提交行以斜杠开头时会改为进入 `ctx.commands`：已知命令直接执行，未知命令产生警告，两条路径都不会自动到达模型。命令生产方可以显式调度 agent 工作；[`dsh-plan-mode`](../../plan/plan-mode/README.md#model-and-human-surfaces) 使用该契约实现 `/plan [message]`。TUI 将 `/help`、`/model`、`/effort`、`/rename`、`/clear`、`/new`、`/reset`、`/config`、`/copy`、`/export`、`/context`、`/details`、`/palette`、`/reload`、`/resume`、`/continue`、`/status`、`/tasks` 和 `/exit` 注册为 agent 作用域定义；其他所有有效命令都会动态加入自动补全与 `/help`，`/skill:` 补全也相同。编辑器上方的状态行会报告 TUI 从会话事件派生的轮次阶段，包括等待首个 token、思考、响应或执行工具；它显示该阶段已经过时间和运行中的步骤总数，每秒刷新，并以 `Enter sends steering, Esc cancels` 提示结尾。Steering 消息等待到达模型期间，会在提示前插入 `N queued ·` 徽标，每条消息排空后随即清除。在实时独立压缩（compaction）标记对处于开启状态期间，提示词上方会显示固定的 `Context being compacted <elapsed>` 状态行，空闲提示符光标会变成占一个终端字符单元并呈呼吸律动的 `⊙`，终端进度状态则会保持活跃，直至标记对闭合；该状态行和字形共用标记对的同一个刷新定时器。该实时状态绝不会从日志中重建；闭合失败时会向 transcript 添加 `Compaction failed: <error>`，而恢复会话时遇到的陈旧未匹配 start 绝不会激活该指示器。Ctrl+C 或 Escape 会取消运行中的轮次。工具卡片与注入上下文卡片都把长主体折叠为可配置的头尾预览；Ctrl+O 让工具卡片在折叠预览、完整输出、隐藏三种状态间循环——隐藏阶段把工具卡片从 transcript 中完全去掉，而上下文卡片保持预览，因为注入的指令不属于工具流量。隐藏阶段还会把每个轮次的 assistant 步骤折叠为一个块：第一个有可见文本或 reasoning 的步骤保留前导间距，之后的步骤渲染为续段，没有可见正文的步骤则不渲染任何内容；离开隐藏阶段会恢复每步各自的间距。注入上下文卡片把消息渲染为文本，并去掉生产方的外层提醒外框，因此折叠与去外框都不依赖载荷的语法。Ctrl+R 打开提示词历史；Ctrl+L 的重绘与新会话行为、编辑器内删除和空输入确认退出遵循下文规则。`/details` 持有 transcript 的两个细节维度：不带参数时打开一个居中的键盘开关，每个维度一个条目——`Tool cards` 与 `Reasoning`——显示实时值，Tab 循环高亮条目并立即应用变更（对话框背后的 transcript 即是预览），Enter、Esc 或 Ctrl+C 关闭；`/details collapsed|expanded|hidden` 让工具卡片直接跳到该阶段，`/details reasoning [on|off]` 设置——或裸 `reasoning` 切换——reasoning 块显示；参数可在一次调用中组合，未知参数会以用法行报错，组合调用先应用 reasoning，使其 transcript 重建不会丢掉卡片通知。

Ctrl+R 会打开一个全 viewport 的字面搜索界面，检索编辑器中已被接受的精确提交。初始作用域是当前会话；Ctrl+S 会依次切换到当前项目和所有项目，同时通过可选 session-query 服务渐进加载旧会话。结果按时间从新到旧排列，重复文本只保留最新观察。键入文本可过滤，Up/Down 或 Page Up/Page Down 用于导航，Tab 只插入而不提交，Enter 插入后立即提交；Esc、Ctrl+C 或空查询上的 Backspace 会取消且不改动原草稿。当前会话可同步使用；跨会话发现会在有界的近期本地与外部项目会话之间平衡名额，以有界并发读取，并跳过单个不可读会话。精确提交以只写日志的 `tui/input` 事件持久化，包括普通提示词、斜杠命令、`/skill:` 调用和感叹号命令。旧会话只在能够精确重建时恢复普通用户提示词、斜杠命令和已完成 Shell 命令；已展开的旧版 skill 正文会被省略。

首字符为感叹号时会进入直接 Shell 模式：`! <command>` 通过已挂载的 `ctx.shell` 执行器，在会话工作目录中启动一条由用户明确授权的进程。由于命令由用户直接输入，它不会进入模型工具审批；但在相关服务已挂载时，仍会接收组合的常驻沙箱策略和受管 `DSH_*` 环境。TUI 会把有界的合并输出实时流入所附终端行；Ctrl+C 取消它，活动期间 Ctrl+D 只发出警告而不退出；缺少执行器或只输入 `!` 时，草稿会保留在编辑器中。每条已接受命令都会立即进入有界的项目历史。光标位于 `!` 草稿末尾时，Tab 会按命令前缀从新到旧补全：当前 channel 的命令无需等待即可返回；可选的 session-query 服务还会惰性恢复规范化工作目录相同的最近 32 个会话中的已完成 `user-shell` 通知。重复命令只保留最新观察，最多保留 100 条命令，精确读取的并发数为 4；不可用或损坏的历史来源只会丢失自身候选。当前 Shell token 包含 `/` 时，会改为在输入过程中打开宿主路径补全；目录保留尾随斜杠以便继续下钻，Windows 上的显示与插入路径也使用正斜杠。`ctx.jobs` 与控制器可用时，Ctrl+B 会在注册表预检成功后把同一条存活进程原子移交为 `bash-N` 任务、移除所附行并重新开放编辑器；预检失败则同一进程仍留在前台。`/tasks` 列出当前 agent 的任务 id、生命周期状态、标签和终止详情。已完成的命令（包括非零退出，无论留在前台还是移入后台）只会成为一份持久 `user-shell` 上下文，并自动启动或 steer 模型；生产方持有的交付会把已移交任务标为 reported，通用 jobs 监听器不会再发送重复完成通知。取消和基础设施故障只保留为终端通知。`/help` 也会记录 `! <command>`、Ctrl+B 与 `/tasks`。

`/model` 与 Alt+P 将建议性的 `ctx.llm` catalog 打开为键盘选择器：列表上方设有一个过滤框，按对每行 `provider/model` 标签、模型名称和描述的大小写不敏感子串匹配来缩小行集，并在高亮行仍通过过滤时保持其选中状态；Up/Down 移动，Shift+Tab 按显示顺序循环切换适配器为焦点模型公布的推理强度，Enter 选择模型和推理强度，Escape 会先清除非空过滤内容，再次按下才关闭选择器。适配器未公布默认推理强度时，循环还会包含 `Default`，该项会清除显式选择并保留提供方默认行为；没有可选推理强度元数据的模型会忽略 Shift+Tab。选择器会原样呈现公布的推理强度列表（包括存在时的 `off`），不会合成、自动调整或在模型之间转移推理强度。`/model <model>` 仍可直接选择无歧义的模型 id，`/model <provider>/<model>` 则选择精确目标，并在存在时使用其适配器默认值。已配置目标或最新记录的请求 header 会初始化选择器；由于 catalog 仅提供建议，未列出的当前模型仍会显示。选择仅对本 TUI 会话有效。提示词组装会为一个步骤建立目标快照，替换 `{{provider}}` 和 `{{model}}`，并通过 `agent/request` 应用同一个提供方／模型／推理强度目标；因此组装期间的切换会从后续步骤开始生效。请求 header 会持久记录真正到达模型的目标，未使用的选择则只存在于进程本地。

不带参数的 `/effort` 会为当前精确路由打开推理强度选择器。`Auto` 会清除显式值，保留适配器配置的默认值；适配器未声明默认值时则保留提供方默认行为。其后按适配器偏好的显示顺序列出全部强度；`/effort <id>` 与 `/effort auto` 可直接应用同样的选择，Left/Right 与 Up/Down 都可循环移动。Alt+T 在 `off` 与该精确路由最近使用的已公布非 `off` 强度之间切换；没有记忆值时依次回退到已公布的非 `off` 默认值和首个非 `off` 条目。模型没有推理元数据、没有 `off` 或没有任何启用强度时，TUI 会解释为何不能执行，而不会虚构能力。这些控制保留编辑器草稿，在轮次运行中仍可使用，并只影响之后建立快照的步骤。

`/rename <name>` 会通过已挂载的 session-title 服务同步规范化并持久化一份由用户所有的标题。不带参数的 `/rename` 则从合格的人类对话历史刷新标题：存在已注册标题提供方时使用该提供方，否则使用确定性回退；不存在合格的人类消息时会报错。两种形式都从同一条 `session/title` 事件更新 banner、终端窗口标题、`/status` 和恢复发现，且不会增加模型可见内容。显式名称会钉住自动标题生成；之后不带参数的刷新会有意解除该状态。组合未挂载标题服务时会明确报告能力不可用。

`/reload`（实验性，仅开发环境）会重新读取所有基于文件的 loader 配置树，并把 diff 应用到运行中 app：它手动调用 HMR（热模块替换）watcher 的配置路径；上下文中必须有 cordis Loader，否则退化为警告。它只在 agent 空闲时运行，并拒绝 reload 进行期间的再次进入。模块源代码热重载仍由 watcher 持有。挂载 `skills` 服务后，`/skill:<name> [instructions]` 会把该 skill 的指令作为一个 user 轮次加载到会话中；自动补全列出用户可调用的 skill，按精确名称调用时也会拒绝用户策略禁用的 skill。

挂载 `mcpConnections` 后，`/mcp` 只列出每个服务器的名称、传输方式、生命周期状态、重连尝试次数和公开工具名称；`/mcp <server>` 会收窄显示，`/mcp reload` 则使用与 `/reload` 相同的 Loader 刷新。目录绝不渲染 endpoint、命令、环境变量值、请求头或失败文本。`/mcp` 只存在于终端，本身不改变模型可见的工具状态。

挂载 `subagents` 后，裸 `/agents` 会显示持久化的后代树，但不会加载子 agent 的提示词或 transcript。`/agents start <task>` 通过已配置的 `spawn` provider 创建可继续子 agent，`/agents send <id> <message>` 则以用户归属的消息恢复或排队一个直接的可继续子 agent。`/agents stop <id>` 只接受存活的直接可继续子 agent，并发出人类父级的中断请求；它报告请求已经发出，而不声称已立即结算。后代行仍可见，但直接的人类控制不会凭空取得另一个子 agent 工作的权限。

Footer 将会话报告的用量汇总为 `↑<uncached input> ↓<output>`；任何输入计费后，后面会显示 `cache <rate>%`，表示提供方缓存服务的已计费提示词 token 占比（未缓存输入加缓存读写），并四舍五入为百分比。它还会将 token-meter 压力与 `ctx.llm.resolveModelInfo()` 为当前路由返回的上下文容量进行比较（适配器没有容量元数据时省略上下文占比），并显示当前模型和工具卡片模式；footer 过窄时，右侧会优先裁剪。

`/context` 会向 transcript 添加一张时间点上下文卡片，并在 agent 运行时保持可用。其占用 meter 使用 token-meter 请求压力与所选模型公布的容量；它会标记未知容量、区分提供方 usage 锚点与估算 baseline、报告超容量压力，并在达到或超过 80% 时建议 `/compact`。挂载 session-projection registry 后，第二条分段 meter 与对应行会显示 system prompt、工具 schema 和模型可见对话的启发式组成；这些组件估算会明确说明不能作为提供方锚定压力的求和项。`/context all` 还会按顺序列出当前经过 replacement 后的模型 surface 上每个节点，包括其持久 seq、来源角色和启发式 token 价格。两种形式都只存在于终端，不会增加模型可见内容。

`/status` 会向 transcript 添加一张时间点诊断卡片，并在 agent 运行时保持可用。它报告会话 id、标题、工作目录、所选提供方／模型、所选推理强度或默认行为、reasoning 块可见性、agent 状态、事件／轮次／步骤／工具调用计数、精确输入／输出／缓存 token bucket、KV-cache 命中率、token-meter 上下文用量与容量、创建时间和最新事件时间。缺失标题、模型、缓存输入或上下文容量时会明确标记，而非推断。该卡片只存在于终端，不会重复紧凑 footer。

随附的 `dsh` runner 在不带 `--resume` 启动时，会先分配新的 `session-<UUID>` 身份，再创建 Agent。未恢复启动绝不会复用 `main` 或其他已持久化 id，因此在同一工作区重复启动不会与已有持久日志发生冲突。已有会话只能通过 `--resume <session>` 或 TUI 内的恢复流程进入；旧版 `main` 日志会原样保留，仍可用 `--resume main` 恢复。

`/resume [session]` 与其别名 `/continue [session]` 共用一条恢复路径。不带参数时，两者都会打开全 viewport 键盘选择器，而非居中对话框。带参数时，TUI 会绕过选择器：精确会话 id 优先，否则该引用必须是同一候选集里区分大小写且唯一的精确标题。引用不存在或标题重名都会在 channel 交换前失败；标题歧义诊断会按稳定顺序列出匹配的 id。选择器在命令执行时立即打开并接管输入焦点，会话扫描仍在进行时显示加载占位符，直到行数据就绪；Escape 取消进行中的扫描，方式与取消已加载列表相同。两个作用域覆盖同一候选项集合：打开时所处的当前工作区，以及按 Tab 切换到的所有工作区。搜索字段下方的作用域行会给出当前作用域的名称以及另一个作用域包含的数量，且在所有工作区作用域中每行还会报告自身所属的工作区。切换会清除搜索与选择，使高亮行始终属于可见列表。

获得焦点的搜索字段紧跟搜索 glyph 开始，并发出 pi-tui 的 cursor marker，使终端 IME 组合保持锚定在字段内。行数据不读取任何完整日志：挂载可选的投影缓存时，标题来自实时投影注册表或持久化 checkpoint 行，冷读取只折叠 checkpoint 之后的日志尾部（并写回，使下次扫描零 I/O，受 `resumeScanConcurrency` 约束）；未挂载缓存的组合回退到一次对日志的有界批量标题读取。候选项按元数据活动时间排序——实时会话取内存中最后一个事件的时间，否则取持久化产物的 mtime，再回退到创建时间——可按标题或会话 id 搜索，在所有工作区作用域中还可按工作区标签搜索；每行报告该时间戳、current/live/persisted 状态和 id。Up/Down 与 Page Up/Page Down 导航，Enter 恢复，Escape 会先清除非空搜索，再次按下才取消，Ctrl+C 则直接取消。当前会话、已在本运行时中活跃的会话、不可读日志，或没有可运行的已记录工作区的会话仍会显示，但不可选择；不同于当前工作区的工作区属于作用域而非禁用原因，因为恢复会进入该目录。

选择器选中与直接引用都会重复这些检查，完整读取并回放验证最终选中的那一份日志，在其日志所记提供方没有当前适配器时拒绝，并要求当前 agent 空闲，随后 flush 当前会话。TUI 接着排空待处理终端输入，并以所选 id 调用由宿主持有的可选 `TuiRuntime.swapResume`。随附 runner 会先准备恢复后的 Agent，仅在准备提交后才让旧 handle 退役，并在 `tui-agent/ready` 上重新挂载终端 channel；拒绝则让原 channel 保持可用。文件系统、shell 与持久终端工具都依据恢复出的会话头部 `cwd` 解析 agent 工作，因此进程内跨工作区交换无需改变进程全局 cwd。恢复操作保留相同的 `SessionId`、transcript、标题、todo 和持久目标；目标激活仍保持解除，TUI 会要求用户确认或执行 `/goal resume`。

退出时打印的行由启动器拥有，不可通过配置指定。启动器在启动上下文上提供 `TUI_GOODBYE_MESSAGE_KEY`（对于随附的 `dsh`，即恢复本会话的命令），释放终端后退出会原样打印它；未提供时退出不打印任何内容。只有启动器知道自己是如何被调用的，因此只有它能给出可用的命令。TUI 在渲染前会转义终端控制字符，且绝不执行该文本。若启动器同时提供 `MAIN_SESSION_ID_KEY`，则会固定已挂载应用绑定的会话，因此恢复功能不受配置层修补影响。

启动器可通过在启动上下文上提供 `INITIAL_SKILL_KEY`（skill 名称）来播种全新会话的首轮；聊天就绪后，TUI 会像用户手动键入 `/skill:<name>` 一样自动调用它。随附的 `dsh migrate`/`dsh upgrade` 会设置该键，且仅对全新会话设置，因此恢复的会话绝不会重复调用该 skill；未知名称会以通知形式报告。

## 编辑器安全性与可发现性

主编辑器为空时，`?` 会打开居中的键盘快捷键参考面板；`?`、Escape 或 Ctrl+C 可关闭。存在任何草稿文本时，`?` 仍是普通的可编辑输入。Alt+P 会打开与不带参数的 `/model` 相同的模型与推理强度选择器；Alt+T 会切换当前模型公布的 thinking 状态且不改变草稿。Ctrl+T 会切换常驻任务清单的显隐，但不改变草稿文本或持久 `todo/write` 状态；清单隐藏后仍会接收更新，再次显示时会呈现最新快照。

Ctrl+S 会暂存主编辑器中的任意非空草稿并清空编辑器；在空编辑器中按下则会恢复最新暂存及其精确光标位置、撤销历史和 pi-tui 大段粘贴内容。存在另一份非空草稿时按 Ctrl+S 会替换旧暂存。暂存只存在于当前 TUI 挂载期间，并在恢复时被消费。

Ctrl+V 或 Alt+V 会从桌面剪贴板读取一张栅格图像，并在编辑器的精确光标位置插入 `[Image #N]`。编码字节只存在于草稿中：删除 marker 后，下一次摄取会释放未保存图像；只有提交包含 marker 的普通提示词时才会持久化附件。发送准入会快照已选路由，在存储前拒绝显式纯文本模型，解析会话 mention，先验证每一张临时图像、再保存第一张，随后按内容顺序把 marker 替换为持久 `ImageBlock` 引用并派发消息。可以只发送图像。读取、能力、解码、限制或存储失败都会把包含 marker 的完整草稿留在编辑器中；图像 marker 不能附带在 `!`、`/skill:` 或其他斜杠命令中。Transcript 中的用户与 assistant 图像以紧凑的格式／尺寸／字节元数据 marker 显示，而不是原始终端图形；路径和 base64 都不会进入会话日志。

随附 reader 在 Windows 与 WSL 上使用 Windows PowerShell，在 Linux 上依次使用 `wl-paste` 与 `xclip`，在 macOS 上使用 `pngpaste`。`clipboardImageCommand` 可用精确、无 shell 的 argv 替换平台选择；其 stdout 必须是原始 PNG，退出码 3 表示“没有图像”。这也是远程桌面与自定义剪贴板桥接的集成 seam。剪贴板读取受字节上限约束，会在 TUI dispose 时取消，并在五秒后超时。部署缺少 `ctx.attachments`、宿主缺少 reader 或剪贴板中没有图像时，会显示明确的终端通知且保持草稿不变。

`/copy [N]` 会复制最新一条可见 assistant 回复；N 为正整数时复制倒数第 N 条。选择按持久 `assistant/message` 事件从新到旧进行，并且只接受 append-origin 可见文本：reasoning、工具调用、纯图像消息、纯空白消息与仅供模型使用的 replacement 都不占用序号。多个文本 block 会原样拼接。回复包含非空 Markdown fenced code 时，会打开键盘选择器，可选择完整回复或按源顺序排列的各段代码正文；Up／Down 移动，Enter 复制，`w` 把高亮目标写入文件，Escape 或 Ctrl+C 取消。文件动作会提示输入路径；相对路径按会话工作目录解析，新文件采用独占创建，已有文件只有在用户明确按下 `y` 后才会被替换。空 fence 不会成为候选。该操作只由人类触发，不会把所选文本或路径发送给模型；斜杠调用本身仍遵循普通 TUI 输入／命令日志生命周期。

随附剪贴板 writer 不经 shell，把 UTF-8 文本从 stdin 交给精确 argv：Windows 与 WSL 使用 Windows PowerShell，Linux 依次尝试 `wl-copy` 和 `xclip`，macOS 使用 `pbcopy`。`clipboardTextCommand` 可用一条受信任的精确 argv 替换平台选择，以支持远程会话或自定义桥接。所选 assistant 文本与导出的对话内容都不会进入 argv 或 shell 插值；stderr 有界，非零退出会明确显示，channel dispose 或五秒超时时会取消子进程。已配置 helper 会收到所选明文内容，因此属于用户信任的部署边界。随附文件 writer 同样绕过 shell，把所选内容按精确 UTF-8 写入；它不会创建缺失的父目录，文件系统失败会显示在 transcript 中，channel dispose 时会取消写入。

Ctrl+G 或 readline 原生的 Ctrl+X Ctrl+E 组合键会在前台外部编辑器中打开当前提示词。同一绑定也可从用户问题面板打开多行自定义回答；必要时会先把选项面板切换到自定义模式。随附宿主依次选择 `VISUAL`、`EDITOR`，然后在 Windows 上回退到 `notepad.exe`，在其他平台回退到 `vi`；通常会脱离当前进程的编辑器必须在配置中加入等待参数，例如 `code --wait`。启动前，TUI 会排空待处理输入并释放终端 raw mode；编辑器成功退出后，TUI 重新接管终端、强制完整重绘，并且只替换草稿。交接期间收到的按键会被消费；启动失败或编辑器以非零状态退出时，草稿保持不变；已附着的前台 Shell 必须先转入后台或取消。

设置 `externalEditorContext: true` 后，临时文件会在开头放入最新一条已提交的 assistant 回复，并使用 `#` 注释和哨兵划定上下文块。保存时只移除该生成的前导块，用户在草稿中自行编写的 `#` 行保持不变。无论成功还是失败，私有临时目录都会被移除。打开、保存和返回都不会创建会话事件或模型可见内容；只有之后的普通提交才会发送编辑后的草稿。

Ctrl+X Ctrl+K 会在三秒内再次按下同一组合键确认后，停止本会话中仍在运行的后台子代理。该控制覆盖精确归属当前 agent 且运行中的一次性 subagent job，以及直接、活跃的可继续子 agent；它会有意保留 bash job、外部或无归属 job、已完成工作和仍驻留但空闲的 continuation。主 agent 轮次运行时仍可使用该控制，当前草稿保持不变，且整个交互只存在于终端。发现与取消故障会按目标隔离，因此单个损坏子项不会阻止其他兄弟项接收停止请求；两个可选服务都未挂载的最小嵌入会明确报告该控制不可用。

不带参数的 `/config` 会打开 `ui-tui` 实时用户设置 namespace 的双条目键盘选择器：reasoning 块显示和外部编辑器上下文。Up/Down 移动，Enter 或 Space 切换，Escape 或 Ctrl+C 关闭。随附 settings 提供方把 `$DSH_HOME/settings.yaml` 分层覆盖在 Cordis 条目值之上，并且只持久化选中的用户覆盖；值只有在验证和存储提交后才会应用到已挂载 channel，写入失败则保留原值并在对话框中显示，不会乐观变更。提供方文件的外部编辑会热应用同一份已提交值，全新或恢复的 channel 也会重新读取。没有可写 settings 提供方的嵌入方仍可查看组合值，但保存会显式失败。

Ctrl+L 总会强制执行一次完整重绘，且不改变当前草稿。Agent 与前台 Shell 都空闲时，首次按下还会显示一条持续两秒的确认提示；在窗口内再次按下 Ctrl+L 会执行不带参数的 `/clear`。手动输入的 `/clear`、它的 `/new` 与 `/reset` 别名以及确认后的 Ctrl+L 共用一条路径：flush 当前日志、排空终端输入，然后请求宿主在同一工作区原子挂载一个具有唯一标识的新会话，并携带已选模型与推理强度。`/clear <name>`（同样包括 `/new <name>` 与 `/reset <name>`）会在空闲预检通过后，先把该名称持久化到旧会话，再进入同一条新建会话路径；标题无效或未挂载标题服务时，当前会话保持不变。旧会话保持持久化且可恢复。活动工作必须先完成或取消。宿主交换失败后原 channel 仍可使用；未提供 `TuiRuntime.swapFresh` 的嵌入方只会清空对话视图，并报告无法创建新会话。

Ctrl+D 会根据上下文处理：有草稿文本时，它仍由编辑器处理，删除光标后的字符；编辑器为空时，首次按下会显示 `Press Ctrl+D again to exit`，只有在 800 ms 内再按一次 Ctrl+D 才退出。空闲 Ctrl+C 在其常规清空输入行为之后遵循相同的确认窗口。任意其他按键或超时都会解除确认。工作活动期间，Ctrl+C 仍会取消前台 Shell 或 agent 轮次，Ctrl+D 仍只警告而不退出。`/exit` 与 `/quit` 仍是显式的单步命令。

快捷键面板、退出与 Ctrl+L 确认提示、提示词暂存、外部编辑器的启动与返回、模型与推理强度控制、任务清单可见性、编辑器内删除和首次按下时的重绘都只存在于终端。它们不追加会话事件，也不添加模型可见内容；确认 Ctrl+L 会有意进入上文的 `/clear` 会话生命周期路径，外部编辑器保存的结果会成为普通草稿文本，模型或推理强度选择的路由与缓存影响则见“会话模型选择”。

`/export [filename]` 会将当前持久对话渲染为可读的纯文本。提供文件名时使用该路径；不提供时，键盘选择器会提供复制到剪贴板或保存到相对默认文件 `dsh-session-<session-id>.txt`。导出包含用户消息、注入上下文消息、已结算的 assistant 消息、工具调用与结果，以及未完成轮次的标记；原始流式 chunk 和请求记账信息会被省略。文件写入与 `/copy` 使用同一独占创建和显式覆盖流程。导出只存在于终端：不会把内容或目标路径发送给模型，但斜杠调用仍遵循普通 TUI 输入／命令日志生命周期。

`/diff` 会打开只读分页器，查看会话工作目录下的已暂存、未暂存和未被忽略的未跟踪改动；diff 文本绝不会发送给模型。`/checkpoint [label]` 会保存一个手动选定的稳定对话边界；当该目录位于 Git 工作树中时，还会把已暂存／未暂存补丁与未被忽略的未跟踪文件保存到 `DSH_HOME`，Git 之外则仅保存对话检查点。`/rewind [checkpoint-id]` 在未提供 id 时打开检查点选择器，随后分别选择恢复工作区文件、分支对话或两者，并必须输入 `y` 才会执行。文件恢复会先创建回退前的安全检查点，并拒绝不同 Git 根目录、会话目录或 `HEAD`；对话回退会从保存的已完成边界创建子会话，原会话仍可恢复。diff、检查点文件、对话框和目标选择只存在于终端本地而非模型上下文；斜杠命令生命周期仍会作为只写日志历史持久化。

TUI 内建命令集包含 `/diff`、`/checkpoint` 和 `/rewind`；`/help` 会显示它们在当前部署中可用的精确形式。

## 模式控制

在主编辑器中，Shift+Tab 会循环切换有效交互模式；无法区分 Shift+Tab 的终端可以使用等价的 Alt+M。循环按组合配置表的顺序使用安全的 [`ctx.permissionPresets`](../../interaction/permission-presets/README.md)，随后进入 [`Plan`](../../plan/plan-mode/README.md)；进入 Plan 绝不会暗中改写权限。派生的 `custom` 权限只用于显示，因此其下一个循环目标是第一个已配置安全 preset。仅挂载 plan mode 时，循环为 `Normal`／`Plan`。

沙箱为 `danger-full-access` 的 preset 不会出现在普通键盘循环中。只有它已经生效后——例如用户显式运行 `/permission danger-full-access`——才会加入后续循环，并在本次 TUI 挂载的剩余期间保持解锁，使用户可以离开后再返回。这样快捷键不会自行提权，同时也不会隐藏显式选中的状态。

每次选择都通过持有状态的服务 setter 完成。轮次中的 Plan 转换会立即渲染为 `Plan (pending)`，直到下一个被接受的 pre-step 提交；权限 preset 仍独立持久化。默认的 `${mode}${queued}` 右侧提示词模板会显示 `⏵ <preset>`、`⏸ Plan` 或警告色的 `⏵⏵ Full access`；`/status` 报告同一有效目标。两个可选服务都未挂载时，`${mode}` 不贡献内容，快捷键则报告模式切换不可用。

## 配置

下表中的 Cordis 字段构成组合层。`/config` 只公开可实时生效并持久化到用户 settings 文档 `ui-tui` 分节的 `showReasoning` 与 `externalEditorContext`；布局和资源上限仍属于部署配置。

| 键 | 默认值 | 含义 |
|---|---|---|
| `welcome` | 未设置 | 会话出现已记录标题前使用的 banner 副标题行；未设置时，banner 进入时没有副标题 |
| `sessionId` | `main` | 由终端驱动的精确共享 agent／会话身份 |
| `showReasoning` | `true` | 渲染 reasoning 块 |
| `externalEditorContext` | `false` | 把最新 assistant 回复作为生成的注释块放在外部编辑器开头，并在保存时移除该块 |
| `clipboardImageCommand` | 平台 helper | 可选的精确 argv，把原始 PNG 写入 stdout；退出码 3 表示剪贴板中没有图像 |
| `clipboardTextCommand` | 平台 helper | 可选的精确 argv，从 UTF-8 stdin 接收要复制的 assistant 文本 |
| `maxToolOutputLines` | `6` | 折叠工具卡片的头尾预览所保留的输出行数 |
| `maxDiffEditLength` | `1000` | 回退到整侧展示前，精确 diff 最多探索的新增与删除行总数 |
| `maxQuestionOptions` | `8` | 一次最多可见的选项块数；行数边界可能进一步减少可见数量 |
| `maxModelOptions` | `8` | 模型选择器中可见的模型数 |
| `maxResumeOptions` | `8` | 恢复选择器中可见的会话数 |
| `resumeScanConcurrency` | `4` | 一次恢复扫描中并发冷读取标题的最大数量 |
| `maxHistoryOptions` | `8` | 一次可见的提示词历史匹配数 |
| `historyMaxEntries` | `1000` | 一个作用域返回的最大唯一提示词历史匹配数 |
| `historyMaxSessions` | `128` | 一次提示词历史扫描检查的最大旧会话数 |
| `historyScanConcurrency` | `4` | 一次提示词历史扫描中并发精确读取的最大数量 |
| `questionDialogWidth` | `200` | 问题面板宽度（列数），以终端宽度为上限 |
| `questionDialogMaxHeight` | `20` | 问题面板最大行数，会进一步受限以保留编辑器 |
| `modelDialogWidth` | `76` | 模型选择器宽度（列数） |
| `modelDialogMaxHeight` | `20` | 模型选择器最大行数 |
| `detailsDialogWidth` | `72` | transcript 细节选择器宽度（列数） |
| `settingsDialogWidth` | `72` | 实时设置选择器宽度（列数） |
| `directShellOutputMaxBytes` | `64000` | 为一条直接 Shell 进程的实时、任务读取和最终结果视图保留的 UTF-8 字节数 |
| `directShellOutputRefreshMs` | `50` | 直接 Shell 增量输出读取之间的毫秒数 |
| `fileSearchMaxResults` | `20` | 一次 `@` 查询显示的最大文件和目录候选数 |
| `fileSearchMaxEntries` | `10000` | 无路径模糊查询使用的有界工作区索引最多保留的路径数 |
| `fileSearchExcludedDirectories` | `['.git', 'node_modules']` | 遍历和直接补全时忽略的目录 basename |
| `showHardwareCursor` | `false` | 在 pi-tui 的 IME marker 处显示硬件 cursor |
| `theme.color` | `true` | 应用内置 ANSI palette（参见[颜色](#color)） |
| `theme.palette` | `claude` | palette 风格：`claude` 在终端支持真彩色时固定为 Claude Code 的陶土色真彩色 token；`adaptive` 只使用跟随终端配色方案的 ANSI 角色 |
| `theme.truecolor` | 自动 | 应用 Claude 真彩色 palette 与品牌渐变；未设置时根据 `COLORTERM` 自动检测 |
| `theme.leftPrompt` | `${cwd}${git/worktree}${model}${token_meter/cache_hit_rate}${context}` | 左对齐提示词模板 |
| `theme.rightPrompt` | `${mode}${queued}` | 右对齐提示词模板；内置模式与排队 steering 指示器不可用时会自行省略 |
| `theme.inputPrompt` | `${symbol}${indicator}` | 编辑器首行前缀：强调色 `❯` 轨道、阶段字形槽与光标间隙 |
| `title` | `DeepSeek Harness` | 终端窗口标题的产品后缀。 |

```yaml
- id: terminal
  name: '@deepseek-ai/dsh-tui'
  config:
    welcome: 'Coding agent ready.'
    sessionId: main-session-123
    showReasoning: true
    externalEditorContext: false
    settingsDialogWidth: 72
    maxToolOutputLines: 6
    maxDiffEditLength: 1000
    fileSearchExcludedDirectories: ['.git', 'node_modules', 'dist']
```

任一进程流不是 TTY 时，启动会在挂载前失败。组合 app 必须先挂载 TUI，再挂载由配置创建的 agent，使入口能够观察 `agent-loop/config-start-failed`；完全匹配会话的失败会在全屏模式启动前写出并以状态 1 退出，而不是留下空白终端。dispose（资源释放）会停止接收扩展请求，卸载 `ctx.tui` 提供方及其依赖插件，中止运行中的命令，移除 TUI 定义，停止 loader，拒绝待处理问题，排空终端输入，恢复终端状态，注销事件 listener 和用户交互提供方，并且绝不会在 HMR 期间退出替换进程。用户退出会先 dispose 应用根上下文以关闭同级资源，再退出进程；五秒兜底可避免某个卡住的 disposer 困住进程。

<a id="color"></a>

## 颜色

TUI 发出的所有 SGR 代码都集中在一个表中，即 `components/theme.ts` 内的 `paletteSpec`；`createPalette` 从该表派生包装层，`/palette` 则打印该表，任何组件都不会自行写入转义序列。默认的 `claude` palette 在真彩色终端上把语义角色固定为 Claude Code 经典真彩色 token：陶土色 `#d77757` 强调、`#767676` 弱化、`#4eba65` 成功、`#ffc107` 警告、`#ff6b80` 错误和 `#af87ff` 行内代码，浅色配色方案使用加深的一组。没有真彩色时，同一批角色降级为明亮的 ANSI 近似色。`theme.palette: adaptive` 恢复终端无关模式，其 16 色 ANSI 角色跟随终端当前配色方案。启动 banner 渐变与官方标志使用的精确 `#4D6BFE` 色值仍是两处固定的品牌例外。正文使用终端默认前景色，而非固定色调。

每种视觉语义只对应一个角色：`dim` 是唯一的弱化色调，`accent` 是唯一的交互强调色，`brand` 是 DeepSeek 标志的标准 ANSI 回退色，`success` 和 `error` 还分别充当 diff 的新增行与删除行。颜色和属性分属不同类型，因此 `bold(accent(x))` 可以通过编译，`accent(error(x))` 则不行——SGR 没有颜色栈；在一种颜色内嵌套另一种颜色时，内层颜色闭合时会静默丢弃外层颜色。各属性占用彼此独立的 SGR 组，可以按任一顺序与任何颜色组合。运行 `/palette` 可查看每个角色在你的终端上的实际渲染效果及其 SGR 码对。

成组区域遵循 Claude Code 的版式而非填充块。每条用户提示词行都带加粗强调色 `❯` 轨道，assistant 正文随后无角色标题出现；用鼠标框选复制时仍会复制消息字节，只是现在包含轨道标记。工具卡片按结果给状态字形着色，按工具家族（文件／Shell／搜索／编辑／网络）给 `Verb(argument)` 标题着色，然后把整个正文缩进到暗色 `⎿` 前缀之后，因此只有家族色标题和状态字形携带颜色，正文读作一个整体弱化的区块。注入上下文卡片的正文与其表头也是同一种色调。编辑器位于圆角 `╭─…╮`／`╰─…╯` 轨道之间且没有侧边；轨道默认弱化，Plan 模式下为警告色，always-approve 下为错误色，而 `❯` 输入轨道保持强调色，Agent 工作时其阶段字形淡入。当前后两侧文本均可用时，diff 卡片会为精确识别出的新增 `+` 行和删除 `-` 行着色并计数；未变更的上下文保持暗色且不纳入计数。如果精确比较超出 `maxDiffEditLength`，卡片会把旧侧每一行渲染为删除行、把新侧每一行渲染为新增行，将页脚标记为近似结果，并缓存该回退结果供后续重绘使用。当 `oldText` 不可用时（包括待处理写入、回放回退以及文件创建），新侧的每个非空行都会显示并计作新增行；该计数不能证明这些行原先不存在于已有文件中。新内容为空时，不会补出虚构的 `+ ` 行。`[signal …]` 标记仍保留颜色，因为那里的颜色本身就是语义，而非强调。问题面板使用粗体强调色文本突出活跃行，选择器则使用反色。所有效果都只作用于前景色，因此不会与终端背景冲突。设置 `color: false` 可移除所有样式。

## 模型体验

### 交互式提示词输入

#### 模型看到的内容

每次非空普通编辑器提交都会成为有序的文本块；存在已识别的剪贴板 marker 时，还会包含持久图像引用块。目标 agent 空闲时通过 `agent.followup()` 发送，运行时通过 `agent.steer()` 发送。`[Image #N]` 只用于草稿展示，绝不会作为文本到达模型。会话 mention 会变为可读的 `@label` 文本，加上由 [`dsh-session-reference`](../../context/session-reference/README.md) 定义的持久不受信任上下文；其完整 JSON 隐藏在紧凑引用卡片之后。斜杠命令和按键绑定仅用于 TUI；命令结果仍是终端通知。命令生产方可以调度单独的 agent 输入，例如 `/plan [message]` 接受的可选消息。

#### Token 影响

提交的文本与持久图像引用会按 agent loop 的普通会话历史与压缩规则保留。Provider 报告的视觉用量是权威值；TUI 不会根据图像尺寸估算 token。Header、草稿 marker、已记录标题、卡片、Markdown 渲染、状态行、计划和帮助文本不会增加 token。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### MCP 与子 agent 命令

#### 模型看到的内容

`/mcp`、裸 `/agents` 和 `/agents stop` 只存在于终端。`/agents start` 与 `/agents send` 只会把用户文本交付给选中的可继续子 agent；它们不会向根 agent 追加 user 消息，也不会暴露另一个子 agent 的 transcript。MCP 目录只读取连接状态；它既不创建工具，也不改变根 agent 已可使用的工具定义。

#### Token 影响

目录和停止控制不增加 token。启动或向子 agent 发送任务会按该子会话自己的普通历史和压缩策略保留文本，而不会进入根会话历史。

#### KV Cache 影响

根 agent 的缓存状态不变。子 agent 任务只追加到它自己的请求历史，并遵循该子 agent 的提供方缓存行为。

### 权限与 Plan 模式控制

#### 模型看到的内容

Shift+Tab／Alt+M 输入、`${mode}` 提示词片段、`/status` 行和 TUI 通知都只存在于终端。一次权限选择会持久化由服务持有的 `permission/preset` 事实，以及任何发生变化的 `sandbox/mode` 与 `approval/policy` 事实；沙箱与审批服务会在下一份 cache-safe runtime-context 快照中公开其有效含义。一次 Plan 选择会持久化 `plan/mode`；激活期间，plan 服务贡献其配置的策略段，并持有任何标准转换通知。TUI 不会创建组合 mode 事件或第二套模型侧词汇。

#### Token 影响

循环切换与状态渲染不增加 token。权限发生变化时，可以新增下一份由服务持有的 runtime-context 快照；Plan 激活时，每个请求都会加入其配置段，服务持有的转换通知还可能新增一条简短的保留消息。无变化的选择不增加任何内容。

#### KV Cache 影响

权限变化会在保留历史之后追加一份取代旧状态的 runtime-context 快照，因此更早的可复用前缀保持不变。进入或离开 Plan 会从 plan 段的顺序位置起改变系统提示词。

### 提示词历史搜索

#### 模型看到的内容

打开 Ctrl+R、过滤、切换作用域、取消，或使用 Tab 接受，都不会向模型发送内容。每次原始编辑器提交被接受时都会追加一个精确的 `tui/input` 事件；该事件只写日志，不进入派生模型历史。使用 Enter 接受会把所选文本恰好一次送回普通提交路径，因此随后正常应用其提示词、斜杠命令、skill 或直接 Shell 行为。

#### Token 影响

搜索 UI 与 `tui/input` 事件不增加 token。使用 Enter 接受时，只产生被执行提交形式本身的 token 影响。

#### KV Cache 影响

搜索与回填不会改变模型可见前缀。提交回填后的提示词时，遵循该提交形式的普通缓存行为。

### 直接 Shell 模式

#### 模型看到的内容

`! <command>` 完成后，TUI 会追加一条由插件产生、以 `<user-shell-command>` 为外框的 user 消息。其中包含原样命令、会话工作目录、有界的合并进程输出（stderr 使用执行器提供的标记）、可用时的 spill 定位信息，以及退出、信号或沙箱状态。Shell 历史与路径补全只会改写编辑器文本；用户提交补全后的命令之前，不会新增事件或模型输入。原始感叹号提交只保留为仅写日志的 `tui/input` 记录，不会成为 human prompt，也不会伪造工具调用。实时渲染和 `job_output` 会在同一条进程消费游标之上使用相互独立的保留视图，因此两者都不会从最终上下文中偷走字节。无论命令始终附着前台还是已移入任务，完成结果都会遵循普通输入的空闲时 followup／运行时 steer 规则，因此模型恰好自动响应一次。用户用 Ctrl+C 明确中止的前台命令不会添加模型可见消息。

#### Token 影响

完成结果会按普通会话历史与压缩规则保留，并贡献 user-message token。终端中的运行、取消及基础设施错误通知不增加 token。

#### KV Cache 影响

仅追加；完成结果位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 文件引用自动补全

#### 模型看到的内容

所选文件仍是普通 user 文本，例如 `@src/index.ts` 或 `@"docs/design notes.md"`；自动补全不会添加内容块、持久上下文或特殊引用 payload。注册 `read` 后，此 TUI agent 的每个请求还会包含下方固定系统提示词段落。模型会判断任务是否需要文件内容，并在需要时通过普通工具循环调用 `read`；只有路径不能证明文件已经过检查。

##### 精确系统提示词文本

```markdown
Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.
```

#### Token 影响

自动补全本身不增加 token。所选路径只贡献普通 user 文本 token；`read` 可用时，固定指令会贡献系统提示词 token。只有模型选择的 `read` 调用返回文件内容后，这些内容才会占用上下文。

#### KV Cache 影响

固定指令属于稳定系统提示词前缀，可以跨轮次复用。每个所选路径都是仅追加 user 文本；后续 `read` 结果通过普通工具 transcript 追加所请求内容。

### 会话模型选择

#### 模型看到的内容

`/model` 与 `/effort` 命令文本、Alt+P 与 Alt+T 输入以及选择器按键均不会记录或发送。新步骤会在提示词变量中收到所选提供方／模型路由，并在请求路由中收到所选提供方／模型／推理强度目标。`auto` 通过省略 `reasoningEffort` 表示，因此会恢复适配器／提供方默认行为，而不是创建一个合成强度。

#### Token 影响

选择器与切换键不会添加消息。更改路由可能改变插值后的系统提示词文本，并把后续请求发送给所选模型；只更改推理强度会改变后续步骤的请求路由元数据。

#### KV Cache 影响

更改提供方或模型会进入该目标的缓存域；不假定不同目标间可以复用缓存。只更改推理强度仍留在同一路由，但提供方是否按 reasoning 设置划分缓存由适配器决定，因此也不假定不同强度间可复用缓存。

### 手动调用 skill

#### 模型看到的内容

提交 `/skill:<name> [instructions]` 会加载具名 skill，并交付一个文本块：用 `<skill name="…">` 元素包装 skill 指令；提供方公开资源基准时，会先添加一行定位 skill 相对资源；最后附上用户输入的尾随指令。交付遵循普通输入同样的空闲时 followup、运行时 steer 规则。选择 skill 的是命令而非模型：自动补全和按精确名称调用都应用 `invocation.userInvocable`，`invocation.modelInvocable` 不限制这个接口。用户禁用的 skill 不出现在自动补全中，按精确名称调用时也会在加载前被拒绝；为防止策略竞态，加载后的定义还会再次接受检查。自动补全会保留最后一份完整 skill 快照，并在 `skills/change` 后重新获取。观测不完整时保留先前菜单，完整的空观测会将其清空；如果目录在斜杠命令名称草稿打开期间到达，则会立即根据该草稿重新查询。skill 服务是可选 peer；这项策略检查仅使用其类型契约，不引入运行时包依赖。

#### Token 影响

渲染后的 skill 块与尾随指令会作为一个 user 轮次保留，并遵循 agent loop 的普通会话历史和压缩规则；重复调用会再次追加正文。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

### 交互式用户问题回答

#### 模型看到的内容

消费方调用 `ctx.userInteraction.ask()` 时，此提供方会按顺序显示各个问题，并返回选中选项标签、`custom` 文本，或为多选题同时返回两者。切回选项后，待提交的自定义文本仍会保留，并在之后从选项模式提交时与已勾选的标签一同返回。中止、取消或 UI dispose 会变为 `Error: ask_user_question was interrupted before the user answered`；该转换由 `dsh-tool-ask-user` 完成。

#### Token 影响

等待和终端 overlay 不增加 token；已解析回答或错误只会通过调用工具或插件的结果对模型可见。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV-cache 条目失效。

## 已知限制与延期工作

- **工作区检查点是手动且受 Git 作用域限制的快照**：`/checkpoint` 只会在用户显式调用时捕获会话目录，不会自动保存每次编辑的状态，也不包含被忽略文件。`/rewind` 会拒绝不同的 Git 根目录、目录或提交，并在修改文件前创建安全检查点；但文件系统恢复与可选的子会话交换无法组成跨资源的单一原子事务。并发宿主必须在 TUI 外协调工作区所有权。
- **循环投影的是当前组合的词汇，而非复制 Claude Code 的每一种 mode**：它组合已配置的安全权限 preset 与 Plan，因此不会合成不受支持的 `default`／`acceptEdits`／`dontAsk`／`delegate` 别名。Full access 必须先通过显式 `/permission danger-full-access` 选择，之后才能加入循环；该命令目前仍使用通用命令表层，而非 TUI 专用的风险确认对话框。
- **恢复功能没有跨进程会话锁**：选择器会拒绝本运行时中已知处于活跃状态的会话，但另一个进程可以在交换之前或期间恢复同一持久 id。所有工作区作用域让这一情形一步即可触及，因为另一个宿主正在其他目录驱动的会话现在也可被选中。能够运行并发宿主的部署必须在 TUI 外协调所有权。
- **一个已配置会话持有 transcript 和编辑器**：其他 agent 的问题仍可使用共享 overlay 提供方，但会话渲染与提示词输入仍绑定到 `sessionId`。
- **`/agents` 是直接子 agent 控制，而非 agent teams**：它通过 `spawn` 创建本地可继续子 agent，列出持久化后代，并且只向直接子项发送或停止。共享任务板、点对点消息、团队领导和多会话 agent 视图仍不属于此终端控制面。
- **栅格图像使用文本终端 marker**：剪贴板输入会为模型创建真实的持久图像块，但用户与 assistant 历史只渲染格式、尺寸、字节数和显示名称；终端不会尝试 sixel、Kitty 或 iTerm 内联图形。
- **有意不支持非 TTY 运行**：需要自动化的 app bundle 必须组合 headless 或服务器入口（`headless`、`dsh-acp`），而不能依赖内部回退。
- **手动 `/skill:` 调用总会重新加载完整 skill 正文**：TUI 不会检测会话中是否已存在某项 skill，因此重复调用会再次追加其指令。
- **跨会话提示词历史是有界的建议性数据**：当前会话的精确输入始终可用，但项目／全部作用域需要可选 session-query 服务，且最多检查 `historyMaxSessions` 个旧会话。单个不可读会话会被跳过。在 `tui/input` 出现前创建的会话可以恢复提示词、斜杠命令和已完成 Shell 命令，但无法恢复已展开 skill 正文背后的精确命令。
- **跨进程 Shell 历史以完成结果为持久来源**：每条已接受命令（包括后来被取消的命令）都会立即出现在当前 TUI channel 中，但重启后只能从已完成且持久化的 `user-shell` 结果恢复。在产生该结果前被取消或中断的命令不会进入另一进程的历史。
- **文件与 Shell 路径发现使用宿主工作目录**：`@` 自动补全和直接 Shell 路径补全都读取 TUI 进程的会话 `cwd`；前者随后由 `read` 解释，后者则提交给宿主 Shell。挂载远程或虚拟文件系统的部署必须对齐这些 namespace，或提供其他补全接口。
- **`@` 文件搜索使用显式目录排除项，而非 ignore 文件**：默认排除 `.git` 和 `node_modules`，部署还可以配置更多 basename，但不会解释 `.gitignore` 和 `.ignore`。目录 symlink 不会遍历。
