# Agent Note: Give every fresh TUI launch a unique session

Status: implemented

English | [中文](2026-08-14-tui-fresh-session-identity.zh.md)

## Problem

The shipped TUI runner created every unresumed process with the literal session id `main`. After one process persisted that id, a later process created a different in-memory session with the same id, and persistence correctly rejected the first append as an identity collision. The full-screen surface could therefore appear ready while the conversation itself was unusable. Deleting the old log would lose history, while silently resuming it would attach fresh launches to stale state and preserve the cross-process ownership ambiguity.

## Decision

An unresumed runner startup now allocates `session-<UUID>` before calling `agents.create()`. The fresh-conversation swap uses the same allocator. Only an explicit `resumeSessionId` calls `agents.resume()`, so an existing `main` log remains untouched and can still be entered with `dsh tui --resume main`.

The identity is allocated without a persistence preflight. A random UUID avoids the check-then-create race that would remain if the runner searched for a free human-readable counter.

## Alternatives considered

**Automatically resume `main` when it exists.** This would make an ordinary fresh launch silently inherit old conversation state and would still let two processes claim the same durable writer.

**Probe storage and allocate a readable counter.** A check followed by creation has a cross-process race unless persistence also owns an atomic reservation protocol. UUID allocation needs no preflight or new storage contract.

**Delete or rename the old `main` log.** Mutating user history is unnecessary and would make the fix destructive. Explicit resume keeps that history available under its original id.

## Verification

The runner unit test asserts that two independent unresumed startups receive distinct durable identities. The built-library keyless PTY test launches the CLI twice with the same `DSH_HOME` and workspace, confirms that neither launch reports an id collision, and verifies two distinct persisted session logs.

## Consequences

Ordinary repeated launches no longer contend for a shared `main` log, and no existing history is renamed or deleted. Fresh session ids are intentionally less memorable; the exit message, `/status`, `/resume`, and session picker expose the exact resumable id. Explicitly resuming the same id from multiple processes still requires coordination outside the TUI.
