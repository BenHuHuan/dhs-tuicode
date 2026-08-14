# Agent Note: TUI direct shell mode

Status: implemented

English | [中文](2026-08-14-tui-direct-shell-mode.zh.md)

## Problem

The restored TUI could ask the model to run a shell tool, but it lacked the user-owned `! command` path expected from a Claude Code-like terminal. Treating that input as an ordinary prompt would make execution indirect and nondeterministic. Treating it as a forged tool call would invent model authorization and a call id that never existed. A direct path also has to preserve the deployment's working directory, managed Harness environment, sandbox boundary, cancellation, durable session history, and Windows/POSIX executor choice.

## Decision

A submitted line whose first character is `!` enters direct shell mode. A non-empty command starts once through the composition's existing `ctx.shell` executor, with the interactive session's working directory, an abort signal, the optional `ctx.shellEnv` snapshot, and the optional `ctx.sandboxPolicy` resolution for that session. The explicit human submission is the authorization boundary, so it does not enter model-tool approval. The standing sandbox policy still applies; direct mode is not an unrestricted escape hatch. The TUI uses `ShellExecutor.start()` because the same live process must remain transferable after launch; unlike foreground `run()`, this handle has no executor timeout.

Only one foreground direct command may be attached per TUI channel. Its bounded combined output is rendered incrementally, and submission stays disabled until it settles or leaves the foreground. Ctrl+C aborts it before the ordinary turn-cancellation path, Ctrl+D refuses to exit while it is attached, and channel disposal aborts an attached command. A bare bang, a missing executor, or a second concurrent submission leaves the draft available and reports a terminal warning. A foreground command explicitly aborted by the user and an infrastructure rejection remain terminal-only notices and do not wake the model.

Ctrl+B asks the optional `ctx.jobs` registry to accept the already-live process as a `bash-N` job. Registry admission and owner/controller checks run before the transfer callback; rejection leaves the process attached and owned by the TUI. Success removes the live row, re-enables the editor, and exposes the task through both `/tasks` and the model-facing jobs tools. `/tasks` is a terminal-only point-in-time list of this agent's visible job ids, states, labels, and terminal detail.

When execution settles normally, including a nonzero exit and whether attached or backgrounded, the TUI appends one durable user-role message with plugin provenance `user-shell` and notice form. Its `<user-shell-command>` frame contains the exact command, effective working directory, bounded combined output, available whole-stream spill locators, and exit/signal/sandbox facts. This is plugin-sourced context rather than a human prompt or synthetic tool result. It follows the ordinary live routing rule: `followup()` while idle and `steer()` while a turn is running. The transcript renders it as a compact `Context · user-shell` card and strips only the known outer frame.

`ShellEnvRegistry.collect()` accepts the public `ToolExecutionInput` shape rather than the registry-private `ToolExecution`. This lets direct user execution receive the same trusted `DSH_*` facts as shell tools without manufacturing a tool-registration token. The executor remains responsible for scrubbing inherited `DSH_*` values before merging the collected snapshot.

`ShellProcess.readOutput()` is a single consuming cursor. `UserShellProcessController` is therefore its only reader and fans each delta into two bounded `TextRetainer` tails: a persistent full view for terminal rendering and final context, and a resettable cursor for `job_output`. Reading job output cannot steal bytes from completion. Upstream lossy/spill facts accumulate independently of either retained tail.

Promoted work sets `JobStart.completionDelivery: 'producer'`. `dsh-jobs-local` initializes that record as reported, so `dsh-tool-jobs` does not send its generic “read with job_output” completion after the TUI has already committed to deliver the full `user-shell` context.

`UserShellHistory` records every accepted command before launch, so a running or later-cancelled command is immediately available in the current channel. Explicit Tab on a trailing `!` draft performs whole-command prefix completion, newest first. The optional session-query service lazily extends that view with completed `user-shell` messages from at most the 32 newest sessions whose resolved, case-normalized-on-Windows working directory matches; discovery retains at most 100 unique commands and reads four exact logs concurrently. Current-session matches never wait behind corpus discovery, duplicate commands keep their newest observation, a failed prior-session read is skipped, and a failed corpus listing may retry on the next completion. Only completed result notices are durable, so an accepted command cancelled before settlement remains process-local.

