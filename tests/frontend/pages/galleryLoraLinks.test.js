import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderGalleryPage } from '../utils/pageFixtures.js';

const initializeAppMock = vi.fn();
const showToastMock = vi.fn();
const openModelInLoraPageMock = vi.fn();

vi.mock('../../../static/js/core.js', () => ({
  appCore: {
    initialize: initializeAppMock,
  },
}));

vi.mock('../../../static/js/utils/uiHelpers.js', () => ({
  showToast: showToastMock,
}));

// The jump only has to hand the right hash to the deep link helper; what that
// helper does with it is covered by tests/frontend/utils/modelDeepLink.test.js.
vi.mock('../../../static/js/utils/modelDeepLink.js', () => ({
  openModelInLoraPage: openModelInLoraPageMock,
}));

const LORA_HASH = 'a'.repeat(64);
const RESOLVED_HASH = 'c'.repeat(64);

const LINKABLE_LORA = {
  name: 'style_a.safetensors',
  weight: 0.8,
  exists_locally: true,
  hash: LORA_HASH,
};
// Not resolved to a local model: the gallery has nothing to open.
const UNRESOLVED_LORA = {
  name: 'mystery.safetensors',
  weight: 0.5,
  exists_locally: true,
  hash: null,
};
// A name that matched several local files is unresolvable by design, and a
// missing LoRA has no page either.
const AMBIGUOUS_LORA = {
  name: 'ambiguous.safetensors',
  weight: 0.3,
  exists_locally: true,
  hash: null,
};
const MISSING_LORA = {
  name: 'gone.safetensors',
  weight: 1,
  exists_locally: false,
  hash: 'b'.repeat(64),
};

const IMAGE_WITH_LORAS = {
  image_path: 'C:\\ComfyUI\\output\\anima_00001_.png',
  file_name: 'anima_00001_.png',
  image_url: '/api/lm/gallery/image?path=one',
  mtime: 1760000000.0,
  size: 1234567,
  width: 832,
  height: 1216,
  rating: 1,
  prompt: 'masterpiece, 1girl',
  negative_prompt: '',
  artists: [],
  loras: [LINKABLE_LORA, UNRESOLVED_LORA, AMBIGUOUS_LORA, MISSING_LORA],
  parser: 'comfy',
  has_metadata: true,
};

const GALLERY_CONFIG = {
  output_path: 'C:\\ComfyUI\\output',
  output_path_source: 'comfyui',
  root_exists: true,
  recursive: true,
  artist_list_path: '',
  artist_list_loaded: false,
  artist_count: 0,
  indexed_images: 1,
  last_run: 1760000000.0,
};

const IDLE_STATUS = {
  running: false,
  stage: 'idle',
  progress: 100,
  total: 1,
  indexed: 1,
  added: 0,
  updated: 0,
  removed: 0,
  failed: 0,
  root: 'C:\\ComfyUI\\output',
  root_source: 'comfyui',
  last_run: 1760000000.0,
  error: null,
};

const LORA_STATS_PAYLOAD = {
  by: 'lora',
  totals: { images: 6, rated: 4, liked: 3, disliked: 1 },
  items: [
    {
      key: 'style_a.safetensors',
      label: 'style_a.safetensors',
      known: true,
      likes: 3,
      dislikes: 1,
      unrated: 1,
      total: 5,
      net: 2,
      like_ratio: 0.75,
      // The row may already carry the resolved hash.
      hash: LORA_HASH,
    },
    {
      key: 'unknown.safetensors',
      label: 'unknown.safetensors',
      known: false,
      likes: 0,
      dislikes: 0,
      unrated: 2,
      total: 2,
      net: 0,
      like_ratio: null,
    },
    {
      key: 'style_c.safetensors',
      label: 'style_c.safetensors',
      known: true,
      likes: 0,
      dislikes: 0,
      unrated: 1,
      total: 1,
      net: 0,
      like_ratio: null,
    },
  ],
};

