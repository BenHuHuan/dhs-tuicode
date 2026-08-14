# Agent Note: TUI adapter-authoritative reasoning-effort controls

Status: implemented

English | [中文](2026-08-14-tui-reasoning-effort-controls.zh.md)

## Problem

Claude Code exposes Alt+T as an extended-thinking toggle in its [interactive-mode reference](https://code.claude.com/docs/en/interactive-mode) and `/effort [level|auto]` as the direct and interactive effort control in its [command reference](https://code.claude.com/docs/en/commands). The restored DeepSeek Harness TUI exposed reasoning effort only inside `/model` through Shift+Tab, so changing the current route's effort required reopening the model catalog and had no discoverable thinking toggle.

DeepSeek Harness adapters own exact per-model reasoning metadata: supported efforts are ordered for display, an optional default materializes adapter configuration, and an absent default preserves provider behavior. A TUI that assumes fixed effort names or treats every reasoning model as switchable would offer invalid values, misrepresent an always-thinking model, or manufacture reasoning support for a model whose adapter advertises none.

## Decision

The TUI registers `/effort [level|auto]` beside `/model`. Bare `/effort` opens a selector scoped to the current exact provider/model route. Its first item is `Auto`, which omits `reasoningEffort` and preserves the adapter or provider default; every remaining item comes from the adapter's advertised list in its preferred order. Up/Down and Left/Right wrap through the same list. A named argument accepts an advertised id or an unambiguous display name, while an unsupported value reports the exact available ids.

Alt+T toggles only when the current model advertises both `off` and at least one non-off effort. Switching off remembers the current advertised non-off effort, including an advertised non-off default. Switching on restores the last valid non-off effort used on that exact route, then falls back to its advertised non-off default and first advertised non-off item. Models without reasoning metadata, without `off`, or without a non-off item receive distinct terminal warnings; the TUI never synthesizes a missing capability.

Model catalog operations share one serialized controller queue, so `/model`, `/effort`, and Alt+T cannot commit out of input order after asynchronous catalog reads. The model and effort dialogs close each other, and an effort dialog refuses to overwrite a route changed while it was open. Route-specific toggle memory belongs to one mounted chat channel and is revalidated against current metadata before reuse.

Effort changes replace the channel's shared `ModelSelectionRef.current` value without submitting editor text or appending a session event. They preserve the draft and remain available while a turn runs. Prompt assembly snapshots the selection for one step, so an in-flight step remains coherent and the changed effort applies to a later step. A request header records the selection only when it reaches the model; an unused UI choice remains process-local.

## Verification

Mounted TUI tests pin draft preservation, route-specific off/on restoration, `auto` clearing an inherited request effort, active-turn changes, direct arguments, selector navigation, and the no-reasoning, no-off, and off-only failure states. A deterministic terminal snapshot pins the route label, Auto semantics, adapter order, descriptions, and keyboard legend.

The built-library keyless PTY conversation selects the scripted reasoning model, sends raw Alt+T input, observes `Off`, restores `Max` through `/effort`, and then continues through the assembled profile's background-agent control, context diagnostics, status card, and clean terminal release. Type, lint, documentation, package-build, unit, snapshot, and assembled e2e checks cover the published path.

## Alternatives considered

**Hardcode Claude-compatible effort names.** Rejected because adapter metadata is the authority for each exact route. Providers may add levels, omit `off`, expose only `off`, or use another ordered set.

**Treat missing explicit effort as thinking enabled.** Rejected because `auto` can mean an adapter default or an opaque provider default, including a disabled default. Alt+T may turn that state off when `off` exists, but it cannot honestly label the unknown default as a fixed enabled level.

**Persist every UI selection immediately.** Rejected because selection is request routing state, not conversation content. The durable request header already records values that reach a model, while persisting unused clicks would create session facts with no model effect.

**Reuse `/details reasoning`.** Rejected because that command controls whether recorded reasoning blocks are rendered in the transcript. Request effort and transcript visibility are independent settings and changing one must not silently change the other.

## Consequences

Terminal users can control current-route reasoning without reopening the model selector, while adapters retain full authority over valid choices and defaults. The same UI works for providers with different effort sets and explains unsupported toggle states instead of sending requests that the adapter will reject.

Each operation reads the advisory catalog and can report a catalog failure. Toggle memory intentionally lasts only for the current TUI mount, and changed adapter metadata can invalidate it. An effort-only change stays on the same provider/model route, but provider cache partitioning by reasoning settings remains adapter-specific, so the TUI assumes no cache reuse across effort values.
