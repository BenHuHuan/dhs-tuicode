# Agent Note: TUI permission and plan mode cycle

Status: implemented

English | [中文](2026-08-14-tui-permission-plan-mode-cycle.zh.md)

## Problem

The restored TUI exposed the existing `/permission` and `/plan` commands but had no unified keyboard control or always-visible effective mode. That left the main coding surface behind the target interaction: Claude Code's current [interactive-mode](https://code.claude.com/docs/en/interactive-mode) and [keybinding](https://code.claude.com/docs/en/keybindings) references assign Shift+Tab to mode cycling, document Alt+M as the Windows fallback, and keep the current mode in the status bar. DeepSeek Harness already had independent durable permission-preset and Plan services, so inventing another universal mode store would duplicate authority and risk coupling soft planning guidance to enforced sandbox policy.

## Decision

The TUI adds a small `TuiModeController` projection over optional `ctx.permissionPresets` and `ctx.planMode`. It computes one terminal view but performs every transition through the owning service setter. Permission remains the configured preset vocabulary and persists through `permission/preset`, `sandbox/mode`, and `approval/policy`; Plan remains independent per-agent state persisted through `plan/mode`. Entering Plan does not rewrite permission, and leaving Plan reveals or selects the permission target already owned by the preset service.

At the main editor, Shift+Tab and Alt+M select the next configured safe permission preset followed by Plan. A derived `custom` state is visible but not selectable. With only plan mode, the controller supplies a local `Normal` view; with neither optional service, it supplies no mode and the key reports unavailability. Pending in-turn Plan intent is shown immediately and marked pending, while service semantics still defer its durable commit to the next accepted pre-step.

A permission preset is dangerous when its resolved sandbox is `danger-full-access`, independent of its configured name. Dangerous targets are excluded from an ordinary cycle. If one is already effective, the controller unlocks it for the remainder of that TUI mount and places it after Plan, allowing a user who explicitly selected full access to leave and return without making the conventional shortcut an escalation path.

The TUI registers a `${mode}` prompt value and adds it before `${queued}` in the default right-prompt template. It renders safe permissions, Plan, pending transitions, and full access with distinct compact markers, includes the same effective target in `/status`, documents the keys in `/help`, and redraws from the existing session-event stream. No combined event, settings namespace, or model-facing prompt contribution is introduced.

## Verification

Pure controller tests cover safe ordering, dangerous exclusion and later unlock, custom-state recovery, pending entry and exit, plan-only fallback, and missing services. TUI integration tests mount the real approval, permission-preset, and Plan services; they verify keyboard transitions, canonical event sequences, `/status`, and open-turn pending rendering.

A keyless recorded-terminal scenario renders the initial permission, Plan, safe wrap, explicit full access, and the unlocked return cycle while asserting exact `plan/mode` and `permission/preset` sequences. A second keyless PTY smoke boots the built shipped profile through Windows ConPTY or a POSIX PTY, sends Shift+Tab and Alt+M, observes Plan and both safe presets in `/status`, verifies the persisted events contain no `danger-full-access`, and exits through normal terminal restoration.

## Alternatives considered

**Add a new universal mode service and event.** Rejected because permission presets and Plan have different enforcement, timing, persistence, prompt, and review semantics. A terminal projection can compose them without becoming another source of truth.

**Rename Harness state to Claude Code's mode vocabulary.** Rejected because aliases such as `acceptEdits`, `dontAsk`, and `delegate` do not exactly describe the configured sandbox-plus-approval bundles or Plan's soft guidance. The shortcut and status affordance are compatible; the state vocabulary remains honest to the mounted services.

**Include full access in every cycle.** Rejected because an accidental keypress must not remove confinement and approval boundaries. Explicit selection remains available through the canonical permission surface; only an already-effective dangerous preset becomes cycle-reachable.

**Make Plan imply read-only permission.** Rejected because Plan is intentionally soft collaboration guidance, while sandbox and approval are independent enforcement. Coupling them in one UI would create a hidden policy change not owned by either service.

**Keep command-only control.** Rejected because commands remain useful for exact selection and automation, but do not provide the low-friction cycle or persistent status required by the interactive terminal target.

## Consequences

The built TUI now has Claude Code-style mode cycling and visible status while preserving DeepSeek Harness's existing service ownership. Keyboard cycling cannot newly grant full access, an in-turn Plan request honestly displays its deferred boundary, and custom or partially composed deployments degrade without forged state.

The controller's unlocked-danger memory is intentionally terminal-local: an explicitly effective full-access state can join the current mount's cycle, but no new durable unlock event is created. Custom right-prompt templates may omit `${mode}`; `/status` remains the explicit diagnostic. Full access still enters through the generic `/permission danger-full-access` command rather than a dedicated TUI confirmation dialog, and exact parity for unsupported Claude Code mode names remains future product work.
