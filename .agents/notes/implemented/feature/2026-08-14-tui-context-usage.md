# Agent Note: TUI context usage visualization

Status: implemented

English | [中文](2026-08-14-tui-context-usage.zh.md)

## Problem

The restored TUI showed aggregate context pressure in its compact footer and repeated it inside `/status`, but offered no dedicated answer to what fills the selected model's window. Claude Code names `/context [all]` as the long-session diagnostic in its [commands reference](https://code.claude.com/docs/en/commands). DeepSeek Harness already owned the required data: replay-aware current request pressure, selected-route capacity, a durable three-part composition projection, and positional post-replacement surface nodes. Reassembling or repricing that data inside the terminal would create a second accounting vocabulary and could make compaction invisible.

## Decision

Register `/context [all]` as an agent-scoped TUI command that remains immediate while a turn is running. Each invocation appends one point-in-time terminal card and no model-visible message. Unknown arguments fail with `Usage: /context [all]`.

The primary occupancy row divides `ctx.tokenMeter.measure(session).totalTokens` by the currently selected model's resolved context window. It labels missing capacity rather than inventing a denominator, identifies whether the meter is provider-usage anchored or estimated, reports exact over-capacity pressure, and recommends `/compact` once occupancy reaches 80%. This retains the same live selected-route semantics as the footer and `/status`; it is an advisory display, not a compaction decision input.

When `ctx.sessionProjections` is mounted, the card reads its `contextBreakdown` value and renders a segmented system-prompt, tool-schema, and conversation meter plus the three heuristic token rows. The fixed heuristic remains visibly separate from provider-anchored pressure and is not scaled to make the values sum. A minimal embedding without the projection registry keeps aggregate occupancy and labels composition unavailable. This reuses the ownership and three-category resolution established by [Composer context meter with heuristic composition breakdown](2026-08-05-composer-context-meter-breakdown.md).

`/context all` additionally walks the token meter's current positional nodes. Each node is joined to its durable event by sequence number and labeled as a user prompt, assistant response, injected-context source, or correlated tool result. Because the nodes are already the post-replacement model surface, compacted or pruned ranges do not reappear. Source labels pass through the terminal control sanitizer. The ordinary form omits per-message rows so long conversations do not flood scrollback.

## Verification

Mounted-channel tests pin provider-anchored occupancy, capacity-unknown and projection-absent degradation, segmented composition figures, expanded user and assistant rows, ordinary-form collapsing, and invalid-argument diagnostics. A deterministic headless snapshot pins the complete colored card under the repository's theme-safety checks.

The built-lib keyless PTY conversation boots the shipped profile, completes real scripted model turns, runs `/context all`, and requires the assembled terminal to show its conservative estimated-pressure provenance, tool and conversation composition, and expanded model-visible items before `/status` and clean exit. The fixture's intentionally tiny provider usage is below its assembled heuristic anchor, so token-meter correctly rejects that unsafe provider baseline; the mounted-channel tests separately pin the accepted provider-anchor path. The normal TUI, documentation, type, lint, build, and keyless e2e gates cover command discovery and artifact behavior.

## Alternatives considered

**Recompute system and tool-schema tokens in the TUI.** Rejected because token-meter already owns the fixed estimator and its projection survives log paging, resume, and compaction. A second estimator would drift.

**Scale composition rows to the provider-anchored total.** Rejected because provider pressure and the fixed heuristic answer different questions. Scaling would fabricate category precision and make unchanged composition move with a provider sample.

**Always print every surface node.** Rejected because an old session can contain hundreds of model-visible messages. The bounded default stays useful in native scrollback; explicit `all` opts into the full list.

**Split rules, skills, MCP servers, and memory into separate rows.** Rejected at this layer because those contributions are already assembled into system text or tool schemas by the request header. The three existing categories are the finest authoritative resolution.

## Consequences

Terminal users can now inspect both current request pressure and honest context composition without leaving the session or sending another model turn. The display stays correct across surface replacements and compaction because it consumes token-meter-owned data rather than transcript rows.

Capacity resolution remains asynchronous and route-advisory, so invoking the command before metadata arrives can show `capacity unknown`; a later invocation reflects the resolved route. Provider-anchored totals and heuristic component figures may visibly differ by design. The TUI still has no finer breakdown until request assembly exposes finer authoritative categories.
