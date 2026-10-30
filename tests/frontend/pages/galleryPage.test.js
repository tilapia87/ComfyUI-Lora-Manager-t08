import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderGalleryPage } from '../utils/pageFixtures.js';

const initializeAppMock = vi.fn();
const showToastMock = vi.fn();

vi.mock('../../../static/js/core.js', () => ({
  appCore: {
    initialize: initializeAppMock,
  },
}));

// The gallery builds its own toolbar, so showToast is the only helper it needs
// from uiHelpers; mocking it keeps the suite free of the manager graph it pulls.
vi.mock('../../../static/js/utils/uiHelpers.js', () => ({
  showToast: showToastMock,
}));

const IMAGE_LIKED = {
  image_path: 'C:\\ComfyUI\\output\\anima_00001_.png',
  file_name: 'anima_00001_.png',
  image_url: '/api/lm/gallery/image?path=C%3A%5CComfyUI%5Coutput%5Canima_00001_.png',
  thumb_url: '/api/lm/gallery/thumbnail?path=C%3A%5CComfyUI%5Coutput%5Canima_00001_.png&size=512',
  mtime: 1760000000.0,
  size: 1234567,
  width: 832,
  height: 1216,
  rating: 1,
  prompt: 'masterpiece, best quality, 1girl, @nnn yryr, smile',
  negative_prompt: 'worst quality, low quality',
  artists: [{ name: 'nnn yryr', canonical: 'nnn yryr', known: true }],
  loras: [{ name: 'some_style.safetensors', weight: 0.8, exists_locally: true }],
  parser: 'comfy',
  has_metadata: true,
};

const IMAGE_UNRATED = {
  image_path: 'C:\\ComfyUI\\output\\anima_00002_.png',
  file_name: 'anima_00002_.png',
  image_url: '/api/lm/gallery/image?path=C%3A%5CComfyUI%5Coutput%5Canima_00002_.png',
  thumb_url: '/api/lm/gallery/thumbnail?path=C%3A%5CComfyUI%5Coutput%5Canima_00002_.png&size=512',
  mtime: 1760000100.0,
  size: 2345678,
  width: 832,
  height: 1216,
  rating: 0,
  prompt: 'masterpiece, @big chungus',
  negative_prompt: '',
  artists: [{ name: 'big chungus', canonical: 'big chungus', known: false }],
  loras: [],
  parser: 'comfy',
  has_metadata: true,
};

// A second unrated image, so the "voted out of the unrated facet" case still
// has a card left in the grid after one is rated.
const IMAGE_UNRATED_SECOND = {
  ...IMAGE_UNRATED,
  image_path: 'C:\\ComfyUI\\output\\anima_00003_.png',
  file_name: 'anima_00003_.png',
  image_url: '/api/lm/gallery/image?path=C%3A%5CComfyUI%5Coutput%5Canima_00003_.png',
  thumb_url: '/api/lm/gallery/thumbnail?path=C%3A%5CComfyUI%5Coutput%5Canima_00003_.png&size=512',
  mtime: 1760000200.0,
};

const GALLERY_CONFIG = {
  output_path: 'C:\\ComfyUI\\output',
  output_path_source: 'comfyui',
  root_exists: true,
  recursive: true,
  artist_list_path: '',
  artist_list_loaded: false,
  artist_count: 0,
  indexed_images: 2,
  last_run: 1760000000.0,
};

const IDLE_STATUS = {
  running: false,
  stage: 'idle',
  progress: 100,
  total: 2,
  indexed: 2,
  added: 0,
  updated: 0,
  removed: 0,
  failed: 0,
  root: 'C:\\ComfyUI\\output',
  root_source: 'comfyui',
  last_run: 1760000000.0,
  error: null,
};

// Whole-gallery distribution behind the sidebar facets. Every level has its own
// count, so the page can tell "+3" apart from a plain positive vote.
const SUMMARY_PAYLOAD = {
  images: 12,
  rated: 8,
  unrated: 4,
  liked: 7,
  disliked: 3,
  loved: 3,
  hated: 1,
  score: 9,
  net: 4,
  levels: { love: 3, like: 4, dislike: 2, hate: 1 },
  like_ratio: 0.875,
};

const STATS_PAYLOAD = {
  by: 'artist',
  totals: {
    images: 12,
    rated: 8,
    liked: 7,
    disliked: 3,
    loved: 3,
    hated: 1,
    net: 4,
    score: 9,
    levels: { love: 3, like: 4, dislike: 2, hate: 1 },
    like_ratio: 0.875,
  },
  items: [
    {
      key: 'nnn yryr',
      label: 'nnn yryr',
      known: true,
      likes: 5,
      dislikes: 1,
      unrated: 2,
      total: 8,
      net: 4,
      score: 6,
      levels: { love: 3, like: 2, dislike: 1, hate: 0 },
      like_ratio: 0.833,
    },
    {
      key: 'big chungus',
      label: 'big chungus',
      known: false,
      likes: 1,
      dislikes: 1,
      unrated: 0,
      total: 2,
      net: 0,
      score: 0,
      levels: { love: 0, like: 1, dislike: 1, hate: 0 },
      like_ratio: 0.5,
    },
    {
      key: 'sad artist',
      label: 'sad artist',
      known: true,
      likes: 0,
      dislikes: 3,
      unrated: 1,
      total: 4,
      net: -3,
      score: -5,
      levels: { love: 0, like: 0, dislike: 2, hate: 1 },
      like_ratio: 0,
    },
  ],
};

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    // Real responses arrive as fresh JSON, never as a shared object the page
    // could mutate across tests.
    json: async () => (body && typeof body === 'object' ? JSON.parse(JSON.stringify(body)) : body),
  };
}

/**
 * Install a fetch stub that answers every gallery endpoint.
 * @param {Object} [overrides] - Per-endpoint payload replacements.
 * @returns {{calls: Array, setRoute: Function}} Recorded calls and a route setter.
 */
