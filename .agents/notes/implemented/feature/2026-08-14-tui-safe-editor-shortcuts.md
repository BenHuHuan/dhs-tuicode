# Agent Note: TUI safe editor shortcuts

Status: implemented

English | [中文](2026-08-14-tui-safe-editor-shortcuts.zh.md)

## Problem

The restored TUI treated Ctrl+D as an unconditional idle exit and Ctrl+C as an immediate empty-prompt exit. It also exposed model selection and help only through slash commands, offered no keyboard control for a standing task checklist, could not park an in-progress prompt, and treated both Ctrl+L and `/clear` as view-only redraws. That made an ordinary forward-delete keystroke destructive and left the main editor behind Claude Code's current [interactive-mode](https://code.claude.com/docs/en/interactive-mode) and [keybinding](https://code.claude.com/docs/en/keybindings) contracts: Ctrl+D deletes forward when text exists and requires a timely second press to exit from an empty prompt, `?` toggles shortcut help only from an empty prompt, Alt+P opens model selection, Ctrl+T toggles the task checklist, Ctrl+S stashes a non-empty prompt or restores it from an empty editor, and a second Ctrl+L within two seconds starts a new conversation through `/clear`.

## Decision

The main input listener now owns an 800 ms, key-specific idle-exit confirmation. On an empty editor, the first Ctrl+C or Ctrl+D paints a transient editor hint; the same key pressed again inside the window requests normal shutdown. A different input, timeout, running-status transition, explicit exit, or TUI disposal clears the state and timer. Ctrl+C retains its higher-priority foreground-shell cancellation, active-turn cancellation, and non-empty-draft clearing behavior.

With draft text, Ctrl+D is not consumed by the global listener and reaches pi-tui's existing forward-delete binding. Active shell and agent work still convert Ctrl+D into a warning, so it cannot exit around live work. `/exit` and `/quit` remain explicit one-step commands.

An empty-prompt `?` opens a centered `ShortcutHelpDialog`; `?`, Escape, or Ctrl+C closes it, while a non-empty-prompt `?` stays ordinary input. Alt+P calls the model controller's public selector entry and therefore shares the catalog loading, overlay lifecycle, reasoning-effort controls, selection semantics, and failure reporting of bare `/model`.

Ctrl+T toggles the task checklist by detaching or reattaching its existing `TodoComponent` within a dedicated container. Detachment preserves component state, so hidden `todo/write` events keep replacing the list and the next reveal paints the latest snapshot. Overlay input keeps priority over this main-editor binding, and toggling neither changes the draft nor creates a session event or model message. These editor affordances are terminal-only.

Ctrl+S snapshots the editor text, cursor, pi-tui large-paste registry and counter, and original undo stack. Clearing and restoration use a fresh temporary undo stack around `setText()`, then restoration reconnects the saved paste registry and undo stack; this prevents temporary state changes from erasing paste payloads or entering the user's undo history. A non-empty press stores or replaces the single stash, an empty press restores and consumes it, and an empty press without a stash is a no-op. Overlay input retains priority, so history-search Ctrl+S keeps its existing scope behavior. The stash is terminal-local to one TUI mount and creates no session event or model message.

Ctrl+L always requests a hard redraw and preserves the editor draft. When the agent and foreground shell are idle, its first press also arms a two-second confirmation; an unrelated key, timeout, status transition, or shutdown disarms it. The confirmation uses a dedicated transient row below the editor because pi-tui editor hints are intentionally hidden while draft text exists. A timely second Ctrl+L and typed `/clear` call the same fresh-conversation routine. Active work blocks that routine.

The shared routine flushes the current session, drains terminal input, snapshots the selected provider, model, and reasoning effort, and invokes the optional `TuiRuntime.swapFresh` boundary. The shipped runner first prepares a uniquely identified `session-<uuid>` agent in the same working directory with the selected provider/model, retires the old handle, and only then commits the replacement and publishes its ready event with the complete selection. Failure to create leaves the old agent untouched; failure to retire it disposes the prepared replacement; either rejection leaves the old channel usable. A host without the boundary degrades to a view-only clear with an explicit warning. The old persisted session is never overwritten and remains resumable.

## Verification

