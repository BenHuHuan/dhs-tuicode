# Agent Note: Built E2E Default and Windows Source PTY Deadline

Status: implemented

English | [中文](2026-08-14-built-e2e-default-and-windows-source-pty-deadline.zh.md)

## Problem

The real-API e2e configuration accepted an unset launch mode even though its consumer-facing CI lane builds the host artifacts and selects `DSH_EXAMPLE_MODE=lib`. On Windows, an explicit source-plane TUI smoke loads and transforms the complete workspace through `tsx`; its cold ConPTY start reaches the input prompt after the former 25-second PTY deadline, producing a timeout before the application can render.

## Decision

`vitest.e2e.config.ts` supplies `DSH_EXAMPLE_MODE=lib` only when neither the process environment nor `.env` supplies a mode. `pnpm run test:e2e` therefore exercises built `lib` bins under plain Node, while `DSH_EXAMPLE_MODE=src` remains an explicit zero-build diagnostic mode. The shared launch resolver retains its source default for callers outside the e2e configuration. The Windows source-plane TUI smoke grants its inner PTY 90 seconds and its per-test Vitest deadline 105 seconds; the artifact path remains at 60 and 75 seconds respectively.

## Verification

The keyless `pnpm run test:e2e` run boots built artifacts and the focused explicit-source MCP and subagent directory PTY smoke reaches its markers and exits cleanly on Windows.

## Alternatives considered

**Make every loader-smoke caller default to `lib`.** The shared resolver also serves zero-build development diagnostics, so changing its default would remove an intentional source-plane path outside e2e acceptance.

**Keep the 25-second source PTY deadline.** A measured Windows cold start exceeds that deadline while completing normal terminal initialization, so it turns a valid source launch into a false failure.

**Treat the delay as a Cordis reload loop.** The sampled process spends startup time in `tsx` module and filesystem resolution, and the TUI reaches its prompt without reload intervention.

## Consequences

The standard e2e command requires current host build artifacts and matches the installed-consumer execution model. Source-plane TUI diagnostics stay available by opt-in and report an actual missing marker rather than a Windows cold-start timing artifact. The longer source timeout can lengthen only explicitly selected source e2e runs.
