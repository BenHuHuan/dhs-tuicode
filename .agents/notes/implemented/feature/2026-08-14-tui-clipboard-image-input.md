# Agent Note: TUI clipboard image input

Status: implemented

English | [中文](2026-08-14-tui-clipboard-image-input.zh.md)

## Problem

The restored TUI had no native path for multimodal prompt intake. The repository already had the durable attachment seam, role-neutral `ImageBlock`, model capability metadata, provider conversion, and Web admission rules documented by [multimodal image input and durable attachments](2026-07-22-web-multimodal-image-input-and-durable-attachments.md), but terminal users could not create those blocks. Claude Code documents Ctrl+V, Cmd+V, and Alt+V clipboard-image input with an `[Image #N]` draft chip in its [interactive-mode reference](https://code.claude.com/docs/en/interactive-mode). A TUI implementation must not solve that gap by putting a host path or base64 in the append-only session log, persisting an image before the prompt is accepted, or letting a stale model selection race the capability check.

## Decision

`TuiRuntime.readClipboardImage` is the replaceable host boundary. It receives an abort signal, byte cap, and session working directory, and returns temporary encoded bytes plus a declared image media type. The shipped `readImageFromClipboard` implementation directly spawns an exact argv without a shell, captures bounded binary stdout, retains only bounded stderr for failures, kills the child on cancellation, and treats exit code 3 as “no image.” The main channel adds a five-second timeout and aborts every reader during disposal.

Platform selection uses Windows PowerShell on Windows and WSL, `wl-paste` followed by `xclip` on Linux, and `pngpaste` on macOS. Each default path produces PNG. Deployment-owned `clipboardImageCommand` replaces the candidate list with one exact argv, also producing raw PNG; it supports remote desktop and custom clipboard bridges without making a shell command string part of the runtime contract.

Ctrl+V and Alt+V invoke the reader from the main editor. While the asynchronous read is active, submission and other global key actions are frozen so the result lands at the activation cursor. A successful intake copies the returned bytes, strips any supplied path down to a display basename, applies the current media/count/individual-byte/aggregate-byte fast checks, and inserts `[Image #N]`. Bytes remain in a mount-local `ClipboardImageDraft` registry rather than editor text. Deleted unsaved entries are pruned before later intake; stashed markers retain their bytes, and disposal releases the registry.

Submission recognizes only marker identifiers owned by that channel. Image markers in shell, skill, or slash commands are refused with the full draft retained. An ordinary prompt snapshots the selected provider/model, disables input, and resolves exact model metadata. An explicit modality list without `image` rejects before validation or storage; unknown capability proceeds to the adapter guard. Session references are prepared before persistence. The draft then enforces current attachment limits, validates every unique temporary image before saving any image, saves in marker order, and only after all saves succeed replaces recognized markers with durable image blocks and dispatches the message. Duplicate markers repeat one durable reference in model content but save the underlying object once. Image-only messages are valid.

Every failure before dispatch restores the exact marker-bearing editor value and appends a terminal error. Successful entries retain their durable reference so current-mount prompt-history recall can resend without retaining raw bytes. Across a remount, an old `[Image #N]` has no registry owner and is ordinary literal text rather than an implicit attachment. User and assistant image blocks render as a compact marker containing format, dimensions, encoded bytes, and optional display name; terminal raster protocols remain out of scope.

## Verification

Process-boundary tests pin platform command selection, binary stdout, the no-image exit, byte caps, nonzero diagnostics, and abort propagation. Draft tests pin cursor marker vocabulary, basename stripping, ordered mixed content, image-only projection, duplicate-reference reuse, count and aggregate limits, unknown-marker literal behavior, deleted-byte pruning, and the validate-all-before-save rule.

Mounted-channel tests drive both Alt+V and Ctrl+V through a headless terminal. They prove mixed and image-only dispatch, explicit text-only model refusal before writes, complete draft restoration, two-image validation failure with zero saves, and visible degradation when the reader, store, or clipboard image is absent. The normal TUI unit, snapshot, lint, and type gates cover the resulting help and rendering surfaces.

A keyless built-lib PTY smoke boots the shipped TUI profile, selects an explicitly image-capable scripted model, invokes a custom clipboard subprocess that writes a valid one-pixel PNG, submits the inserted marker, and requires the adapter to observe an image block. Its post-run inspection proves the JSONL contains only the `sha256:` attachment reference and display metadata, contains no base64, and that the exact PNG bytes exist in `$DSH_HOME/attachments/v1/objects` before clean terminal release.

## Alternatives considered

**Persist at paste time.** Rejected because an unsent or deleted draft would create durable unowned objects and require quota and garbage-collection policy. Prompt acceptance remains the durability boundary shared with Web.

**Store a temporary file path in the marker or session.** Rejected because paths leak host layout, are not portable across resume or fork, and can outlive or be replaced independently of the event. A native bridge may stage bytes privately, but the runtime copies them and the attachment store owns every accepted object.

**Inline base64 in editor text or the user event.** Rejected because it exposes binary data to history, rendering, compaction, token accounting, and every session copy. The marker is presentation-only and the canonical message carries a small immutable reference.

**Trust the selected-model label without re-resolving capabilities.** Rejected because catalog rows are advisory and model selection can change. Submission resolves the exact snapshotted route, while the adapter remains authoritative when capability metadata is unknown.

**Use one cross-platform clipboard dependency.** Rejected because the shipped terminal profile already runs on native Windows, WSL, Linux desktops, and macOS, whose clipboard ownership models differ. Small shell-free platform candidates plus an argv override keep failures explicit and integrations replaceable.

## Consequences

The TUI can now create the repository's canonical multimodal prompt representation without an API key or Web front door. Unsent bytes are ephemeral, accepted bytes are durable before their owning event, and failure never logs raw data or a local path. Text-only deployments retain ordinary TUI chat and receive an explicit notice if image intake is attempted.

The default Linux and macOS paths depend on an available desktop helper, and WSL depends on Windows PowerShell interop; `clipboardImageCommand` is the escape hatch for other environments. Terminal history uses textual metadata instead of inline pixels. Draft images do not survive remount, durable storage still has the repository-wide reference-aware garbage-collection debt, and adapter capability enforcement remains necessary even after the TUI preflight.
