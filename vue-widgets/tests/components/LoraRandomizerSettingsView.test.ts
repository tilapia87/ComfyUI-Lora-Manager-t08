/**
 * Component tests for the New LoRA Boost section in LoraRandomizerSettingsView.
 */

import { shallowMount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import LoraRandomizerSettingsView from '@/components/lora-randomizer/LoraRandomizerSettingsView.vue'

function createProps(overrides: Record<string, unknown> = {}) {
  return {
    countMode: 'range' as const,
    countFixed: 3,
    countMin: 2,
    countMax: 5,
    modelStrengthMin: 0,
    modelStrengthMax: 1,
    useCustomClipRange: false,
    clipStrengthMin: 0,
    clipStrengthMax: 1,
    rollMode: 'fixed' as const,
    isRolling: false,
    isClipStrengthDisabled: true,
    lastUsed: null,
    currentLoras: [],
    canReuseLast: false,
    useRecommendedStrength: false,
    recommendedStrengthScaleMin: 0.5,
    recommendedStrengthScaleMax: 1,
    useNewLoraBoost: false,
    newLoraBoostStrength: 3,
    newLoraBoostDays: 7,
    ...overrides,
  }
}

describe('LoraRandomizerSettingsView New LoRA Boost', () => {
  it('renders the section with the current boost values', () => {
    const wrapper = shallowMount(LoraRandomizerSettingsView, {
      props: createProps({ useNewLoraBoost: true, newLoraBoostStrength: 4.5, newLoraBoostDays: 21 }),
    })

    const text = wrapper.text()
    expect(text).toContain('New LoRA Boost')
    expect(text).toContain('Weight ×4.5 for the newest LoRA')
    expect(text).toContain('Fades out over 21 days')
  })

  it('emits the toggle update when the switch is clicked', async () => {
    const wrapper = shallowMount(LoraRandomizerSettingsView, {
      props: createProps(),
    })

    const switches = wrapper.findAll('button.toggle-switch')
    // Order: Preset Strength Scale, New LoRA Boost, Clip Strength Range
    await switches[1].trigger('click')

    expect(wrapper.emitted('update:useNewLoraBoost')).toEqual([[true]])
  })

  it('disables the boost sliders while the boost is off', () => {
    const wrapper = shallowMount(LoraRandomizerSettingsView, {
      props: createProps({ useNewLoraBoost: false }),
    })

    expect(wrapper.findAll('.slider-container--disabled').length).toBeGreaterThan(0)
  })
})
