import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  openMediaViewer,
  closeMediaViewer,
  isMediaViewerOpen,
} from '../../../static/js/components/shared/MediaViewer.js';

const ITEMS = [
  { url: '/api/lm/gallery/image?path=one', type: 'image' },
  { url: '/api/lm/gallery/image?path=two', type: 'image' },
  { url: '/api/lm/gallery/image?path=three', type: 'image' },
];

const overlay = () => document.querySelector('.media-viewer-overlay');
const contentContainer = () => overlay()?.querySelector('.media-viewer-content-container');
const footer = () => overlay()?.querySelector('.media-viewer-footer');
const counter = () => overlay()?.querySelector('.media-viewer-counter');
const press = (key) =>
  document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

describe('MediaViewer footer and onKey hooks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    closeMediaViewer();
    // Flush the deferred overlay removal so nothing outlives the test.
    vi.runAllTimers();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('renders the footer on open and again on every navigation', () => {
    const footerCalls = vi.fn((container, item, index) => {
      container.textContent = `footer-${index}`;
    });

    openMediaViewer(ITEMS, 0, { footer: footerCalls });

    expect(footer()).not.toBeNull();
    // The hook is told which item and index are on screen, not just that a
    // render happened.
    expect(footerCalls).toHaveBeenCalledTimes(1);
    expect(footerCalls.mock.calls[0][1]).toBe(ITEMS[0]);
    expect(footerCalls.mock.calls[0][2]).toBe(0);
    expect(footer().textContent).toBe('footer-0');

    // Next / previous both re-render it for the image that replaces the old
    // one, without reopening the viewer.
    overlay().querySelector('.media-viewer-next').click();

    expect(footerCalls).toHaveBeenCalledTimes(2);
    expect(footerCalls.mock.calls[1][1]).toBe(ITEMS[1]);
    expect(footerCalls.mock.calls[1][2]).toBe(1);
    expect(counter().textContent).toBe('2 / 3');
    expect(footer().textContent).toBe('footer-1');

    overlay().querySelector('.media-viewer-prev').click();

    expect(footerCalls).toHaveBeenCalledTimes(3);
    expect(footerCalls.mock.calls[2][2]).toBe(0);
    expect(footer().textContent).toBe('footer-0');
  });

  it('empties the footer container before each render', () => {
    const empties = [];
    openMediaViewer(ITEMS, 0, {
      footer: (container, item, index) => {
        // The viewer must clear the slot first, or a page hook that appends
        // would stack its controls on every navigation.
        empties.push(container.innerHTML);
        container.insertAdjacentHTML('beforeend', `<span class="page-marker">${index}</span>`);
      },
    });

    expect(empties).toEqual(['']);
    expect(footer().querySelectorAll('.page-marker').length).toBe(1);
    expect(footer().querySelector('.page-marker').textContent).toBe('0');

    // Keyboard navigation goes through the same drawFooter path.
    press('ArrowRight');

    expect(counter().textContent).toBe('2 / 3');
    expect(empties).toEqual(['', '']);
    // Nothing from the first render survived.
    expect(footer().querySelectorAll('.page-marker').length).toBe(1);
    expect(footer().querySelector('.page-marker').textContent).toBe('1');
  });

  it('adds the has-footer class only when a footer is rendered', () => {
    openMediaViewer(ITEMS, 0, { footer: (container) => { container.textContent = 'footer'; } });

    expect(contentContainer().classList.contains('has-footer')).toBe(true);

    closeMediaViewer();
    vi.runAllTimers();

    // The plain viewer keeps its original layout: no reserved footer slot.
    openMediaViewer(ITEMS, 0);

    expect(footer()).toBeNull();
    expect(contentContainer().classList.contains('has-footer')).toBe(false);
  });

  it('lets onKey suppress ArrowLeft/ArrowRight navigation when it returns true', () => {
    const onKey = vi.fn(() => true);
    openMediaViewer(ITEMS, 0, { onKey });

    const event = new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);

    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey.mock.calls[0][1]).toBe(0);
    expect(onKey.mock.calls[0][0].key).toBe('ArrowRight');
    // Returning true means "the page handled it": consumed, not navigated.
    expect(event.defaultPrevented).toBe(true);
    expect(counter().textContent).toBe('1 / 3');

    press('ArrowLeft');
    expect(counter().textContent).toBe('1 / 3');
    expect(onKey).toHaveBeenCalledTimes(2);
  });

  it('lets the viewer navigate when onKey returns false', () => {
    const onKey = vi.fn(() => false);
    openMediaViewer(ITEMS, 0, { onKey });

    press('ArrowRight');

    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey.mock.calls[0][1]).toBe(0);
    expect(counter().textContent).toBe('2 / 3');

    // The index handed to the hook follows the navigation.
    press('ArrowRight');

    expect(onKey).toHaveBeenCalledTimes(2);
    expect(onKey.mock.calls[1][1]).toBe(1);
    expect(counter().textContent).toBe('3 / 3');
  });

  it('still closes on Escape even with an onKey hook', () => {
    const onKey = vi.fn(() => true);
    openMediaViewer(ITEMS, 0, { onKey });

    // Escape wins over the page hook: the viewer must always be closable.
    press('Escape');

    expect(isMediaViewerOpen()).toBe(false);
    expect(onKey).not.toHaveBeenCalled();
    // The key handler is gone with the viewer, so a later press is a no-op.
    press('ArrowRight');
    expect(onKey).not.toHaveBeenCalled();
  });
});
