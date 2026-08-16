# Agent Note: TUI model routing profiles

Status: implemented

English | [中文](2026-08-15-tui-model-routing-profiles.zh.md)

## Problem

DeepSeek coding sessions need distinct first-request behaviors without coupling them to permission modes. A compact request must preserve the official Minimal tool and prompt structure, while the routing-suite profiles need two measured first-request shapes: the v0.2.0 RL-interface restoration (one RL training sentence plus shell/editor) and the deep-think-first classified persona surface. Windows must expose the same Bash-facing request instead of changing the model-visible tool description or failing because its private temporary directory is inside a home-directory workspace.

## Decision

The TUI `/mode` command creates a fresh session in `minimal`, `router` (Router Standard), or `spec` (Router Spec). Minimal is the default label and uses the standard preset's anchored first request. Router Standard selects the `routing-suite` preset; Router Spec selects the `routing-suite-spec` preset. Permission modes such as Build, Flow, Inspect, Plan, and bypass remain independent and do not select a model-routing profile.

The anchored request uses the official Minimal system prompt and the `bash` plus `str_replace_editor` schemas. Agent instructions and skill catalogs stay out of that request. The normal coding catalog becomes available after the first durable tool call or assistant result, so later turns retain the complete product tool set.

Router Standard ports dsh-router-standard v0.2.0 verbatim: the first request carries only the RL training sentence (`You are a helpful software engineer assistant.`) and the shell plus `str_replace_editor` surface; the plan-mode section is the one boundary that survives. Router Spec keeps the classified persona (`spec`/`react`/weak, model-matched for Pro/Flash), the other assembled prompt sections, and the legacy first-turn core tools. Both Router profiles promote only after a real tool call, keep weak-band near-field guidance, and expose `dev_router_status` / `dev_router_mode` / `dev_mode_subagent` for self-optimization; the Router tuning tools are filtered out of every non-Router catalog.

Windows mounts persistent Git Bash for the anchored request and uses a configurable ACL sandbox temporary root outside the workspace. PowerShell and the remaining Windows tools become available after promotion, except Router profiles keep the single Bash dialect after promotion as well.

## Alternatives considered

**Use permission modes for model routing.** Rejected because filesystem authority and model-visible tool selection are independent user decisions. Combining them would make Shift+Tab change the conversation profile and force a new session unexpectedly.

**Rewrite hidden reasoning prefixes after generation.** Rejected because a displayed prefix would not alter planning or tool use. The implementation aligns the actual system prompt, tool schemas, and shell behavior instead of masking model output.

**Expose PowerShell in the anchored first request on Windows.** Rejected because the platform-specific schema changes the request the Minimal profile is intended to preserve. Git Bash supplies the stable model-facing shell contract while the promoted catalog still includes Windows-native tools.

## Consequences

Users can switch between a stable Minimal profile, Router Standard, and Router Spec without changing workspace permissions. Profile changes start fresh sessions because system prompts and initial tool catalogs cannot be replaced safely inside an existing conversation. The alignment improves trajectory consistency but does not guarantee a particular hidden-reasoning phrase; Router Spec intentionally permits different reasoning styles for different task bands, and Router Standard intentionally restores the measured think-act RL interface.

Focused bootstrap, Windows shell, runner, sandbox, and TUI tests pin classification, profile selection, shell composition, temporary-root placement, weak guidance, and the running-status presentation above the editor.
