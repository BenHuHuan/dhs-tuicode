# Agent Note: TUI foreground external editor

Status: implemented

English | [中文](2026-08-14-tui-external-editor.zh.md)

## Problem

The restored TUI could edit a prompt only inside pi-tui. It lacked Claude Code's documented Ctrl+G and readline-native Ctrl+X Ctrl+E external-editor entry, could not use that entry for a custom question response, and had no equivalent of the `externalEditorContext` setting that prepends the previous assistant reply as disposable comment context. A foreground editor also needs exclusive control of the inherited terminal; spawning one while ProcessTerminal still owns raw mode, bracketed paste, and cursor state would make both interfaces consume the same bytes and could leave the user's shell damaged after failure. The target behavior is documented by Claude Code's [interactive-mode](https://code.claude.com/docs/en/interactive-mode), [keybinding](https://code.claude.com/docs/en/keybindings), and [configuration](https://code.claude.com/docs/en/configuration) references.

## Decision

`TuiRuntime.editText` is the replaceable host boundary. The channel passes the expanded draft and, when configured, the latest committed assistant text. The shipped host supplies `editTextInExternalEditor`; an embedder that omits the boundary gets an explicit error and keeps the draft. A foreground direct-Shell attachment blocks the operation because it already owns the same terminal, while an active model turn does not block composing a later steering prompt.

The production helper selects the first non-empty `VISUAL` or `EDITOR`, then falls back to `notepad.exe` on Windows and `vi` elsewhere. Conventional quoted commands and arguments are parsed without a shell for normal executables. Windows `.cmd` or `.bat` editors, and a bare command whose direct spawn reports `EINVAL` or `ENOENT`, run through `ComSpec`; the editor command is user-owned configuration, while the generated file path travels through a dedicated environment variable instead of command interpolation. The child inherits stdio and must exit before the helper returns. Editors that detach by default therefore need their normal wait option, such as `code --wait`.

Each invocation creates a private `dsh-tui-editor-*` directory and UTF-8 `prompt.md`, waits for the child, reads the saved file, normalizes line endings and a UTF-8 BOM, then removes the exact directory in `finally`. A spawn error, signal, or nonzero exit rejects without changing the live draft. Cleanup failure is surfaced, and a cleanup failure following an editor failure reports both causes rather than hiding the first one.

When `externalEditorContext` is true and a committed assistant text exists, the helper prepends it as `#`-commented lines between fixed start and end sentinels. On readback it strips only a generated leading block with both sentinels. A missing or edited closing sentinel leaves the document intact instead of silently deleting content, and a user-authored draft beginning with Markdown headings is never treated as generated context. The context never becomes a session event or model input unless the user deliberately removes the sentinel contract and retains it as draft text.

The channel sets an in-flight guard, disables main-editor submission, drains terminal input, calls `TUI.stop()`, awaits the host, then calls `TUI.start()`, invalidates the component tree, and requests a forced render. Input that reaches a fake or unusually buffered terminal during the handoff is consumed. The draft is replaced only after a successful return; failure appends a visible error after terminal ownership is restored. Disposal while the editor is open prevents a late restart.

One `ExternalEditorShortcut` recognizer serves both editing surfaces. Ctrl+G invokes immediately. Ctrl+X arms the readline chord; Ctrl+E invokes, a second Ctrl+X rearms, and any unrelated next input disarms the prefix while allowing that input through. A combined legacy `\x18\x05` chunk is also recognized. Overlay priority remains unchanged, so only `QuestionDialog` handles the shortcut while a user question is active.

The custom-response control now uses pi-tui's multiline `Editor` instead of its single-line `Input`. Ctrl+G or Ctrl+X Ctrl+E from option mode switches to custom mode and opens the same host boundary; the saved multiline text remains editable in the dialog and is returned losslessly as the custom answer. Its control legend advertises Ctrl+G without expanding the main transcript.

## Verification

Pure unit tests pin command parsing, `VISUAL`/`EDITOR` precedence, platform fallbacks, comment-block construction and stripping, latest-assistant selection, both shortcut forms, actual foreground Node editing, nonzero exits, exact temporary-directory cleanup, BOM and line-ending normalization, and a quoted Windows `.cmd` editor path. Channel tests pin optional context, terminal drain and stop/start counts, in-flight input consumption, multiline main drafts, unrelated chord followers, combined chunks, failure rollback, missing-host degradation, and multiline custom question answers. Recorded terminal output pins a returned two-line draft and the `started=2 stopped=1` lifecycle.

A keyless built-lib PTY smoke sets `VISUAL` to a fixture editor. After a fresh-session swap and two real scripted turns, the fixture requires both the current draft and latest assistant reply in its file, prints a start marker, and saves a replacement prompt. The smoke waits for the third bracketed-paste enable before submitting, observes the scripted model's response, and inspects both JSONL logs: the replacement prompt is durable, while the original draft and context sentinel are absent. This validates ProcessTerminal release and reacquisition on Windows ConPTY or a POSIX PTY without an API key.

## Alternatives considered

**Open the file with the operating system's default-app API.** Rejected because default-app launchers are intentionally fire-and-forget. The TUI cannot know when to reacquire raw mode or when the user has finished saving.

**Keep ProcessTerminal running while the editor child inherits stdio.** Rejected because two input owners would race over the same terminal, bracketed-paste state would remain enabled for the child, and failure could strand raw mode.

**Run every configured editor through a shell.** Rejected on POSIX and for ordinary Windows executables because direct argv spawning avoids another quoting and expansion layer. Windows command wrappers retain a narrow shell path because Node cannot execute `.cmd` or `.bat` files directly.

**Strip every leading `#` line after save.** Rejected because Markdown headings and commented prompt material are valid user drafts. Paired sentinels identify only the generated block and fail closed when the block is modified.

**Flatten a multiline external custom response back into the old single-line `Input`.** Rejected because it would silently change the answer the user saved. Reusing pi-tui's multiline editor keeps prompt and custom-response semantics aligned.

## Consequences

The TUI now offers both documented external-editor shortcuts for prompts and custom responses, restores terminal state before showing any result, and keeps failed edits rollback-safe. Optional previous-reply context is useful to the human editor but excluded from the submitted prompt by construction. The external-editor operation itself is terminal-local; the saved result becomes ordinary draft text and enters the session only if the user submits it.

The configured editor is trusted user configuration and receives a temporary plaintext copy of the draft plus optional previous reply. That copy is deleted after the editor exits, but an editor may retain its own backups or history. A detaching editor needs a wait flag, and a foreground direct Shell must be backgrounded or cancelled first. `externalEditorContext` defaults to false so existing deployments do not expose prior replies to an external process unless they opt in.
