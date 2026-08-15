# @deepseek-ai/dsh-tool-allin

[English](README.md) | 中文

面向模型的 `allin` 工具运行固定的 All in Luna 风格编排：一个 pro 协调者（智能体）把具体目标编译成独立顶层任务，多个 flash 车道按依赖波次并行执行所有就绪任务，最后由 pro 协调者把类型化报告合并为一份有界的父级结果。它是基于 [`ctx.workflowEngine`](../workflow/README.md) 和 [`ctx.subagents`](../../subagent/subagent/README.md) 的普通插件，形态与 [`dsh-tool-ralph`](../tool-ralph/README.md) 相同。不会向 `agent-loop` 添加多智能体循环，同会话的[目标领域](../../goal/goal/README.md)也保持独立。

## 契约

`allin({ goal, maxTasks? })` 会等待整个运行完成。部署配置中的 `maxTasks` 既是默认值，也是调用覆盖值的上限。每个子 agent 都通过 `subagentProvider` 启动；该提供方必须存在、支持结构化输出，并报告 `inheritsParentContext: false`。已配置的提供方以 `WorkflowStartRequest.subagentProvider` 传递，使固定脚本无法检查或更改路由，普通的模型编写 `workflow` 工具也不会因此获得提供方选择器。

固定脚本包含三个阶段：

1. **Plan**——pro 子 agent（`orchestratorModel`）返回 `{ title, tasks }`。每个任务带有唯一的规范化 `id`、`title`、自包含的 `prompt` 和 `dependencies`。脚本会拒绝空计划、超大计划、重复 id、未知依赖、自依赖、循环依赖和全依赖。
2. **Parallel task lanes**——依赖就绪的任务作为全新 flash 子 agent（`workerModel`）按波次运行，每波最多 `maxParallelWorkers` 个。`parallel()` 并发启动同一波的车道；下一波等待本波结算，因此车道在其依赖完成后即可启动，无关工作不会排在被阻塞车道之后。每个车道返回 `{ status: done | blocked, summary, artifacts, evidence, handoff, blocker }`。未返回结构化报告的车道成为 `failed` 结果，不会阻塞其他就绪车道。
3. **Synthesis**——pro 子 agent 收到全部车道结果，返回 `{ status: complete | blocked | partial, summary, deliverables, remaining, blocker }`。脚本结合合成结果与车道结果确定终态：`complete` 要求每个车道都 `done` 且合成为 `complete`；`blocked` 要求存在阻塞车道或阻塞合成；其余情况为 `partial`。

成功的规范值为 `{ runId, agentsStarted, result }`，其中 `result` 包含计划、每个车道结果和合成结果。Native 渲染器会明确说明结果由协调者报告，而非独立认证。`maxResultChars` 只限制包含截断标记的渲染文本，不会改变规范值。

计划子 agent 未返回结构化计划属于错误。车道结算后，合成子 agent 未返回结构化合成也属于错误。无效的计划、报告或合成形状会使工作流失败，而不会被截断或当作成功。致命的提供方启动、传输、worker 或工作流失败仍是工作流错误。取消同样属于错误；局部输出绝不会视为成功。

## 生命周期与取消

调用方 agent 是每个全新子 agent 的父级，因此会保留 cwd 和谱系，但不会复制其对话。`exec.signal` 进入工作流引擎，同时也桥接到 `run.cancel()`，以便不依赖具体实现。工具等待 `run.result` 并调用 `run.dispose()`，后一个调用位于 `finally` 中，因此取消的父级步骤会等到引擎完成有界终止且子 agent 完全停稳后才返回。

## 渲染意图

待处理调用使用 `generic` 卡片，标题为 `allin`；具体目标作为其 `rawInput`。结果继续使用 generic 卡片。两个呈现函数都只依赖工具参数和已结算的工具包络。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `subagentProvider` | `spawn` | 每个子 agent 使用的全新结构化输出提供方。 |
| `orchestratorModel` | `deepseek-v4-pro` | 计划与合成子 agent 使用的 pro 协调者模型。 |
| `workerModel` | `deepseek-v4-flash` | 每个任务车道使用的 flash worker 模型。 |
| `maxTasks` | `8` | 一次运行任务数的默认值和部署上限。 |
| `maxParallelWorkers` | `8` | 单个依赖波次启动车道数的部署上限。 |
| `maxPlanChars` | `16384` | 一份计划序列化后的最大字符数。 |
| `maxReportChars` | `16384` | 一份车道报告序列化后的最大字符数。 |
| `maxResultChars` | `50000` | 返回给父级的成功终态文本最大字符数。 |

插件应用时会规范化并校验所有配置值，也包括绕过 Loader schema 规范化而直接应用的情况。每次调用前都会立即解析提供方能力，因为提供方注册可能随插件生命周期和热模块替换（HMR）变化。

## 模型体验

### 系统提示词

#### 模型看到的内容

在该插件的注册作用域内，每个父级请求都会收到下方的固定路由指导。作用域化的工具过滤可以隐藏 schema，但不会移除这份独立注册的指导。

##### Allin 指导

```markdown
Use the allin tool ONLY when the direct human explicitly asks for allinluna-style multi-agent execution or hands you one large goal that decomposes into independent top-level work areas. The tool runs a deployment-fixed pro planner, parallel flash task lanes in dependency waves, and a pro synthesis; completion is coordinator-reported, not independent certification. Prefer plain subagents or the workflow tool for bounded fan-out, and same-session goal tools for ordinary long-running objectives.
```

#### Token 影响

插件启用期间，每个请求都会产生少量固定的指导 token 开销。

#### KV Cache 影响

只要插件作用域和指导文本不变，前缀就保持稳定。启用或 dispose（资源释放）可能会使从该提示词段起的缓存复用失效。

### 工具 schema 与结果

#### 模型看到的内容

已生成的 [`allin` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-allin)公开一个必填 `goal` 字符串和一个可选 `maxTasks` 数字。提供方路由、模型、并发度、schema 和编排行为均由部署侧控制，不在调用 schema 中。父级只看到原始调用和一份终态结果；中间子 agent 提示词和报告不会进入父级对话。

#### Token 影响

固定 schema 开销加上每次调用一份有界的渲染结果。每个全新子 agent 支付自己的独立上下文成本；`maxPlanChars` 限制计划，`maxReportChars` 限制每份车道交接，`maxResultChars` 独立限制父级文本。

#### KV Cache 影响

只要本插件定义稳定，父级请求前缀不受影响。每个全新子 agent 都有独立的请求缓存。父级结果追加在可复用前缀之后。

## 已知限制与暂缓事项

- **完成由协调者报告**：没有独立评估器认证目标或合成结果；评估器认证暂缓处理。
- **仅支持前台**：没有 job id、后台收集、进程恢复检查点、持久运行存储或基于挂钟时间的调度。
- **单一共享工作区**：车道通过当前工作树和有界类型化报告协调，没有跨车道工件存储或持久任务数据库。
- **没有重试或晋升协议**：失败车道只被报告而不会重试；跨车道权限变更与冲突解决暂缓处理。
- **扁平任务图**：车道不能递归扩展为新的顶层任务图，但每个车道仍可使用自己的工具和子 agent。
- **仅限制 agent 数量**：token、费用和耗时预算暂缓处理；工作流引擎的子 agent 总数上限是失控循环的后备闸门。
