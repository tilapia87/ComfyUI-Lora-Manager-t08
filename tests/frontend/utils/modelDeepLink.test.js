import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const showToastMock = vi.fn();
const showModelModalMock = vi.fn();
const getCompleteApiConfigMock = vi.fn(() => ({ endpoints: { list: '/api/lm/loras/list' } }));

vi.mock('../../../static/js/utils/uiHelpers.js', () => ({
  showToast: showToastMock,
}));

vi.mock('../../../static/js/components/shared/ModelModal.js', () => ({
  showModelModal: showModelModalMock,
}));

vi.mock('../../../static/js/api/apiConfig.js', () => ({
  getCompleteApiConfig: getCompleteApiConfigMock,
}));

const LORA_HASH = 'd'.repeat(64);

const LORA_MODEL = {
  model_name: 'Deep Linked',
  file_name: 'deep_linked.safetensors',
  file_path: 'models/deep_linked.safetensors',
  sha256: LORA_HASH,
  civitai: {},
};

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Internal Server Error',
    json: async () => (body && typeof body === 'object' ? JSON.parse(JSON.stringify(body)) : body),
  };
}

/**
 * Answer the LoRA listing request and record every URL.
 * @param {Object|Function} route - Payload or url -> response producer.
 * @returns {string[]} Requested URLs.
 */
function installFetchStub(route) {
  const calls = [];
  globalThis.fetch = vi.fn(async (url) => {
    const requestUrl = String(url);
    calls.push(requestUrl);
    if (typeof route === 'function') return route(requestUrl);
    return jsonResponse(route);
  });
  return calls;
}

const LIST_HIT = { items: [LORA_MODEL], total: 1, page: 1, page_size: 1, total_pages: 1 };
const LIST_MISS = { items: [], total: 0, page: 1, page_size: 1, total_pages: 0 };

describe('LoRA page deep link', () => {
  let nativeFetch;
  let calls;

  beforeEach(async () => {
    vi.clearAllMocks();
    getCompleteApiConfigMock.mockReturnValue({ endpoints: { list: '/api/lm/loras/list' } });
    nativeFetch = globalThis.fetch;
    window.history.replaceState(null, '', '/loras');
  });

  afterEach(() => {
    globalThis.fetch = nativeFetch;
    delete window.LM_BASE_PATH;
    window.history.replaceState(null, '', '/');
  });

  it('builds the deep link behind the reverse-proxy base path', async () => {
    const { buildLoraPageUrl } = await import('../../../static/js/utils/modelDeepLink.js');

    expect(buildLoraPageUrl(LORA_HASH)).toBe(`/loras?model=${LORA_HASH}`);

    window.LM_BASE_PATH = '/comfyui';
    expect(buildLoraPageUrl(LORA_HASH)).toBe(`/comfyui/loras?model=${LORA_HASH}`);
    expect(buildLoraPageUrl('')).toBe('/comfyui/loras');
  });

  it('reads the requested hash case-insensitively and ignores other queries', async () => {
    const { readRequestedModelHash } = await import('../../../static/js/utils/modelDeepLink.js');

    expect(readRequestedModelHash(`?model=${LORA_HASH.toUpperCase()}`)).toBe(LORA_HASH);
    expect(readRequestedModelHash('?model=')).toBe('');
    expect(readRequestedModelHash('?foo=1')).toBe('');
    expect(readRequestedModelHash('')).toBe('');
  });

  it('drops only the model parameter from the URL', async () => {
    const { stripRequestedModelFromUrl } = await import('../../../static/js/utils/modelDeepLink.js');

    window.history.replaceState(null, '', `/loras?model=${LORA_HASH}&foo=1`);
    stripRequestedModelFromUrl();

    expect(window.location.pathname).toBe('/loras');
    expect(window.location.search).toBe('?foo=1');
  });

  it('does nothing when the page was opened without a deep link', async () => {
    calls = installFetchStub(LIST_HIT);
    const { openDeepLinkedModel } = await import('../../../static/js/utils/modelDeepLink.js');

    await expect(openDeepLinkedModel()).resolves.toBeNull();

    expect(calls.length).toBe(0);
    expect(showToastMock).not.toHaveBeenCalled();
    expect(showModelModalMock).not.toHaveBeenCalled();
  });

  it('opens the requested model modal and strips the parameter', async () => {
    calls = installFetchStub(LIST_HIT);
    window.history.replaceState(null, '', `/loras?model=${LORA_HASH}`);

    const { openDeepLinkedModel } = await import('../../../static/js/utils/modelDeepLink.js');
    await expect(openDeepLinkedModel()).resolves.toEqual(LORA_MODEL);

    // One by-hash lookup, then the modal.
    expect(calls.length).toBe(1);
    const query = new URL(calls[0], 'http://localhost').searchParams;
    expect(calls[0].startsWith('/api/lm/loras/list?')).toBe(true);
    expect(query.get('hash')).toBe(LORA_HASH);
    expect(query.get('page_size')).toBe('1');

    expect(showModelModalMock).toHaveBeenCalledTimes(1);
    expect(showModelModalMock).toHaveBeenCalledWith(LORA_MODEL, 'loras');
    // A refresh must not repeat the deep link.
    expect(window.location.search).toBe('');
  });

  it('reports an unknown hash, keeps the listing and strips the parameter', async () => {
    calls = installFetchStub(LIST_MISS);
    window.history.replaceState(null, '', `/loras?model=${LORA_HASH}`);

    const { openDeepLinkedModel } = await import('../../../static/js/utils/modelDeepLink.js');
    await expect(openDeepLinkedModel()).resolves.toBeNull();

    expect(showToastMock).toHaveBeenCalledWith(
      'toast.loras.deepLinkNotFound',
      {},
      'error',
      'That LoRA is not in the library, so the normal list is shown.'
    );
    expect(showModelModalMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });

  it('reports a failing lookup without throwing', async () => {
    calls = installFetchStub(() => jsonResponse({ error: 'boom' }, false, 500));
    window.history.replaceState(null, '', `/loras?model=${LORA_HASH}`);

    const { openDeepLinkedModel } = await import('../../../static/js/utils/modelDeepLink.js');
    await expect(openDeepLinkedModel()).resolves.toBeNull();

    expect(showToastMock).toHaveBeenCalledWith(
      'toast.loras.deepLinkFailed',
      { message: 'HTTP 500' },
      'error',
      'Could not open the linked LoRA: HTTP 500'
    );
    expect(showModelModalMock).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
  });
});
