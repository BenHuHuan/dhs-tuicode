/**
 * Model-selection sub-controller for the interactive chat channel: the queued
 * `/model` and `/effort` commands, their keyboard selectors, the Alt+T
 * extended-thinking toggle, and resolution of the selected model's context
 * window. Owns the context-window cache the prompt and status views read; the
 * caller owns the shared {@link ModelSelectionRef}.
 * @module @deepseek-ai/dsh-tui/chat/model-command
 */

import type { ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { errorChain, LlmError, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { TuiOverlaySession } from '../extension/types.ts'
import { displayText } from '../components/text.ts'
import {
  ModelDialog,
  ReasoningEffortDialog,
  readModelChoices,
  targetLabel,
  targetReasoningLabel,
  type ModelChoice,
  type ModelDialogSelection,
} from '../components/dialogs.ts'
import type { ChannelNotice, ChatChannelDeps } from './channel.ts'

/** Collaborators the model controller needs from the chat channel. */
export interface ModelControllerDeps extends ChatChannelDeps, ChannelNotice {
  /** Shared selected-target handle owned by the channel. */
  readonly target: ModelSelectionRef
}

/** Model-selection controller for one chat channel. */
export interface ModelController {
  /** Resolved context window of the selected model, or `undefined` if unknown. */
  contextWindow(): number | undefined
  /** Open the interactive model selector. */
  openSelector(): void
  /** Queue a `/model` command; empty argument opens the selector. */
  queueModelCommand(raw: string): void
  /** Queue a `/effort` command; empty argument opens the effort selector. */
  queueEffortCommand(raw: string): void
  /** Toggle extended thinking when the selected adapter advertises both on and off efforts. */
  toggleThinking(): void
  /** Drop the pending context-window resolution (shutdown). */
  resetContextResolution(): void
  /** Forget the tracked selector overlay (shutdown). */
  clearOverlay(): void
  /** Remove the adapter-registration listener (channel detach). */
  detach(): void
}

type ContextResolution =
  | { readonly kind: 'resolved'; readonly contextWindow: number | undefined }
  | { readonly kind: 'error'; readonly error: unknown }

/**
 * Build the model-selection controller for one chat channel.
 * @param deps - channel collaborators and shared target handle.
 * @returns the controller wired to the channel's overlay and prompt views.
 */
export function createModelController(deps: ModelControllerDeps): ModelController {
  const { ctx, resolved, palette, overlayManager, target } = deps
  let contextWindow: number | undefined
  let contextResolution: Promise<ContextResolution> | undefined
  let modelOverlay: TuiOverlaySession | undefined
  let effortOverlay: TuiOverlaySession | undefined
  let modelCommands = Promise.resolve()
  const lastNonOffByRoute = new Map<string, ReasoningEffortId>()

  // A route whose adapter has not registered yet. Loader activation order is
  // service-driven, so the TUI can mount before a configured adapter plugin
  // activates; that transient NO_ADAPTER is not an error — the resolution
  // waits for the next `llm/adapters-updated` commit instead of surfacing it.
  let awaitingAdapter = false

  const resolveContextWindow = (selected: ModelSelection | undefined): void => {
    contextWindow = undefined
    awaitingAdapter = false
    const resolution: Promise<ContextResolution> = selected === undefined
      ? Promise.resolve({ kind: 'resolved', contextWindow: undefined } as const)
      : ctx.llm.resolveModelInfo(selected.provider, selected.model).then(
        info => ({ kind: 'resolved', contextWindow: info.context?.contextWindow } as const),
        (error: unknown) => ({ kind: 'error', error } as const),
      )
    contextResolution = resolution
    void resolution.then((result) => {
      if (contextResolution !== resolution) return
      if (result.kind === 'error') {
        if (selected !== undefined && result.error instanceof LlmError && result.error.code === 'NO_ADAPTER') {
          awaitingAdapter = true
          return
        }
        deps.appendNotice(`Could not resolve model context: ${errorChain(result.error)}`, 'error')
        return
      }
      contextWindow = result.contextWindow
      deps.requestRender()
    })
  }
  // The wait cannot go stale against `target.current`: every target change
  // re-enters resolveContextWindow, which clears it. A commit that still
  // lacks the route parks the resolution again rather than erroring, so
  // unrelated topology changes stay silent. The disposer rides the channel's
  // detachListeners() through detach(), matching the sibling listeners.
  const disposeAdapterListener = ctx.on('llm/adapters-updated', () => {
    if (deps.isDisposed() || !awaitingAdapter) return
    resolveContextWindow(target.current)
  })
  resolveContextWindow(target.current)

  const currentChoice = (choices: readonly ModelChoice[]): ModelChoice | undefined => {
    const selected = target.current
    if (selected === undefined) return undefined
    return choices.find(choice =>
      choice.provider === selected.provider && choice.model === selected.model)
  }

  const rememberNonOff = (
    choice: ModelChoice,
    effort: ReasoningEffortId | undefined,
  ): void => {
    const candidate = effort ?? choice.reasoning?.defaultEffort
    if (
      candidate === undefined
      || candidate === 'off'
      || !choice.reasoning?.efforts.some(advertised => advertised.id === candidate)
    ) return
    lastNonOffByRoute.set(targetLabel(choice), candidate)
  }

  const effortSelectionLabel = (
    choice: ModelChoice,
    effort: ReasoningEffortId | undefined,
  ): string => {
    if (effort !== undefined) return displayText(targetReasoningLabel(choice, effort) ?? effort)
    const defaultEffort = choice.reasoning?.defaultEffort
    if (defaultEffort === undefined) return 'Auto (provider default)'
    return `Auto (adapter default: ${displayText(targetReasoningLabel(choice, defaultEffort) ?? defaultEffort)})`
  }

  const effortUsage = (choice: ModelChoice): string => {
    const available = ['auto', ...(choice.reasoning?.efforts.map(effort => effort.id) ?? [])]
    return `Usage: /effort [level|auto]. Available for ${targetLabel(choice)}: ${available.join(', ')}.`
  }

  const requireCurrentReasoningChoice = (
    choices: readonly ModelChoice[],
  ): ModelChoice | undefined => {
    if (target.current === undefined) {
      deps.appendNotice('Reasoning effort is unavailable because no model is selected. Run /model first.', 'warning')
      return undefined
    }
    const choice = currentChoice(choices)
    if (choice === undefined) {
      deps.appendNotice(`Could not find the selected model ${targetLabel(target.current)} in the advertised model catalog.`, 'warning')
      return undefined
    }
    if (choice.reasoning === undefined || choice.reasoning.efforts.length === 0) {
      deps.appendNotice(`Reasoning effort is unavailable for ${targetLabel(choice)} because its adapter advertises no reasoning controls.`, 'warning')
      return undefined
    }
    return choice
  }

  const selectReasoningEffort = (
    choice: ModelChoice,
    effort: ReasoningEffortId | undefined,
  ): void => {
    const selected = target.current
    if (
      selected === undefined
      || selected.provider !== choice.provider
      || selected.model !== choice.model
    ) {
      deps.appendNotice('The selected model changed while the reasoning selector was open. Run /effort again.', 'warning')
      return
    }
    rememberNonOff(choice, effort)
    if (selected.reasoningEffort === effort) {
      deps.appendNotice(`Reasoning effort is already ${effortSelectionLabel(choice, effort)} for ${targetLabel(choice)}.`)
      return
    }
    target.current = {
      provider: selected.provider,
      model: selected.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }
    deps.requestRender()
    deps.appendNotice(`Reasoning effort: ${effortSelectionLabel(choice, effort)}. New steps will use it.`)
  }

  const selectModel = (
    selected: ModelChoice,
    explicitReasoning?: { effort: ReasoningEffortId | undefined },
  ): void => {
    const sameRoute = target.current?.provider === selected.provider && target.current.model === selected.model
    const reasoningEffort = explicitReasoning === undefined
      ? (sameRoute ? target.current?.reasoningEffort ?? selected.reasoning?.defaultEffort : selected.reasoning?.defaultEffort)
      : explicitReasoning.effort
    rememberNonOff(selected, reasoningEffort)
    if (sameRoute && target.current?.reasoningEffort === reasoningEffort) {
      const reasoning = targetReasoningLabel(selected, reasoningEffort)
      deps.appendNotice(`Model is already ${targetLabel(selected)}${reasoning === undefined ? '' : ` with reasoning effort ${displayText(reasoning)}`}.`)
      return
    }
    target.current = {
      provider: selected.provider,
      model: selected.model,
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
    }
    resolveContextWindow(target.current)
    const reasoning = targetReasoningLabel(selected, reasoningEffort)
    deps.appendNotice([
      `Model selected: ${targetLabel(selected)}.`,
      ...reasoning === undefined ? [] : [`Reasoning effort: ${displayText(reasoning)}.`],
      'New steps will use it.',
    ].join(' '))
  }

  const showModelSelector = (choices: readonly ModelChoice[]): void => {
    const current = target.current === undefined ? 'unset' : targetLabel(target.current)
    if (choices.length === 0) {
      deps.appendNotice(`Current model: ${current}\nNo models are advertised by registered providers.`, 'warning')
      return
    }
    void effortOverlay?.close()
    void modelOverlay?.close()
    const session = overlayManager.open({
      create: () => new ModelDialog(
        choices,
        target.current,
        resolved.maxModelOptions,
        palette,
        (selection: ModelDialogSelection) => {
          void session.close()
          selectModel(selection.choice, { effort: selection.reasoningEffort })
        },
        () => { void session.close() },
      ),
      options: {
        width: resolved.modelDialogWidth,
        maxHeight: resolved.modelDialogMaxHeight,
        anchor: 'center',
        margin: 1,
      },
    })
    modelOverlay = session
    void session.closed.then(() => {
      if (modelOverlay === session) modelOverlay = undefined
    })
    deps.requestRender()
  }

  const showEffortSelector = (choice: ModelChoice): void => {
    void modelOverlay?.close()
    void effortOverlay?.close()
    const session = overlayManager.open({
      create: () => new ReasoningEffortDialog(
        choice,
        target.current?.reasoningEffort,
        resolved.maxModelOptions,
        palette,
        (effort) => {
          void session.close()
          selectReasoningEffort(choice, effort)
        },
        () => { void session.close() },
      ),
      options: {
        width: resolved.modelDialogWidth,
        maxHeight: resolved.modelDialogMaxHeight,
        anchor: 'center',
        margin: 1,
      },
    })
    effortOverlay = session
    void session.closed.then(() => {
      if (effortOverlay === session) effortOverlay = undefined
    })
    deps.requestRender()
  }

  const handleModelCommand = async (raw: string): Promise<void> => {
    const choices = await readModelChoices(ctx, target.current)
    if (deps.isDisposed()) return
    const argument = raw.trim()
    if (argument === '') {
      showModelSelector(choices)
      return
    }
    const parts = argument.split(/\s+/u)
    if (parts.length > 2) {
      deps.appendNotice('Usage: /model [provider/]model', 'warning')
      return
    }

    let matches: ModelChoice[]
    if (parts.length === 2) {
      matches = choices.filter(choice => choice.provider === parts[0] && choice.model === parts[1])
    } else {
      const value = argument
      const qualified = choices.filter(choice => targetLabel(choice) === value)
      matches = qualified.length > 0 ? qualified : choices.filter(choice => choice.model === value)
    }
    if (matches.length === 0) {
      deps.appendNotice(`Unknown model: ${argument}. Run /model to list available models.`, 'warning')
      return
    }
    if (matches.length > 1) {
      deps.appendNotice(`Model "${argument}" is advertised by multiple providers; use /model <provider>/<model>.`, 'warning')
      return
    }
    const selected = matches[0]
    /* v8 ignore next -- a non-empty matches array always has index zero. */
    if (selected === undefined) return
    selectModel(selected)
  }

  const handleEffortCommand = async (raw: string): Promise<void> => {
    const choices = await readModelChoices(ctx, target.current)
    if (deps.isDisposed()) return
    const choice = requireCurrentReasoningChoice(choices)
    if (choice === undefined) return
    const argument = raw.trim()
    if (argument === '') {
      showEffortSelector(choice)
      return
    }
    const parts = argument.split(/\s+/u)
    if (parts.length !== 1) {
      deps.appendNotice(effortUsage(choice), 'warning')
      return
    }
    if (argument.toLocaleLowerCase() === 'auto') {
      selectReasoningEffort(choice, undefined)
      return
    }
    const normalized = argument.toLocaleLowerCase()
    const idMatches = choice.reasoning?.efforts.filter(effort =>
      effort.id.toLocaleLowerCase() === normalized) ?? []
    const matches = idMatches.length > 0
      ? idMatches
      : choice.reasoning?.efforts.filter(effort =>
        effort.name.toLocaleLowerCase() === normalized) ?? []
    if (matches.length !== 1) {
      deps.appendNotice(effortUsage(choice), 'warning')
      return
    }
    /* v8 ignore next -- a one-element match array always has index zero. */
    const selected = matches[0]
    if (selected === undefined) return
    selectReasoningEffort(choice, selected.id)
  }

  const handleThinkingToggle = async (): Promise<void> => {
    const choices = await readModelChoices(ctx, target.current)
    if (deps.isDisposed()) return
    const choice = requireCurrentReasoningChoice(choices)
    if (choice === undefined) return
    const efforts = choice.reasoning?.efforts ?? []
    const off = efforts.find(effort => effort.id === 'off')
    const nonOff = efforts.filter(effort => effort.id !== 'off')
    if (off === undefined) {
      deps.appendNotice(`${targetLabel(choice)} cannot disable extended thinking because its adapter does not advertise an "off" effort.`, 'warning')
      return
    }
    if (nonOff.length === 0) {
      deps.appendNotice(`${targetLabel(choice)} cannot enable extended thinking because its adapter advertises no enabled effort.`, 'warning')
      return
    }
    const current = target.current?.reasoningEffort ?? choice.reasoning?.defaultEffort
    if (current !== off.id) {
      rememberNonOff(choice, current)
      selectReasoningEffort(choice, off.id)
      return
    }
    const remembered = lastNonOffByRoute.get(targetLabel(choice))
    const restored = nonOff.find(effort => effort.id === remembered)
      ?? nonOff.find(effort => effort.id === choice.reasoning?.defaultEffort)
      ?? nonOff[0]
    /* v8 ignore next -- nonOff was proven non-empty above. */
    if (restored === undefined) return
    selectReasoningEffort(choice, restored.id)
  }

  const queueCatalogCommand = (operation: () => Promise<void>): void => {
    modelCommands = modelCommands.then(operation).catch((error: unknown) => {
      if (!deps.isDisposed()) deps.appendNotice(`Could not read the model catalog: ${errorChain(error)}`, 'error')
    })
  }

  const queueModelCommand = (raw: string): void => {
    queueCatalogCommand(async () => { await handleModelCommand(raw) })
  }

  const queueEffortCommand = (raw: string): void => {
    queueCatalogCommand(async () => { await handleEffortCommand(raw) })
  }

  return {
    contextWindow: () => contextWindow,
    openSelector(): void {
      queueModelCommand('')
    },
    queueModelCommand,
    queueEffortCommand,
    toggleThinking(): void {
      queueCatalogCommand(handleThinkingToggle)
    },
    resetContextResolution(): void {
      contextResolution = undefined
    },
    clearOverlay(): void {
      modelOverlay = undefined
      effortOverlay = undefined
    },
    detach(): void {
      disposeAdapterListener()
    },
  }
}
