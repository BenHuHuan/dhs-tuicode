/**
 * Point-in-time `/context` rows derived from token-meter pressure and the
 * optional session-projection composition view.
 * @module @deepseek-ai/dsh-tui/chat/context-usage
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {
  ContextBreakdownProjection,
  TokenMeasurement,
} from '@deepseek-ai/dsh-token-meter'
import {
  diagnosticMeter,
  formatDiagnosticNumber,
  type StatusCardRow,
} from '../components/dialogs.ts'
import { displayText } from '../components/text.ts'
import type { Palette } from '../components/theme.ts'

const COMPOSITION_METER_WIDTH = 16

/** Complete data needed to render one `/context` snapshot. */
export interface ContextUsageSnapshot {
  readonly measurement: TokenMeasurement
  readonly capacity?: number
  readonly breakdown?: ContextBreakdownProjection
  readonly events: readonly SessionEvent[]
  readonly expanded: boolean
}

function compositionWidths(
  breakdown: ContextBreakdownProjection,
): readonly [system: number, tools: number, messages: number] {
  const values = [
    breakdown.systemTokens,
    breakdown.toolsTokens,
    breakdown.messageTokens,
  ] as const
  const total = values.reduce((sum, value) => sum + value, 0)
  if (total === 0) return [0, 0, 0]
  const raw = values.map(value => value / total * COMPOSITION_METER_WIDTH)
  const widths: [number, number, number] = [
    Math.floor(raw[0] as number),
    Math.floor(raw[1] as number),
    Math.floor(raw[2] as number),
  ]
  const fractions: [number, number, number] = [
    (raw[0] as number) - widths[0],
    (raw[1] as number) - widths[1],
    (raw[2] as number) - widths[2],
  ]
  let remaining = COMPOSITION_METER_WIDTH - widths.reduce((sum, value) => sum + value, 0)
  while (remaining > 0) {
    let largest: 0 | 1 | 2 = 0
    if (fractions[1] > fractions[largest]) largest = 1
    if (fractions[2] > fractions[largest]) largest = 2
    widths[largest] += 1
    fractions[largest] = -1
    remaining -= 1
  }
  return widths
}

function compositionMeter(breakdown: ContextBreakdownProjection, palette: Palette): string {
  const [system, tools, messages] = compositionWidths(breakdown)
  const empty = COMPOSITION_METER_WIDTH - system - tools - messages
  const systemCells = system === 0 ? '' : palette.accent('█'.repeat(system))
  const toolCells = tools === 0 ? '' : palette.warning('█'.repeat(tools))
  const messageCells = messages === 0 ? '' : palette.success('█'.repeat(messages))
  return [
    palette.dim('['),
    systemCells,
    toolCells,
    messageCells,
    palette.dim(`${'░'.repeat(empty)}]`),
  ].join('')
}

function pressureSource(measurement: TokenMeasurement): string {
  switch (measurement.baseline.kind) {
    case 'none': return 'No request baseline yet'
    case 'estimated': return 'Estimated request pressure'
    case 'usage': return 'Provider usage anchored + live surface delta'
  }
}

function surfaceLabels(events: readonly SessionEvent[]): Map<number, string> {
  const toolNames = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') toolNames.set(event.data.callId, event.data.name)
  }
  const labels = new Map<number, string>()
  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const source = event.data.source
        if (source.kind === 'user') labels.set(event.seq, 'User prompt')
        else if (source.kind === 'plugin') labels.set(event.seq, `Context · ${displayText(source.plugin)}`)
        else labels.set(event.seq, `Context · ${displayText(source.kind)}`)
        break
      }
      case 'assistant/message':
        labels.set(event.seq, 'Assistant response')
        break
      case 'tool/result': {
        const callId = event.data.message.content[0].toolCallId
        const name = toolNames.get(callId)
        labels.set(event.seq, name === undefined
          ? `Tool result · ${displayText(callId)}`
          : `Tool result · ${displayText(name)}`)
        break
      }
      default:
        break
    }
  }
  return labels
}

/**
 * Build grouped field rows for the `/context` transcript card.
 * @param snapshot - Current pressure, composition, surface, and expansion choice.
 * @param palette - Active terminal role palette.
 * @returns Status-card row groups in display order.
 */
export function contextUsageGroups(
  snapshot: ContextUsageSnapshot,
  palette: Palette,
): readonly (readonly StatusCardRow[])[] {
  const { measurement, capacity, breakdown } = snapshot
  let pressure = `${formatDiagnosticNumber(measurement.totalTokens)} used · capacity unknown`
  let percent: number | undefined
  if (capacity !== undefined) {
    percent = Math.round(measurement.totalTokens / capacity * 100)
    const over = Math.max(0, measurement.totalTokens - capacity)
    pressure = `${diagnosticMeter(percent, palette)} ${String(percent)}% used (${formatDiagnosticNumber(measurement.totalTokens)} / ${formatDiagnosticNumber(capacity)})${over === 0 ? '' : ` · ${formatDiagnosticNumber(over)} over`}`
  }

  const groups: StatusCardRow[][] = [[
    ['Pressure', pressure],
    ['Source', pressureSource(measurement)],
  ]]
  if (breakdown === undefined) {
    groups.push([
      ['Composition', 'Unavailable in this runtime composition'],
    ])
  } else {
    const legend = [
      palette.accent('S'),
      palette.dim(' system · '),
      palette.warning('T'),
      palette.dim(' tools · '),
      palette.success('M'),
      palette.dim(' messages'),
    ].join('')
    groups.push([
      ['Composition', `${compositionMeter(breakdown, palette)} ${legend}`],
      ['System prompt', `≈ ${formatDiagnosticNumber(breakdown.systemTokens)} tokens`],
      ['Tool schemas', `≈ ${formatDiagnosticNumber(breakdown.toolsTokens)} tokens`],
      ['Conversation', `≈ ${formatDiagnosticNumber(breakdown.messageTokens)} tokens`],
      ['Estimate', 'Component figures use a fixed heuristic and may not sum to anchored pressure'],
    ])
  }

  if (capacity !== undefined && measurement.totalTokens >= capacity) {
    groups.push([
      ['Suggestion', 'Run /compact before the next model step to return below capacity'],
    ])
  } else if (percent !== undefined && percent >= 80) {
    groups.push([
      ['Suggestion', 'Run /compact to free context before the window fills'],
    ])
  }

  if (snapshot.expanded) {
    const labels = surfaceLabels(snapshot.events)
    const surface: StatusCardRow[] = [[
      'Surface items',
      `${String(measurement.nodes.length)} model-visible message${measurement.nodes.length === 1 ? '' : 's'}`,
    ]]
    for (const node of measurement.nodes) {
      surface.push([
        `#${String(node.seq)}`,
        `${labels.get(node.seq) ?? 'Model-visible message'} · ≈ ${formatDiagnosticNumber(node.tokens)} tokens`,
      ])
    }
    groups.push(surface)
  }
  return groups
}
