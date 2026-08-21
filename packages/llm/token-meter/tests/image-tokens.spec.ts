import { describe, expect, it } from 'vitest'
import { estimateImageTokens } from '../src/image-tokens.ts'

describe('estimateImageTokens', () => {
  it.each([
    [1, 1, 117],
    [100, 100, 117],
    [384, 384, 117],
    [640, 480, 209],
    [1024, 1024, 349],
    [1920, 1080, 369],
    [2000, 2000, 349],
    [5000, 5000, 349],
    [8192, 8192, 349],
    [8192, 1, 113],
    [1, 8192, 381],
    [800, 800, 349],
    [1000, 100, 113],
    [100, 1000, 125],
  ] as const)('matches the official calculator for %s×%s', (width, height, expected) => {
    expect(estimateImageTokens(width, height)).toBe(expected)
  })

  it('never exceeds the provider per-image token bound', () => {
    for (const [width, height] of [[10_000, 10_000], [20_000, 1], [1, 20_000]] as const) {
      expect(estimateImageTokens(width, height)).toBeLessThanOrEqual(384)
    }
  })
})
