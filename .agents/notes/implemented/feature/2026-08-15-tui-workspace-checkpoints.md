# Agent Note: Manual TUI workspace checkpoints and rewind

Status: implemented

English | [中文](2026-08-15-tui-workspace-checkpoints.zh.md)

## Problem

The terminal could inspect a conversation and resume a persisted session, but it had no deliberate recovery point tying readable workspace state to a safe conversation boundary. A raw `git diff` is not enough: a user needs to preserve staged changes, unstaged changes, and newly created files without placing their contents into model context. Rewinding in place would also either discard the original conversation or risk seeding a child with an open command or turn lifecycle.

## Decision

`@deepseek-ai/dsh-tui` owns a host-facing `WorkspaceHistory` boundary and ships `LocalWorkspaceHistory`. It stores checkpoint metadata and artifacts below `DSH_HOME/workspace-checkpoints/v1/<sha256(session-id)>`, outside the project worktree. A Git-backed checkpoint records the resolved Git root, session-directory scope, `HEAD`, staged patch, unstaged patch, and nonignored untracked regular files or symlinks. A non-Git directory still receives a durable conversation-only checkpoint with the unavailability reason.

`/diff` opens a read-only full-screen pager for the current scoped Git change set. `/checkpoint [label]` saves the event boundary immediately before its own pending `command/run` record, so a later child seed never contains a dangling command lifecycle. `/rewind [checkpoint-id]` selects a saved checkpoint, then asks separately for workspace restore, conversation branch, or both and requires an explicit `y` confirmation.

Workspace restoration first captures the current state as a visible safety checkpoint. It refuses a changed Git root, session directory, or `HEAD`; removes only current nonignored untracked paths inside the captured scope; restores tracked paths from the recorded commit; then reapplies the staged and worktree patches and checkpointed untracked files. Empty patch artifacts are intentionally skipped because `git apply` rejects them. Snapshot diff generation disables rename detection so a checkpoint from a nested session directory cannot carry a rename endpoint outside that directory. Once the safety checkpoint is durable, restore and safety recovery use an uncancelled operation signal: cancellation remains available during preflight, but cannot leave a confirmed filesystem restore half-applied.

Conversation rewind uses the runner's exact completed event boundary to create a newly identified child session with `parentSession` and `seedLength` metadata. The source session is never truncated and remains resumable. When a combined rewind restores files but the child swap later fails, the new safety checkpoint remains available for an explicit recovery.

## Alternatives considered

**In-place session truncation and `git reset --hard`.** Rejected because both discard the original recovery path and make accidental loss too easy. The selected checkpoint must branch conversation history and retain a separate safety point instead.

**Automatic snapshotting after every edit or tool call.** Rejected for this scope because the TUI does not own every filesystem mutation, the artifact volume would be unbounded, and automatic snapshots would obscure the user-selected recovery boundary. Checkpoints remain explicit.

**Commit-based restore or cross-commit patch application.** Rejected because a later commit can change patch applicability and semantics. The provider requires the same resolved root, directory scope, and `HEAD` rather than pretending a checkpoint is a general Git history rewrite.

**Showing the diff or checkpoint contents to the agent.** Rejected because inspection and recovery are local user operations. The TUI renders those artifacts only in terminal overlays; no workspace bytes are added to model context.

## Consequences

Terminal users gain a recoverable, reviewable coding loop without needing a graphical client: inspect with `/diff`, name a point with `/checkpoint`, and choose exactly which state to restore with `/rewind`. The feature deliberately remains manual, Git-scoped, and single-host coordinated: ignored files, automatic per-edit snapshots, cross-commit restore, worktree creation, and atomic filesystem-plus-session swaps are not provided.

The branch invariant follows the existing [SessionStore fork API](2026-06-30-session-store-fork-api.md) and [completed-turn-tail rule](../bug-fix/2026-08-02-message-fork-actions-require-completed-turn-tail.md): child replay starts from a balanced persisted prefix, while the original log stays authoritative and resumable.

## Verification

Focused Git integration tests cover staged, unstaged, untracked, ignored, empty-patch, nested-directory rename, same-`HEAD`, non-Git, and post-safety-checkpoint cancellation behavior. Runner tests pin exact seed selection and rejection of an active-turn boundary. Mounted TUI tests and keyless snapshots cover the diff pager, checkpoint command, action picker, explicit confirmation, and child-swap handoff.
