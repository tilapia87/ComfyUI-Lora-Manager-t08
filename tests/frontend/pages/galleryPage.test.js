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

const STATS_PAYLOAD = {
  by: 'artist',
  totals: { images: 12, rated: 8, liked: 6, disliked: 2 },
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
    '/api/lm/gallery/stats': { success: true, data: STATS_PAYLOAD },
    '/api/lm/gallery/rating': { success: true, data: { image_path: '', rating: 0 } },
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

const cardAt = (index) => document.querySelectorAll('.gallery-card')[index];

describe('GalleryPage', () => {
  let GalleryPage;
  let initializeGalleryPage;
  let fetchStub;
  let nativeFetch;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

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
  });

  afterEach(() => {
    delete window.galleryPage;
    delete window.i18n;
    document.querySelectorAll('.media-viewer-overlay').forEach((node) => node.remove());
    globalThis.fetch = nativeFetch;
    vi.useRealTimers();
  });

  const boot = async () => {
    const page = new GalleryPage();
    await page.initialize();
    return page;
  };

  it('renders the grid container and a card per returned image', async () => {
    await boot();

    expect(document.getElementById('galleryGrid')).not.toBeNull();
    expect(document.querySelectorAll('.gallery-card').length).toBe(2);

    const first = cardAt(0);
    expect(first.dataset.path).toBe(IMAGE_LIKED.image_path);
    expect(first.querySelector('.gallery-card-name').textContent).toBe('anima_00001_.png');
    expect(first.querySelector('.gallery-card-image').getAttribute('src')).toBe(IMAGE_LIKED.image_url);
    expect(first.querySelector('.gallery-card-image').getAttribute('loading')).toBe('lazy');
    // 832 x 1216 from the payload, not from the browser.
    expect(first.querySelector('.gallery-card-meta').textContent).toContain('832');
  });

  it('renders artist chips with the @ prefix and flags unknown artists', async () => {
    await boot();

    const knownChip = cardAt(0).querySelector('.gallery-chip-artist');
    expect(knownChip.textContent).toBe('@nnn yryr');
    expect(knownChip.dataset.artist).toBe('nnn yryr');
    expect(knownChip.classList.contains('is-unknown')).toBe(false);

    const unknownChip = cardAt(1).querySelector('.gallery-chip-artist');
    expect(unknownChip.textContent).toBe('@big chungus');
    expect(unknownChip.classList.contains('is-unknown')).toBe(true);
    expect(unknownChip.getAttribute('title')).toBeTruthy();

    const loraChip = cardAt(0).querySelector('.gallery-chip-lora');
    expect(loraChip.dataset.lora).toBe('some_style.safetensors');
    expect(loraChip.querySelector('.gallery-chip-weight').textContent).toBe('0.80');
  });

  it('shows the existing rating from the payload', async () => {
    await boot();

    expect(cardAt(0).querySelector('.gallery-rate-up').classList.contains('is-active')).toBe(true);
    expect(cardAt(1).querySelector('.gallery-rate-up').classList.contains('is-active')).toBe(false);
    expect(cardAt(1).querySelector('.gallery-rate-down').classList.contains('is-active')).toBe(false);
  });

  it('posts the rating with the image path when a rating button is clicked', async () => {
    await boot();

    cardAt(1).querySelector('.gallery-rate-up').click();

    await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(1));
    const call = ratingCalls(fetchStub.calls)[0];
    expect(call.url).toBe('/api/lm/gallery/rating');
    expect(call.options.method).toBe('POST');
    expect(JSON.parse(call.options.body)).toEqual({
      image_path: IMAGE_UNRATED.image_path,
      rating: 1,
    });
    // Optimistic update happens before the request resolves.
    expect(cardAt(1).querySelector('.gallery-rate-up').classList.contains('is-active')).toBe(true);
  });

  it('clears the rating when the active button is clicked again', async () => {
    await boot();

    cardAt(0).querySelector('.gallery-rate-up').click();

    await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(1));
    expect(JSON.parse(ratingCalls(fetchStub.calls)[0].options.body).rating).toBe(0);
    expect(cardAt(0).querySelector('.gallery-rate-up').classList.contains('is-active')).toBe(false);
    expect(cardAt(0).querySelector('.gallery-card-badge')).toBeNull();
  });

  it('rates a focused card with ArrowUp / ArrowDown and the u / d keys', async () => {
    await boot();

    const press = (index, key) => {
      cardAt(index).dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    };

    press(1, 'ArrowUp');
    await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(1));
    expect(JSON.parse(ratingCalls(fetchStub.calls)[0].options.body)).toEqual({
      image_path: IMAGE_UNRATED.image_path,
      rating: 1,
    });

    // "d" on a liked image dislikes it, and a second ArrowDown clears it again.
    press(1, 'd');
    await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(2));
    expect(JSON.parse(ratingCalls(fetchStub.calls)[1].options.body).rating).toBe(-1);

    press(1, 'ArrowDown');
    await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(3));
    expect(JSON.parse(ratingCalls(fetchStub.calls)[2].options.body).rating).toBe(0);
  });

  it('reverts the optimistic rating and toasts when the API rejects it', async () => {
    await boot();

    fetchStub.setRoute('/api/lm/gallery/rating', () =>
      jsonResponse({ success: false, error: 'read-only output folder' }, false, 400)
    );

    cardAt(1).querySelector('.gallery-rate-up').click();

    await vi.waitFor(() => expect(ratingCalls(fetchStub.calls).length).toBe(1));
    await vi.waitFor(() =>
      expect(cardAt(1).querySelector('.gallery-rate-up').classList.contains('is-active')).toBe(false)
    );
    expect(showToastMock).toHaveBeenCalledWith(
      'toast.gallery.ratingFailed',
      { message: 'read-only output folder' },
      'error'
    );
  });

  it('filters the grid by an artist chip and shows the active-filter banner', async () => {
    await boot();

    cardAt(1).querySelector('.gallery-chip-artist').click();

    await vi.waitFor(
      () => expect(document.getElementById('galleryFilterBanner').classList.contains('hidden')).toBe(false),
      { timeout: 2000 }
    );
    expect(imageCalls(fetchStub.calls)[1].url).toContain('artist=big+chungus');
    expect(document.getElementById('galleryFilterBannerText').textContent).toContain('big chungus');

    document.getElementById('galleryFilterClearBtn').click();
    await vi.waitFor(() => expect(imageCalls(fetchStub.calls).length).toBe(3));
    expect(imageCalls(fetchStub.calls)[2].url).not.toContain('artist=');
  });

  it('requests the selected sort order and rating filter', async () => {
    await boot();

    const sort = document.getElementById('gallerySortSelect');
    sort.value = 'rating_desc';
    sort.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(imageCalls(fetchStub.calls).length).toBe(2), { timeout: 2000 });
    expect(imageCalls(fetchStub.calls)[1].url).toContain('sort=rating_desc');

    const rating = document.getElementById('galleryRatingSelect');
    rating.value = 'liked';
    rating.dispatchEvent(new Event('change'));

    await vi.waitFor(() => expect(imageCalls(fetchStub.calls).length).toBe(3), { timeout: 2000 });
    expect(imageCalls(fetchStub.calls)[2].url).toContain('rating=liked');
  });

  it('renders the metadata filter select next to the rating select', async () => {
    await boot();

    const metadata = document.getElementById('galleryMetadataSelect');
    expect(metadata).not.toBeNull();
    expect(metadata.value).toBe('all');
    // The three states the backend understands: all | with | without.
    expect([...metadata.options].map((option) => option.value)).toEqual(['all', 'with', 'without']);

    const selects = [...document.querySelectorAll('#galleryImagesPanel .gallery-control select')].map(
      (node) => node.id
    );
    expect(selects).toEqual(['gallerySortSelect', 'galleryRatingSelect', 'galleryMetadataSelect']);
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

  it('renders the statistics table from the stats response', async () => {
    await boot();

    document.getElementById('galleryStatsTab').click();

    await vi.waitFor(() => expect(document.querySelectorAll('#galleryStatsBody tr').length).toBe(3));

    const rows = document.querySelectorAll('#galleryStatsBody tr');
    const cells = [...rows[0].querySelectorAll('td')].map((cell) => cell.textContent.trim());
    expect(cells[0]).toBe('1');
    expect(cells[1]).toBe('nnn yryr');
    expect(cells[2]).toBe('5');
    expect(cells[3]).toBe('1');
    expect(cells[4]).toBe('2');
    expect(cells[5]).toBe('8');
    expect(cells[6]).toBe('+4');
    expect(cells[7]).toBe('83%');

    // Net score colouring and the unknown-artist flag come from the payload.
    expect(rows[0].querySelector('.gallery-col-net').classList.contains('is-positive')).toBe(true);
    expect(rows[2].querySelector('.gallery-col-net').classList.contains('is-negative')).toBe(true);
    expect(rows[1].classList.contains('is-unknown')).toBe(true);

    // Summary row from `totals`.
    const summary = [...document.querySelectorAll('#galleryStatsSummary .gallery-stats-card-value')].map(
      (node) => node.textContent.trim()
    );
    expect(summary).toEqual(['12', '8', '6', '2']);

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
      like_ratio: null,
    });

    fetchStub.setRoute('/api/lm/gallery/stats', (url) => {
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset') || 0);
      return jsonResponse({
        success: true,
        data: {
          by: 'artist',
          totals: { images: 0, rated: 0, liked: 0, disliked: 0 },
          total: TOTAL_ROWS,
          offset,
          items: Array.from({ length: 100 }, (_, i) => statRow(offset + i + 1)),
        },
      });
    });

    await boot();

    document.getElementById('galleryStatsTab').click();
    await vi.waitFor(() => expect(document.querySelectorAll('#galleryStatsBody tr').length).toBe(100));

    const statsCalls = () => fetchStub.calls.filter((call) => call.url.startsWith('/api/lm/gallery/stats'));
    expect(statsCalls()[0].url).toContain('limit=100');
    expect(statsCalls()[0].url).toContain('offset=0');

    // The pager appears because the ranking spans three pages.
    const pagination = document.getElementById('galleryStatsPagination');
    expect(pagination.classList.contains('hidden')).toBe(false);
    expect(document.getElementById('galleryStatsPageInfo').textContent).toContain('1,3');
    expect(document.querySelector('#galleryStatsBody tr td').textContent.trim()).toBe('1');

    document.getElementById('galleryStatsNextPage').click();

    await vi.waitFor(() => expect(statsCalls().length).toBe(2));
    expect(statsCalls()[1].url).toContain('offset=100');

    // Ranks keep counting instead of restarting at 1 on every page.
    await vi.waitFor(() =>
      expect(document.querySelector('#galleryStatsBody tr td').textContent.trim()).toBe('101')
    );
  });

  it('filters the grid by an artist when a statistics row is clicked', async () => {
    await boot();

    document.getElementById('galleryStatsTab').click();
    await vi.waitFor(() => expect(document.querySelectorAll('#galleryStatsBody tr').length).toBe(3));

    document.querySelectorAll('#galleryStatsBody tr')[0].click();

    await vi.waitFor(() => expect(imageCalls(fetchStub.calls).length).toBe(2));
    expect(imageCalls(fetchStub.calls)[1].url).toContain('artist=nnn+yryr');
    expect(document.getElementById('galleryImagesPanel').classList.contains('hidden')).toBe(false);
    expect(document.getElementById('galleryStatsPanel').classList.contains('hidden')).toBe(true);
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
    const { closeMediaViewer } = await import('../../../static/js/components/shared/MediaViewer.js');
    closeMediaViewer();
    expect(document.querySelector('.media-viewer-overlay')).not.toBeNull();
    expect(overlay.classList.contains('active')).toBe(false);
  });

  it('boots through the exported initializer', async () => {
    const page = await initializeGalleryPage();

    expect(initializeAppMock).toHaveBeenCalledTimes(1);
    expect(page).toBeInstanceOf(GalleryPage);
    expect(window.galleryPage).toBe(page);
  });
});
