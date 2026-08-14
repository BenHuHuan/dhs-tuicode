# Agent Note: TUI prompt-history search

Status: implemented

English | [中文](2026-08-14-tui-prompt-history-search.zh.md)

## Problem

The restored TUI kept only pi-editor memory for exact submitted text and rebuilt that memory from model-visible human messages on resume. That lost slash commands, manual skill commands, direct-shell submissions, and every prior session. It also assigned Ctrl+R to reasoning visibility even though the Claude Code-compatible interaction target uses Ctrl+R for reverse history search. Deriving exact input only from existing model and command events is impossible after a skill body or session reference has been expanded, and an eager unbounded scan would make opening the terminal depend on every stored log.

## Decision

Ctrl+R opens a full-viewport prompt-history dialog without modifying the current editor draft. It begins in the current-session scope; Ctrl+S cycles through current project, all projects, and back to the session. Literal case-insensitive filtering, newest-first ordering, newest-observation duplicate collapse, Up/Down and Page Up/Page Down navigation, Tab insertion, Enter insertion plus immediate submission, and Esc/Ctrl+C/empty-query Backspace cancellation are terminal-owned behavior. Reasoning visibility remains available through the `/details` selector and `/details reasoning [on|off]`.

Every non-empty editor submission that passes its form-specific admission checks appends the exact trimmed text as a log-only `tui/input` event before command execution, shell launch, skill loading, or model delivery. Consecutive exact duplicates do not append another event. The event never contributes to `deriveMessages()` or model context; package invariants reject empty text and adjacent duplicates. Ordinary prompts, slash commands, `/skill:` invocations, direct-shell commands, and asynchronously prepared session-reference prompts therefore share one honest recall source without a private side file.

The current session is indexed synchronously. The first `tui/input` event makes exact events authoritative from that point onward, so downstream `user/message` and `command/run` records do not duplicate the same submission. Before that boundary, legacy sessions recover direct user messages, user-originated slash commands, and completed `user-shell` results. An expanded legacy `<skill>` body is omitted because the original `/skill:` command cannot be reconstructed exactly.

Project and all-project scopes lazily borrow the optional `ctx.sessionQuery` service. One scan inspects at most `historyMaxSessions` prior sessions, reads at most `historyScanConcurrency` exact logs concurrently, and returns at most `historyMaxEntries` unique matches. Half of the bounded candidate budget is reserved for recent same-project sessions and the remainder follows global recency, so a prolific workspace cannot starve all-project recall. A listing failure is retryable; one unreadable prior session is skipped; disposal aborts cancellable listing work and ignores any exact read that was already in flight. `maxHistoryOptions` separately bounds visible rows.

## Verification

Prompt-history unit tests pin exact/legacy indexing, adjacent and result-level deduplication, legacy skill omission, normalized project scope, balanced bounded discovery, progressive results, concurrency, unreadable-session containment, retry, disposal, and invalid bounds. Dialog tests pin filtering, scope cycling, navigation, insertion, submission, cancellation, paste handling, paging, and loading/failure states. TUI integration tests cover every accepted input form, draft preservation, Tab versus Enter, and project/all-project persistence. Package invariants cover malformed and adjacent `tui/input` events.

The keyless recorded-terminal snapshot renders the Ctrl+R search and accepted editor result after a real platform shell command. The root snapshot lane now collects the package-owned TUI terminal snapshots as well as assembled app snapshots, so renderer goldens cannot silently fall outside CI. The built `dsh` PTY smoke performs the same search and Tab insertion through Windows ConPTY or a POSIX PTY, verifies the durable event without an API key, and observes terminal restoration.

## Alternatives considered

**Persist a private readline-style history file.** Rejected because it would create a second durability, locking, workspace-identity, and retention system beside the session log, while still lacking a trustworthy relationship to accepted TUI actions.

**Derive all history from existing model-visible and command events.** Rejected because expanded skills, prepared references, cancelled shell commands, and other transformed inputs cannot be inverted to the exact editor text. Showing an approximation as executable history would be dishonest.

**Read every session eagerly when the TUI mounts.** Rejected because terminal startup would scale with the entire store and one corrupt neighbor could delay an unrelated current-session interaction. Discovery is lazy, bounded, progressive, cancellable, and failure-contained.

**Keep Ctrl+R as the reasoning toggle.** Rejected because it conflicts with the target reverse-history interaction and reasoning already has the explicit `/details` surface. A user can still toggle reasoning without spending the conventional history keybinding.

## Consequences

Exact accepted TUI input now survives resume and can be recalled across bounded project or global history without entering model context. Tab is a safe edit-only acceptance, Enter preserves the selected form's ordinary execution path, and cancellation leaves the draft untouched. Cross-session results remain advisory when session-query is absent or a prior log is unreadable, while current-session recall remains synchronous.

The persistence vocabulary gains `tui/input`, so each non-consecutive accepted submission adds one log-only event and increments event diagnostics without adding tokens. Existing sessions retain best-effort compatibility, but pre-event manual skill invocations are deliberately absent rather than replaced by generated instruction bodies. The scan caps trade exhaustive recall in very large stores for predictable terminal latency and bounded I/O.