The wrapped autocomplete provider advertises `/` as a live trigger. The pi-tui dependency patch permits that provider trigger outside a leading slash-command position and keeps later characters, backspace, and deletion in the same path-completion state. Pi's native path provider owns quoting, `~/`, absolute and relative lookup, directory descent, and completion replacement; the TUI uses the session working directory as its base. Forward slashes are the input/display grammar on Windows as well as POSIX. A slash command at the start of the message retains its existing command-menu precedence.

## Verification

Pure contract tests pin bang parsing, durable message provenance, bounded stream/truncation rendering, status rendering, and one-reader fan-out. TUI controller tests pin cwd, managed environment, sandbox propagation, live output, followup delivery, nonzero completion, draft restoration, Ctrl+C cancellation, Ctrl+D refusal, successful Ctrl+B transfer, `/tasks`, job reads, and exactly-once completion with the real local registry plus `dsh-tool-jobs`. Registry tests pin producer-owned completion as reported before and after settlement. Shell-env tests prove a tokenless public execution input still receives the managed environment.

A keyless recorded-session snapshot runs a real platform executor and diffs nine terminal states: live output, Ctrl+B transfer, `/tasks` while running, producer-delivered completion, project-history Tab completion, the live shell-path menu, the accepted path, Ctrl+R prompt-history search, and the accepted history result. It also proves all three jobs tools are composed, the job is terminal and reported, the durable context retains early and late output, no generic jobs notice was logged, and autocomplete alone adds no session event. A separate keyless PTY test boots the built `dsh tui` Loader profile, observes early output in a real terminal, backgrounds the process, lists it while running, expands the completed context to expose late output, observes the model acknowledgement, live-completes a seeded forward-slash path, recalls the exact bang command through Ctrl+R, and verifies terminal release on Windows ConPTY or a POSIX PTY. The snapshot harness selects the platform-native executor and normalizes JSON-escaped Windows working-directory paths.

## Alternatives considered

**Send the bang line to the model as ordinary user text.** Rejected because the model could decline, rewrite, or duplicate a command the user explicitly requested, and the terminal would not provide a deterministic direct-shell interaction.

**Forge a model tool call and tool result.** Rejected because no model issued the call and no legitimate tool-call correlation id exists. It would also misrepresent the authorization path to approval hooks and durable history.

**Bypass the Harness shell seam with `child_process`.** Rejected because it would fork platform selection, subprocess cleanup, output caps, managed `DSH_*` identity, and sandbox behavior away from the same contracts used by the shipped shell tools.

**Launch a second process when Ctrl+B is pressed.** Rejected because it would duplicate side effects and lose already-emitted output. Backgrounding transfers the exact live handle only after the registry accepts it.

**Let the generic jobs reporter own every promoted completion.** Rejected because its intentionally generic notice requires a later `job_output` call and cannot preserve the direct-shell promise that the model responds automatically to the full result. Producer-owned delivery makes the richer context explicit and suppresses only the duplicate reporter.

## Consequences

TUI users can now run an explicit platform-native command with `!`, watch bounded output as it arrives, move it into shared jobs with Ctrl+B, keep prompting, inspect lifecycle with `/tasks`, recall project commands with Tab, complete live host paths with forward slashes, and continue the conversation automatically over a durable result. The model sees command output exactly once under honest plugin provenance, even if `job_output` consumed its own cursor; session replay retains it, and foreground cancellation cannot accidentally submit partial output. Deployments without `ctx.shell` keep a usable editor draft, while deployments without a jobs controller retain the foreground process and receive a clear Ctrl+B warning.

The TUI gains a runtime peer on output retention plus optional type-level peers on the shell, shell-env, sandbox-policy, jobs, and session-query seams. The shell-env public collection contract broadens from private registered executions to public execution inputs, and the jobs Service Definition gains cooperative live-resource transfer plus explicit completion-delivery ownership. Output retention remains bounded per configured command, while executor spill files remain the recovery path for omitted bytes; history discovery is independently bounded by entry, session, and concurrency caps. Cross-process recall of commands that never produced a durable result is the remaining direct-shell history boundary.