function installFetchStub(overrides = {}) {
  const routes = {
    '/api/lm/gallery/index/status': { success: true, data: IDLE_STATUS },
    '/api/lm/gallery/config': { success: true, data: GALLERY_CONFIG },
    '/api/lm/gallery/images': {
      success: true,
      data: {
        items: [IMAGE_LIKED, IMAGE_UNRATED],
        total: 2,
        page: 1,
        page_size: 40,
        total_pages: 1,
      },
    },
    '/api/lm/gallery/summary': { success: true, data: SUMMARY_PAYLOAD },
    '/api/lm/gallery/stats': { success: true, data: STATS_PAYLOAD },
    '/api/lm/gallery/rating': { success: true, data: { image_path: '', rating: 0 } },
    // Artist thumbnails are decoration; the default answer is "no match".
    '/api/lm/gallery/artist-preview': {
      success: true,
      data: { artist: '', matched_name: '', thumb_url: '', page_url: '', count: 0 },
    },
    '/api/lm/gallery/thumbnail-cache': {
      success: true,
      data: { count: 12, bytes: 3 * 1024 * 1024, directory: 'C:\\tmp\\thumbs', size: 512 },
    },
    '/api/lm/gallery/thumbnail-cache/clear': { success: true, data: { removed: 12 } },
    '/api/lm/gallery/index': { success: true, data: { started: true } },
    ...overrides,
  };

  const calls = [];
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, options });

    // Longest prefix wins so "/index/status" is never shadowed by "/index".
    const match = Object.keys(routes)
      .sort((a, b) => b.length - a.length)
      .find((path) => requestUrl.startsWith(path));
    if (!match) return jsonResponse({ success: false, error: `unexpected ${requestUrl}` }, false, 500);

    const route = routes[match];
    if (typeof route === 'function') return route(requestUrl, options);
    return jsonResponse(route.body || route, route.ok !== false, route.status || 200);
  });

  return {
    calls,
    setRoute(path, value) {
      routes[path] = value;
    },
  };
}

const imageCalls = (calls) => calls.filter((call) => call.url.startsWith('/api/lm/gallery/images'));
const ratingCalls = (calls) => calls.filter((call) => call.url.startsWith('/api/lm/gallery/rating'));
const summaryCalls = (calls) => calls.filter((call) => call.url.startsWith('/api/lm/gallery/summary'));
const statsCalls = (calls) => calls.filter((call) => call.url.startsWith('/api/lm/gallery/stats'));

const cardAt = (index) => document.querySelectorAll('.gallery-card')[index];
const facet = (name) => document.querySelector(`#galleryRatingFacets [data-rating-filter="${name}"]`);
const facetCount = (name) => document.querySelector(`#galleryRatingFacets [data-facet-count="${name}"]`);
const rateButton = (cardIndex, rating) =>
  cardAt(cardIndex).querySelector(`.gallery-rate-btn[data-rating="${rating}"]`);
const parseRatingBody = (call) => JSON.parse(call.options.body);

