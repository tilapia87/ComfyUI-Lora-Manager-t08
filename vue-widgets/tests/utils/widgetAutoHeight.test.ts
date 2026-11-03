import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createWidgetAutoHeight, measureContentHeight } from '@/utils/widgetAutoHeight'

function buildHost(contentHeight: number): { container: HTMLElement; host: HTMLElement; content: HTMLElement } {
  const container = document.createElement('div')
  const host = document.createElement('div')
  host.className = 'lora-randomizer-widget'
  host.style.padding = '6px'
  const content = document.createElement('div')
  content.className = 'randomizer-settings'
  Object.defineProperty(content, 'scrollHeight', { configurable: true, value: contentHeight })
  Object.defineProperty(content, 'offsetHeight', { configurable: true, value: contentHeight })
  host.appendChild(content)
  container.appendChild(host)
  document.body.appendChild(container)
  return { container, host, content }
}

describe('measureContentHeight', () => {
  it('adds host padding to the measured content height', () => {
    const { container, host } = buildHost(700)
    const content = container.querySelector<HTMLElement>('.randomizer-settings')
    // jsdom does not run layout, so padding is read from getComputedStyle.
    expect(measureContentHeight(host, content, 448)).toBeGreaterThanOrEqual(700)
  })

  it('never reports less than the design minimum', () => {
    const { container, host } = buildHost(120)
    const content = container.querySelector<HTMLElement>('.randomizer-settings')
    expect(measureContentHeight(host, content, 448)).toBe(448)
  })

  it('falls back to the minimum when the content is missing', () => {
    expect(measureContentHeight(null, null, 448)).toBe(448)
  })
})

describe('createWidgetAutoHeight', () => {
  let originalResizeObserver: typeof ResizeObserver | undefined

  beforeEach(() => {
    originalResizeObserver = globalThis.ResizeObserver
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver
    } else {
      delete (globalThis as any).ResizeObserver
    }
    document.body.innerHTML = ''
  })

  function makeNode(currentHeight: number) {
    const node: any = {
      size: [500, currentHeight] as [number, number],
      computeSize: vi.fn(() => [500, currentHeight] as [number, number]),
      setSize: vi.fn(),
      setDirtyCanvas: vi.fn()
    }
    return node
  }

  it('grows the node when the content is taller than the current height', () => {
    const { container, host } = buildHost(800)
    const node = makeNode(448)
    node.computeSize = vi.fn(() => [500, 812])

    const controller = createWidgetAutoHeight({
      node,
      container,
      minHeight: 448,
      contentSelector: '.randomizer-settings'
    })

    expect(controller.getHeight()).toBe(448)
    const height = controller.sync()

    // 800px of content plus the host's 6px top/bottom padding.
    expect(height).toBe(812)
    expect(host.style.minHeight).toBe('812px')
    expect(node.setSize).toHaveBeenCalledWith([500, 812])
    expect(node.setDirtyCanvas).toHaveBeenCalledWith(true, true)
    controller.dispose()
  })

  it('never shrinks a node the user made larger', () => {
    const { container } = buildHost(300)
    const node = makeNode(900)

    const controller = createWidgetAutoHeight({
      node,
      container,
      minHeight: 448,
      contentSelector: '.randomizer-settings'
    })

    expect(controller.sync()).toBe(448)
    expect(node.setSize).not.toHaveBeenCalled()
    expect(node.setDirtyCanvas).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('stops observing after dispose', () => {
    const { container } = buildHost(800)
    const node = makeNode(448)
    const disconnect = vi.fn()
    globalThis.ResizeObserver = vi.fn(() => ({
      observe: vi.fn(),
      unobserve: vi.fn(),
      disconnect
    })) as unknown as typeof ResizeObserver

    const controller = createWidgetAutoHeight({
      node,
      container,
      minHeight: 448,
      contentSelector: '.randomizer-settings'
    })
    controller.dispose()

    expect(disconnect).toHaveBeenCalled()
    expect(controller.sync()).toBe(448)
    expect(node.setSize).not.toHaveBeenCalled()
  })
})
