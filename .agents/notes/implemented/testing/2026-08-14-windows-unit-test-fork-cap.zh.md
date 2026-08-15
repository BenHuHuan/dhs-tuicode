# Agent Note: Windows Unit-Test Fork Cap

Status: implemented

[English](2026-08-14-windows-unit-test-fork-cap.md) | 中文

## Problem

Windows 单元测试包含 Git、PowerShell、worker 和子进程 fixture，它们会与 Vitest fork 的创建竞争资源。八个并发 fork 在每个受影响测试单独运行均能通过时，仍可能间歇性耗尽主机进程资源，并以 `spawn UNKNOWN`、缓冲区错误和超时掩盖真正的应用回归。

## Decision

`vitest.config.ts` 将 Windows 单元测试 fork 池的默认上限设为四个 worker。非 Windows 主机保持 Vitest 的正常并发度，显式传入的命令行 `--maxWorkers` 仍可覆盖此本地默认值。

## Alternatives considered

**保留八个 fork 的上限。** 空闲主机上它更快，但当机器同时运行正常开发工作负载时，无法为进程密集型 fixture 留出足够余量。

**所有平台都强制使用四个 worker。** 已观测到的失败模式是 Windows 进程抖动，因此约束 Linux 和 macOS 会消耗 CI 容量，却不能解决其上的已知问题。

**要求开发者记住命令行覆盖参数。** M4 要求普通的 `pnpm run test` 命令可靠，因此安全值应属于 Windows 默认配置，而不是未记录的本地规避手段。

## Consequences

Windows 测试吞吐量可能降低，但普通命令会为嵌套进程 fixture 预留容量；当产品确有问题时，失败也更可复现。拥有已确认空闲且资源更大的主机时，开发者仍可为单次运行显式提高 worker 数。