const FOR_LORA_RESOLUTION = {
  success: true,
  data: {
    items: [
      {
        ...IMAGE_WITH_LORAS,
        loras: [{ name: 'style_c.safetensors', weight: 1, exists_locally: true, hash: RESOLVED_HASH }],
      },
    ],
    total: 1,
    page: 1,
    page_size: 1,
    total_pages: 1,
    summary: { total: 1, liked: 0, disliked: 0, unrated: 1, net: 0 },
    lora: { name: 'style_c.safetensors', hash: RESOLVED_HASH },
  },
};

const FOR_LORA_EMPTY = {
  success: true,
  data: {
    items: [],
    total: 0,
    page: 1,
    page_size: 1,
    total_pages: 0,
    summary: { total: 0, liked: 0, disliked: 0, unrated: 0, net: 0 },
    lora: { name: 'style_c.safetensors', hash: null },
  },
};

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    json: async () => (body && typeof body === 'object' ? JSON.parse(JSON.stringify(body)) : body),
  };
}

/**
 * Install a fetch stub answering every gallery endpoint.
 * @param {Object} [overrides] - Per-endpoint payload replacements.
 * @returns {{calls: Array, setRoute: Function}}
 */
function installFetchStub(overrides = {}) {
  const routes = {
    '/api/lm/gallery/index/status': { success: true, data: IDLE_STATUS },
    '/api/lm/gallery/config': { success: true, data: GALLERY_CONFIG },
    '/api/lm/gallery/images': {
      success: true,
      data: {
        items: [IMAGE_WITH_LORAS],
        total: 1,
        page: 1,
        page_size: 40,
        total_pages: 1,
      },
    },
    '/api/lm/gallery/stats': { success: true, data: LORA_STATS_PAYLOAD },
    '/api/lm/gallery/for-lora': { success: true, data: FOR_LORA_RESOLUTION.data },
    '/api/lm/gallery/rating': { success: true, data: { image_path: '', rating: 0 } },
    '/api/lm/gallery/index': { success: true, data: { started: true } },
    ...overrides,
  };

  const calls = [];
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const requestUrl = String(url);
    calls.push({ url: requestUrl, options });

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
const forLoraCalls = (calls) => calls.filter((call) => call.url.startsWith('/api/lm/gallery/for-lora'));
const cardAt = (index) => document.querySelectorAll('.gallery-card')[index];
const statsRows = () => document.querySelectorAll('#galleryStatsBody tr');
const jumpButtons = (root = document) => root.querySelectorAll('.gallery-open-lora');

describe('Gallery to LoRA page links', () => {
  let GalleryPage;
  let fetchStub;
  let nativeFetch;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    initializeAppMock.mockResolvedValue(undefined);
    nativeFetch = globalThis.fetch;
    fetchStub = installFetchStub();

    // Key-echoing i18n double; the `#` keeps the echoed key distinct from the
    // key itself, so translate() does not fall back to the inline English text.
    window.i18n = {
      t: (key, params = {}) => `${key}#${Object.values(params || {}).join(',')}`,
    };

    renderGalleryPage();

    ({ GalleryPage } = await import('../../../static/js/gallery.js'));
  });

  afterEach(() => {
    delete window.galleryPage;
    delete window.i18n;
    globalThis.fetch = nativeFetch;
  });

  const boot = async () => {
    const page = new GalleryPage();
    await page.initialize();
    return page;
  };

  /** Open the statistics view in the LoRA grouping. */
  async function openLoraStats() {
    document.getElementById('galleryStatsTab').click();
    document.querySelector('#galleryStatsBySwitch [data-by="lora"]').click();
    await vi.waitFor(() => expect(statsRows().length).toBe(3));
    // Both in-flight renders group by LoRA, so the affordance on the first row
    // is what proves the table was painted for this grouping.
    await vi.waitFor(() => expect(jumpButtons(statsRows()[0]).length).toBe(1));
  }

  it('offers the LoRA page jump only for a LoRA the gallery resolved locally', async () => {
    await boot();

    const chips = cardAt(0).querySelectorAll('.gallery-chip-lora');
    expect(chips.length).toBe(4);

    const jumps = jumpButtons(cardAt(0));
    expect(jumps.length).toBe(1);
    expect(jumps[0].dataset.loraHash).toBe(LORA_HASH);
    expect(jumps[0].getAttribute('title')).toBe('gallery.actions.openInLoraPage#');
    expect(jumps[0].getAttribute('aria-label')).toBe('gallery.actions.openInLoraPage#');

    // The chip for the same LoRA still filters the grid.
    expect(chips[0].dataset.lora).toBe('style_a.safetensors');
    expect(chips[0].querySelector('.gallery-chip-weight').textContent).toBe('0.80');
  });

  it('does not filter the grid when the chip jump is clicked', async () => {
    await boot();
    expect(imageCalls(fetchStub.calls).length).toBe(1);

    jumpButtons(cardAt(0))[0].click();

    expect(openModelInLoraPageMock).toHaveBeenCalledTimes(1);
    expect(openModelInLoraPageMock).toHaveBeenCalledWith(LORA_HASH);
    // No reload: the chip filter is the other, separate action.
    expect(imageCalls(fetchStub.calls).length).toBe(1);
    expect(document.getElementById('galleryFilterBanner').classList.contains('hidden')).toBe(true);
  });

  it('still filters the grid when the chip itself is clicked', async () => {
    await boot();

    cardAt(0).querySelector('.gallery-chip-lora').click();

    await vi.waitFor(() => expect(imageCalls(fetchStub.calls).length).toBe(2));
    expect(imageCalls(fetchStub.calls)[1].url).toContain('lora=style_a.safetensors');
    expect(openModelInLoraPageMock).not.toHaveBeenCalled();
  });

  it('offers the jump on LoRA statistics rows only', async () => {
    await boot();
    await openLoraStats();

    // Row 0 is a resolved LoRA; row 1 is not in the library at all; row 2 is in
    // the library but the row carries no hash (resolved on click).
    expect(jumpButtons(statsRows()[0]).length).toBe(1);
    expect(jumpButtons(statsRows()[0])[0].dataset.loraHash).toBe(LORA_HASH);
    expect(jumpButtons(statsRows()[1]).length).toBe(0);
    expect(jumpButtons(statsRows()[2]).length).toBe(1);

    // The artist grouping has no models to open.
    document.querySelector('#galleryStatsBySwitch [data-by="artist"]').click();
    await vi.waitFor(() =>
      expect(jumpButtons(document.getElementById('galleryStatsBody')).length).toBe(0)
    );
    expect(statsRows().length).toBe(3);
  });

  it('opens the LoRA page from a statistics row without filtering the grid', async () => {
    const page = await boot();
    await openLoraStats();
    expect(imageCalls(fetchStub.calls).length).toBe(1);

    jumpButtons(statsRows()[0])[0].click();

    await vi.waitFor(() => expect(openModelInLoraPageMock).toHaveBeenCalledWith(LORA_HASH));
    expect(imageCalls(fetchStub.calls).length).toBe(1);
    expect(document.getElementById('galleryImagesPanel').classList.contains('hidden')).toBe(true);
    expect(page.view).toBe('stats');
  });

  it('resolves the hash of a statistics row that only knows the LoRA name', async () => {
    await boot();
    await openLoraStats();

    jumpButtons(statsRows()[2])[0].click();

    await vi.waitFor(() => expect(forLoraCalls(fetchStub.calls).length).toBe(1));
    expect(forLoraCalls(fetchStub.calls)[0].url).toContain('name=style_c.safetensors');
    await vi.waitFor(() => expect(openModelInLoraPageMock).toHaveBeenCalledWith(RESOLVED_HASH));
  });

  it('reports a statistics row whose LoRA cannot be resolved', async () => {
    fetchStub.setRoute('/api/lm/gallery/for-lora', { success: true, data: FOR_LORA_EMPTY.data });

    await boot();
    await openLoraStats();

    jumpButtons(statsRows()[2])[0].click();

    await vi.waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        'toast.gallery.loraLinkFailed',
        { name: 'style_c.safetensors' },
        'error'
      )
    );
    expect(openModelInLoraPageMock).not.toHaveBeenCalled();
  });
});
