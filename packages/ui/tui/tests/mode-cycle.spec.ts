import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {
  PermissionPresetService,
  PresetSpec,
} from '@deepseek-ai/dsh-permission-presets'
import type { PlanModeController } from '@deepseek-ai/dsh-plan-mode'
import type { Session } from '@deepseek-ai/dsh-session'
import { TuiModeController } from '../src/chat/mode-cycle.ts'

function fakeAgent(): Agent {
  return { session: { events: [] } } as unknown as Agent
}

interface PermissionHarness {
  service: PermissionPresetService
  selected(): string
}

function fakePermissions(
  initial: string,
  presets: Readonly<Record<string, PresetSpec>> = {
    'read-only': { sandbox: 'read-only', approval: 'ask' },
    'workspace-write': { sandbox: 'workspace-write', approval: 'ask' },
    'danger-full-access': { sandbox: 'danger-full-access', approval: 'never' },
  },
): PermissionHarness {
  let selected = initial
  const names = Object.keys(presets)
  return {
    selected: () => selected,
    service: {
      names,
      current: () => selected,
      resolve: (name: string) => {
        const spec = presets[name]
        if (spec === undefined) throw new Error(`unknown preset ${name}`)
        return spec
      },
      optionOf: (name: string) => ({
        value: name,
        name: name === 'custom' ? 'Custom policy' : presets[name]?.name ?? name,
      }),
      set: (_session: Session, name: string) => { selected = name },
    } as unknown as PermissionPresetService,
  }
}

interface PlanHarness {
  service: PlanModeController
  state(): { active: boolean; pending?: boolean }
}

function fakePlan(initial: { active: boolean; pending?: boolean } = { active: false }): PlanHarness {
  let state = initial
  return {
    state: () => state,
    service: {
      get: () => ({ ...state }),
      set: (_agent: Agent, active: boolean) => {
        const target = state.pending ?? state.active
        if (target === active) return 'noop'
        state = { active }
        return 'committed'
      },
    } as unknown as PlanModeController,
  }
}

describe('TuiModeController', () => {
  it('cycles ordinary permissions through Plan without admitting full access', () => {
    const agent = fakeAgent()
    const permission = fakePermissions('workspace-write')
    const plan = fakePlan()
    const controller = new TuiModeController(agent, permission.service, plan.service)

    expect(controller.current()).toMatchObject({ id: 'permission:workspace-write', label: 'Workspace Write' })
    expect(controller.cycle()).toEqual({
      changed: true,
      view: { id: 'plan', label: 'Plan', kind: 'plan', pending: false, dangerous: false },
    })
    expect(permission.selected()).toBe('workspace-write')
    expect(plan.state()).toEqual({ active: true })

    expect(controller.cycle().view).toMatchObject({ id: 'permission:read-only', label: 'Read Only' })
    expect(controller.cycle().view).toMatchObject({ id: 'permission:workspace-write' })
    expect(controller.cycle().view).toMatchObject({ id: 'plan' })
    expect(permission.selected()).not.toBe('danger-full-access')
  })

  it('keeps an already-selected full-access preset in subsequent cycles', () => {
    const permission = fakePermissions('danger-full-access')
    const controller = new TuiModeController(fakeAgent(), permission.service, fakePlan().service)

    expect(controller.current()).toMatchObject({
      id: 'permission:danger-full-access',
      label: 'Full access',
      dangerous: true,
    })
    expect(controller.cycle().view).toMatchObject({ id: 'permission:read-only' })
    expect(controller.cycle().view).toMatchObject({ id: 'permission:workspace-write' })
    expect(controller.cycle().view).toMatchObject({ id: 'plan' })
    expect(controller.cycle().view).toMatchObject({ id: 'permission:danger-full-access' })
  })

  it('projects pending plan entry and exit as the requested target', () => {
    const agent = fakeAgent()
    const permission = fakePermissions('workspace-write')
    const entering = fakePlan({ active: false, pending: true })
    const leaving = fakePlan({ active: true, pending: false })

    expect(new TuiModeController(agent, permission.service, entering.service).current()).toMatchObject({
      id: 'plan',
      pending: true,
    })
    expect(new TuiModeController(agent, permission.service, leaving.service).current()).toMatchObject({
      id: 'permission:workspace-write',
      pending: true,
    })
  })

  it('moves a derived custom state to the first configured safe preset', () => {
    const permission = fakePermissions('custom')
    const controller = new TuiModeController(fakeAgent(), permission.service, undefined)

    expect(controller.current()).toMatchObject({ id: 'permission:custom', label: 'Custom policy' })
    expect(controller.cycle().view).toMatchObject({ id: 'permission:read-only' })
    expect(permission.selected()).toBe('read-only')
  })

  it('toggles Normal and Plan when only plan mode is mounted', () => {
    const plan = fakePlan()
    const controller = new TuiModeController(fakeAgent(), undefined, plan.service)

    expect(controller.current()).toMatchObject({ id: 'normal' })
    expect(controller.cycle().view).toMatchObject({ id: 'plan' })
    expect(controller.cycle().view).toMatchObject({ id: 'normal' })
  })

  it('reports no mode when neither owning service is mounted', () => {
    const controller = new TuiModeController(fakeAgent(), undefined, undefined)
    expect(controller.current()).toBeUndefined()
    expect(controller.cycle()).toEqual({ changed: false })
  })
})
