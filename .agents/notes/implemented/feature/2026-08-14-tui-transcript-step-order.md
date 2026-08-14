# Agent Note: TUI transcript step ordering

Status: implemented

English | [中文](2026-08-14-tui-transcript-step-order.zh.md)

## Problem

The agent loop durably opens a model step with `step/start` before it appends the accepted user message and any injected context for that step. The restored TUI treated `step/start` as permission to create an `Assistant` transcript group immediately. Live output and replay could therefore render `Assistant` before `You` or context, and a step that produced no assistant body left an empty `Assistant` / `Model wait` row. The durable event order was valid; the presentation projection was not.

## Decision

`step/start` now updates timing and retry state without creating a transcript component. The first `assistant/chunk` lazily creates the streaming assistant step before applying its delta. A committed `assistant/message` remains a second lazy creation boundary, and `step/end` may create and finish an otherwise missing step only when the existing completion path requires one.

The TUI still derives model-wait, reasoning, response, tool, retry, and completion timing from the durable events. Deferring the visual group changes neither the log nor model history. It only aligns the rendered conversation with semantic ownership: accepted user and context messages appear first, followed by the assistant output they prompted. A start that never develops a visible body leaves no ghost transcript row.

Transcript rebuild uses the same event handler as live rendering, so the rule applies identically after resume and after display-setting changes such as `/details reasoning off`. No alternate replay-only ordering or event buffer is introduced.

## Verification

A TUI integration test appends the production order—`step/start`, accepted user message, assistant chunk—then forces a full repaint and asserts `You` precedes `Assistant`. It repeats the assertion after a transcript rebuild triggered through `/details`, covering the live and replay projections with the same fixture.

The package's 25 recorded-terminal scenarios were refreshed and replayed in built-lib mode. Streaming scenarios now show `You` before `Assistant`; menus and idle surfaces no longer include a fabricated empty assistant group. The shipped-profile mode-control snapshot and the focused built-profile PTY smoke continue to pass.

## Alternatives considered

**Reorder core session events.** Rejected because the append order is an agent-loop lifecycle contract used by persistence and timing consumers. Presentation should adapt without changing durable semantics.

**Buffer user and context events until an assistant chunk arrives.** Rejected because accepted input should appear immediately, and a tool or failure path may occur without assistant text. Only the premature assistant container needed deferral.

**Render an empty assistant row for every opened step.** Rejected because it misstates that the assistant produced transcript content and made menus, questions, and interrupted starts appear to contain model output.

**Use separate live and replay sorting.** Rejected because duplicated projections drift. One append-origin event handler keeps resume, redraw, and active-session rendering consistent.

## Consequences

The transcript now reads in conversational order during a live turn, after resume, and after a full rebuild. Empty opened steps no longer consume terminal rows. Phase timing remains event-derived, so waiting and retry diagnostics retain their original boundaries even though the `Assistant` heading is created only when assistant content exists.

This is a presentation invariant rather than a new event guarantee. Consumers that need lifecycle order must continue to read the durable sequence as written; only the TUI maps that sequence into role-grouped conversation order.
