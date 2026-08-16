/**
 * Faithful mirror of dsh-router-standard@eff787e `router.test.mjs`:
 * classification, bands, personas, core surfaces, parseMode, extractText,
 * and plan-section survival for the TypeScript port in `router-core.ts`.
 */

import { describe, expect, it } from 'vitest'
import {
  applyPersona, bandFor, classifyTask, coreFor, extractText, isFlashModel,
  parseMode, personaFor, sessionMode, testinessFor,
} from '../src/router-core.ts'

describe('router-core (dsh-router-standard@eff787e mirror)', () => {
  it('react: greenfield/build tasks map to react band', () => {
    expect(bandFor(classifyTask('需要本地开发一个马里奥网页小游戏，参考经典原版'))).toBe('react')
    expect(bandFor(classifyTask('帮我写一个 Python 脚本处理 CSV'))).toBe('react')
    expect(bandFor(classifyTask('从零搭建一个网站'))).toBe('react')
  })

  it('spec: maintenance/fix tasks map to spec band', () => {
    expect(bandFor(classifyTask('修复这个仓库里的 bug'))).toBe('spec')
    expect(bandFor(classifyTask('为什么登录一直报错，帮我排查'))).toBe('spec')
    expect(classifyTask('修复这个仓库里的 bug')).toBe(0)
  })

  it('mixed task lands in react band (net react keywords)', () => {
    expect(bandFor(classifyTask('帮我开发一个小游戏然后修复里面的 bug'))).toBe('react')
  })

  it('unmatched defaults to weak (internal routing)', () => {
    expect(classifyTask('今天天气怎么样')).toBe('weak')
    expect(bandFor('weak')).toBe('weak')
  })

  it('ties default to weak (internal routing)', () => {
    expect(classifyTask('帮我开发一个小游戏然后修复里面的 bug')).toBe(1) // net react wins
    expect(classifyTask('开发并修复')).toBe('weak') // tie → weak
  })

  it('issue #1: plugin-generated nested user/message shape still classifies', () => {
    // 注入器 startIngest 的旧 seed 形状（data.message 嵌套）：提取必须解包，
    // 否则构建/修复任务误入 weak。
    const nested = { message: { kind: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把目录里的内容内化成 DSH 插件并构建注入' }] } }
    expect(extractText(nested)).toMatch(/内化成/u)
    expect(bandFor(classifyTask(extractText(nested)))).toBe('react')
    // 标准形状不受影响
    const flat = { kind: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '修复这个仓库里的 bug' }] }
    expect(extractText(flat)).toBe('修复这个仓库里的 bug')
    expect(bandFor(classifyTask(extractText(flat)))).toBe('spec')
    // sessionMode 用首条 user/message（嵌套形状）
    const session = { events: [{ type: 'user/message', data: nested }] }
    expect(sessionMode(session)).toBe(1)
  })

  it('weak persona is model-specific (P11/P24)', () => {
    const pro = personaFor('weak', 'deepseek-v4-pro')
    const flash = personaFor('weak', 'deepseek-v4-flash')
    expect(pro).toContain('decide the task type (build or fix)')
    expect(pro).toContain('You are a helpful software engineer assistant.')
    expect(pro).not.toContain('review what you have already done') // P24: anchors hurt Pro
    expect(flash).toContain('decide the task type (build or fix)')
    expect(flash).toContain('review what you have already done') // anchors help flash
    expect(pro).not.toBe(flash)
    expect(personaFor('weak', 'deepseek-v4-flash')).toBe(personaFor('weak', 'deepseek-v4-flash'))
    expect(isFlashModel('deepseek-v4-flash')).toBe(true)
    expect(isFlashModel('deepseek-v4-pro')).toBe(false)
  })

  it('parseMode accepts weak', () => {
    expect(parseMode('weak')).toBe('weak')
    expect(parseMode('router')).toBe('weak')
  })

  it('persona quantizes to three measured bands', () => {
    expect(personaFor(0)).toBe('You are a helpful software engineer assistant.')
    expect(personaFor(0.1)).toBe('You are a helpful software engineer assistant.')
    expect(personaFor(0.3)).toContain('Work directly')
    expect(personaFor(0.3)).not.toContain('test harnesses')
    expect(personaFor(1)).toContain('hands-on')
    expect(personaFor(1)).toContain('do not build test harnesses')
  })

  it('core tool surface varies by band', () => {
    expect(coreFor(0)).toEqual(['read', 'edit', 'glob', 'grep'])
    expect(coreFor(1)).toEqual(['read', 'write', 'edit'])
    expect(coreFor(0.3)).toEqual(['read', 'edit', 'write', 'glob', 'grep'])
    expect(coreFor('weak')).toEqual(['str_replace_editor'])
  })

  it('band mapping matches the measured phase transition', () => {
    expect(bandFor(0.1)).toBe('spec') // stable spec region
    expect(bandFor(0.2)).toBe('mixed') // unstable band (display name)
    expect(bandFor(0.4)).toBe('mixed')
    expect(bandFor(0.5)).toBe('react') // stable react region
    expect(bandFor(0.99)).toBe('react')
  })

  it('testiness rises toward spec', () => {
    expect(testinessFor(1)).toBe('suppressed')
    expect(testinessFor(0)).toBe('normal')
    expect(testinessFor(0.3)).toBe('light')
  })

  it('parseMode accepts bands, percents, and decimals', () => {
    expect(parseMode('spec')).toBe(0)
    expect(parseMode('react')).toBe(1)
    expect(parseMode('balanced')).toBe(0.3)
    expect(parseMode('70')).toBe(0.7)
    expect(parseMode('0.3')).toBe(0.3)
    expect(parseMode('auto')).toBe('auto')
    expect(parseMode('nonsense')).toBeNull()
  })

  it('applyPersona replaces only the persona section (keeps plan-mode)', () => {
    const sections = [
      { name: 'harness-identity', text: 'x', order: -100 },
      { name: 'persona', text: 'old persona', order: 0 },
      { name: 'plan-mode', text: 'You are in plan mode.', order: -50 },
      { name: 'tool-guidance', text: 'y', order: 100 },
    ]
    const out = applyPersona(sections, 'new persona')
    const names = out.map(section => section.name)
    expect(names).toContain('harness-identity')
    expect(names).toContain('plan-mode') // plan-mode section must survive
    expect(names).toContain('tool-guidance')
    expect(names).not.toContain('persona') // old persona section replaced
    expect(out.find(section => section.name === 'router-persona')?.text).toBe('new persona')
  })

  it('applyPersona tolerates missing sections', () => {
    expect(applyPersona([], 'p')).toEqual([{ name: 'router-persona', text: 'p', order: 0 }])
  })
})
