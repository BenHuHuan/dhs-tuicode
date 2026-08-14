/**
 * TUI interaction-mode projection over the optional permission-preset and
 * plan-mode services. The controller keeps dangerous full-access presets out
 * of keyboard cycling until the current session has already selected one.
 * @module @deepseek-ai/dsh-tui/chat/mode-cycle
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PermissionPresetService, PresetSpec } from '@deepseek-ai/dsh-permission-presets'
import type { PlanModeController } from '@deepseek-ai/dsh-plan-mode'

type PermissionService = Pick<
  PermissionPresetService,
  'current' | 'names' | 'optionOf' | 'resolve' | 'set'
>

type PlanService = Pick<PlanModeController, 'get' | 'set'>

interface PermissionTarget {
  kind: 'permission'
  id: string
  label: string
  preset: string
  dangerous: boolean
}

interface PlanTarget {
  kind: 'plan'
  id: 'plan'
  label: 'Plan'
  dangerous: false
}

interface NormalTarget {
  kind: 'normal'
  id: 'normal'
  label: 'Normal'
  dangerous: false
}

type ModeTarget = PermissionTarget | PlanTarget | NormalTarget

/** User-visible effective mode and whether its transition awaits a step boundary. */
export interface TuiModeView {
  /** Stable identity used to find the next cycle entry. */
  id: string
  /** Human-readable status label. */
  label: string
  /** Owning state domain. */
  kind: ModeTarget['kind']
  /** Whether the requested plan transition has not reached a pre-step boundary. */
  pending: boolean
  /** Whether this mode removes the shell confinement boundary. */
  dangerous: boolean
}

/** Result of one keyboard cycle request. */
export interface TuiModeCycleResult {
  /** Whether the effective target changed. */
  changed: boolean
  /** Effective mode after the request; absent when neither service is mounted. */
  view?: TuiModeView
}

const PLAN_TARGET: PlanTarget = {
  kind: 'plan',
  id: 'plan',
  label: 'Plan',
  dangerous: false,
}

const NORMAL_TARGET: NormalTarget = {
  kind: 'normal',
  id: 'normal',
  label: 'Normal',
  dangerous: false,
}

/** Convert a conventional kebab-case service label into terminal copy. */
function displayName(value: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)) return value
  return value.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/** Full shell access is the capability whose accidental keyboard admission matters. */
function isDangerous(spec: PresetSpec): boolean {
  return spec.sandbox === 'danger-full-access'
}

/**
 * Combine configured permission presets and logged plan state into one
 * terminal mode cycle. Plan mode remains an independent service state;
 * entering it does not silently rewrite the deployment's permission preset.
 */
export class TuiModeController {
  private dangerousUnlocked = false

  /**
   * @param agent - Exact agent/session driven by this terminal.
   * @param permission - Optional configured permission-preset service.
   * @param plan - Optional per-agent plan-mode service.
   */
  constructor(
    private readonly agent: Agent,
    private readonly permission: PermissionService | undefined,
    private readonly plan: PlanService | undefined,
  ) {}

  /**
   * Read the effective target from durable permission facts and live plan
   * intent. A pending plan transition is shown immediately and marked pending.
   * @returns current mode, or undefined when no owning service is mounted.
   */
  current(): TuiModeView | undefined {
    const permissionTarget = this.currentPermissionTarget()
    const planState = this.plan?.get(this.agent)
    const pending = planState?.pending !== undefined
    if ((planState?.pending ?? planState?.active) === true) {
      return this.view(PLAN_TARGET, pending)
    }
    if (permissionTarget !== undefined) return this.view(permissionTarget, pending)
    if (this.plan !== undefined) return this.view(NORMAL_TARGET, pending)
    return undefined
  }

  /**
   * Select the next safe configured permission preset or plan state. A full-
   * access preset joins the cycle only after this session is already using it,
   * so a normal Shift+Tab sequence cannot grant it accidentally.
   * @returns whether the target changed and the resulting effective view.
   */
  cycle(): TuiModeCycleResult {
    const current = this.current()
    const targets = this.targets()
    if (targets.length === 0) return { changed: false, ...current === undefined ? {} : { view: current } }
    const currentIndex = current === undefined ? -1 : targets.findIndex(target => target.id === current.id)
    const target = targets[(currentIndex + 1) % targets.length]
    /* v8 ignore next -- a non-empty array and modulo index always produce one target. */
    if (target === undefined) return { changed: false, ...current === undefined ? {} : { view: current } }
    if (target.id === current?.id) return { changed: false, view: current }

    this.apply(target)
    const next = this.current()
    return { changed: next?.id !== current?.id, ...next === undefined ? {} : { view: next } }
  }

  /** Build configured permission targets and unlock an already-effective full-access entry. */
  private permissionTargets(): PermissionTarget[] {
    const permission = this.permission
    if (permission === undefined) return []
    const current = permission.current(this.agent.session.events)
    const targets = permission.names.map((preset): PermissionTarget => {
      const option = permission.optionOf(preset)
      const dangerous = isDangerous(permission.resolve(preset))
      return {
        kind: 'permission',
        id: `permission:${preset}`,
        label: dangerous ? 'Full access' : displayName(option.name),
        preset,
        dangerous,
      }
    })
    if (targets.some(target => target.preset === current && target.dangerous)) {
      this.dangerousUnlocked = true
    }
    return targets
  }

  /** Resolve even a derived custom state for status, though it is never a cycle target. */
  private currentPermissionTarget(): PermissionTarget | undefined {
    if (this.permission === undefined) return undefined
    const current = this.permission.current(this.agent.session.events)
    const configured = this.permissionTargets().find(target => target.preset === current)
    if (configured !== undefined) return configured
    return {
      kind: 'permission',
      id: `permission:${current}`,
      label: displayName(this.permission.optionOf(current).name),
      preset: current,
      dangerous: false,
    }
  }

  /** Safe presets precede Plan; an unlocked full-access preset follows it. */
  private targets(): ModeTarget[] {
    const permissions = this.permissionTargets()
    const safe = permissions.filter(target => !target.dangerous)
    const dangerous = this.dangerousUnlocked
      ? permissions.filter(target => target.dangerous)
      : []
    return [
      ...this.permission === undefined && this.plan !== undefined ? [NORMAL_TARGET] : safe,
      ...this.plan === undefined ? [] : [PLAN_TARGET],
      ...dangerous,
    ]
  }

  /** Apply through each owning service instead of writing its session events directly. */
  private apply(target: ModeTarget): void {
    if (target.kind === 'plan') {
      this.plan?.set(this.agent, true)
      return
    }
    const planState = this.plan?.get(this.agent)
    if ((planState?.pending ?? planState?.active) === true) {
      this.plan?.set(this.agent, false)
    }
    if (target.kind === 'permission') this.permission?.set(this.agent.session, target.preset)
  }

  /** Add live transition metadata to a static target. */
  private view(target: ModeTarget, pending: boolean): TuiModeView {
    return { ...target, pending }
  }
}
