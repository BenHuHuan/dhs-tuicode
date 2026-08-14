# Agent Note: Restore the shipped TUI profile

Status: implemented

English | [中文](2026-08-14-restore-tui-profile.zh.md)

## Problem

The 2026-08-04 TUI removal was correct for a package with no shipped composition, but the product direction changed: DeepSeek Harness now needs a named, Claude Code-like interactive terminal front door. Restoring the package from history alone did not make that product real. Its APIs had drifted, its old launcher assumptions no longer matched profile bundles, and source-mode `tsx` resolution concealed failures that appeared when the CommonJS artifacts used by CI were loaded by plain Node. On Windows, ConPTY input modes, native PowerShell execution, and unprivileged symlink behavior added platform-specific acceptance failures.

## Decision

Restore `@deepseek-ai/dsh-tui` as the interactive frontend of the shipped `tui` profile and expose `dsh tui` as the profile alias. This is a product composition, not an unmounted reusable package: the profile supplies the agent, persistence, tools, model adapters, interaction services, and the TUI package together. The package README owns the detailed rendering, command, extension-overlay, resume, and terminal-safety contracts.

The profile-local `tui-runner` waits for the Loader tree to settle, creates or resumes one interactive agent through `AgentRegistry`, publishes it as `ctx.tuiAgent`, and emits `tui-agent/ready` after each committed settlement. The TUI channel is the sole owner of the live model-selection reference; the runner only snapshots `agentDefaultModel.currentSelection()` when it creates the agent. A failed initial settlement reports the error, disposes the application, and requests a forced post-disposal exit so a surviving process handle cannot turn a startup failure into a silent hang. Resume swaps commit before disposing the previous handle, so a rejected resume leaves the current session usable.

The assembled keyless acceptance path is the built-host-library path: `DSH_EXAMPLE_MODE=lib` runs the CLI with plain Node over `lib` artifacts. The scripted LLM fixture is compiled with esbuild before it is installed into a temporary profile's `node_modules`; Node deliberately refuses type stripping for TypeScript in that location. A separate late-failure fixture starts the renderer before rejecting, which proves terminal restoration without depending on sibling-plugin mount timing. Invalid configuration that fails before terminal acquisition is instead required to leave the terminal untouched.

Windows uses the platform-native PowerShell executor and filters ConPTY-only input-mode sequences from portable transcript assertions. Tests that need directory aliases create junctions; tests whose subject is specifically a file symlink are skipped on Windows because an ordinary checkout does not have `SeCreateSymbolicLinkPrivilege`. The Windows ACL runner receives the resolved absolute PowerShell executable because a restricted token cannot be assumed to resolve a bare command through the caller's environment. Workspace catalog scans tolerate a temporary lint probe disappearing between glob enumeration and file inspection, and spawned lint-fix probes use an explicit bounded timeout, so full-suite concurrency does not turn fixture cleanup or Windows process startup into false failures.

This decision reverses [Remove the TUI package](../simplification/2026-08-04-remove-tui-package.md). That note's reintroduction threshold is now satisfied by the named profile, explicit package boundary, concrete terminal interaction provider, and assembled lifecycle and transcript acceptance. M4 establishes a reliable baseline; it does not claim that every Claude Code feature is already present.

## Verification

The full unit suite passes on Windows: 781 files passed and 5 were platform-skipped, containing 13,071 passing and 75 skipped tests. The built-library keyless e2e suite passes with 28 files passed and 33 skipped, containing 134 passing and 88 skipped tests. The focused TUI PTY suite passes all 23 runnable cases, with 2 platform-inapplicable cases skipped. It covers first-run rendering, create and resume flows, personal overlays, model switching, commands, direct shell execution, tool cards, terminal restoration on late failure, and fail-loud startup behavior without API keys.

## Alternatives considered

**Keep Web as the only interactive frontend.** Rejected because the current product goal explicitly requires a first-class terminal workflow, and the existing provider-neutral command, question, approval, presentation, session, and PTY seams can support it without coupling those capabilities to Web.

**Restore the package but leave it unshipped.** Rejected for the same reason the removal note rejected that state: an unmounted frontend has no assembled lifecycle proving that its public surface works. The named `tui` profile is the deployment and acceptance owner.

**Use source-mode `tsx` as the acceptance path.** Rejected because official CI and installed consumers load built CommonJS artifacts through Node. Source mode can resolve workspace packages to a different module graph and cannot execute a TypeScript fixture installed below `node_modules`, so green source tests would not prove the released shape.

**Let the launcher own the interactive agent and selected model.** Rejected because it duplicates frontend state across launcher, runner, and channel and makes overlay replacement capable of dropping identity or selection fields. The runner owns agent settlement; the TUI owns session-local selection and presentation.

## Consequences

DeepSeek Harness again ships a TTY-only interactive terminal frontend on macOS, Linux, and Windows. Pipes and automation must use the headless or protocol profiles. The TUI is a publishable release member whose explicit payload includes its startup, runner, prompt, profile patch, runtime entry, invariant companion, and declarations without source files or declaration maps. The repository again carries the TUI source, snapshots, `pi-tui` patch, PTY harness, service catalog surface, and their ongoing maintenance cost; that cost is accepted because a real product profile and cross-platform assembled suite now consume them.

Built-library behavior is the release authority, while source-mode behavior remains a development convenience rather than an M4 gate. Windows file-symlink semantics are not weakened in production code; only privilege-dependent tests are excluded there, while junction-compatible directory-containment behavior remains covered. Further Claude Code parity work builds on this green baseline and must add its own product contracts and acceptance coverage.
