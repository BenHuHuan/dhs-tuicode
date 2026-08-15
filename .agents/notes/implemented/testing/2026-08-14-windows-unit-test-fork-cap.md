# Agent Note: Windows Unit-Test Fork Cap

Status: implemented

English | [中文](2026-08-14-windows-unit-test-fork-cap.zh.md)

## Problem

Windows unit suites include Git, PowerShell, worker, and subprocess fixtures that compete with Vitest fork creation. Eight concurrent forks can intermittently exhaust host process resources while each affected test succeeds in isolation, obscuring application regressions with `spawn UNKNOWN`, buffer, and timeout failures.

## Decision

`vitest.config.ts` caps the default Windows unit-test fork pool at four workers. Non-Windows hosts retain Vitest's normal concurrency, and an explicit `--maxWorkers` command-line value still overrides the local default.

## Alternatives considered

**Keep the eight-fork cap.** It is faster on an idle host but did not leave enough process headroom when the machine also ran normal development workloads.

**Force every platform to four workers.** The failure mode is Windows process churn, so constraining Linux and macOS would spend CI capacity without addressing an observed issue there.

**Require developers to remember a command-line override.** M4 requires the ordinary `pnpm run test` command to be reliable, so the safe value belongs in the Windows default rather than an undocumented local workaround.

## Consequences

Windows test throughput may be lower, but the normal command reserves capacity for nested process fixtures and returns deterministic failures when the product is actually broken. Developers with a demonstrably idle, larger host can opt into more workers for an individual run.
