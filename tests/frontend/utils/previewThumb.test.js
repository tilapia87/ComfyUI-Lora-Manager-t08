import { describe, expect, it } from 'vitest';

import {
  CARD_PREVIEW_SIZE,
  withCardThumbnail,
  withoutCardThumbnail,
} from '../../../static/js/utils/previewThumb.js';

describe('withCardThumbnail', () => {
  it('asks the preview endpoint for a downscaled copy', () => {
    expect(withCardThumbnail('/api/lm/previews?path=root1%2Fpreview%2Fa.png')).toBe(
      `/api/lm/previews?path=root1%2Fpreview%2Fa.png&size=${CARD_PREVIEW_SIZE}`
    );
  });

  it('keeps an existing cache-busting parameter', () => {
    expect(withCardThumbnail('/api/lm/previews?path=a.png&t=12')).toBe(
      `/api/lm/previews?path=a.png&t=12&size=${CARD_PREVIEW_SIZE}`
    );
  });

  it('is idempotent', () => {
    const once = withCardThumbnail('/api/lm/previews?path=a.png');
    expect(withCardThumbnail(once)).toBe(once);
  });

  it('leaves URLs that cannot be resized alone', () => {
    expect(withCardThumbnail('/loras_static/root1/preview/a.png')).toBe(
      '/loras_static/root1/preview/a.png'
    );
    expect(withCardThumbnail('/api/lm/previews?path=a.mp4')).toContain('.mp4');
    expect(withCardThumbnail('/api/lm/previews?path=a.mp4')).not.toContain('size=');
    expect(withCardThumbnail('/api/lm/previews?path=a.webm')).not.toContain('size=');
    expect(withCardThumbnail('/api/lm/previews?path=a.gif')).not.toContain('size=');
    expect(withCardThumbnail('')).toBe('');
    expect(withCardThumbnail(null)).toBe(null);
  });

  it('accepts a custom size', () => {
    expect(withCardThumbnail('/api/lm/previews?path=a.png', 256)).toContain('size=256');
  });
});

describe('withoutCardThumbnail', () => {
  it('strips the size parameter and keeps the rest', () => {
    expect(withoutCardThumbnail('/api/lm/previews?path=a.png&size=512')).toBe(
      '/api/lm/previews?path=a.png'
    );
    expect(withoutCardThumbnail('/api/lm/previews?path=a.png&t=12&size=512')).toBe(
      '/api/lm/previews?path=a.png&t=12'
    );
  });

  it('returns the URL untouched when there is nothing to strip', () => {
    expect(withoutCardThumbnail('/api/lm/previews?path=a.png')).toBe(
      '/api/lm/previews?path=a.png'
    );
    expect(withoutCardThumbnail('/loras_static/root1/preview/a.png')).toBe(
      '/loras_static/root1/preview/a.png'
    );
    expect(withoutCardThumbnail('')).toBe('');
  });
});
