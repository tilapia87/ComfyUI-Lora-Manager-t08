import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';

const {
  MODAL_MODULE,
  API_FACTORY,
  UI_HELPERS_MODULE,
  MODAL_MANAGER_MODULE,
  SHOWCASE_MODULE,
  MODEL_TAGS_MODULE,
  UTILS_MODULE,
  TRIGGER_WORDS_MODULE,
  PRESET_TAGS_MODULE,
  MODEL_VERSIONS_MODULE,
  RECIPE_TAB_MODULE,
} = vi.hoisted(() => ({
  MODAL_MODULE: new URL('../../../static/js/components/shared/ModelModal.js', import.meta.url).pathname,
  API_FACTORY: new URL('../../../static/js/api/modelApiFactory.js', import.meta.url).pathname,
  UI_HELPERS_MODULE: new URL('../../../static/js/utils/uiHelpers.js', import.meta.url).pathname,
  MODAL_MANAGER_MODULE: new URL('../../../static/js/managers/ModalManager.js', import.meta.url).pathname,
  SHOWCASE_MODULE: new URL('../../../static/js/components/shared/showcase/ShowcaseView.js', import.meta.url).pathname,
  MODEL_TAGS_MODULE: new URL('../../../static/js/components/shared/ModelTags.js', import.meta.url).pathname,
  UTILS_MODULE: new URL('../../../static/js/components/shared/utils.js', import.meta.url).pathname,
  TRIGGER_WORDS_MODULE: new URL('../../../static/js/components/shared/TriggerWords.js', import.meta.url).pathname,
  PRESET_TAGS_MODULE: new URL('../../../static/js/components/shared/PresetTags.js', import.meta.url).pathname,
  MODEL_VERSIONS_MODULE: new URL('../../../static/js/components/shared/ModelVersionsTab.js', import.meta.url).pathname,
  RECIPE_TAB_MODULE: new URL('../../../static/js/components/shared/RecipeTab.js', import.meta.url).pathname,
}));

vi.mock(UI_HELPERS_MODULE, () => ({
  showToast: vi.fn(),
  openCivitai: vi.fn(),
  copyToClipboard: vi.fn(),
}));

vi.mock(MODAL_MANAGER_MODULE, () => ({
  modalManager: {
    showModal: vi.fn((id, html) => {
      document.body.innerHTML = `<div id="${id}">${html}</div>`;
    }),
    closeModal: vi.fn(),
  },
}));

vi.mock(SHOWCASE_MODULE, () => ({
  scrollToTop: vi.fn(),
  loadExampleImages: vi.fn(),
}));

vi.mock(MODEL_TAGS_MODULE, () => ({
  setupTagEditMode: vi.fn(),
}));

vi.mock(UTILS_MODULE, async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    renderCompactTags: vi.fn(() => ''),
    setupTagTooltip: vi.fn(),
    formatFileSize: vi.fn(() => '1 MB'),
  };
});

vi.mock(TRIGGER_WORDS_MODULE, () => ({
  renderTriggerWords: vi.fn(() => ''),
  setupTriggerWordsEditMode: vi.fn(),
}));

vi.mock(PRESET_TAGS_MODULE, () => ({
  parsePresets: vi.fn(() => ({})),
  renderPresetTags: vi.fn(() => ''),
}));

