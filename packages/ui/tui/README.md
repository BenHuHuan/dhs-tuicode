# @deepseek-ai/dsh-tui

English | [中文](README.zh.md)

The interactive terminal front door for DeepSeek Harness agents, built on [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui). It requires stdin and stdout TTYs; scripts and Loader pipes should use the [headless agent profile](../../../examples/headless-agent/README.md) instead.

The [restored TUI profile Agent Note](../../../.agents/notes/implemented/feature/2026-08-14-restore-tui-profile.md) owns the front-door, supported-platform, lifecycle, and assembled-verification decisions. This README owns the detailed interaction contracts below.

Interactive terminals on macOS, Linux, and Windows are supported. Windows uses pi-tui's native console VT-input handling and ConPTY process verification.

This package owns interactive terminal presentation and input only. It injects `agents`, [`commands`](../../interaction/commands/README.md), `llm`, `systemPrompt`, `tokenMeter`, `tools`, and `userInteraction`; it optionally reads `skills`, `shell`, `shellEnv`, `sandboxPolicy`, `jobs`, `mcpConnections`, and `subagents` services when the composition mounts them, then drives an agent created or resumed by app or developer code. Agent lifecycle, persistence, and the model-facing [`ask_user_question`](../../interaction/tool-ask-user/README.md) tool remain separate composition entries.

After terminal startup succeeds, the package provides the terminal-local `ctx.tui` extension service. A plugin that injects it can call `openOverlay()` with a component factory and constrained layout options; the host exposes the viewport, semantic theme (including terminal-safe DeepSeek `brand` treatment), display-text escaping, redraw, close, and a lifetime signal, but not the pi-tui tree, terminal, focus controller, or overlay handle. Plugin overlays, the model selector, and user questions share one FIFO modal queue. Each request is an effect of the calling plugin fiber, so unload removes queued work or closes visible work before cleanup settles; terminal shutdown unloads dependents before stopping pi-tui. Overlay state is not logged or replayed. Component code is trusted and may render ANSI styling, but must pass untrusted text through `host.display()`.

The TUI rebuilds resumed history in the Claude Code visual language: accepted prompts carry a bold terracotta `❯` rail, assistant output renders headerless in the terminal's default tone, reasoning opens with a dim `✻ Reasoning` line, and each tool call renders as a family-colored `Verb(argument)` card with a status bullet (`⠋` pending, `›` ok, `✗` error), a `⎿`-prefixed body, and a bounded elapsed time once it reaches one second. It renders Markdown responses, applies each tool's `presentCall` / `presentResult` intent to terminal, diff, or generic cards, keeps the standing `todo/write` plan above the editor (cleared on the next `turn/start`), and presents `ctx.userInteraction` questions inline between the transcript/status area and the editor. The question panel shows progress, numbered options, wrapped labels, and separately indented descriptions; it obeys both `maxQuestionOptions` and `questionDialogMaxHeight`, marks hidden options with `↑ N more` / `↓ N more`, and uses Page Up / Page Down to page long question/detail content before an individually oversized selected block while keeping the editor visible. The latest logged session title becomes the header subtitle, with `welcome` before a title exists, and the terminal window title becomes `<session title> — <configured title>`. A durable `llm/retry` event retracts the failed step's live chunks and renders the scheduled retry count, delay, and failure in the transcript; success, exhaustion, and cancellation then settle through ordinary session events. The footer totals each logged model step's usage once, including failed attempts, while treating committed-message usage as a fallback for logs without a usage chunk. Its idle view compares token-meter pressure with `ctx.llm.resolveModelInfo()` context for the current route, displays `context unknown` when the adapter has no capacity metadata, and also shows tool-card mode plus the current model and any explicitly selected reasoning effort; while the agent runs, an elapsed working indicator and `esc interrupt` replace that summary. A surface replacement never rewrites the rendered transcript: the conversation it shadows stays readable, and a landed compaction checkpoint adds one dim `… earlier context was compacted …` marker at its log position, so the terminal reports where the model stopped seeing that history instead of erasing it. Model-only replacement copies — a pruned tool result, a regenerated assistant message — render nothing.

The durable log records `step/start` before the accepted user and injected-context messages for that step. The TUI therefore treats the start as timing state only and defers the assistant block until the first assistant chunk or committed assistant message; an empty step may settle at `step/end` without leaving a ghost row. Live rendering and replay both preserve the conversational order `❯` user / context, then the headerless assistant block.

An embedding may provide `TuiRuntime.formatCwd` when its logical workspace label differs from the session's host directory. The override changes only the footer label; tools continue to use the session `cwd`.

Before model output, session events, tool presenters, questions, configuration, or diagnostics reach pi-tui's ANSI-aware renderers or the terminal title, the TUI renders C0 and C1 controls other than line feeds as visible `\xNN` text. Those sources cannot add terminal control sequences; the TUI and pi-tui retain ownership of terminal rendering and styling.

Typing `@` at a token boundary searches files and directories under the session working directory. A bare fuzzy query uses a reusable bounded workspace index; a query containing `/` lists that directory directly, and selecting a folder keeps completion open for descent. Whitespace-bearing paths are inserted as `@"path with spaces"`. Selecting a file inserts only its path and a trailing space: the TUI does not read it, attach hidden context, or replace it with a reference object. When a model-facing `read` tool is registered, the TUI adds one fixed system-prompt instruction telling the model to read an explicit path when its contents are needed.

When optional `ctx.sessionReferences` is mounted, the same `@` menu also offers metadata-only session candidates, inserts `@[label](dsh-session:<payload>)`, and prepares the selected snapshots before dispatch. Session references remain structured because the model has no filesystem-like tool for retrieving session snapshots later. Preparation disables duplicate submission and restores the editor input on failure. The TUI chooses `agent.steer()` or `agent.followup()` from the status after that asynchronous preparation, so idle follow-ups still dispatch `agent/prompt-submit` while in-turn steering joins at a checkpoint without that hook.

