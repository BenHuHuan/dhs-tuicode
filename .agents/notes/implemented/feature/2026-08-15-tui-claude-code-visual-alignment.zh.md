# Agent Note: TUI 的 Claude Code 视觉对齐

Status: implemented

[English](2026-08-15-tui-claude-code-visual-alignment.md) | 中文

## Problem

恢复后的 TUI 是可靠的终端入口，但其视觉语言与产品所述「类 Claude Code」目标不符。它使用加粗带下划线的 `You` / `Assistant` 标题对、`○ Tool / <name>` 卡片外框、无边框编辑器加 `dsh > ` 提示符，以及单一的终端无关 ANSI palette，其强调色在大多数配色方案下渲染为品红色。产品所参照的 TUI 项目呈现的是 Claude Code 的陶土色强调、带轨道的用户消息、无标题 assistant 输出和 `Verb(argument)` 工具卡片。

## Decision

`theme.palette` 是新增的经过校验的配置字段，默认值为 `claude`，逃生通道为 `adaptive`。在真彩色终端上，`claude` palette 把语义角色固定为 Claude Code 经典 token——陶土色 `#d77757` 强调、`#767676` 弱化、`#4eba65` 成功、`#ffc107` 警告、`#ff6b80` 错误和 `#af87ff` 行内代码——浅色配色方案使用加深的一组。没有真彩色时，同一批角色回退为明亮的 ANSI 近似色；`adaptive` 保留此前的终端重映射 16 色角色。`paletteSpec` 仍是唯一的 SGR 表，`/palette` 继续报告每个角色。

transcript 采用 Claude Code 的分组方式：用户行和已接受提示词行带加粗强调色 `❯` 轨道，assistant 输出以终端默认色无标题渲染，reasoning 以暗色斜体 `✻ Reasoning` 行开头。工具卡片用状态字形（`⠋` 进行中、`›` 成功、`✗` 错误）加按家族着色的加粗 `Verb(argument)` 标题替换 `○ Tool / <name>` 外框；标题由有界的工具名／参数映射推导，正文以 `⎿` 前缀缩进，调用达到一秒后追加耗时后缀。终端卡片始终把命令保留在标题中，包括 presenter 提供标题的未知名工具，因此新标题绝不会抹掉待处理命令卡片所携带的唯一信息。

编辑器获得 Claude Code 的圆角输入轨道：上方 `╭─…╮`、下方 `╰─…╯`，没有侧边。轨道通常为弱化色，Plan 模式生效或待确认时为警告色，always-approve 下为错误色。默认输入提示词变为 `${symbol}${indicator}`——强调色 `❯` 后接阶段字形槽——运行字形淡入该槽且不移动光标。亚秒级工具耗时不再渲染：它们是进程调度噪声，会让实时快照无法回放。

## Verification

聚焦的 TUI 单测固定了新的 `tool-card` 动词／参数与耗时 helper、Claude 真彩色角色码、带轨道提示词几何、圆角编辑器外框和隐藏模式卡片折叠。40 个文件的终端快照语料通过 keyless 快照 harness 重新录制并可确定性回放；真彩色 banner 检查点证明获批的 24 位前景色不含背景色或扩展 palette 码，ANSI 回退检查点仍报告零违规。包级 typecheck 与完整非快照 TUI 测试套件通过。

## Alternatives considered

**只保留终端无关 ANSI palette 作为唯一模式。** 拒绝，因为 ANSI 16 没有陶土色：最接近的角色是品红或黄色，无法在终端支持真彩色时不使用获批的 24 位前景码表达 Claude Code 对齐。

**保留加粗带下划线角色标题，只改颜色。** 拒绝，因为与 Claude Code 视觉距离最大的正是标题而非色相；带轨道用户行与无标题 assistant 输出才是产品所参照的布局。

**渲染每个亚秒级工具耗时。** 拒绝，因为 `tool/call` 与 `tool/result` 的时间戳来自追加时的 `Date.now()`；实时回放会把 1–2 毫秒的调度抖动写进终端快照。一秒下限保留真实命令时长可见，同时让快照确定。

**只从 presenter `title` 字符串推导工具标题。** 拒绝，因为 presenter 标题因工具而异且常与工具名重复；有界动词／参数映射提供稳定的 `Run(command)`、`Read(file)`、`Search(pattern)` 词汇，presenter 标题仍在正文中渲染。

## Consequences

TUI 现在读起来是 Claude Code 风格入口，同时仍是纯展示层：会话事件、模型输入和工具 schema 均未改变。偏好终端重映射颜色的现有部署可设置 `theme.palette: adaptive`；除输入提示词模板外，其余配置默认值不变。用户行现在包含框选复制会带上的 `❯` 标记，工具卡标题不再包含字面 `Tool / <name>` 外框，隐藏模式折叠以前导间距而非 assistant 标题计数。包 README 与终端快照语料拥有渲染契约。

[Restore the shipped TUI profile](2026-08-14-restore-tui-profile.md) 建立了本对齐工作所依托的绿色基线；它仍是 profile 组合、生命周期与组装验证的所有者。
