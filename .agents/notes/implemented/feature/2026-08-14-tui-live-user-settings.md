# Agent Note: TUI live user settings

Status: implemented

English | [中文](2026-08-14-tui-live-user-settings.zh.md)

## Problem

The TUI exposed presentation fields only through its Cordis entry. Changing reasoning-block visibility or the [external editor's previous-reply context](2026-08-14-tui-external-editor.md) required editing a composition patch, and the value did not have Claude Code's documented interactive `/config` path. Treating every TUI field as live user configuration would be inaccurate: widths, resource limits, prompt templates, and terminal construction choices are consumed while the component tree is built.

## Decision

The TUI registers a `ui-tui` user-settings namespace containing exactly `showReasoning` and `externalEditorContext`. Its schema supplies the same defaults as `TuiConfig`; the Cordis entry is the composition base and the settings provider's document is the user layer. The remaining TUI config stays deployment-owned because changing it requires rebuilding components or resource controllers.

Bare `/config` opens a centered two-entry selector. Up/Down selects a row, Enter or Space writes the opposite value, and Escape or Ctrl+C closes. A row shows a saving state while `SettingsProvider.update()` validates and persists the sparse patch. The mounted channel changes only after the write returns its committed snapshot; rejection keeps the prior value and renders the error in the dialog. An embedding without a settings provider may inspect its composition values, but a write fails explicitly.

The production host installs the namespace through `installSettingsSection`. Its source thunk reads the latest provider snapshot and falls back to the entry when the optional service detaches. Provider commits, including externally edited `$DSH_HOME/settings.yaml`, are forwarded to the current mount; a fresh or resumed mount reads the same source before constructing transcript state. `TuiRuntime.readSettings` and `updateSettings` keep this host ownership replaceable for embeddings and tests, while `TuiController.updateSettings` applies provider notifications to an existing channel.

Reasoning visibility updates rebuild the transcript from the durable session log without changing that log. External-editor context is read when an edit starts, so a committed toggle affects the next invocation without remounting. `/details reasoning` remains a transient transcript control; `/config` owns the persisted default and a later settings commit or remount reapplies it. `settingsDialogWidth` remains Cordis configuration because it determines selector layout rather than user behavior.

## Verification

Package tests pin schema defaults, successful persistence, missing-writer failure without optimistic mutation, external-editor consumption of the committed value, and a provider-style reasoning update on a mounted controller. A terminal snapshot records the committed selector state. The built-lib keyless PTY smoke toggles external-editor context through `/config`, verifies the `ui-tui` section in the isolated `settings.yaml`, crosses a fresh-session remount, and then requires the foreground editor fixture to receive the latest assistant reply. The PTY driver can force an input-turn boundary after Escape so ConPTY cannot merge overlay close and the following global shortcut into one byte chunk.

## Alternatives considered

**Register the complete `TuiConfig` as one live settings namespace.** Rejected because most fields are construction-time values. Advertising them as live would promise behavior the mounted tree cannot apply; marking the whole namespace restart-only would also deny immediate updates to the two fields that are genuinely live.

**Mutate the Loader-provided config object in `/config`.** Rejected because it would be process-local, bypass settings validation and atomic persistence, ignore external edits, and lose the value on a fresh process.

**Apply the selected value optimistically and roll it back after a failed write.** Rejected because the settings provider publishes only committed state. Rendering an uncommitted value would let the transcript or external editor observe configuration that never reached the user's document.

## Consequences

The shipped TUI has a persistent interactive configuration path for the two settings it can honor immediately. The same `$DSH_HOME/settings.yaml` values apply across fresh and resumed TUI channels, while composition remains the fallback for deployments without a provider. Failed writes are visible and leave runtime behavior unchanged.

These settings are terminal presentation state. They create no session events and add no model-visible content; edited prompt text still enters the log only through ordinary submission. Adding another `/config` row requires proving that the field can apply to an already-mounted channel, or defining a separate restart-scoped interface instead of widening this live namespace.
