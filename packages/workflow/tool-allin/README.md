# @deepseek-ai/dsh-tool-allin

English | [中文](README.zh.md)

The model-facing `allin` tool runs a fixed All in Luna-style orchestration: one pro coordinator compiles a concrete goal into independent top-level tasks, parallel flash lanes execute every dependency-ready task in waves, and a pro synthesis merges their typed reports into one bounded parent result. It is an ordinary plugin over [`ctx.workflowEngine`](../workflow/README.md) and [`ctx.subagents`](../../subagent/subagent/README.md), in the same shape as [`dsh-tool-ralph`](../tool-ralph/README.md). No multi-agent loop is added to `agent-loop`, and the same-session [goal domain](../../goal/goal/README.md) remains independent.

## Contract

`allin({ goal, maxTasks? })` waits for the entire run. The deployment config's `maxTasks` is both the default and a ceiling on a call override. Every child starts through `subagentProvider`; that provider must exist, support structured output, and report `inheritsParentContext: false`. The configured provider is carried as `WorkflowStartRequest.subagentProvider`, so the fixed script cannot inspect or change routing and the ordinary model-written `workflow` tool gains no provider selector.

The fixed script uses three phases:

1. **Plan** — a pro child (`orchestratorModel`) returns `{ title, tasks }`. Each task carries a unique normalized `id`, `title`, a self-contained `prompt`, and `dependencies`. The script rejects empty, oversized, duplicate-id, unknown-dependency, self-dependent, cyclic, or all-dependent plans.
2. **Parallel task lanes** — dependency-ready tasks run as fresh flash children (`workerModel`) in waves of at most `maxParallelWorkers`. `parallel()` starts one wave's lanes concurrently; the next wave waits for the wave to settle, so a lane starts as soon as its dependencies are done and unrelated work never queues behind a blocked lane. Each lane returns `{ status: done | blocked, summary, artifacts, evidence, handoff, blocker }`. A lane that ends without a structured report becomes a `failed` outcome and does not block other ready lanes.
3. **Synthesis** — a pro child receives every lane outcome and returns `{ status: complete | blocked | partial, summary, deliverables, remaining, blocker }`. The script coerces the terminal status from both the synthesis and the lane outcomes: `complete` requires every lane `done` and a `complete` synthesis; `blocked` requires a blocked lane or a `blocked` synthesis; everything else is `partial`.

The successful canonical value is `{ runId, agentsStarted, result }`, with `result` containing the plan, every lane outcome, and the synthesis. The Native renderer labels the outcome as coordinator-reported, not independently certified. `maxResultChars` bounds only that rendered text, including its truncation marker, without altering the canonical value.

A planner child that ends without a structured plan is an error. A synthesis child that ends without a structured synthesis is an error after the lanes settle. Invalid plan, report, or synthesis shapes fail the workflow rather than being truncated or treated as success. Fatal provider-start, transport, worker, or workflow failures remain workflow errors. Cancellation is also an error; partial output is never success.

## Lifecycle and cancellation

The caller's agent is the parent of every fresh child, preserving cwd and lineage without copying its conversation. `exec.signal` enters the workflow engine and is also bridged to `run.cancel()` for implementation independence. The tool awaits `run.result` and calls `run.dispose()` in `finally`, so a cancelled parent step waits for the engine's bounded termination and child quiescence before returning.

## Render intent

The pending call is a `generic` card titled `allin`; the concrete goal is its `rawInput`. The result keeps the generic card. Both presentation functions depend only on tool arguments and the settled tool envelope.

## Config

| Key | Default | Meaning |
|---|---|---|
| `subagentProvider` | `spawn` | Fresh structured-output provider used for every child. |
| `orchestratorModel` | `deepseek-v4-pro` | Pro coordinator model for the plan and synthesis children. |
| `workerModel` | `deepseek-v4-flash` | Flash worker model for every task lane. |
| `maxTasks` | `8` | Default and deployment ceiling for one run's task count. |
| `maxParallelWorkers` | `8` | Deployment ceiling for lanes started in one dependency wave. |
| `maxPlanChars` | `16384` | Maximum serialized characters in one plan. |
| `maxReportChars` | `16384` | Maximum serialized characters in one lane report. |
| `maxResultChars` | `50000` | Maximum characters in the successful parent-facing terminal text. |

All config values are normalized and validated when the plugin applies, including direct application outside Loader schema normalization. Provider capabilities are resolved immediately before each call because provider registration can change under plugin lifecycle and HMR.

## Model Experience

### System prompt

#### What the model sees

Every parent request in this plugin's registration scope receives the fixed routing guidance below. A scoped tool restriction can hide the schema without removing this independently registered guidance.

##### Allin guidance

```markdown
Use the allin tool ONLY when the direct human explicitly asks for allinluna-style multi-agent execution or hands you one large goal that decomposes into independent top-level work areas. The tool runs a deployment-fixed pro planner, parallel flash task lanes in dependency waves, and a pro synthesis; completion is coordinator-reported, not independent certification. Prefer plain subagents or the workflow tool for bounded fan-out, and same-session goal tools for ordinary long-running objectives.
```

#### Token effect

Small fixed input cost on every request where this plugin's prompt registration is in scope.

#### KV Cache effect

Prefix-stable while the plugin scope and guidance text are unchanged. Activation, disposal, or configuration changes may invalidate reuse from this prompt section.

### Tool schema and result

#### What the model sees

The generated [`allin` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-allin) exposes a required `goal` string and an optional `maxTasks` number. Provider route, models, concurrency, schemas, and orchestration behavior stay deployment-owned and absent from the call schema. The parent sees only the raw call and one terminal result; intermediate child prompts and reports do not enter the parent conversation.

#### Token effect

Fixed schema cost plus one bounded rendered result per call. Each fresh child pays its own independent context; `maxPlanChars` bounds the plan, `maxReportChars` bounds each lane handoff, and `maxResultChars` independently bounds the parent-facing text.

#### KV Cache effect

The parent's request prefix is unaffected while this plugin's definitions are stable. Each fresh child has an independent request cache. The parent result appends after its reusable prefix.

## Known Limitations and Deferred Work

- **Completion is coordinator-reported** — no independent evaluator certifies the goal or the synthesis; evaluator-backed certification is deferred.
- **Foreground only** — no job id, background collection, process-resume checkpoint, durable run store, or wall-clock scheduling.
- **One shared workspace** — lanes coordinate through the current working tree plus bounded typed reports; there is no cross-lane artifact store or durable task database.
- **No retry or promotion protocol** — a failed lane is reported, not retried; cross-lane authority changes and conflict resolution are deferred.
- **Flat task graph** — lanes cannot recursively expand into their own top-level task graphs, although each lane may use its own tools and subagents.
- **Agent count only** — token, currency, and elapsed-time budgets are deferred; the workflow engine's total-agent cap is the runaway backstop.