While the agent is running, ordinary editor submissions call `agent.steer()`; otherwise they call `agent.followup()`. A slash at the start of the submitted line enters `ctx.commands` instead: known commands execute directly, unknown commands produce a warning, and neither path automatically reaches the model. A bang as the first character enters direct shell mode: `! <command>` starts one user-authorized process through the mounted `ctx.shell` executor in the session working directory. It bypasses model-tool approval because the human entered the command, but still receives the composition's standing sandbox policy and managed `DSH_*` environment when those services are mounted. The TUI streams its bounded combined output into an attached row; Ctrl+C cancels it, Ctrl+D warns instead of exiting, and a missing executor or bare `!` leaves the draft in the editor. Every accepted command enters a bounded project history immediately. With a `!` draft at the cursor end, Tab completes newest-first by command prefix: current-channel commands return without waiting, while the optional session-query service lazily recovers completed `user-shell` notices from up to 32 newest sessions whose normalized working directory matches. Duplicate commands collapse to their newest observation, at most 100 commands are retained, and exact reads run four at a time; an unavailable or corrupt history source only removes its candidates. A live shell token containing `/` instead opens host-path completion as it is typed. Directories retain a trailing slash for descent, and displayed/inserted paths use forward slashes on Windows. When `ctx.jobs` and a controller are available, Ctrl+B atomically transfers the already-live process to a `bash-N` job after registry preflight, removes the attached row, and re-enables submission; a failed preflight leaves the same process in the foreground. `/tasks` lists this agent's current job ids, lifecycle states, labels, and terminal details. A completed command, including a nonzero exit and whether foreground or background, becomes one durable `user-shell` context and automatically starts or steers the model; producer-owned delivery marks a promoted job reported so the generic jobs listener cannot send a duplicate completion notice. Cancellation and infrastructure failure remain terminal notices. A command producer may explicitly schedule agent work; [`dsh-plan-mode`](../../plan/plan-mode/README.md#model-and-human-surfaces) uses that contract for `/plan [message]`. The TUI registers `/help`, `/model`, `/effort`, `/rename`, `/clear`, `/new`, `/reset`, `/config`, `/copy`, `/export`, `/context`, `/details`, `/palette`, `/reload`, `/resume`, `/continue`, `/status`, `/tasks`, and `/exit` as agent-scoped definitions; every other effective command joins autocomplete and `/help` dynamically, as do `/skill:` completions, while `/help` also documents `! <command>` and Ctrl+B. A status line above the editor reports the turn phase the TUI derives from session events — waiting for the first token, thinking, responding, or executing tools — with the elapsed time in that phase and the running step total, refreshed each second, and ends with the `Enter sends steering, Esc cancels` hint; while steering messages wait to reach the model it inserts a `N queued ·` badge before the hint that clears as each drains. During a live standalone compaction bracket, a fixed `Context being compacted <elapsed>` row appears above the prompt, the idle prompt caret becomes a one-cell throbbing `⊙`, and terminal progress stays active until close; the row and glyph share the bracket's one refresh timer. This live state is never reconstructed from the log; a failed close adds `Compaction failed: <error>` to the transcript, while a resumed orphaned start never activates the indicator. Ctrl+C or Escape cancels a running turn. Tool and injected-context cards collapse long bodies into a configurable head/tail preview; Ctrl+O cycles tool cards through collapsed preview, full output, and hidden — the hidden phase drops tool cards from the transcript entirely while context cards stay at their preview, since injected instructions are not tool traffic. The hidden phase also folds each turn's assistant steps into one block: the first step with visible text or reasoning keeps its leading spacing, later steps render as continuations, and a step without a visible body renders nothing; leaving the hidden phase restores per-step spacing. An injected-context card renders its message as prose with the producer's outer reminder frame stripped, so neither the fold nor the frame stripping depends on the payload's syntax. Ctrl+R opens prompt history; Ctrl+L redraw and fresh-conversation behavior, editor-local deletion, and confirmed idle exit follow the rules below. `/details` owns the two transcript-detail dimensions: bare it opens a centered keyboard toggle with one entry per dimension — `Tool cards` and `Reasoning` — showing the live values, where Tab cycles the highlighted entry and applies the change immediately (the transcript behind the dialog is the preview), and Enter, Esc, or Ctrl+C closes; `/details collapsed|expanded|hidden` jumps tool cards to that phase directly, and `/details reasoning [on|off]` sets — or bare `reasoning` toggles — reasoning-block display; arguments combine in one invocation, an unknown argument fails with the usage line, and a combined invocation applies reasoning first so its transcript rebuild never drops the card notice.

Ctrl+R opens a full-viewport literal search over exact accepted editor submissions. It starts with this session, and Ctrl+S cycles through this project and all projects while older sessions load progressively through the optional session-query service. Results are newest-first and duplicate text collapses to its newest observation. Type to filter, use Up/Down or Page Up/Page Down to navigate, Tab to insert without submitting, Enter to insert and submit immediately, and Esc, Ctrl+C, or Backspace on an empty query to cancel without changing the draft. The current session is available synchronously; cross-session discovery inspects a bounded, balanced set of recent local and foreign sessions with bounded read concurrency, and skips an unreadable neighbor. Exact submissions are durable log-only `tui/input` events, including ordinary prompts, slash commands, `/skill:` invocations, and bang commands. Legacy sessions recover ordinary user prompts, slash commands, and completed shell commands where exact input can be reconstructed; expanded legacy skill bodies are omitted.

`/model` and Alt+P open the advisory `ctx.llm` catalog as a keyboard selector: a filter box above the list narrows rows by a case-insensitive substring over each row's `provider/model` label, model name, and description, keeping the highlighted row selected when it survives the filter; Up/Down moves, Shift+Tab cycles the focused model's adapter-advertised reasoning efforts in display order, Enter selects the model and effort, and Escape clears a non-empty filter before a second Escape closes it. When an adapter does not advertise a default effort, the cycle also includes `Default`, which clears an explicit selection and preserves the provider default; models without selectable effort metadata ignore Shift+Tab. The selector renders the exact advertised effort list—including `off` when present—and does not synthesize, clamp, or transfer an effort between models. `/model <model>` still selects an unambiguous model id directly, while `/model <provider>/<model>` selects an exact target and uses its adapter default when one exists. The configured target or latest logged request header initializes the selector, and an unlisted current model remains visible because catalogs are advisory. Selection is local to this TUI session. Prompt assembly snapshots the target for one step, replaces `{{provider}}` and `{{model}}`, and applies the same provider/model/reasoning-effort target through `agent/request`; a switch during assembly therefore starts with a later step. The request header durably records targets that reach the model, while an unused selection remains process-local.

Bare `/effort` opens a focused selector for the current route. `Auto` clears an explicit value and preserves the adapter-configured default—or the provider default when the adapter declares none—followed by every effort in the adapter's preferred display order; `/effort <id>` and `/effort auto` apply the same choices directly. Left/Right and Up/Down wrap through the list. Alt+T toggles between `off` and the last advertised non-off effort used on that exact route, falling back to its advertised non-off default and then its first non-off entry. A model without reasoning metadata, without `off`, or without any enabled effort reports why it cannot perform that operation instead of inventing a capability. These controls preserve the editor draft, remain available during a turn, and affect only a later step snapshot.

`/rename <name>` synchronously normalizes and persists a user-owned title through the mounted session-title service. Bare `/rename` instead refreshes the title from eligible human conversation history, using the registered title provider when present and the deterministic fallback otherwise; it reports an error when no eligible human message exists. Both forms update the banner, terminal window title, `/status`, and resume discovery from the same `session/title` event without adding model-visible content. An explicit name pins automatic title generation, while a later bare refresh deliberately unpins it. A composition without the title service reports the capability as unavailable.

`/reload` (EXPERIMENTAL, dev-only) re-reads every file-backed loader config tree and applies the diff to the running app — the HMR watcher's config path, invoked manually; it needs the cordis Loader in the context and degrades to a warning without one, runs only while the agent is idle, and refuses re-entry while a reload is in flight. Module-source hot reload remains watcher-owned. When a `skills` service is mounted, `/skill:<name> [instructions]` loads that skill's instructions into the conversation as a user turn; autocomplete lists user-invocable skills, and exact invocation rejects a skill whose user policy disables it.

When `mcpConnections` is mounted, `/mcp` lists only each server's name, transport, lifecycle state, reconnect attempt, and public tool names; `/mcp <server>` narrows the display, while `/mcp reload` uses the same Loader refresh as `/reload`. The directory never renders endpoints, commands, environment values, request headers, or failure text. `/mcp` is terminal-only and does not change model-visible tool state itself.

When `subagents` is mounted, bare `/agents` shows the durable descendant tree without loading child prompts or transcripts. `/agents start <task>` creates a continuable child through the configured `spawn` provider, and `/agents send <id> <message>` resumes or queues a direct continuable child with a user-attributed message. `/agents stop <id>` accepts only a live direct continuable child and issues a human-parent interruption request; it reports a request rather than claiming immediate settlement. Descendant rows remain visible, but direct human controls do not manufacture authority over another child's work.

The footer sums the session's reported usage as `↑<uncached input> ↓<output>`, followed by `cache <rate>%` once any input has been billed — the share of billed prompt tokens (uncached input plus cache reads and writes) served from the provider cache, rounded to a percent. It also compares token-meter pressure with `ctx.llm.resolveModelInfo()` context for the current route (omitting the context share when the adapter has no capacity metadata) and shows the current model and tool-card mode; the right side clips first when the footer is narrow.

`/context` adds a point-in-time context card and remains available while the agent runs. Its occupancy meter uses token-meter request pressure and the selected model's advertised capacity; it labels an unknown capacity, distinguishes provider-usage anchoring from an estimated baseline, reports over-capacity pressure, and recommends `/compact` at 80% or above. When the session-projection registry is mounted, a second segmented meter and rows show the heuristic system-prompt, tool-schema, and model-visible-conversation composition; these component estimates are explicitly not presented as a sum of provider-anchored pressure. `/context all` additionally lists every node on the current post-replacement model surface in order, with its durable sequence, source role, and heuristic token price. Both forms are terminal-only and add no model-visible content.

`/status` adds a point-in-time diagnostics card to the transcript and remains available while the agent runs. It reports the session id, title, working directory, selected provider/model, selected reasoning effort or default behavior, reasoning-block visibility, agent state, event/turn/step/tool-call counts, exact input/output/cache token buckets, KV-cache hit rate, token-meter context use and capacity, creation time, and latest event time. Missing titles, models, cache input, or context capacity are labeled instead of inferred. The card is terminal-only and does not duplicate the compact footer.

When the shipped `dsh` runner starts without `--resume`, it allocates a new `session-<UUID>` identity before creating the Agent. It never reuses `main` or another persisted id for an unresumed launch, so repeated launches in the same workspace cannot collide with an existing durable log. Existing sessions are entered only through `--resume <session>` or the in-TUI resume flow; legacy `main` logs remain intact and resumable with `--resume main`.

`/resume [session]` and its alias `/continue [session]` share one resume path. Without an argument, either opens a full-viewport keyboard selector instead of a centered dialog. With an argument, the TUI bypasses the selector: an exact session id wins, otherwise the reference must be one unique, case-sensitive exact title across the same candidate set. A missing reference or duplicate title fails before the channel swap, and an ambiguous-title diagnostic lists the matching ids in stable order. The selector opens as soon as the command runs and takes input focus while the session scan is still pending, showing a loading placeholder until the rows arrive; Escape cancels an in-flight scan the same way it cancels the loaded list. Two scopes cover the same candidate set: the current workspace, which it opens on, and all workspaces, which Tab toggles to. The scope line under the search field names the active scope and the count the other holds, and each row in the all-workspaces scope also reports its own workspace. Toggling clears the search and selection so the highlighted row always belongs to the visible list.

Its focused search field starts immediately after the search glyph and emits pi-tui's cursor marker, so terminal IME composition remains anchored inside the field. Rows read no whole logs: when the optional projection cache is mounted, titles come from the live projection registry or the durable checkpoint row, with a cold read folding only the log tail since the checkpoint (written back so the next scan is zero-I/O, bounded by `resumeScanConcurrency`); a composition without the cache falls back to one bounded batch title read over the logs. Candidates are sorted by metadata activity — a live session's last in-memory event time, otherwise the persisted artifact's mtime, falling back to creation time — and searchable by title or session id, and by workspace label in the all-workspaces scope; each row reports that timestamp plus current/live/persisted state and the id. Up/Down and Page Up/Page Down navigate, Enter resumes, Escape clears a non-empty search before a second Escape cancels, and Ctrl+C cancels directly. The current session, a session already live in this runtime, an unreadable log, or a session with no recorded workspace to run in remains visible but disabled; a workspace other than the current one is a scope rather than a disabled reason, because resume enters that directory.

Picker selection and direct resolution repeat those checks, fully read and replay-validate the one chosen log, reject it when its logged provider has no current adapter, and require the current agent to be idle before flushing the current session. The TUI then drains pending terminal input and calls the optional host-owned `TuiRuntime.swapResume` with the selected id. The shipped runner prepares the resumed Agent first, retires the old handle only after that preparation commits, and remounts the terminal channel on `tui-agent/ready`; rejection leaves the original channel usable. Filesystem, shell, and persistent-terminal tools resolve agent work against the restored session header's `cwd`, so an in-process cross-workspace swap does not mutate process-wide cwd. Resume restores the same `SessionId`, transcript, title, todos, and durable goal; goal activation remains disarmed and the TUI asks for human confirmation or `/goal resume`.

The exit line is launcher-owned, not configurable. A launcher provides `TUI_GOODBYE_MESSAGE_KEY` on the boot context — for the shipped `dsh`, the command that resumes this session — and exiting prints it verbatim after the terminal is released; absent, exiting prints nothing. Only the launcher knows how it was invoked, so only it can name a command that works. The TUI escapes terminal controls before rendering and never executes the text. A launcher that also supplies `MAIN_SESSION_ID_KEY` fixes which session the mounted app binds to, so resume survives any config-level patch.

A launcher can seed a fresh session's first turn by providing `INITIAL_SKILL_KEY` (the skill name) on the boot context; the TUI auto-invokes it exactly as a typed `/skill:<name>`, once the chat is live. The shipped `dsh migrate`/`dsh upgrade` set it and only for a fresh session, so a resumed session never re-invokes the skill; an unknown name is reported as a notice.

## Editor safety and discovery

At an empty main editor, `?` opens a centered keyboard-shortcut reference; `?`, Escape, or Ctrl+C closes it. With any draft text, `?` remains ordinary editable input. Alt+P opens the same model-and-reasoning selector as bare `/model`; Alt+T toggles the current model's advertised thinking state without changing the draft. Ctrl+T toggles the standing task checklist without changing draft text or durable `todo/write` state; a hidden checklist continues to accept updates and reveals the latest snapshot when shown again.

Ctrl+S stashes any non-empty main-editor draft and clears the editor. At an empty editor it restores the latest stash with its exact cursor position, undo history, and pi-tui large-paste contents; pressing Ctrl+S with another non-empty draft replaces the previous stash. The stash exists only for the current TUI mount and is consumed when restored.

Ctrl+V or Alt+V reads one raster image from the desktop clipboard and inserts `[Image #N]` at the exact editor cursor. The encoded bytes remain draft-local: deleting the marker releases an unsaved image on the next intake, and no attachment is persisted until an ordinary prompt containing the marker is submitted. Send admission snapshots the selected route, rejects an explicitly text-only model before storage, resolves any session mentions, validates every temporary image before saving the first one, then replaces markers in content order with durable `ImageBlock` references and dispatches the message. Image-only prompts are valid. A read, capability, decode, limit, or storage failure leaves the complete marker-bearing draft in the editor; image markers cannot accompany `!`, `/skill:`, or other slash commands. Transcript user and assistant images render as compact format/dimension/byte metadata markers rather than raw terminal graphics, and neither paths nor base64 enter the session log.

The shipped reader uses Windows PowerShell on Windows and WSL, `wl-paste` then `xclip` on Linux, and `pngpaste` on macOS. `clipboardImageCommand` can replace that platform selection with an exact shell-free argv whose stdout is raw PNG and whose exit code 3 means “no image”; this is also the integration seam for remote desktops and custom clipboard bridges. Clipboard reads are byte-bounded, cancelled on TUI disposal, and time out after five seconds. A deployment without `ctx.attachments`, a host without a reader, or a clipboard without an image reports an explicit terminal notice and leaves the draft unchanged.

`/copy [N]` copies the latest visible assistant reply, or the Nth latest when N is a positive integer. Selection walks persistent `assistant/message` events newest-first and accepts only append-origin visible text: reasoning, tool calls, image-only messages, whitespace-only messages, and model-only replacements do not consume an ordinal. Text blocks are concatenated without rewriting their bytes. A reply with non-empty fenced Markdown code opens a keyboard picker for the full reply or each code body in source order; Up/Down moves, Enter copies, `w` writes the highlighted target to a file, and Escape or Ctrl+C cancels. The file action prompts for a path, resolves relative paths against the session working directory, creates a new file exclusively, and requires an explicit `y` before replacing an existing file. Empty fences are not offered. The operation is human-only and never sends the selected text or path to the model, although the slash invocation follows the ordinary TUI input/command log lifecycle.

The shipped clipboard writer passes UTF-8 text on stdin to an exact argv without a shell: Windows and WSL use Windows PowerShell, Linux tries `wl-copy` then `xclip`, and macOS uses `pbcopy`. `clipboardTextCommand` replaces platform selection with one trusted exact argv for remote sessions or custom bridges. Neither selected assistant text nor exported conversation content enters argv or shell interpolation; stderr is bounded, nonzero exits are visible, and the child is cancelled on channel disposal or after five seconds. A configured helper receives the selected plaintext content and therefore belongs to the user's trusted deployment boundary. The shipped file writer likewise bypasses the shell and writes the selected text as exact UTF-8. It never creates missing parent directories, reports filesystem failures in the transcript, and is cancelled on channel disposal.

Ctrl+G or the readline-native Ctrl+X Ctrl+E chord opens the current prompt in a foreground external editor. The same binding opens a multiline custom response from a user-question panel, switching an option panel into custom mode when necessary. The shipped host chooses `VISUAL`, then `EDITOR`, then `notepad.exe` on Windows or `vi` elsewhere; an editor that normally detaches must include its wait flag, such as `code --wait`. Before launch, the TUI drains pending input and releases raw terminal ownership; after the editor exits successfully it reacquires the terminal, forces a full redraw, and replaces only the draft. Keystrokes received during the handoff are consumed, a failed launch or nonzero editor exit leaves the draft unchanged, and an attached foreground Shell must first be backgrounded or cancelled.

With `externalEditorContext: true`, the temporary file starts with the latest committed assistant reply as a `#`-commented, sentinel-delimited context block. That generated leading block is removed on save, while user-authored `#` lines in the draft remain untouched. The private temporary directory is removed after every success or failure. Opening, saving, and returning create no session event or model-visible content; only a later ordinary submission sends the edited draft.

Ctrl+X Ctrl+K stops this session's running background subagents after the same chord is pressed a second time within three seconds. The control covers exact-owner running one-shot subagent jobs and direct active continuable children; it deliberately leaves bash jobs, foreign or unowned jobs, completed work, and resident idle continuations alone. It remains available while the main agent turn is running, preserves the current draft, and is terminal-only. Discovery and cancellation failures are contained per target, so one broken child cannot prevent sibling stop requests; a minimal embedding without either optional service reports that the control is unavailable.

Bare `/config` opens a two-entry keyboard selector for the live `ui-tui` user-settings namespace: reasoning-block display and external-editor context. Up/Down moves, Enter or Space toggles, and Escape or Ctrl+C closes. The shipped settings provider layers `$DSH_HOME/settings.yaml` over the Cordis entry values and persists only the selected user override; a value changes in the mounted channel only after validation and storage commit, while a failed write remains visible in the dialog without optimistic mutation. Provider file edits hot-apply the same committed values, and a fresh or resumed channel reads them again. An embedding without a writable settings provider can inspect the composition values but receives an explicit save failure.

Ctrl+L always forces a full redraw without changing the current draft. While the agent and foreground shell are idle, the first press also shows a two-second confirmation line; a second Ctrl+L inside that window runs bare `/clear`. Typed `/clear`, its `/new` and `/reset` aliases, and confirmed Ctrl+L share one path: flush the current log, drain terminal input, then ask the host to atomically mount a fresh uniquely identified session in the same workspace with the selected model and reasoning effort. `/clear <name>` (equally `/new <name>` or `/reset <name>`) first persists that name on the previous session after the idle preflight and only then enters the same fresh-session path; an invalid title or missing title service leaves the current session in place. The previous session stays persisted and resumable. Active work must finish or be cancelled first. A host swap failure leaves the original channel usable; an embedder without `TuiRuntime.swapFresh` clears only the conversation view and reports that it could not create a fresh session.

Ctrl+D is context-sensitive: with draft text it stays inside the editor and deletes the character after the cursor; with an empty editor, the first press shows `Press Ctrl+D again to exit` and only a second Ctrl+D within 800 ms exits. Idle Ctrl+C follows the same confirmation window after its ordinary clear-input behavior. A different key or the timeout disarms the confirmation. While work is active, Ctrl+C still cancels the foreground shell or agent turn, and Ctrl+D still warns instead of exiting. `/exit` and `/quit` remain explicit one-step commands.

The help overlay, exit and Ctrl+L confirmation hints, prompt stash, external-editor launch and return, model and reasoning-effort controls, task-checklist visibility, editor-local deletion, and first-press redraw are terminal-only. They append no session event and add no model-visible content; confirming Ctrl+L deliberately enters the `/clear` session-lifecycle path above, a saved external-editor result becomes ordinary draft text, and a model or effort selection has the routing and cache effects documented under “Session model selection.”

`/export [filename]` renders the current durable conversation as readable plain text. With a filename it uses that path; without one, a keyboard selector offers clipboard copy or the relative default `dsh-session-<session-id>.txt`. The export includes user and injected-context messages, settled assistant messages, tool calls and results, and non-completed turn markers; raw stream chunks and request bookkeeping are omitted. File writes use the same exclusive-create and explicit-overwrite flow as `/copy`. The export is terminal-only: it never sends its content or destination path to the model, although the slash invocation follows the ordinary TUI input/command log lifecycle.

`/diff` opens a read-only pager for staged, unstaged, and nonignored untracked changes below the session working directory; it never sends diff text to the model. `/checkpoint [label]` saves a manual stable conversation boundary and, when that directory is a Git worktree, its staged and unstaged patches plus nonignored untracked files under `DSH_HOME`; outside Git it remains a conversation-only checkpoint. `/rewind [checkpoint-id]` opens a checkpoint picker when no id is supplied, then separately asks whether to restore workspace files, branch the conversation, or both, and requires `y` to proceed. File restoration first creates a pre-rewind safety checkpoint and refuses a different Git root, session directory, or `HEAD`. Conversation rewind opens a child from the saved completed boundary while leaving the source session resumable. The diff, checkpoint artifacts, dialogs, and destination choices are terminal-local rather than model context; the slash command lifecycle is still durable log-only history.

The TUI-owned built-in set includes `/diff`, `/checkpoint`, and `/rewind`; `/help` presents their exact available forms.

## Mode controls

At the main editor, Shift+Tab cycles the effective interaction mode; Alt+M is the equivalent fallback for terminals that cannot distinguish Shift+Tab. The cycle uses the composition's configured safe [`ctx.permissionPresets`](../../interaction/permission-presets/README.md) in table order, followed by [`Plan`](../../plan/plan-mode/README.md), and never rewrites permission merely to enter Plan. A derived `custom` permission is display-only, so its next cycle target is the first configured safe preset. If only plan mode is mounted, the cycle is `Normal` / `Plan`.

A preset whose sandbox is `danger-full-access` is excluded from ordinary keyboard cycling. It joins the later cycle only after it is already effective—for example, after the user explicitly runs `/permission danger-full-access`—and remains unlocked for the rest of that TUI mount so the user can leave and return. This makes the shortcut non-escalating without hiding an explicitly selected state.

Each selection goes through the owning service setter. An in-turn Plan transition is rendered immediately as `Plan (pending)` until the next accepted pre-step commits it; the permission preset remains independently durable. The default `${mode}${queued}` right-prompt template shows `⏵ <preset>`, `⏸ Plan`, or the warning-colored `⏵⏵ Full access`; `/status` reports the same effective target. When neither optional service is mounted, `${mode}` contributes nothing and the shortcut reports that switching is unavailable.

## Config

The Cordis fields below form the composition layer. `/config` exposes only `showReasoning` and `externalEditorContext`, the subset that can apply live and persist in the `ui-tui` section of the user settings document; layout and resource limits remain deployment configuration.

| Key | Default | Meaning |
|---|---|---|
| `welcome` | — | Banner subtitle line until the session has a logged title; unset, the banner sweeps in with no subtitle |
| `sessionId` | `main` | Exact shared agent/session identity driven by the terminal |
| `showReasoning` | `true` | Render reasoning blocks |
| `externalEditorContext` | `false` | Prepend the latest assistant reply as a generated comment block that is stripped when the external editor saves |
| `clipboardImageCommand` | platform helper | Optional exact argv that writes raw PNG to stdout; exit 3 means the clipboard has no image |
| `clipboardTextCommand` | platform helper | Optional exact argv that receives copied assistant text as UTF-8 stdin |
| `maxToolOutputLines` | `6` | Output lines retained across a collapsed tool card's head/tail preview |
| `maxDiffEditLength` | `1000` | Maximum added and removed lines explored for an exact diff before whole-side fallback |
| `maxQuestionOptions` | `8` | Maximum option blocks visible at once; the row bound may reduce this further |
| `maxModelOptions` | `8` | Visible models in the model selector |
| `maxResumeOptions` | `8` | Visible sessions in the resume selector |
| `resumeScanConcurrency` | `4` | Maximum concurrent cold title reads in one resume scan |
| `maxHistoryOptions` | `8` | Prompt-history matches visible at once |
| `historyMaxEntries` | `1000` | Maximum unique prompt-history matches returned for one scope |
| `historyMaxSessions` | `128` | Maximum prior sessions inspected by one prompt-history scan |
| `historyScanConcurrency` | `4` | Maximum concurrent exact reads in one prompt-history scan |
| `questionDialogWidth` | `200` | Question-panel width in columns, clamped to the terminal |
| `questionDialogMaxHeight` | `20` | Maximum question-panel rows, further bounded to retain the editor |
| `modelDialogWidth` | `76` | Model-selector width in columns |
| `modelDialogMaxHeight` | `20` | Model-selector maximum rows |
| `detailsDialogWidth` | `72` | Transcript-details selector width in columns |
| `settingsDialogWidth` | `72` | Live-settings selector width in columns |
| `directShellOutputMaxBytes` | `64000` | UTF-8 bytes retained from one direct-shell process for live, job-read, and final-result views |
| `directShellOutputRefreshMs` | `50` | Milliseconds between incremental direct-shell output reads |
| `fileSearchMaxResults` | `20` | Maximum file and directory candidates shown for one `@` query |
| `fileSearchMaxEntries` | `10000` | Maximum paths retained in the bounded workspace index used by bare fuzzy queries |
| `fileSearchExcludedDirectories` | `['.git', 'node_modules']` | Directory basenames omitted from traversal and direct completion |
| `showHardwareCursor` | `false` | Show the hardware cursor at pi-tui's IME marker |
| `theme.color` | `true` | Apply the built-in ANSI palette (see [Color](#color)) |
| `theme.palette` | `claude` | Palette style: `claude` pins Claude Code's terracotta truecolor tokens when the terminal advertises truecolor; `adaptive` keeps only terminal-ANSI roles |
| `theme.truecolor` | auto | Apply the Claude truecolor palette and the brand gradient; an unset value auto-detects from `COLORTERM` |
| `theme.leftPrompt` | `${cwd}${git/worktree}${model}${token_meter/cache_hit_rate}${context}` | Left-aligned prompt template |
| `theme.rightPrompt` | `${mode}${queued}` | Right-aligned prompt template; the built-in mode and queued-steering indicators omit themselves when unavailable |
| `theme.inputPrompt` | `${symbol}${indicator}` | First-line editor prefix: the accent `❯` rail, the phase glyph slot, and the caret gap |
| `title` | `DeepSeek Harness` | Product suffix for the terminal window title. |

```yaml
- id: terminal
  name: '@deepseek-ai/dsh-tui'
  config:
    welcome: 'Coding agent ready.'
    sessionId: main-session-123
    showReasoning: true
    externalEditorContext: false
    settingsDialogWidth: 72
    maxToolOutputLines: 6
    maxDiffEditLength: 1000
    fileSearchExcludedDirectories: ['.git', 'node_modules', 'dist']
```

Startup fails before mounting when either process stream is not a TTY. The composing app must mount the TUI before its config-created agent so the front door can observe `agent-loop/config-start-failed`; a matching exact-session failure is written before fullscreen mode starts and exits with status 1 instead of leaving a blank terminal. Disposal stops extension admission, unloads the `ctx.tui` provider and its dependent plugins, aborts running commands, removes the TUI definitions, stops loaders, rejects pending questions, drains terminal input, restores terminal state, unregisters event listeners and the user-interaction provider, and never exits a replacement process during HMR. A user exit disposes the application root so sibling resources close, then exits; a five-second fallback prevents one stuck disposer from trapping the process.

## Color

Every SGR code the TUI emits lives in one table, `paletteSpec` in `components/theme.ts`, which `createPalette` derives its wrappers from and `/palette` prints; no component writes an escape of its own. The default `claude` palette pins the semantic roles to Claude Code's classic truecolor tokens on truecolor terminals — terracotta `#d77757` accent, `#767676` subtle, `#4eba65` success, `#ffc107` warning, `#ff6b80` error, and `#af87ff` inline code — with a darkened set for light color schemes. Without truecolor, the same roles degrade to bright ANSI approximations. `theme.palette: adaptive` restores the terminal-agnostic mode, whose 16-color ANSI roles follow whatever color scheme the terminal is using. The startup banner gradient and the official mark's exact `#4D6BFE` ink remain the two fixed brand exceptions. Body text keeps the terminal's default foreground rather than a fixed shade.

There is one role per visual meaning: `dim` is the single recessed tone, `accent` the single interaction emphasis, and `brand` the DeepSeek mark's standard-ANSI fallback, while `success` and `error` double as a diff's added and removed lines. Colors and attributes are separately typed, so `bold(accent(x))` compiles and `accent(error(x))` does not — SGR has no color stack, so nesting one color inside another silently drops the outer color at the inner one's close. Attributes occupy independent SGR groups and compose with any color in either order. Run `/palette` to see every role as your terminal renders it, with its SGR pair.

Grouped regions follow Claude Code's layout rather than filled blocks. Every user-prompt row carries a bold accent `❯` rail, and the assistant body follows without a role header; a transcript drag-select still copies the message bytes, now including the rail marker. A tool card paints its status bullet by outcome and its `Verb(argument)` title by tool family (file/shell/search/edit/network), then indents the whole body behind a dim `⎿` prefix, so only the family-colored title and the status bullet carry color and the body reads as one recessed block. An injected-context card's prose is the same tone as its header. The editor sits between rounded `╭─…╮` / `╰─…╯` rails with no side borders; the rails are dim by default, warning under plan mode, and error under always-approve, while the `❯` input rail stays accent and its phase glyph fades in while the agent works. A diff card with both sides available colors and counts exact added `+` and removed `-` lines, while unchanged context stays dim and uncounted. If exact comparison exceeds `maxDiffEditLength`, the card renders each old-side row as removed and each new-side row as added, marks the footer approximate, and caches that fallback for later redraws. When `oldText` is unavailable, including pending writes and replay fallbacks as well as creates, every non-empty new-side row is shown and counted as added; that count does not prove the rows were absent from an existing file. Empty new content produces no synthetic `+ ` row. A `[signal …]` marker remains colored because there the color is the meaning rather than emphasis. The question panel emphasizes its active row with bold accent text, while selectors use reverse video. These treatments are foreground-only, so they never collide with the terminal background. Set `color: false` to strip all styling.

## Model Experience

### Interactive prompt input

#### What the model sees

Each non-empty ordinary editor submission becomes ordered text blocks and, when recognized clipboard markers are present, durable image-reference blocks; it is sent with `agent.followup()` while the target agent is idle and `agent.steer()` while it is running. `[Image #N]` is draft presentation only and never reaches the model as text. A session mention becomes readable `@label` text plus the durable untrusted context defined by [`dsh-session-reference`](../../context/session-reference/README.md); its full JSON is hidden behind a compact reference card. Slash commands and keybindings are TUI-only; command results remain terminal notices. A command producer may schedule a separate agent input, such as the optional message accepted by `/plan [message]`.

#### Token effect

Submitted text and durable image references are retained under the agent loop's normal session-history and compaction rules. Provider-reported visual usage is authoritative; the TUI does not estimate image tokens from dimensions. Headers, draft markers, the logged title, cards, Markdown rendering, status lines, plans, and help text add no tokens.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### MCP and subagent commands

#### What the model sees

`/mcp`, bare `/agents`, and `/agents stop` are terminal-only. `/agents start` and `/agents send` deliver their user text only to the selected continuable child; they do not append a root-agent user message or expose another child's transcript. The MCP directory reads connection state only; it neither creates tools nor alters the tool definitions already available to the root agent.

#### Token effect

Directory and stop controls add no tokens. Starting or sending a child task adds text under that child session's ordinary history and compaction policy, not the root session's history.

#### KV Cache effect

Root-agent cache state is unchanged. A child task is append-only in its own request history and follows that child's provider cache behavior.

### Permission and plan mode controls

#### What the model sees

Shift+Tab / Alt+M input, the `${mode}` prompt fragment, `/status` rows, and TUI notices are terminal-only. A permission selection persists the owning `permission/preset` fact and any changed `sandbox/mode` and `approval/policy` facts; the sandbox and approval services expose their effective meanings in the next cache-safe runtime-context snapshot. A Plan selection persists `plan/mode`; while active, the plan service contributes its configured policy section and owns any standard transition notice. The TUI does not create a combined mode event or a second model-facing vocabulary.

#### Token effect

Cycling and status rendering add no tokens. A changed permission can add the next service-owned runtime-context snapshot; an active Plan adds its configured section to every request, and a service-owned transition notice may add one short retained message. A no-op selection adds nothing.

#### KV Cache effect

Permission changes append a superseding runtime-context snapshot after retained history, preserving the earlier reusable prefix. Entering or leaving Plan changes the system prompt from the plan section's order onward.

### Prompt-history search

#### What the model sees

Opening Ctrl+R, filtering, changing scope, cancelling, or accepting with Tab sends nothing to the model. Each accepted original editor submission appends one exact `tui/input` event, which is log-only and excluded from derived model history. Accepting with Enter returns the chosen text through the ordinary submission path exactly once, so its prompt, slash-command, skill, or direct-shell behavior then applies normally.

#### Token effect

Search UI and `tui/input` events add no tokens. An Enter acceptance has only the token effect of the submission form it runs.

#### KV Cache effect

Search and recall do not change the model-visible prefix. A recalled prompt that is submitted follows that submission form's ordinary cache behavior.

### Direct shell mode

#### What the model sees

After `! <command>` completes, the TUI appends one plugin-sourced user message framed as `<user-shell-command>`. It contains the exact command, session working directory, bounded combined process output (with executor-owned stderr markers), spill locators when available, and exit, signal, or sandbox status. Shell-history and path completion only rewrite editor text; they add no event or model input until the user submits the resulting command. The original bang submission is retained only as a log-only `tui/input` record, not as a human prompt or synthetic tool call. Live rendering and `job_output` use independent retained views over the same single process cursor, so neither can consume bytes away from this final context. The completed result follows the ordinary followup-while-idle / steer-while-running rule whether it stayed attached or moved to a job, so the model responds automatically exactly once. A foreground command explicitly aborted with Ctrl+C adds no model-visible message.

#### Token effect

The completed result is retained under normal session-history and compaction rules and contributes user-message tokens. Terminal running, cancellation, and infrastructure-error notices add no tokens.

#### KV Cache effect

Append-only; the completed result follows the reusable request prefix and does not invalidate existing KV-cache entries.

### File-reference autocomplete

#### What the model sees

A selected file remains ordinary user text such as `@src/index.ts` or `@"docs/design notes.md"`; autocomplete adds no content block, durable context, or special reference payload. When `read` is registered, every request from this TUI agent also contains the following fixed system-prompt section. The model decides whether the task requires the file contents and calls `read` through the normal tool loop when it does; a path alone is not evidence that the file was inspected.

##### Exact system-prompt text

```markdown
Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.
```

#### Token effect

Autocomplete itself adds no tokens. The selected path contributes only its ordinary user-text tokens; the fixed instruction contributes system-prompt tokens whenever `read` is available. File contents consume context only after a model-selected `read` call returns them.

#### KV Cache effect

The fixed instruction is part of the stable system-prompt prefix and is reusable across turns. Each selected path is append-only user text; a later `read` result appends the requested contents through the ordinary tool transcript.

### Session model selection

#### What the model sees

The `/model` and `/effort` command text, Alt+P and Alt+T input, and selector keystrokes are not logged or sent. New steps receive the selected provider/model route in prompt variables and the selected provider/model/reasoning-effort target in request routing. `auto` is represented by omitting `reasoningEffort`, so it restores adapter/provider default behavior instead of creating a synthetic level.

#### Token effect

The selectors and toggle add no messages. A route change may alter interpolated system-prompt text and sends subsequent requests to the selected model; an effort-only change alters request routing metadata for later steps.

#### KV Cache effect

Changing provider or model enters that target's cache domain; no cache reuse across distinct targets is assumed. An effort-only change stays on the route, but provider cache partitioning by reasoning settings is adapter-specific, so reuse across effort values is not assumed.

### Manual skill invocation

#### What the model sees

A `/skill:<name> [instructions]` submission loads the named skill and delivers one text block: a `<skill name="…">` element wrapping the skill's instructions — preceded, when the provider exposes a resource base, by a line locating the skill's relative resources — followed by any trailing instructions the user typed. Delivery follows the same followup-while-idle / steer-while-running rule as ordinary input. The command, not the model, chooses the skill: autocomplete and exact invocation apply `invocation.userInvocable`, while `invocation.modelInvocable` does not restrict this surface. User-disabled skills are omitted from autocomplete and rejected before exact-name loading; the loaded definition is rechecked for a policy race. Autocomplete retains its last complete skill snapshot and refetches after `skills/change`; an incomplete observation preserves the prior menu, a complete empty observation clears it, and a catalog arriving while a slash-name draft is open immediately re-queries that draft. The skill service is an optional peer; this policy check uses its type contract without introducing a runtime package dependency.

#### Token effect

The rendered skill block and trailing instructions are retained as one user turn under the agent loop's normal session-history and compaction rules; a repeated invocation appends the body again.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

### Interactive user-question answers

#### What the model sees

When a consumer calls `ctx.userInteraction.ask()`, this provider presents each question in order and returns selected option labels, `custom` text, or both for a multi-select question. Pending custom text survives switching back to options and joins checked labels on a later options-mode submit. Abort, cancellation, or UI disposal becomes `Error: ask_user_question was interrupted before the user answered` through `dsh-tool-ask-user`.

#### Token effect

Waiting and terminal overlays add no tokens; the resolved answer or error is model-visible only through the calling tool or plugin's result.

#### KV Cache effect

Append-only; newly visible content follows the reusable request prefix and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

- **Workspace checkpoints are manual, scoped Git snapshots** — `/checkpoint` captures only the session directory when explicitly invoked, rather than automatic per-edit state or ignored files. `/rewind` refuses a different Git root, directory, or commit and creates a safety checkpoint before file mutation, but filesystem restoration and the optional child-session swap cannot form one cross-resource transaction. Concurrent hosts must coordinate workspace ownership outside the TUI.
- **The cycle projects this composition's vocabulary rather than cloning every Claude Code mode** — it combines configured safe permission presets with Plan, so unsupported `default` / `acceptEdits` / `dontAsk` / `delegate` aliases are not synthesized. Full access requires an explicit `/permission danger-full-access` selection before it can join the cycle, and that command still uses the generic command surface rather than a dedicated TUI risk-confirmation dialog.
- **Resume has no cross-process session lock** — the selector rejects sessions known to be live in its own runtime, but another process can resume the same persisted id before or during the swap. The all-workspaces scope makes this reachable in one step, since a session another host is driving in a different directory is now selectable. Deployments that can run concurrent hosts must coordinate ownership outside the TUI.
- **One configured session owns the transcript and editor** — questions from other agents can still use the shared overlay provider, but session rendering and prompt input remain bound to `sessionId`.
- **`/agents` is direct-child control, not agent teams** — it creates local continuable children through `spawn`, lists durable descendants, and sends or stops only direct children. Shared task boards, peer-to-peer messaging, team leadership, and a multi-session agent view remain outside this terminal control plane.
- **Raster images use textual terminal markers** — clipboard input creates real durable image blocks for the model, but user and assistant history renders only format, dimensions, bytes, and display name; the terminal does not attempt sixel, Kitty, or iTerm inline graphics.
- **Non-TTY operation is intentionally unsupported** — app bundles that need automation must compose a headless or server front door (`headless`, `dsh-acp`) rather than expecting an internal fallback.
- **Manual `/skill:` invocation always reloads the full skill body** — the TUI does not detect a skill already present in the conversation, so repeated invocations append its instructions again.
- **Cross-session prompt history is bounded and advisory** — exact current-session input remains available, but project/all scopes require the optional session-query service and inspect at most `historyMaxSessions` prior sessions. One unreadable session is skipped. Sessions created before `tui/input` can recover prompts, slash commands, and completed shell commands, but not the exact command behind an already-expanded skill body.
- **Cross-process shell history is completion-backed** — every accepted command, including a later cancellation, is available for the current TUI channel, but only commands with a completed durable `user-shell` result can be recovered after restart. A command cancelled or interrupted before that result does not survive into another process's history.
- **File and shell-path discovery use the host working directory** — `@` autocomplete and direct-shell path completion read the TUI process's session `cwd`; the former is later interpreted by `read`, while the latter is submitted to the host shell. Deployments that mount a remote or virtual filesystem must align those namespaces or provide another completion surface.
- **The `@` file search uses explicit directory exclusions, not ignore files** — `.git` and `node_modules` are excluded by default and deployments may configure more basenames, but `.gitignore` and `.ignore` are not interpreted. Directory symlinks are not traversed.