vi.mock(MODEL_VERSIONS_MODULE, () => ({
  initVersionsTab: vi.fn(() => ({
    load: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Recipes are loaded eagerly when the modal opens; the gallery tab must not be.
vi.mock(RECIPE_TAB_MODULE, () => ({
  loadRecipesForModel: vi.fn(),
}));

vi.mock('../../../static/js/api/apiConfig.js', () => ({
  MODEL_TYPES: {
    LORA: 'loras',
    CHECKPOINT: 'checkpoints',
    EMBEDDING: 'embeddings',
  },
}));

vi.mock(API_FACTORY, () => ({
  getModelApiClient: vi.fn(),
}));

const LORA_HASH = 'a'.repeat(64);

const GALLERY_ITEM_LIKED = {
  image_path: 'C:\\ComfyUI\\output\\anima_00001_.png',
  file_name: 'anima_00001_.png',
  image_url: '/api/lm/gallery/image?path=one',
  mtime: 1760000000.0,
  rating: 1,
  artists: [],
  loras: [{ name: 'style_a.safetensors', weight: 0.8, exists_locally: true, hash: LORA_HASH }],
  parser: 'comfy',
  has_metadata: true,
};

const GALLERY_ITEM_UNRATED = {
  image_path: 'C:\\ComfyUI\\output\\anima_00002_.png',
  file_name: 'anima_00002_.png',
  image_url: '/api/lm/gallery/image?path=two',
  mtime: 1760000100.0,
  rating: 0,
  artists: [],
  loras: [{ name: 'style_a.safetensors', weight: 0.8, exists_locally: true, hash: LORA_HASH }],
  parser: 'comfy',
  has_metadata: true,
};

const FOR_LORA_PAYLOAD = {
  success: true,
  data: {
    items: [GALLERY_ITEM_LIKED, GALLERY_ITEM_UNRATED],
    total: 2,
    page: 1,
    page_size: 60,
    total_pages: 1,
    summary: { total: 2, liked: 1, disliked: 0, unrated: 1, net: 1 },
    lora: { name: 'style_a.safetensors', hash: LORA_HASH },
  },
};

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Bad Request',
    // Responses arrive as fresh JSON, never as a shared mutable object.
    json: async () => (body && typeof body === 'object' ? JSON.parse(JSON.stringify(body)) : body),
  };
}

/**
 * Route gallery requests through a fetch stub and record every URL.
 * @returns {{calls: string[], setForLoraRoute: Function}}
 */
function installFetchStub() {
  const calls = [];
  let forLoraRoute = FOR_LORA_PAYLOAD;

  globalThis.fetch = vi.fn(async (url) => {
    const requestUrl = String(url);
    calls.push(requestUrl);
    if (requestUrl.startsWith('/api/lm/gallery/for-lora')) {
      return typeof forLoraRoute === 'function' ? forLoraRoute(requestUrl) : jsonResponse(forLoraRoute);
    }
    return jsonResponse({ success: false, error: `unexpected ${requestUrl}` }, false, 500);
  });

  return {
    calls,
    setForLoraRoute(route) {
      forLoraRoute = route;
    },
  };
}

function makeModel(overrides = {}) {
  return {
    model_name: 'Style A',
    file_path: 'models/style_a.safetensors',
    file_name: 'style_a.safetensors',
    sha256: LORA_HASH,
    from_civitai: false,
    civitai: {},
    ...overrides,
  };
}

describe('Model modal gallery tab', () => {
  let fetchStub;
  let nativeFetch;

  const forLoraCalls = () => fetchStub.calls.filter((url) => url.startsWith('/api/lm/gallery/for-lora'));
  const galleryTabButton = () => document.querySelector('.showcase-tabs .tab-btn[data-tab="gallery"]');
  const galleryTabPane = () => document.getElementById('gallery-tab');
  const thumbs = () => document.querySelectorAll('.gallery-tab-thumb');

  beforeEach(async () => {
    vi.clearAllMocks();
    document.body.innerHTML = '';

    nativeFetch = globalThis.fetch;
    fetchStub = installFetchStub();

    // Key-echoing i18n double: assertions stay independent of the locale files.
    // The `#` keeps the echoed key distinct from the key itself, so
    // i18nHelpers.translate() does not fall back to the inline English text.
    window.i18n = {
      t: (key, params = {}) => `${key}#${Object.values(params || {}).join(',')}`,
    };

    const { getModelApiClient } = await import(API_FACTORY);
    getModelApiClient.mockReset();
    getModelApiClient.mockReturnValue({
      fetchModelMetadata: vi.fn().mockResolvedValue(null),
      saveModelMetadata: vi.fn(),
    });
  });

  afterEach(() => {
    delete window.i18n;
    document.querySelectorAll('.media-viewer-overlay').forEach((node) => node.remove());
    globalThis.fetch = nativeFetch;
  });

  async function renderModal(modelType = 'loras', model = makeModel()) {
    document.body.innerHTML = '';
    const { showModelModal } = await import(MODAL_MODULE);
    await showModelModal(model, modelType);
  }

  /** Open the tab and wait for the fetch it triggers. */
  async function openGalleryTab() {
    galleryTabButton().click();
    await vi.waitFor(() => expect(forLoraCalls().length).toBe(1));
  }

  it('offers the gallery tab for LoRAs and fetches nothing before it is opened', async () => {
    await renderModal('loras');

    expect(galleryTabButton()).not.toBeNull();
    expect(galleryTabPane()).not.toBeNull();
    // Lazy: opening the modal must not hit the gallery endpoints.
    expect(forLoraCalls().length).toBe(0);
  });

  it('keeps the gallery tab out of every other model type', async () => {
    await renderModal('checkpoints');
    expect(galleryTabButton()).toBeNull();
    expect(galleryTabPane()).toBeNull();

    await renderModal('embeddings');
    expect(galleryTabButton()).toBeNull();
    expect(galleryTabPane()).toBeNull();
  });

  it('loads the images on first open and renders the summary line', async () => {
    await renderModal('loras');
    await openGalleryTab();

    const query = new URL(forLoraCalls()[0], 'http://localhost').searchParams;
    // The hash is the preferred lookup key; the name is only a fallback.
    expect(query.get('hash')).toBe(LORA_HASH);
    expect(query.get('name')).toBeNull();

    await vi.waitFor(() => expect(thumbs().length).toBe(2));

    const first = thumbs()[0];
    expect(first.querySelector('img').getAttribute('src')).toBe(GALLERY_ITEM_LIKED.image_url);
    expect(first.querySelector('img').getAttribute('loading')).toBe('lazy');
    expect(first.getAttribute('title')).toBe('anima_00001_.png');

    expect(document.querySelector('.gallery-tab-summary').textContent).toBe(
      'gallery.loraTab.summary#2,1,0,1,1'
    );
  });

  it('falls back to the LoRA name when the model has no hash', async () => {
    await renderModal('loras', makeModel({ sha256: '' }));
    await openGalleryTab();

    const query = new URL(forLoraCalls()[0], 'http://localhost').searchParams;
    expect(query.get('hash')).toBeNull();
    expect(query.get('name')).toBe('style_a.safetensors');
  });

  it('loads the set only once, however often the tab is reopened', async () => {
    await renderModal('loras');
    await openGalleryTab();
    await vi.waitFor(() => expect(thumbs().length).toBe(2));

    galleryTabButton().click();
    galleryTabButton().click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(forLoraCalls().length).toBe(1);
  });

  it('opens the shared media viewer with the whole set for prev/next', async () => {
    await renderModal('loras');
    await openGalleryTab();
    await vi.waitFor(() => expect(thumbs().length).toBe(2));

    thumbs()[1].click();

    const overlay = document.querySelector('.media-viewer-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('.media-viewer-counter').textContent).toBe('2 / 2');
    expect(overlay.querySelector('.media-viewer-title').textContent).toBe('anima_00002_.png');
    expect(overlay.querySelector('.media-viewer-media').getAttribute('src')).toBe(
      GALLERY_ITEM_UNRATED.image_url
    );

    // Close through the same module instance the tab holds, so no key handler
    // is left behind for the next test.
    const { closeMediaViewer } = await import('../../../static/js/components/shared/MediaViewer.js');
    closeMediaViewer();
    expect(overlay.classList.contains('active')).toBe(false);
  });

  it('shows the empty state when no gallery image used the LoRA', async () => {
    fetchStub.setForLoraRoute({
      success: true,
      data: {
        items: [],
        total: 0,
        page: 1,
        page_size: 60,
        total_pages: 0,
        summary: { total: 0, liked: 0, disliked: 0, unrated: 0, net: 0 },
        lora: { name: 'style_a.safetensors', hash: LORA_HASH },
      },
    });

    await renderModal('loras');
    await openGalleryTab();

    await vi.waitFor(() => expect(galleryTabPane().querySelector('.recipes-empty')).not.toBeNull());
    expect(thumbs().length).toBe(0);
    expect(galleryTabPane().querySelector('.recipes-empty p').textContent).toBe('gallery.loraTab.empty#');
  });

  it('shows the failure state when the gallery request fails', async () => {
    fetchStub.setForLoraRoute(() => jsonResponse({ success: false, error: 'boom' }, false, 500));

    await renderModal('loras');
    await openGalleryTab();

    await vi.waitFor(() => expect(galleryTabPane().querySelector('.recipes-error')).not.toBeNull());
    expect(galleryTabPane().querySelector('.recipes-error p').textContent).toBe(
      'gallery.loraTab.loadFailed#'
    );
  });
});
