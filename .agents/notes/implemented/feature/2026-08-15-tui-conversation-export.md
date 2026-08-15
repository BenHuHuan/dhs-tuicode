# Agent Note: TUI conversation export

Status: implemented

English | [中文](2026-08-15-tui-conversation-export.zh.md)

## Problem

A durable session can be resumed but has no focused terminal command for sharing its complete readable record. `/copy` intentionally selects one assistant reply or code block, so it cannot preserve user prompts, injected context, tool traffic, and an interrupted turn together. An export must remain human-directed and must not turn a local archival action into model input.

## Decision

`@deepseek-ai/dsh-tui` registers `/export [filename]`. It renders the current session header and chronological durable events as plain text: user and injected-context messages, settled assistant messages, tool calls, tool results, and a concise marker for every non-completed turn. Raw stream chunks and request bookkeeping are omitted because they are not a readable transcript.

With a filename, the command writes the selected path. Without one, an overlay offers clipboard copy or a relative `dsh-session-<session-id>.txt` file. Both destinations use the existing cancellable host writers. File creation is exclusive, and an existing path needs the same explicit overwrite confirmation as `/copy`; transferring content disables duplicate submissions until the host call settles.

The command reads the durable log without appending an event, steering the root agent, or delivering any export text or destination path to a model. It reuses the TUI's terminal-local clipboard and file writer integrations, which remain user-trusted deployment helpers.

## Verification

`export.spec.ts` pins filename sanitization, chronological readable rendering, source labels, tool-call/result correlation, incomplete-turn markers, and omission of completed-turn bookkeeping. Mounted `tui.spec.ts` exercises quoted explicit paths, guarded overwrite confirmation, no-argument copy/save selection, unavailable hosts, and the absence of root-agent messages. The keyless real TUI snapshot pins the selector and `/help` inventory.

## Alternatives considered

**Export the visible terminal buffer.** Rejected because terminal wrapping, ANSI styling, card folding, and scrollback do not form a stable or complete conversation record.

**Write the default file immediately.** Rejected because a no-argument command must let the user choose clipboard versus disk and must not create a file without an explicit destination choice.

**Send the export through the agent.** Rejected because a local sharing action does not require inference and could add sensitive conversation data to model context.

## Consequences

Terminal users can preserve or share a complete readable session without leaving the TUI or requiring a graphical client. The output is intentionally a human-readable record rather than a replay format; session persistence remains the source for exact reconstruction. Clipboard and file destinations receive plaintext session content, so deployments must continue to trust their configured helpers.
