# Agent Note: Claude Code visual alignment for the TUI

Status: implemented

English | [中文](2026-08-15-tui-claude-code-visual-alignment.zh.md)

## Problem

The restored TUI was a reliable terminal front door, but its visual language did not match the product's stated Claude Code-like target. It used a bold, underlined `You` / `Assistant` header pair, a `○ Tool / <name>` card frame, a borderless editor with a `dsh > ` prompt, and a single terminal-agnostic ANSI palette whose accent rendered magenta on most schemes. The reference TUI project the product follows renders Claude Code's terracotta accents, railed user messages, headerless assistant output, and `Verb(argument)` tool cards.

## Decision

`theme.palette` is a new validated config field with the default `claude` and the escape hatch `adaptive`. On truecolor terminals the `claude` palette pins semantic roles to Claude Code's classic tokens — terracotta `#d77757` accent, `#767676` subtle, `#4eba65` success, `#ffc107` warning, `#ff6b80` error, and `#af87ff` inline code — with a darkened set for light color schemes. Without truecolor the same roles fall back to bright ANSI approximations, and `adaptive` keeps the previous terminal-remapped 16-color roles. `paletteSpec` remains the single SGR table and `/palette` keeps reporting every role.

The transcript adopts Claude Code's grouping: user and accepted prompt rows carry a bold accent `❯` rail, assistant output renders headerless in the terminal's default tone, and reasoning opens with a dim italic `✻ Reasoning` line. Tool cards replace the `○ Tool / <name>` frame with a status bullet (`⠋` pending, `›` ok, `✗` error) plus a bold family-colored `Verb(argument)` title derived from a bounded tool-name/argument map, a `⎿`-prefixed body, and a duration suffix once the call reaches one second. Terminal cards always keep their command in the header, including unknown tools whose presenter supplies one, so the new title can never erase the one piece of information a pending command card carries.

The editor gains Claude Code's rounded input rail: `╭─…╮` above and `╰─…╯` below with no side borders. The rail is dim normally, warning while plan mode is active or pending, and error under always-approve. The default input prompt becomes `${symbol}${indicator}` — an accent `❯` followed by the phase-glyph slot — and the running glyph fades into that slot without shifting the cursor. Sub-second tool durations are not rendered: they are process-scheduling noise and would make live snapshots unreplayable.

## Verification

Focused TUI unit tests pin the new `tool-card` verb/argument and elapsed helpers, the Claude truecolor role codes, the railed prompt geometry, the rounded editor frame, and hidden-mode card folding. The 40-file terminal snapshot corpus was re-recorded through the keyless snapshot harness and replays deterministically; the truecolor banner checkpoint proves the sanctioned 24-bit foregrounds carry no background or extended-palette codes, and ANSI-fallback checkpoints still report zero violations. Package typecheck and the full non-snapshot TUI suite pass.

## Alternatives considered

**Keep the terminal-agnostic ANSI palette as the only mode.** Rejected because ANSI 16 has no terracotta: the closest roles are magenta or yellow, so Claude Code alignment cannot be expressed without sanctioned truecolor foreground codes when the terminal supports them.

**Keep the bold underlined role headers and only recolor them.** Rejected because the headers, not the hue, are the largest visual distance from Claude Code; railed user rows and headerless assistant output are the reference layout the product follows.

**Render every sub-second tool duration.** Rejected because `tool/call` and `tool/result` timestamps come from `Date.now()` at append time; live replay would then embed 1–2 ms scheduling jitter in terminal snapshots. The one-second floor keeps real command durations visible while making snapshots deterministic.

**Derive tool titles from presenter `title` strings only.** Rejected because presenter titles vary by tool and often duplicate the tool name; the bounded verb/argument map gives the stable `Run(command)`, `Read(file)`, `Search(pattern)` vocabulary, with the presenter title still rendered in the body.

## Consequences

The TUI now visually reads as a Claude Code-style front door while remaining a pure presentation layer: no session event, model input, or tool schema changed. Existing deployments that prefer terminal-mapped colors can set `theme.palette: adaptive`; every other config default is unchanged except the input-prompt template. User rows now include the `❯` marker in what a drag-select copies, tool-card headers no longer contain the literal `Tool / <name>` frame, and hidden-mode folding counts leading spacing rather than assistant headers. The package README and the terminal snapshot corpus own the rendered contract.

[Restore the shipped TUI profile](2026-08-14-restore-tui-profile.md) established the green baseline this parity work builds on; it remains the owner of profile composition, lifecycle, and assembled verification.