describe('GalleryPage', () => {
  let GalleryPage;
  let initializeGalleryPage;
  let mediaViewer;
  let fetchStub;
  let nativeFetch;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    window.localStorage.clear();

    initializeAppMock.mockResolvedValue(undefined);
    nativeFetch = globalThis.fetch;
    fetchStub = installFetchStub();

    // Minimal i18n double: the page renders whatever translate() returns, so
    // echoing the key makes the assertions independent of the locale files.
    // Interpolation parameters are appended so filtered-by text stays visible.
    window.i18n = {
      t: (key, params = {}) => {
        const values = Object.values(params || {});
        return values.length ? `${key}|${values.join(',')}` : key;
      },
    };

    renderGalleryPage();

    ({ GalleryPage, initializeGalleryPage } = await import('../../../static/js/gallery.js'));
    // Same module instance the page holds, so the viewer key handler can be
    // removed between tests even when a test leaves the viewer open.
    mediaViewer = await import('../../../static/js/components/shared/MediaViewer.js');
  });

  afterEach(async () => {
    // A rating request can still be finishing its continuation when the test
    // body ends; let it schedule (and then clear) its debounced summary refresh
    // so the timer cannot leak into the next test.
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Drop debounced summary refreshes and scan polls before the DOM goes away.
    window.galleryPage?.destroy?.();
    mediaViewer?.closeMediaViewer?.();
    delete window.galleryPage;
    delete window.i18n;
    document.querySelectorAll('.media-viewer-overlay').forEach((node) => node.remove());
    globalThis.fetch = nativeFetch;
    vi.useRealTimers();
  });

  const boot = async () => {
    const page = new GalleryPage();
    await page.initialize();
    // Exposed so afterEach can clear the page's timers.
    window.galleryPage = page;
    return page;
  };

  it('lets the user pick the thumbnail size and remembers it', async () => {
    await boot();

    const page = document.getElementById('galleryPage');
    const grid = document.getElementById('galleryGrid');
    expect(page.dataset.density).toBe('comfortable');
    expect(grid.dataset.density).toBe('comfortable');

    document.querySelector('#galleryDensitySwitch [data-density="large"]').click();

    expect(page.dataset.density).toBe('large');
    expect(grid.dataset.density).toBe('large');
    expect(
      document.querySelector('#galleryDensitySwitch [data-density="large"]').classList.contains('active')
    ).toBe(true);
    expect(document.querySelector('#galleryDensitySwitch [data-density="comfortable"]').classList.contains('active')).toBe(false);
    expect(window.localStorage.getItem('gallery_card_density')).toBe('large');

    // Switching down also sticks, and a re-render keeps the choice.
    document.querySelector('#galleryDensitySwitch [data-density="compact"]').click();
    expect(page.dataset.density).toBe('compact');
  });

  it('restores the remembered thumbnail size on boot', async () => {
    window.localStorage.setItem('gallery_card_density', 'large');

    await boot();

    expect(document.getElementById('galleryPage').dataset.density).toBe('large');
    expect(
      document.querySelector('#galleryDensitySwitch [data-density="large"]').classList.contains('active')
    ).toBe(true);
  });

  it('renders the grid container and a card per returned image', async () => {
    await boot();

    expect(document.getElementById('galleryGrid')).not.toBeNull();
    expect(document.querySelectorAll('.gallery-card').length).toBe(2);

    const first = cardAt(0);
    expect(first.dataset.path).toBe(IMAGE_LIKED.image_path);
    expect(first.querySelector('.gallery-card-name').textContent).toBe('anima_00001_.png');
    expect(first.querySelector('.gallery-card-image').getAttribute('src')).toBe(IMAGE_LIKED.thumb_url);
    expect(first.querySelector('.gallery-card-image').getAttribute('loading')).toBe('lazy');
    // 832 x 1216 from the payload, not from the browser.
    expect(first.querySelector('.gallery-card-meta').textContent).toContain('832');
  });

  it('draws the thumbnail and settles the card once it loads', async () => {
    await boot();

    const media = cardAt(0).querySelector('.gallery-card-media');
    const image = cardAt(0).querySelector('.gallery-card-image');

    // The grid loads the downscaled thumbnail, not the multi-megabyte output.
    expect(image.getAttribute('src')).toBe(IMAGE_LIKED.thumb_url);
    expect(media.classList.contains('is-loading')).toBe(true);

    image.dispatchEvent(new Event('load'));

    expect(media.classList.contains('is-loading')).toBe(false);
    expect(media.classList.contains('is-loaded')).toBe(true);
  });

  it('renders the four rating buttons with the stored level active', async () => {
    await boot();

    const buttons = [...cardAt(0).querySelectorAll('.gallery-rate-btn')];
    expect(buttons.length).toBe(4);
    // The value is the label: with four levels a thumbs-up icon cannot say
    // whether the vote is +1 or +3.
    expect(buttons.map((button) => button.dataset.rating)).toEqual(['3', '1', '-1', '-3']);
    expect(buttons.map((button) => button.textContent.trim())).toEqual(['+3', '+1', '−1', '−3']);
    expect(buttons[0].classList.contains('gallery-rate-love')).toBe(true);
    expect(buttons[1].classList.contains('gallery-rate-like')).toBe(true);
    expect(buttons[2].classList.contains('gallery-rate-dislike')).toBe(true);
    expect(buttons[3].classList.contains('gallery-rate-hate')).toBe(true);

    // The payload says +1, so only that button is active.
    expect(buttons[1].classList.contains('is-active')).toBe(true);
    expect(buttons[1].getAttribute('aria-pressed')).toBe('true');
    expect(buttons[0].classList.contains('is-active')).toBe(false);
    expect(buttons[0].getAttribute('aria-label')).toBe('gallery.card.loveHint');
    expect(buttons[1].getAttribute('title')).toBe('gallery.card.likeHint');

    expect(cardAt(1).querySelectorAll('.gallery-rate-btn.is-active').length).toBe(0);
    expect(cardAt(0).querySelector('.gallery-card-badge').textContent).toBe('+1');
  });

  it('posts each of the four levels and clears the active one back to 0', async () => {
    await boot();

    const levels = ['3', '1', '-1', '-3'];
    for (const [index, level] of levels.entries()) {
      rateButton(1, level).click();

      await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(index + 1));
      expect(parseRatingBody(ratingCalls(fetchStub.calls)[index])).toEqual({
        image_path: IMAGE_UNRATED.image_path,
        rating: Number(level),
      });
      // Optimistic update happens before the request resolves.
      expect(rateButton(1, level).classList.contains('is-active')).toBe(true);
      expect(rateButton(1, level).getAttribute('aria-pressed')).toBe('true');
    }

    expect(cardAt(1).querySelector('.gallery-card-badge').textContent).toBe('−3');
    expect(cardAt(1).querySelector('.gallery-card-badge').classList.contains('is-hate')).toBe(true);

    // Clicking the active button again clears the rating.
    rateButton(1, '-3').click();

    await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(5));
    expect(parseRatingBody(ratingCalls(fetchStub.calls)[4]).rating).toBe(0);
    expect(cardAt(1).querySelectorAll('.gallery-rate-btn.is-active').length).toBe(0);
    expect(cardAt(1).querySelector('.gallery-card-badge')).toBeNull();
  });

  it('clears the rating of a previously voted card when its active button is clicked', async () => {
    await boot();

    rateButton(0, '1').click();

    await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(1));
    expect(parseRatingBody(ratingCalls(fetchStub.calls)[0])).toEqual({
      image_path: IMAGE_LIKED.image_path,
      rating: 0,
    });
    expect(rateButton(0, '1').classList.contains('is-active')).toBe(false);
    expect(cardAt(0).querySelector('.gallery-card-badge')).toBeNull();
  });

  it('rates a focused card with every keyboard shortcut', async () => {
    await boot();

    const press = (key, shiftKey = false) => {
      cardAt(1).dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
    };
    const expected = [
      ['ArrowUp', false, 1],
      ['ArrowUp', true, 3],
      ['u', false, 1],
      ['i', false, 3],
      ['ArrowDown', false, -1],
      ['ArrowDown', true, -3],
      ['d', false, -1],
      ['k', false, -3],
    ];

    for (const [index, [key, shiftKey, rating]] of expected.entries()) {
      press(key, shiftKey);
      await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(index + 1));
      expect(parseRatingBody(ratingCalls(fetchStub.calls)[index])).toEqual({
        image_path: IMAGE_UNRATED.image_path,
        rating,
      });
      expect(rateButton(1, String(rating)).classList.contains('is-active')).toBe(true);
    }
  });

  it('moves focus between cards with the arrow keys', async () => {
    await boot();

    cardAt(0).focus();
    cardAt(0).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.activeElement).toBe(cardAt(1));

    cardAt(1).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(document.activeElement).toBe(cardAt(0));

    // End/Home jump to the edges of the page.
    cardAt(0).dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(cardAt(1));
    cardAt(1).dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(cardAt(0));

    // Rating keys keep working after navigating.
    cardAt(0).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(1));
  });

  it('reverts the optimistic rating and toasts when the API rejects it', async () => {
    await boot();

    fetchStub.setRoute('/api/lm/gallery/rating', () =>
      jsonResponse({ success: false, error: 'read-only output folder' }, false, 400)
    );

    rateButton(1, '3').click();

    await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(1));
    await vi.waitFor(() => expect(rateButton(1, '3').classList.contains('is-active')).toBe(false));
    expect(cardAt(1).querySelector('.gallery-card-badge')).toBeNull();
    expect(showToastMock).toHaveBeenCalledWith(
      'toast.gallery.ratingFailed',
      { message: 'read-only output folder' },
      'error'
    );
  });

  it('fetches the whole-gallery summary on boot and paints the sidebar facets', async () => {
    await boot();

    expect(summaryCalls(fetchStub.calls).length).toBe(1);
    expect(summaryCalls(fetchStub.calls)[0].url).toBe('/api/lm/gallery/summary');

    expect(facetCount('all').textContent).toBe('12');
    expect(facetCount('love').textContent).toBe('3');
    expect(facetCount('like').textContent).toBe('4');
    expect(facetCount('dislike').textContent).toBe('2');
    expect(facetCount('hate').textContent).toBe('1');
    expect(facetCount('unrated').textContent).toBe('4');

    const score = document.getElementById('galleryRatingScore');
    expect(score.textContent).toBe('+9');
    expect(score.classList.contains('is-positive')).toBe(true);
    expect(score.classList.contains('is-negative')).toBe(false);

    // The distribution bar is one segment per level plus the unrated remainder.
    const bar = document.getElementById('galleryRatingDistribution');
    expect(bar.classList.contains('is-empty')).toBe(false);
    expect(
      [...bar.querySelectorAll('.gallery-level-seg')].map(
        (segment) => [...segment.classList].find((name) => name.startsWith('is-'))
      )
    ).toEqual(['is-love', 'is-like', 'is-dislike', 'is-hate', 'is-unrated']);
    expect(bar.getAttribute('title')).toBe('gallery.rating.distribution|3,4,2,1,4');

    // Sidebar footer: filtered result count and library-wide rating coverage.
    expect(document.getElementById('galleryRatedProgress').textContent).toBe(
      'gallery.rating.progress|8,12'
    );

    expect(facet('all').classList.contains('active')).toBe(true);
    expect(facet('all').getAttribute('aria-pressed')).toBe('true');
  });

  it('filters the grid from the sidebar facets and marks the active one', async () => {
    const page = await boot();

    const filters = ['loved', 'like', 'dislike', 'hate', 'unrated', 'all'];
    let callIndex = 1;
    for (const filter of filters) {
      facet(filter).click();

      await vi.waitFor(
        () => expect(imageCalls(fetchStub.calls).length).toBe(callIndex + 1),
        { timeout: 2000 }
      );
      expect(imageCalls(fetchStub.calls)[callIndex].url).toContain(`rating=${filter}`);
      expect(facet(filter).classList.contains('active')).toBe(true);
      expect(facet(filter).getAttribute('aria-pressed')).toBe('true');
      expect(
        filters
          .filter((name) => name !== filter)
          .every((name) => !facet(name).classList.contains('active'))
      ).toBe(true);
      callIndex += 1;
    }
    expect(page.ratingFilter).toBe('all');
  });

  it('clears the rating facet when the active chip is clicked again', async () => {
    const page = await boot();

    facet('loved').click();
    await vi.waitFor(() => expect(imageCalls(fetchStub.calls).length).toBe(2), { timeout: 2000 });
    expect(page.ratingFilter).toBe('loved');

    // The active chip is a toggle: a second click returns to the unfiltered grid.
    facet('loved').click();
    await vi.waitFor(() => expect(imageCalls(fetchStub.calls).length).toBe(3), { timeout: 2000 });
    expect(page.ratingFilter).toBe('all');
    expect(imageCalls(fetchStub.calls)[2].url).toContain('rating=all');
    expect(facet('all').classList.contains('active')).toBe(true);
  });

  it('refreshes the summary once after a rating, debounced', async () => {
    await boot();
    expect(summaryCalls(fetchStub.calls).length).toBe(1);

    rateButton(1, '3').click();

    await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(1));
    // The refresh is coalesced: it must not fire with the rating request.
    expect(summaryCalls(fetchStub.calls).length).toBe(1);

    await vi.waitFor(() => expect(summaryCalls(fetchStub.calls).length).toBe(2), { timeout: 2000 });
  });

  it('removes a card that no longer matches the active facet without reloading', async () => {
    fetchStub.setRoute('/api/lm/gallery/images', (url) => {
      const requested = new URL(url, 'http://localhost').searchParams.get('rating') || 'all';
      const items = requested === 'unrated'
        ? [IMAGE_UNRATED, IMAGE_UNRATED_SECOND]
        : [IMAGE_LIKED, IMAGE_UNRATED];
      return jsonResponse({
        success: true,
        data: { items, total: items.length, page: 1, page_size: 40, total_pages: 1 },
      });
    });

    const page = await boot();
    expect(document.querySelectorAll('.gallery-card').length).toBe(2);

    facet('unrated').click();
    await vi.waitFor(() => expect(imageCalls(fetchStub.calls).length).toBe(2), { timeout: 2000 });
    // Wait for the filtered response to paint, otherwise the click below would
    // land on the still-displayed boot cards.
    await vi.waitFor(() => {
      expect(document.querySelectorAll('.gallery-card').length).toBe(2);
      expect(cardAt(0).dataset.path).toBe(IMAGE_UNRATED.image_path);
    });
    expect(document.getElementById('galleryTotalCount').textContent).toBe('gallery.pagination.total|2');

    // Rating one of the two unrated images is the filter's whole point.
    rateButton(0, '3').click();

    await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(1));
    await vi.waitFor(() => expect(document.querySelectorAll('.gallery-card').length).toBe(1));

    expect(cardAt(0).dataset.path).toBe(IMAGE_UNRATED_SECOND.image_path);
    // The removed card is the first one, so the survivor keeps a valid index.
    expect(cardAt(0).dataset.index).toBe('0');
    expect(page.items.length).toBe(1);
    expect(page.totalItems).toBe(1);
    expect(document.getElementById('galleryTotalCount').textContent).toBe('gallery.pagination.total|1');

    // No reload: the page still only holds the boot request plus the facet one.
    expect(imageCalls(fetchStub.calls).length).toBe(2);
  });

  it('renders the metadata filter select next to the sort select', async () => {
    await boot();

    const metadata = document.getElementById('galleryMetadataSelect');
    expect(metadata).not.toBeNull();
    expect(metadata.value).toBe('all');
    // The three states the backend understands: all | with | without.
    expect([...metadata.options].map((option) => option.value)).toEqual(['all', 'with', 'without']);

    // The rating filter is now the six-chip facet group, not a select.
    expect(document.getElementById('galleryRatingSelect')).toBeNull();
    const selects = [...document.querySelectorAll('#gallerySidebar .gallery-control select')].map(
      (node) => node.id
    );
    expect(selects).toEqual(['gallerySortSelect', 'galleryMetadataSelect']);
  });

  it('requests the selected sort order for the grid', async () => {
    await boot();

    const sort = document.getElementById('gallerySortSelect');
    sort.value = 'rating_desc';
    sort.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(imageCalls(fetchStub.calls).length).toBe(2), { timeout: 2000 });
    expect(imageCalls(fetchStub.calls)[1].url).toContain('sort=rating_desc');
  });

  it('requests the selected metadata filter and resets to the first page', async () => {
    const page = await boot();

    // The unfiltered request still names the parameter, like the rating filter.
    expect(imageCalls(fetchStub.calls)[0].url).toContain('metadata=all');

    // Pretend the user paged forward: switching a filter must come back to page 1.
    page.page = 2;

    const metadata = document.getElementById('galleryMetadataSelect');
    metadata.value = 'with';
    metadata.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(imageCalls(fetchStub.calls).length).toBe(2), { timeout: 2000 });
    const query = new URL(imageCalls(fetchStub.calls)[1].url, 'http://localhost').searchParams;
    expect(query.get('metadata')).toBe('with');
    expect(query.get('page')).toBe('1');
    expect(page.metadataFilter).toBe('with');
  });

  it('treats the metadata filter as an active filter in the empty state', async () => {
    fetchStub.setRoute('/api/lm/gallery/images', {
      success: true,
      data: { items: [], total: 0, page: 1, page_size: 40, total_pages: 0 },
    });

    await boot();

    // Nothing indexed and no filter set: the plain "no images yet" state.
    expect(document.getElementById('galleryEmptyTitle').textContent).toBe('gallery.empty.noImagesTitle');

    const metadata = document.getElementById('galleryMetadataSelect');
    metadata.value = 'without';
    metadata.dispatchEvent(new Event('change'));

    await vi.waitFor(() =>
      expect(document.getElementById('galleryEmptyTitle').textContent).toBe('gallery.empty.noMatchesTitle')
    );
    expect(imageCalls(fetchStub.calls)[1].url).toContain('metadata=without');
  });

  it('renders the statistics summary and ranking from the four-level payload', async () => {
    await boot();

    document.getElementById('galleryStatsTab').click();

    await vi.waitFor(() => expect(document.querySelectorAll('#galleryStatsBody .gallery-rank-card').length).toBe(3));

    const rows = document.querySelectorAll('#galleryStatsBody .gallery-rank-card');
    const first = rows[0];

    // Summary cards: images / rated / the four levels / weighted score.
    const summaryValues = [...document.querySelectorAll('#galleryStatsSummary .gallery-stats-card-value')].map(
      (node) => node.textContent.trim()
    );
    expect(summaryValues).toEqual(['12', '8', '3', '4', '2', '1', '+9']);
    const summaryLabels = [...document.querySelectorAll('#galleryStatsSummary .gallery-stats-card-label')].map(
      (node) => node.textContent.trim()
    );
    expect(summaryLabels).toEqual([
      'gallery.stats.summary.images',
      'gallery.stats.summary.rated',
      'gallery.stats.summary.love',
      'gallery.stats.summary.like',
      'gallery.stats.summary.dislike',
      'gallery.stats.summary.hate',
      'gallery.stats.summary.score',
    ]);
    // The four levels reuse the sidebar's tone classes.
    const levelValues = [...document.querySelectorAll('#galleryStatsSummary .gallery-stats-card-value')].slice(2, 6);
    expect(levelValues.map((node) => [...node.classList].find((name) => name.startsWith('is-level-')))).toEqual([
      'is-level-love',
      'is-level-like',
      'is-level-dislike',
      'is-level-hate',
    ]);
    expect(
      document.querySelectorAll('#galleryStatsSummary .gallery-stats-card-value')[6].classList.contains('is-positive')
    ).toBe(true);

    // Preview, rank badge, label and the numbers each keep their own hook so
    // the ranking can be restyled without rewriting the assertions.
    expect(first.querySelector('.gallery-rank-media .gallery-stats-thumb.is-placeholder')).not.toBeNull();
    expect(first.querySelector('.gallery-rank-badge').textContent.trim()).toBe('1');
    expect(first.querySelector('.gallery-stat-label').textContent.trim()).toBe('nnn yryr');
    expect(first.querySelector('.gallery-stat-sub').textContent).toContain('8');

    // The four exact levels are each their own metric and sort control.
    const levelMetrics = [...first.querySelectorAll('.gallery-level-metric')];
    expect(levelMetrics.map((metric) => metric.dataset.sortMetric)).toEqual([
      'loved',
      'liked',
      'disliked',
      'hated',
    ]);
    expect(levelMetrics.map((metric) => metric.querySelector('.gallery-level-tag').textContent)).toEqual([
      '+3',
      '+1',
      '−1',
      '−3',
    ]);
    const levelCount = (metric) =>
      metric.textContent.replace(metric.querySelector('.gallery-level-tag').textContent, '').trim();
    expect(levelMetrics.map(levelCount)).toEqual(['3', '2', '1', '0']);
    expect(first.querySelector('.gallery-col-unrated').textContent.trim()).toBe('2');
    expect(first.querySelector('.gallery-col-score').textContent.trim()).toBe('+6');
    expect(first.querySelector('.gallery-col-score').dataset.sortMetric).toBe('score');
    // The score is the headline of the card, not one more small metric: it sits
    // in the header block with its own label, tinted by sign.
    const scoreBlock = first.querySelector('.gallery-rank-head .gallery-rank-score');
    expect(scoreBlock).not.toBeNull();
    expect(scoreBlock.classList.contains('is-positive')).toBe(true);
    expect(scoreBlock.querySelector('.gallery-rank-score-label').textContent).toBe(
      'gallery.stats.summary.score'
    );
    expect(first.querySelector('.gallery-rank-metrics .gallery-col-score')).toBeNull();
    expect(first.querySelector('.gallery-ratio-value').textContent.trim()).toBe('83%');
    expect(first.querySelectorAll('.gallery-level-bar .gallery-level-seg').length).toBe(3);

    // Net score colouring and the unknown-artist flag come from the payload.
    expect(rows[0].querySelector('.gallery-col-score').classList.contains('is-positive')).toBe(true);
    expect(rows[2].querySelector('.gallery-col-score').classList.contains('is-negative')).toBe(true);
    expect(rows[1].classList.contains('is-unknown')).toBe(true);

    // The images panel is hidden while statistics are shown.
    expect(document.getElementById('galleryImagesPanel').classList.contains('hidden')).toBe(true);
  });

  it('pages through a statistics ranking that is longer than one page', async () => {
    const TOTAL_ROWS = 250;
    const statRow = (rank) => ({
      key: `lora_${rank}`,
      label: `lora_${rank}`,
      known: false,
      likes: 0,
      dislikes: 0,
      unrated: 1,
      total: 1,
      net: 0,
      score: 0,
      levels: { love: 0, like: 0, dislike: 0, hate: 0 },
      like_ratio: null,
    });

    fetchStub.setRoute('/api/lm/gallery/stats', (url) => {
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset') || 0);
      return jsonResponse({
        success: true,
        data: {
          by: 'artist',
          totals: {
            images: 0,
            rated: 0,
            liked: 0,
            disliked: 0,
            levels: { love: 0, like: 0, dislike: 0, hate: 0 },
            score: 0,
          },
          total: TOTAL_ROWS,
          offset,
          items: Array.from({ length: 100 }, (_, i) => statRow(offset + i + 1)),
        },
      });
    });

    await boot();

    document.getElementById('galleryStatsTab').click();
    await vi.waitFor(() => expect(document.querySelectorAll('#galleryStatsBody .gallery-rank-card').length).toBe(100));

    expect(statsCalls(fetchStub.calls)[0].url).toContain('limit=100');
    expect(statsCalls(fetchStub.calls)[0].url).toContain('offset=0');

    // The pager appears because the ranking spans three pages.
    const pagination = document.getElementById('galleryStatsPagination');
    expect(pagination.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('galleryStatsPageInfo').textContent).toContain('1,3');
    expect(
      document.querySelector('#galleryStatsBody .gallery-rank-badge').textContent.trim()
    ).toBe('1');

    document.getElementById('galleryStatsNextPage').click();

    await vi.waitFor(() => expect(statsCalls(fetchStub.calls).length).toBe(2));
    expect(statsCalls(fetchStub.calls)[1].url).toContain('offset=100');

    // Ranks keep counting instead of restarting at 1 on every page.
    await vi.waitFor(() =>
      expect(
        document.querySelector('#galleryStatsBody .gallery-rank-badge').textContent.trim()
      ).toBe('101')
    );
  });

  it('shows a thumbnail per ranking row and prefers the model preview', async () => {
    fetchStub.setRoute('/api/lm/gallery/stats', {
      success: true,
      data: {
        by: 'lora',
        totals: {
          images: 2,
          rated: 2,
          liked: 2,
          disliked: 0,
          levels: { love: 2, like: 0, dislike: 0, hate: 0 },
          score: 6,
        },
        total: 2,
        offset: 0,
        items: [
          {
            key: 'style_a.safetensors',
            label: 'style_a.safetensors',
            known: true,
            hash: 'a'.repeat(64),
            likes: 2,
            dislikes: 0,
            unrated: 0,
            total: 2,
            net: 2,
            score: 6,
            levels: { love: 2, like: 0, dislike: 0, hate: 0 },
            like_ratio: 1,
            preview_url: '/api/lm/previews?path=root1%2Fpreview%2Fstyle_a.png',
            images: [{ image_path: 'C:\\out\\a.png', image_url: '/api/lm/gallery/image?path=a' }],
          },
          {
            key: 'style_b.safetensors',
            label: 'style_b.safetensors',
            known: true,
            hash: 'b'.repeat(64),
            likes: 0,
            dislikes: 0,
            unrated: 2,
            total: 2,
            net: 0,
            score: 0,
            levels: { love: 0, like: 0, dislike: 0, hate: 0 },
            like_ratio: null,
            preview_url: '',
            images: [{ image_path: 'C:\\out\\b.png', image_url: '/api/lm/gallery/image?path=b' }],
          },
        ],
      },
    });

    await boot();

    document.getElementById('galleryStatsTab').click();
    await vi.waitFor(() => expect(document.querySelectorAll('#galleryStatsBody .gallery-rank-card').length).toBe(2));

    const thumbs = () => document.querySelectorAll('#galleryStatsBody .gallery-stats-thumb');
    // The model's own preview wins, the gallery image is the documented fallback.
    expect(thumbs()[0].tagName).toBe('IMG');
    expect(thumbs()[0].getAttribute('src')).toContain('/api/lm/previews');
    expect(thumbs()[1].getAttribute('src')).toContain('/api/lm/gallery/image');
  });

  it('upgrades artist thumbnails with the animadex preview', async () => {
    fetchStub.setRoute('/api/lm/gallery/artist-preview', (url) => {
      const name = new URL(url, 'http://localhost').searchParams.get('name') || '';
      return jsonResponse({
        success: true,
        data: {
          artist: name,
          matched_name: name,
          thumb_url: `https://blobs.animadex.net/ArtistOutputs/thumbs/${encodeURIComponent(name)}.webp`,
          page_url: '',
          count: 12,
        },
      });
    });

    await boot();

    document.getElementById('galleryStatsTab').click();
    await vi.waitFor(() => expect(document.querySelectorAll('#galleryStatsBody .gallery-rank-card').length).toBe(3));

    const firstThumb = () =>
      document.querySelector('#galleryStatsBody .gallery-stats-thumb');
    await vi.waitFor(() =>
      expect(firstThumb().getAttribute('src')).toContain('blobs.animadex.net')
    );

    // One lookup per artist, not per render.
    const previewCalls = () =>
      fetchStub.calls.filter((call) => call.url.startsWith('/api/lm/gallery/artist-preview'));
    expect(previewCalls().length).toBe(3);
    expect(previewCalls()[0].url).toContain('name=nnn+yryr');
  });

  it('filters the grid by an artist when a statistics row is clicked', async () => {
    await boot();

    document.getElementById('galleryStatsTab').click();
    await vi.waitFor(() => expect(document.querySelectorAll('#galleryStatsBody .gallery-rank-card').length).toBe(3));

    document.querySelectorAll('#galleryStatsBody .gallery-rank-card')[0].click();

    await vi.waitFor(() => expect(imageCalls(fetchStub.calls).length).toBe(2));
    expect(imageCalls(fetchStub.calls)[1].url).toContain('artist=nnn+yryr');
    expect(document.getElementById('galleryImagesPanel').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('galleryStatsPanel').classList.contains('hidden')).toBe(true);
  });

  it('sorts the ranking from the sort pills', async () => {
    await boot();

    document.getElementById('galleryStatsTab').click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#galleryStatsBody .gallery-rank-card').length).toBe(3)
    );

    // The default ranking is the weighted score, not the old vote count.
    expect(statsCalls(fetchStub.calls)[0].url).toContain('sort=score');

    let callIndex = 1;
    for (const sort of ['loved', 'hated', 'total', 'ratio', 'score']) {
      document.querySelector(`#galleryStatsSortPills [data-sort="${sort}"]`).click();

      await vi.waitFor(() => expect(statsCalls(fetchStub.calls).length).toBe(callIndex + 1));
      expect(statsCalls(fetchStub.calls)[callIndex].url).toContain(`sort=${sort}`);
      expect(
        document.querySelector(`#galleryStatsSortPills [data-sort="${sort}"]`).classList.contains('active')
      ).toBe(true);
      callIndex += 1;
    }
  });

  it('ranks by an exact level when its metric is clicked', async () => {
    await boot();

    document.getElementById('galleryStatsTab').click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#galleryStatsBody .gallery-rank-card').length).toBe(3)
    );

    let callIndex = 1;
    for (const sort of ['loved', 'liked', 'disliked', 'hated']) {
      // Clicking a metric on a card is the sort control, not a grid filter.
      document.querySelector(`#galleryStatsBody .gallery-rank-card [data-sort-metric="${sort}"]`).click();

      await vi.waitFor(() => expect(statsCalls(fetchStub.calls).length).toBe(callIndex + 1));
      expect(statsCalls(fetchStub.calls)[callIndex].url).toContain(`sort=${sort}`);
      expect(imageCalls(fetchStub.calls).length).toBe(1);
      callIndex += 1;
    }
  });

  it('appends the next page instead of paging with buttons', async () => {
    fetchStub.setRoute('/api/lm/gallery/images', (url) => {
      const requested = Number(new URL(url, 'http://localhost').searchParams.get('page') || 1);
      const third = {
        ...IMAGE_UNRATED,
        image_path: 'C:\\ComfyUI\\output\\anima_00003_.png',
        file_name: 'anima_00003_.png',
        image_url: '/api/lm/gallery/image?path=third',
        thumb_url: '/api/lm/gallery/thumbnail?path=third&size=512',
      };
      const items = requested === 1 ? [IMAGE_LIKED, IMAGE_UNRATED] : [third];
      return jsonResponse({
        success: true,
        data: { items, total: 3, page: requested, page_size: 40, total_pages: 2 },
      });
    });

    await boot();

    expect(document.querySelectorAll('.gallery-card').length).toBe(2);
    // A pager is not used for the grid; the scroll/load-more block is.
    expect(document.getElementById('galleryPagination').classList.contains('hidden')).toBe(true);
    const loadMore = document.getElementById('galleryLoadMore');
    expect(loadMore.classList.contains('hidden')).toBe(false);

    document.getElementById('galleryLoadMoreBtn').click();

    await vi.waitFor(() => expect(document.querySelectorAll('.gallery-card').length).toBe(3));
    expect(cardAt(2).dataset.path).toContain('anima_00003_.png');
    expect(imageCalls(fetchStub.calls)[1].url).toContain('page=2');
    // Nothing left to load, so the block disappears.
    await vi.waitFor(() => expect(loadMore.classList.contains('hidden')).toBe(true));
  });

  it('reverses the listing and the ranking from one switch', async () => {
    await boot();

    const ascButton = document.querySelector('#galleryOrderSwitch [data-order="asc"]');
    ascButton.click();

    await vi.waitFor(() => expect(imageCalls(fetchStub.calls).length).toBe(2));
    expect(imageCalls(fetchStub.calls)[1].url).toContain('order=asc');
    expect(ascButton.classList.contains('active')).toBe(true);
    expect(window.localStorage.getItem('gallery_order')).toBe('asc');

    // The ranking honours the same switch.
    document.getElementById('galleryStatsTab').click();
    await vi.waitFor(() =>
      expect(document.querySelectorAll('#galleryStatsBody .gallery-rank-card').length).toBe(3)
    );
    const ascCalls = statsCalls(fetchStub.calls);
    expect(ascCalls[ascCalls.length - 1].url).toContain('order=asc');

    // Switching back restores the default ordering.
    document.querySelector('#galleryOrderSwitch [data-order="desc"]').click();
    await vi.waitFor(() => {
        const calls = statsCalls(fetchStub.calls);
        expect(calls[calls.length - 1].url).toContain('order=desc');
    });
  });

  it('shows how big the thumbnail cache is and clears it', async () => {
    await boot();

    document.getElementById('gallerySettingsToggle').click();

    const info = document.getElementById('galleryThumbnailCacheInfo');
    await vi.waitFor(() => expect(info.textContent).toContain('12'));
    expect(info.textContent).toContain('3.0 MB');

    document.getElementById('galleryThumbnailCacheClear').click();

    await vi.waitFor(() =>
      expect(
        fetchStub.calls.some((call) =>
          call.url.startsWith('/api/lm/gallery/thumbnail-cache/clear')
        )
      ).toBe(true)
    );
    await vi.waitFor(() => expect(info.textContent).toContain('12'));
  });

  it('shows the empty state with a scan action when nothing is indexed', async () => {
    fetchStub.setRoute('/api/lm/gallery/images', {
      success: true,
      data: { items: [], total: 0, page: 1, page_size: 40, total_pages: 0 },
    });
    fetchStub.setRoute('/api/lm/gallery/config', {
      success: true,
      data: { ...GALLERY_CONFIG, indexed_images: 0 },
    });

    await boot();

    expect(document.getElementById('galleryEmptyState').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('galleryEmptyScanBtn')).not.toBeNull();
    expect(document.getElementById('galleryEmptyTitle').textContent).toBe('gallery.empty.noImagesTitle');
  });

  it('explains an unset output folder and offers the path input', async () => {
    fetchStub.setRoute('/api/lm/gallery/images', {
      success: true,
      data: { items: [], total: 0, page: 1, page_size: 40, total_pages: 0 },
    });
    fetchStub.setRoute('/api/lm/gallery/config', {
      success: true,
      data: { ...GALLERY_CONFIG, output_path: '', output_path_source: 'unset', root_exists: false },
    });

    await boot();

    expect(document.getElementById('galleryEmptyTitle').textContent).toBe('gallery.empty.unsetTitle');

    document.getElementById('galleryEmptySettingsBtn').click();
    expect(document.getElementById('gallerySettingsPanel').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('galleryOutputPathInput')).not.toBeNull();
  });

  it('surfaces the index error text', async () => {
    fetchStub.setRoute('/api/lm/gallery/index/status', {
      success: true,
      data: { ...IDLE_STATUS, stage: 'error', error: 'output folder is unreadable' },
    });

    await boot();

    expect(document.getElementById('galleryProgressText').textContent).toContain(
      'output folder is unreadable'
    );
    expect(document.getElementById('galleryProgress').classList.contains('is-error')).toBe(true);
  });

  it('starts a scan and follows the progress endpoint until it finishes', async () => {
    let running = false;
    let statusCalls = 0;
    fetchStub.setRoute('/api/lm/gallery/index/status', () => {
      statusCalls += 1;
      // The first call is the boot-time check, which must stay idle.
      const runningNow = running;
      return jsonResponse({
        success: true,
        data: {
          ...IDLE_STATUS,
          running: runningNow,
          stage: runningNow ? 'parsing' : 'completed',
          progress: runningNow ? 40 : 100,
          indexed: runningNow ? 1 : 2,
          added: runningNow ? 0 : 2,
        },
      });
    });

    const page = await boot();
    expect(statusCalls).toBe(1);
    expect(page.scanTimer).toBeNull();
    expect(showToastMock).not.toHaveBeenCalled();

    running = true;
    document.getElementById('galleryScanBtn').click();

    await vi.waitFor(() =>
      expect(fetchStub.calls.some((call) => call.url.startsWith('/api/lm/gallery/index?'))).toBe(true)
    );
    await vi.waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith('toast.gallery.scanStarted', {}, 'info')
    );

    // The poll right after starting the scan paints the running progress.
    await vi.waitFor(() => expect(statusCalls).toBe(2));
    expect(document.getElementById('galleryProgress').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('galleryProgressText').textContent).toContain(
      'gallery.progress.stage.parsing'
    );

    // The periodic poll then observes the finished scan and stops.
    running = false;
    await vi.waitFor(
      () =>
        expect(showToastMock).toHaveBeenCalledWith(
          'toast.gallery.scanComplete',
          { added: 2, updated: 0, removed: 0 },
          'success'
        ),
      { timeout: 4000, interval: 100 }
    );
    expect(page.scanTimer).toBeNull();
  });

  it('opens the shared media viewer with the whole page for prev/next', async () => {
    await boot();

    cardAt(0).querySelector('.gallery-card-image').click();

    const overlay = document.querySelector('.media-viewer-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('.media-viewer-counter').textContent).toBe('1 / 2');
    expect(overlay.querySelector('.media-viewer-title').textContent).toBe('anima_00001_.png');
    expect(overlay.querySelector('.media-viewer-media').getAttribute('src')).toBe(IMAGE_LIKED.image_url);

    // Close through the same module instance the page holds.
    mediaViewer.closeMediaViewer();
    expect(document.querySelector('.media-viewer-overlay')).not.toBeNull();
    expect(overlay.classList.contains('active')).toBe(false);
  });

  it('rates the image on screen from the viewer footer', async () => {
    await boot();

    cardAt(0).querySelector('.gallery-card-image').click();

    const overlay = () => document.querySelector('.media-viewer-overlay');
    const footer = () => overlay().querySelector('.media-viewer-footer');
    const viewerValue = () => footer().querySelector('.gallery-viewer-rate-value');
    const viewerButton = (rating) => footer().querySelector(`.gallery-viewer-rate-btn[data-rating="${rating}"]`);

    // The footer is the page's own rating strip inside the shared viewer.
    expect(footer()).not.toBeNull();
    const buttons = [...footer().querySelectorAll('.gallery-viewer-rate-btn')];
    expect(buttons.length).toBe(4);
    expect(buttons.map((button) => button.dataset.rating)).toEqual(['3', '1', '-1', '-3']);
    expect(viewerButton('1').classList.contains('is-active')).toBe(true);
    expect(viewerValue().textContent).toBe('+1');

    viewerButton('3').click();

    await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(1));
    expect(parseRatingBody(ratingCalls(fetchStub.calls)[0])).toEqual({
      image_path: IMAGE_LIKED.image_path,
      rating: 3,
    });
    await vi.waitFor(() => expect(viewerButton('3').classList.contains('is-active')).toBe(true));
    expect(viewerButton('1').classList.contains('is-active')).toBe(false);
    expect(viewerValue().textContent).toBe('+3');

    // Navigation re-renders the footer for the image now on screen.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(overlay().querySelector('.media-viewer-counter').textContent).toBe('2 / 2');
    expect(viewerValue().textContent).toBe('gallery.rating.unrated');
    expect(footer().querySelectorAll('.gallery-viewer-rate-btn.is-active').length).toBe(0);

    // The rating keys vote on the second image without eating the navigation.
    const expected = [
      ['u', 1],
      ['i', 3],
      ['d', -1],
      ['k', -3],
    ];
    for (const [index, [key, rating]] of expected.entries()) {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));

      await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(index + 2));
      expect(parseRatingBody(ratingCalls(fetchStub.calls)[index + 1])).toEqual({
        image_path: IMAGE_UNRATED.image_path,
        rating,
      });
    }
    await vi.waitFor(() => expect(viewerButton('-3').classList.contains('is-active')).toBe(true));

    // Escape still closes the viewer (and only the viewer).
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(mediaViewer.isMediaViewerOpen()).toBe(false);
    expect(overlay().classList.contains('active')).toBe(false);

    // The key handler went with it: another rating key does nothing.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true }));
    expect(ratingCalls(fetchStub.calls).length).toBe(5);
  });

  it('boots through the exported initializer', async () => {
    const page = await initializeGalleryPage();

    expect(initializeAppMock).toHaveBeenCalledTimes(1);
    expect(page).toBeInstanceOf(GalleryPage);
    expect(window.galleryPage).toBe(page);
  });
});
