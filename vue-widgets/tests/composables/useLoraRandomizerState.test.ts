/**
 * Unit tests for the "New LoRA Boost" state in useLoraRandomizerState.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useLoraRandomizerState } from '@/composables/useLoraRandomizerState'
import type { RandomizerConfig } from '@/composables/types'

function createMockWidget(value: RandomizerConfig) {
  return {
    value,
    callback: null as any,
    name: 'randomizer_config',
    type: 'RANDOMIZER_CONFIG',
  } as any
}

function createConfig(overrides: Partial<RandomizerConfig> = {}): RandomizerConfig {
  return {
    count_mode: 'range',
    count_fixed: 3,
    count_min: 2,
    count_max: 5,
    model_strength_min: 0,
    model_strength_max: 1,
    use_same_clip_strength: true,
    clip_strength_min: 0,
    clip_strength_max: 1,
    roll_mode: 'fixed',
    use_recommended_strength: false,
    recommended_strength_scale_min: 0.5,
    recommended_strength_scale_max: 1,
    ...overrides,
  }
}

describe('useLoraRandomizerState new LoRA boost', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('defaults the boost to disabled', () => {
    const state = useLoraRandomizerState(createMockWidget(createConfig()))

    expect(state.useNewLoraBoost.value).toBe(false)
    expect(state.newLoraBoostStrength.value).toBe(3)
    expect(state.newLoraBoostDays.value).toBe(7)
  })

  it('restores boost settings from config', () => {
    const state = useLoraRandomizerState(createMockWidget(createConfig()))

    state.restoreFromConfig(
      createConfig({
        use_new_lora_boost: true,
        new_lora_boost_strength: 6.5,
        new_lora_boost_days: 30,
      })
    )

    expect(state.useNewLoraBoost.value).toBe(true)
    expect(state.newLoraBoostStrength.value).toBe(6.5)
    expect(state.newLoraBoostDays.value).toBe(30)
  })

  it('falls back to defaults for configs written before the feature existed', () => {
    const state = useLoraRandomizerState(createMockWidget(createConfig()))

    state.restoreFromConfig(createConfig())

    expect(state.useNewLoraBoost.value).toBe(false)
    expect(state.newLoraBoostStrength.value).toBe(3)
    expect(state.newLoraBoostDays.value).toBe(7)
  })

  it('includes boost settings in buildConfig', () => {
    const state = useLoraRandomizerState(createMockWidget(createConfig()))
    state.useNewLoraBoost.value = true
    state.newLoraBoostStrength.value = 8
    state.newLoraBoostDays.value = 14

    const config = state.buildConfig()

    expect(config.use_new_lora_boost).toBe(true)
    expect(config.new_lora_boost_strength).toBe(8)
    expect(config.new_lora_boost_days).toBe(14)
  })

  it('sends boost settings to the random-sample endpoint', async () => {
    const widget = createMockWidget(createConfig())
    const state = useLoraRandomizerState(widget)
    state.useNewLoraBoost.value = true
    state.newLoraBoostStrength.value = 4
    state.newLoraBoostDays.value = 10

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, loras: [] }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await state.rollLoras(null, [])

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.use_new_lora_boost).toBe(true)
    expect(body.new_lora_boost_strength).toBe(4)
    expect(body.new_lora_boost_days).toBe(10)
  })
})
