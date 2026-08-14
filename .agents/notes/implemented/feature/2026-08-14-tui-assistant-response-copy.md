# Agent Note: TUI assistant-response copy

Status: implemented

English | [中文](2026-08-14-tui-assistant-response-copy.zh.md)

## Problem

The restored TUI could display durable assistant replies but could not move one into the desktop clipboard. Claude Code documents `/copy [N]` as copying the latest or Nth latest assistant response and, when a response contains code blocks, selecting either the complete response or one block in an interactive picker. Implementing that behavior directly over the model surface would be wrong: compaction and regenerated model-only replacements can contain assistant text that the terminal never showed, while reasoning and tool-call blocks are not response text. Passing assistant content through a shell command string would also add an avoidable injection and quoting boundary. The target behavior follows Claude Code's [interactive-mode command reference](https://code.claude.com/docs/en/commands).

## Decision

`visibleAssistantResponses()` walks committed session events newest-first. It accepts only `assistant/message` events whose `surfaceOp` is `append`, concatenates text blocks without normalizing the selected value, and excludes a message when the resulting text is whitespace-only. Reasoning, tool calls, images, replacement-origin messages, and non-assistant events therefore do not consume an ordinal. The external editor now uses the same selector for its optional previous-response context, so both human surfaces agree on what “latest visible assistant reply” means.

`/copy` selects ordinal 1; `/copy N` requires a positive safe integer. A missing ordinal reports the available visible-response count. A response without a non-empty fenced code block goes directly to the clipboard writer. A response with copyable backtick or tilde fences opens a centered `CopyResponseDialog` containing the complete reply followed by code bodies in source order. Up/Down moves, Enter copies, `w` begins a file write for the highlighted target, and Escape or Ctrl+C cancels without writing. The parser honors longer closing fences and treats an unclosed final fence as owning the finalized reply tail; empty fences remain detectable but are not offered as targets.

`TuiRuntime.writeClipboardText` is the replaceable host boundary. It receives exact text, the session working directory, and an abort signal. The shipped `writeTextToClipboard` implementation spawns an exact argv with `shell: false` and sends UTF-8 text only on stdin. Native Windows and WSL use noninteractive STA PowerShell plus `System.Windows.Forms.Clipboard`; Linux tries `wl-copy` and then `xclip`; macOS uses `pbcopy`. `clipboardTextCommand` replaces platform selection with one exact argv for remote desktops and custom bridges. Stderr retention is bounded, start and nonzero-exit failures are explicit, and a custom command never falls through to a different helper.

`TuiRuntime.writeTextFile` owns the corresponding host filesystem boundary. After `w`, a focused one-line dialog requires a non-empty path. Relative paths resolve against the session working directory. The first attempt uses exclusive creation with private-mode intent, so an existing target remains byte-for-byte untouched and produces a second confirmation dialog. Only an explicit `y` retries with overwrite enabled; `n`, Escape, Ctrl+C, or closing either dialog cancels. The writer sends no path or text through a shell, writes exact UTF-8, does not invent parent directories, and returns the resolved target for the completion notice.

The command keeps its command-lifecycle abort signal while any picker, path prompt, or overwrite guard is open and links clipboard work to a five-second child-operation timeout. During clipboard or file I/O, editor submission and other global actions are frozen and the status row names the operation. TUI disposal aborts both the command and transfer controller before overlays and terminal ownership are released. The selected text and file path never become model input; the explicit slash invocation itself retains the ordinary log-only TUI command lifecycle.

## Verification

Pure tests pin newest-first append-origin selection, multi-block concatenation, whitespace/reasoning/tool/replacement exclusion, positive ordinals, and backtick, tilde, longer, CRLF, invalid, empty, and unclosed fences. Process-boundary tests pin platform clipboard argv selection, exact Unicode and terminal-control bytes on stdin, empty input, bounded failure diagnostics, missing executables, and cancellation. Filesystem-boundary tests pin relative-path resolution, exact UTF-8 content, exclusive creation, unchanged existing content, explicit overwrite, invalid parents, and cancellation. Mounted-channel tests pin `/copy`, `/copy 2`, argument and range failures, absent-writer degradation, the complete-response/code-block picker, copy and write cancellation, path validation, overwrite refusal and acceptance, no model send or steer, visible in-flight state, and writer abort on disposal. Recorded terminal output pins the selector and command inventory.

Keyless built-lib PTY smokes boot the shipped profile, select the scripted model, and complete real streamed responses. One invokes `/copy` and drives the configured shell-free stdin clipboard writer; another opens a fenced-response picker, highlights its code block, presses `w`, enters a relative path, and drives the shipped file writer. Post-run inspection requires byte-equivalent UTF-8 text in both files, while PTY output requires each completion notice and bracketed-paste release. This covers the production config, built package, CLI, Loader tree, ProcessTerminal, and both host boundaries without an API key.

## Alternatives considered

**Copy the current model surface.** Rejected because replacements deliberately change model visibility without rewriting the human transcript. A clipboard command must describe what the user saw, not what a later request sees.

**Copy reasoning or rendered tool cards along with assistant text.** Rejected because `/copy` names an assistant response. Reasoning visibility is a presentation setting, and tool cards can contain presenter-generated summaries rather than assistant-authored text.

**Pass the text as a command-line argument or shell interpolation.** Rejected because assistant text is untrusted, can contain controls and arbitrary quoting syntax, and may exceed command-line limits. UTF-8 stdin has one exact byte boundary and keeps the process argv data-free.

**Depend on one cross-platform clipboard package.** Rejected because the shipped profile runs on native Windows, WSL, Linux desktops, and macOS. Small platform argv candidates plus an override keep ownership and failure behavior inspectable.

## Consequences

TUI users can now copy a stable visible response or one fenced code body without an API key, and `N` remains stable against compaction replacements and private reasoning. Clipboard text is plaintext exposed to the operating-system clipboard and any configured writer, so `clipboardTextCommand` is trusted deployment configuration. Default desktop helpers remain optional host dependencies; an embedding can omit the boundary and receives an explicit error.

The picker now also covers Claude Code's SSH-oriented `w` action without silently choosing a filename or overwriting an existing target. This is an explicit host filesystem mutation outside the agent tool-policy path: the human chooses the selection and path, and the destructive retry has its own confirmation. Embedders may omit the file boundary and receive an explicit error after choosing `w`.
