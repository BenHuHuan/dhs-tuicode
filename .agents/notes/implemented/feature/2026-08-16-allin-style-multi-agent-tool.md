# Agent Note: Allin-style multi-agent tool

Status: implemented

English | [中文](2026-08-16-allin-style-multi-agent-tool.zh.md)

## Problem

One large goal usually spans independent work areas, but running all of them in the same conversation grows one context, lets unrelated work contaminate each other, and lets one blocked lane stall everything. The subagent seam already provides one-shot and continuable children, and the workflow seam already runs model-written fan-out scripts, but neither encodes the All in Luna shape: a pro coordinator compiles the goal, parallel flash lanes execute dependency-ready top-level tasks, and the same pro coordinator synthesizes the lane reports.

## Decision

Add `@deepseek-ai/dsh-tool-allin` under `packages/workflow/` as a fixed-policy Consumer, in the same shape as `@deepseek-ai/dsh-tool-ralph`. It registers `allin({ goal, maxTasks? })`, owns one fixed workflow script, and depends only on `ctx.tools`, `ctx.systemPrompt`, `ctx.workflowEngine`, and `ctx.subagents`. The shipped `dsh-base` bundle enables it with `orchestratorModel: deepseek-v4-pro`, `workerModel: deepseek-v4-flash`, `maxTasks: 16`, and `maxParallelWorkers: 8`.

The script has three phases. **Plan** sends a pro child a decomposition prompt and requires `{ title, tasks }`, where every task has a unique normalized id, a self-contained prompt, and explicit dependencies; duplicate ids, unknown or self dependencies, and cycles fail the workflow. **Parallel task lanes** runs every dependency-ready task as a fresh flash child. A dependency wave starts at most `maxParallelWorkers` lanes through `parallel()` and the next wave waits for the previous one, so unrelated lanes never queue behind a blocked or failed lane. Each lane returns a structured report with `done | blocked`, summary, artifacts, evidence, handoff, and blocker. A child that ends without a structured report becomes a `failed` outcome and does not block other ready lanes. **Synthesis** sends every lane outcome to a pro child and requires `{ complete | blocked | partial, summary, deliverables, remaining, blocker }`; the script coerces the terminal status from both the synthesis and the lane outcomes so a synthesis cannot claim completion over failed lanes.

The model may supply only the goal and an optional task cap. Provider route, both models, concurrency, schemas, and validation stay deployment-owned. The calling agent parents every child for cwd and lineage, the tool waits for the whole run, `exec.signal` cancels the workflow, and `run.dispose()` is awaited on every path. The canonical result is `{ runId, agentsStarted, result }`; the parent renderer labels completion as coordinator-reported, not independent certification. Planner and synthesis child failures are errors, and malformed plan, report, or synthesis shapes fail instead of being truncated or accepted.

## Testing

Unit tests cover request routing, model and concurrency args, complete/blocked/partial outcomes, planner and synthesis failure envelopes, result truncation, provider capability rejection, and direct config validation. Two keyless real-stack integration tests drive the fixed script through the worker-thread engine, the spawn provider, the structured-output runtime, and the agent loop: one proves the pro/flash/pro model order and distinct unseeded children, the other proves two independent flash lanes run through one parallel wave.

## Alternatives considered

- **Extend the general workflow tool** — rejected because the fixed report protocol, model routes, and stop policy deserve one reviewable consumer instead of widening the model-written script API.
- **Add a multi-agent loop to the agent loop or goal driver** — rejected because orchestration is a removable policy over existing seams, not a change to turn execution or goal state.
- **Port the Python All in Luna runtime** — rejected because DSH already owns workflow execution, cancellation, quiescence, and child lifecycles; a native fixed script reuses them without an external runtime or relay protocol.
- **Run lanes as continuable background children** — rejected because the foreground workflow gives the parent tool call a single bounded terminal result and cancellation quiescence for the whole run.

## Consequences

- A big-goal decomposition path exists as one plugin, with pro plan/synthesis and multiple concurrent flash lanes.
- Lane reports are bounded (`maxPlanChars`, `maxReportChars`, `maxResultChars`), and the workflow engine's total-agent cap remains the runaway backstop.
- Dependencies are wave-scheduled, so one blocked lane delays only its dependents.
- The same-session goal domain, Ralph rounds, and the general workflow tool remain separate products.

## Known limitations and deferred work

- Completion and blockers are coordinator- or worker-reported; no independent evaluator certifies the result.
- Runs are foreground and process-local; durable task state, resume, retry, and cross-process recovery are deferred.
- Lanes share one workspace and bounded reports; there is no artifact store, conflict manager, or promotion protocol.
- The task graph is flat; lanes may use their own tools and subagents but cannot recursively expand into new top-level graphs.
- Only task count and concurrency are capped; token, currency, and elapsed-time budgets are deferred.