TUI integration tests cover Ctrl+D forward deletion at a moved cursor, both confirmed exit keys, timeout rearming, unrelated-key disarming, literal `?` insertion, every shortcut-dialog close key, Alt+P model selection, Ctrl+T visibility while a hidden list receives a replacement, Ctrl+S no-op, replacement, cursor, undo-stack, and large-paste restoration without a logged action, plus Ctrl+L draft preservation, timeout rearming, unrelated-key disarming, double-press and typed `/clear` flushing, selection carryover, and swap rejection recovery. Runner tests pin unique ids, working-directory and AgentOptions carryover, ready-event selection, and prepared-agent rollback. Recorded terminal snapshots pin the centered shortcut panel, the transient exit and Ctrl+L confirmation rows, the updated `/help` copy, an absent hidden checklist and its latest restored state, the empty stashed-prompt hint, and a restored large-paste marker at its original cursor.

A keyless PTY smoke boots the built shipped profile under Windows ConPTY or a POSIX PTY, opens and closes `?` help, selects a model and maximum reasoning effort with Alt+P, performs the Ctrl+L handshake, waits until the replacement TUI reacquires bracketed-paste input, then drives the real `todo_write` tool. The scripted adapter rejects any lost model or reasoning selection. The smoke also verifies exactly one old `main` log and one unique fresh-session log, exercises the Ctrl+T, Ctrl+S, and Ctrl+D flows, exits on confirmed Ctrl+D, and observes terminal restoration without making an API call.

## Alternatives considered

**Keep Ctrl+D as a global exit and assign deletion elsewhere.** Rejected because it makes a common editor operation destructive and diverges from the target interaction.

**Append the first-press warning to the transcript.** Rejected because confirmation is ephemeral UI state; persisting it would pollute replay, history, and model-adjacent presentation.

**Reuse `/help` by appending another transcript block for `?`.** Rejected because a toggleable overlay is discoverable without permanently growing the conversation view. `/help` remains the durable scrollback-oriented command reference.

**Duplicate model-selector loading in the key handler.** Rejected because `/model` already owns catalog resolution, selection, error handling, and overlay replacement. A public controller entry keeps one behavior.

**Discard the task list while hidden and rebuild it from the session log when shown.** Rejected because the live `TodoComponent` already consumes authoritative `todo/write` events. Keeping that component and changing only its container membership preserves the latest state without a second projection or replay path.

**Store only `editor.getText()` for Ctrl+S.** Rejected because pi-tui represents a large paste as a compact `[paste #N …]` marker whose payload lives in a separate private registry; restoring only the marker would submit that literal marker to the model.

**Store only `editor.getExpandedText()` for Ctrl+S.** Rejected because expansion discards the marker-to-payload structure and makes the saved cursor and undo history describe a different text layout. Capturing the narrow pinned runtime state preserves editor semantics exactly.

**Keep `/clear` as a view-only transcript reset.** Rejected because the previous conversation would remain the model's live context and there would be no fresh session boundary to resume across.

**Reuse the `main` session identity after clearing.** Rejected because the new conversation would collide with the old persistence identity and destroy the resumable boundary.

**Dispose the old agent before creating its replacement.** Rejected because a creation failure would strand the user without a live conversation. Preparing first and rolling it back on retirement failure gives the transition a recoverable commit point.

## Consequences

The editor matches the safe, context-sensitive target behavior. Accidental empty-prompt exits require a second same-key press, Ctrl+D remains useful for editing, Ctrl+S can park a lossless draft, shortcut help is one key away, model switching no longer requires typing a command, a long task checklist can leave the viewport without losing updates, and Ctrl+L now distinguishes a harmless redraw from an explicit fresh-session transition.

The old session remains persisted and resumable, while every cleared conversation receives a unique identity in the same workspace and starts with the selected model and reasoning effort. The fresh-session transition is restricted to idle work and requires a capable host; the first redraw and its two-second confirmation remain terminal-only. Because `/clear` remounts the TUI, an unconsumed mount-local Ctrl+S stash does not cross that boundary.

The 800 ms exit confirmation and two-second Ctrl+L confirmation are deliberately terminal-local and are not configurable. Alt+P depends on the terminal reporting an Alt-modified P sequence; bare `/model` remains the portable fallback. The shortcut panel documents the current built-ins but is not yet a user-rebindable keymap browser. Lossless Ctrl+S intentionally depends on the runtime fields of the pinned pi-tui editor; a pi-tui upgrade that changes those fields must update the adapter and its large-paste regression test together.
