# Agent Note: TUI stop-all background subagents

Status: implemented

English | [中文](2026-08-14-tui-stop-background-subagents.zh.md)

## Problem

Claude Code documents Ctrl+X Ctrl+K as the session-level emergency stop for background agents and labels the action `chat:killAgents` in its [keybindings reference](https://code.claude.com/docs/en/keybindings); its [interactive-mode reference](https://code.claude.com/docs/en/interactive-mode) requires the chord twice within three seconds. The restored DeepSeek Harness TUI had foreground-turn and shell cancellation, but no equivalent way to stop background delegation without finding individual ids.

The assembled runtime has two independently owned background-subagent lifecycles. One-shot delegation appears in `ctx.jobs` as `kind: subagent`; a continuable child stays in `ctx.subagents` and may remain resident while idle without a job record. Implementing only one registry would make the shortcut silently incomplete in one of the shipped profiles.

## Decision

Recognize split terminal chunks (`Ctrl+X`, then `Ctrl+K`) and the combined legacy chunk without swallowing an unrelated follower. The first complete chord arms a terminal-only three-second confirmation; the second timely chord runs the stop operation. Any ordinary editor input disarms the confirmation and still reaches the draft. TUI disposal clears the timer and aborts unfinished discovery.

The confirmed operation uses the current agent as exact authority and targets both lifecycles:

- From `ctx.jobs`, select only `kind: subagent`, `status: running`, and `ownerSession === agent.id`, then call the registry's authorized `kill` operation.
- From `ctx.subagents.listChildren(agent.id)`, select only direct `continuable` children reported active whose live Agent status is still `running`, then call `interrupt` with exact ancestor authority.

The second live-status check occurs after asynchronous discovery so an idle or just-settled continuation is not counted as cancelled. Bash jobs, foreign or unowned jobs, completed one-shot work, diagnostic rows, one-shot child projections, deeper descendants, and resident idle continuations are intentionally excluded. A descendant remains its direct parent's responsibility; the top-level human control stops work directly owned by this chat rather than manufacturing authority over an arbitrary tree.

Both optional service handles are captured through Cordis' safe `ctx.get()` lookup. The TUI does not read `ctx.jobs` or `ctx.subagents` directly after probing: those protected properties require hard injection and would fail in the assembled profile even when the optional service exists.

Discovery and cancellation are best-effort per source and target. One failure is retained and reported without shielding siblings. Accepted requests, jobs that settled during the race, no-active-target results, unavailable optional services, and partial failures each receive explicit terminal feedback. The operation does not append session events, alter the prompt, or add model-visible content.

## Verification

Pure tests pin split and combined chord decoding, unrelated-key pass-through, exact job ownership, lifecycle and activity filtering, ancestor authority, race settlement, per-target failure containment, discovery failure containment, and pre-cancelled discovery. Mounted TUI tests pin the double-confirmation window, ordinary-input disarming, prompt preservation, unavailable-service feedback, and rendered result notice.

A deterministic headless snapshot pins the armed confirmation line. The built-lib keyless PTY conversation exercises the two chords against the fully assembled shipped profile, observes the no-running-subagents result, and continues through `/context all`, `/status`, and clean exit. Type, lint, documentation, package build, unit, and assembled e2e gates cover the optional-service boundary.

## Alternatives considered

**Kill every running job.** Rejected because Ctrl+X Ctrl+K is a background-agent control, not a shell-job kill switch. User-owned bash work must not be collateral damage.

**Interrupt every descendant recursively.** Rejected because ownership and ancestor authority are explicit runtime invariants. Direct children are the work this chat owns; recursive discovery could duplicate cancellation or cross a child's own coordination boundary.

**Treat every continuable child as running.** Rejected because continuations deliberately persist between turns. Killing resident idle children would destroy resumable state while reporting that active work was stopped.

**Use a single chord without confirmation.** Rejected because the official interaction is guarded and accidental cancellation can discard useful parallel work.

## Consequences

Terminal users now have one discoverable, guarded safety control across both shipped delegation modes, including while the main turn is active. Minimal embeddings degrade explicitly, and a broken provider cannot prevent healthy sibling cancellations.

The action is a point-in-time best-effort stop rather than a durable ban: a producer may create new background work after discovery, and an already-settled target may win the race. The shortcut does not delete durable child records or idle continuations; lifecycle owners retain cleanup and later-resume semantics.
