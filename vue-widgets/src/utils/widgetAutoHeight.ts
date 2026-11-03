/**
 * Content-driven node height for DOM widgets.
 *
 * A DOM widget only receives the slice of the node that `computeLayoutSize`
 * allocates: whatever the node height grants is all the space the HTML gets,
 * and `overflow: hidden` silently clips the rest. Widgets whose body is a form
 * (the LoRA Randomizer settings, for example) can therefore render taller than
 * the node and lose their last rows — the Roll Mode buttons in #0000.
 *
 * This controller measures the widget's *content* element (not the host box,
 * which is stretched to the allocated height and would feed an endless
 * grow-loop back into the observer) and reports the measured height as the
 * widget's minimum layout height. When the content turns out taller than the
 * current node, the node is resized to fit, following the three-step sequence
 * documented in `docs/dom_widget_dev_guide.md` §4.4:
 *
 *   const newSize = node.computeSize()
 *   node.setSize(newSize)
 *   node.setDirtyCanvas(true, true)
 *
 * Growth is one-way: a node the user made larger is never snapped back, and
 * collapsed sections leave the node at its previous (still fitting) height
 * instead of shrinking under the pointer.
 */

export interface AutoHeightNode {
  size?: [number, number] | number[]
  computeSize?: () => [number, number] | number[]
  setSize?: (size: [number, number]) => void
  setDirtyCanvas?: (front: boolean, back: boolean) => void
}

export interface WidgetAutoHeightOptions {
  node: AutoHeightNode
  container: HTMLElement
  /** Height the widget must never report below (its design minimum). */
  minHeight: number
  /** Selector for the element whose height is the content height. */
  contentSelector: string
}

export interface WidgetAutoHeightController {
  /** Current height reported through `computeLayoutSize().minHeight`. */
  getHeight: () => number
  /** Re-measure and grow the node when the content no longer fits. */
  sync: () => number
  /** Stop observing. Safe to call more than once. */
  dispose: () => void
}

const HEIGHT_TOLERANCE = 1

function verticalPadding(element: HTMLElement): number {
  const view = element.ownerDocument?.defaultView
  if (!view || typeof view.getComputedStyle !== 'function') return 0
  const style = view.getComputedStyle(element)
  const top = Number.parseFloat(style.paddingTop) || 0
  const bottom = Number.parseFloat(style.paddingBottom) || 0
  return top + bottom
}

/**
 * Height needed to show `content` without clipping, including the host
 * element's vertical padding, and never less than `minHeight`.
 */
export function measureContentHeight(
  host: HTMLElement | null,
  content: HTMLElement | null,
  minHeight: number
): number {
  if (!content) return minHeight
  const contentHeight = Math.max(
    Math.ceil(content.scrollHeight || 0),
    Math.ceil(content.offsetHeight || 0)
  )
  return Math.max(minHeight, contentHeight + (host ? verticalPadding(host) : 0))
}

export function createWidgetAutoHeight(
  options: WidgetAutoHeightOptions
): WidgetAutoHeightController {
  const { node, container, minHeight, contentSelector } = options

  let height = minHeight
  let disposed = false
  let observer: ResizeObserver | null = null
  let frame = 0

  const resolveHost = (): HTMLElement | null =>
    (container.firstElementChild as HTMLElement | null) ?? null

  const resolveContent = (): HTMLElement | null => {
    const host = resolveHost()
    if (!host) return null
    return host.querySelector<HTMLElement>(contentSelector) ?? null
  }

  const applyNodeSize = (): void => {
    if (typeof node.computeSize !== 'function' || typeof node.setSize !== 'function') return
    const size = node.computeSize()
    if (!Array.isArray(size)) return
    const current = Array.isArray(node.size) ? node.size : []
    const width = Math.max(Number(size[0]) || 0, Number(current[0]) || 0)
    const targetHeight = Math.max(Number(size[1]) || 0, Number(current[1]) || 0)
    node.setSize([width, targetHeight])
    node.setDirtyCanvas?.(true, true)
  }

  const sync = (): number => {
    if (disposed) return height
    const host = resolveHost()
    const next = measureContentHeight(host, resolveContent(), minHeight)
    if (next <= height + HEIGHT_TOLERANCE) return height
    height = next
    // Let Vue/components that size themselves by the host box follow along.
    if (host) host.style.minHeight = `${height}px`
    applyNodeSize()
    return height
  }

  const schedule = (): void => {
    if (disposed) return
    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      sync()
      return
    }
    if (frame) return
    frame = window.requestAnimationFrame(() => {
      frame = 0
      sync()
    })
  }

  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(schedule)
    const host = resolveHost()
    if (host) observer.observe(host)
    const content = resolveContent()
    if (content && content !== host) observer.observe(content)
  }

  // Content is rendered by the Vue app mounted into `container` right after
  // this controller is created, so measure on the next frame.
  schedule()

  return {
    getHeight: () => height,
    sync,
    dispose: () => {
      disposed = true
      observer?.disconnect()
      observer = null
      if (frame && typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function') {
        window.cancelAnimationFrame(frame)
      }
      frame = 0
    }
  }
}
