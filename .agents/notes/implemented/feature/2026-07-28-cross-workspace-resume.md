# Agent Note: Cross-workspace session resume

Status: implemented

English | [中文](2026-07-28-cross-workspace-resume.zh.md)

## Problem

`/resume` could only reach sessions started in the launch directory, so returning to yesterday's work in another project meant remembering its path, leaving the TUI, and relaunching there. Two independent causes produced that limit, and fixing either alone changes nothing.

Storage was the binding one. The shipped TUI composition defaulted its persistence root to a relative `./.sessions`, so each launch directory owned a disjoint JSONL root and a disjoint derived `session-query.db`. Sessions from another project were not filtered out of the listing — they were absent from the store the listing reads. The JSONL backend already partitions per-cwd *inside* one root, so the partitioning was doubled: once by root, once within it.

The picker then filtered again. It dropped records whose `cwd` differed from the current session before display, and `summarizeResumeCandidate` independently marked a differing `cwd` as `disabledReason: 'different workspace'`, so a foreign session that did reach the store was both hidden and refused.

Finally, resume needed execution routing, not only transcript replay. Restoring a session header is insufficient if agent-scoped filesystem or shell tools still default to process cwd: an in-process foreign-session swap would then display the right history while acting on the launch project. Conversely, changing process cwd would retarget every agent and process-global service in the same runtime.

## Decision

The shared CLI configuration supplies one session root under the Harness home, the picker gains a workspace scope, and the resumed session header remains the per-agent workspace authority.

**Storage.** The shared base owns the default in `apps/cli/config/base.cordis.yml`: its `session-persistence-jsonl` row calls the app-boot-provided `dshHomePath('sessions')`, which uses the canonical `DSH_HOME` resolver and its standard `~/.dsh` fallback. TUI, Web, and headless therefore consume one default without a session-specific launcher patch or slot. An overlay or personal patch that states an explicit root replaces that row's whole `config` and remains the deployment's authoritative choice.

**Scope, not exclusion.** A workspace other than the current one is a display scope rather than a disabled reason. `showResume()` summarizes every record and the `ResumePicker` owns a `scope` of `'workspace' | 'all'`, defaulting to the current workspace so the common case is unchanged. Tab toggles; the scope line names the active scope and the count the other holds; each row in the all-workspaces scope reports its own workspace, and that label joins the searchable text only in the scope that shows it. A toggle clears the query and selection so the highlighted row always belongs to the visible list, and the per-row workspace line makes a row one terminal row taller in that scope, which the visible-count budget accounts for.

`summarizeResumeCandidate` therefore drops `'different workspace'` and gains `'session has no recorded workspace'`. That is a real new refusal rather than a rename: a header without `cwd` names no directory for the host to enter, so it cannot be handed off even though its log is intact.

**Direct references.** `/resume [session]` and its `/continue [session]` alias converge on the same controller. A bare command opens the picker; an argument resolves an exact session id first, then a unique case-sensitive exact title across the full candidate set. No match fails locally, while a duplicate title reports the matching ids in stable order and requires an id. Resolution deliberately feeds the same mutable preflight and atomic swap as picker selection rather than trusting listing-time metadata.

**Atomic in-process swap.** `preflightResume` re-lists and fully reads the selected log, validates its current `cwd`, route, replay surface, and idle status, then passes the exact `SessionId` to optional `TuiRuntime.swapResume`. The shipped `TuiAgentService` prepares `AgentRegistry.resume()` before retiring the previous handle; only a committed replacement emits `tui-agent/ready` and remounts the channel, so rejection leaves the original terminal session usable. The restored Agent owns the log's re-read header, and agent-scoped filesystem, bash, PowerShell, and persistent-terminal paths derive their default workspace from `agent.session.header.cwd`. Process cwd remains unchanged, avoiding cross-agent global mutation while a foreign session acts on its own workspace.

## Alternatives considered

**Patch `persistenceRoot` from the `dsh` launcher instead of changing the bundle default.** Rejected after finding that a loader patch assigns `config` wholesale. The personal `~/.dsh/config.yaml` overlay already patches the `tui-agent` row with a partial config, which is exactly why `persistenceRoot` was falling back to the bundle default in the first place; a launcher patch would either be erased by that overlay or have to win over it and make the overlay unable to set the field. Owning the default in the bundle survives any partial patch and keeps one home for the fact.

**Keep `./.sessions` and additionally scan the Harness-home root.** Rejected: two roots means two SQLite indexes and a merged listing whose rows have different liveness and revision authorities, to preserve visibility of logs that the no-migration decision already gives up.

**Migrate existing project-local logs into the shared root.** Rejected by the requester. Sessions under a project's `./.sessions` stay on disk and stay resumable by explicit `dsh --resume <id>` from that directory, but no longer appear in `/resume`.

**One flat list of every workspace.** Rejected: it loses the "this project" default that the overwhelmingly common case wants, and in a busy home directory the current project's sessions would compete with unrelated ones.

**Change process cwd during an in-process swap.** Rejected: cwd is process-global, so mutating it for one resumed Agent would silently retarget unrelated agents and services. The durable session header is already the correct per-agent authority, and agent-scoped tools consume it explicitly.

## Consequences

- Sessions already stored under a project-local `./.sessions` disappear from `/resume`. This is the accepted cost of no migration.
- A foreign resume leaves process cwd unchanged but changes the active Agent's workspace authority; every agent-scoped path-resolving tool follows the restored session header.
- The Harness home now holds session logs for every project on the machine. Its growth is no longer bounded by one checkout, and no retention policy is introduced here.

## Testing

TUI tests cover the default scope hiding other workspaces while reporting their count, Tab revealing them with per-row workspace labels, Tab back clearing the query and selection, searching by workspace label, a cwd-less record staying visible but disabled, exact-id and unique-title direct resolution, deterministic duplicate-title refusal, mutable preflight rechecks, and atomic swap rejection. Built CLI PTY tests exercise the shared config default, the per-process derived query index, and `/continue <title>` through terminal release, in-process channel replacement, and restored state. The keyless TUI snapshot pins both scopes of the selector, including the scope line, the per-row workspace lines, and the Tab hint in the footer. Filesystem and shell integration suites separately pin per-session cwd routing.
