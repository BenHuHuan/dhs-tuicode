# Agent Note: TUI model routing profiles

Status: implemented

English | [中文](2026-08-15-tui-model-routing-profiles.zh.md)

## Problem

DeepSeek coding sessions need two distinct first-request behaviors without coupling them to permission modes. A compact request must preserve the official Minimal tool and prompt structure, while task-aware routing needs a separate profile that can choose a tool band. Windows must expose the same Bash-facing request instead of changing the model-visible tool description or failing because its private temporary directory is inside a home-directory workspace.

## Decision

The TUI `/mode` command creates a fresh session in either `minimal` or `router`. Minimal is the default label and uses the standard preset's anchored first request. Router selects the `routing-suite` preset. Permission modes such as Build, Flow, Inspect, Plan, and bypass remain independent and do not select a model-routing profile.

The anchored request uses the official Minimal system prompt and the `bash` plus `str_replace_editor` schemas. Agent instructions and skill catalogs stay out of that request. The normal coding catalog becomes available after the first durable tool call or assistant result, so later turns retain the complete product tool set.

Windows mounts persistent Git Bash for the anchored request and uses a configurable ACL sandbox temporary root outside the workspace. PowerShell and the remaining Windows tools become available after promotion. The task classifier routes explicit search, investigation, and research requests through the specification band; other Router decisions retain the routing suite's task-dependent behavior.

## Alternatives considered

**Use permission modes for model routing.** Rejected because filesystem authority and model-visible tool selection are independent user decisions. Combining them would make Shift+Tab change the conversation profile and force a new session unexpectedly.

**Rewrite hidden reasoning prefixes after generation.** Rejected because a displayed prefix would not alter planning or tool use. The implementation aligns the actual system prompt, tool schemas, and shell behavior instead of masking model output.

**Expose PowerShell in the anchored first request on Windows.** Rejected because the platform-specific schema changes the request the Minimal profile is intended to preserve. Git Bash supplies the stable model-facing shell contract while the promoted catalog still includes Windows-native tools.

## Consequences

Users can switch between a stable Minimal profile and task-aware Router without changing workspace permissions. Profile changes start fresh sessions because system prompts and initial tool catalogs cannot be replaced safely inside an existing conversation. The alignment improves trajectory consistency but does not guarantee a particular hidden-reasoning phrase; Router intentionally permits different reasoning styles for different task bands.

Focused bootstrap, Windows shell, runner, sandbox, and TUI tests pin classification, profile selection, shell composition, temporary-root placement, and the running-status presentation above the editor.
