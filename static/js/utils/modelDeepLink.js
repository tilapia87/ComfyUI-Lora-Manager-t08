/**
 * Deep link into a model's detail modal.
 *
 * The LoRA page accepts `/loras?model=<sha256>`: on load it resolves that hash
 * against the LoRA listing (`GET /api/lm/loras/list?hash=...`, the by-hash
 * lookup the backend already exposes) and opens the model modal. A hash that
 * resolves to nothing leaves the normal listing alone and says so.
 *
 * Only `basePath.js` is imported statically: this module is pulled in by the
 * page entry point (`loras.js`), and the model/modal/API modules it needs at
 * run time are heavy and only required once a `?model=` parameter is present.
 */
import { withBasePath } from './basePath.js';

export const MODEL_QUERY_PARAM = 'model';
export const LORA_PAGE_PATH = '/loras';

/**
 * Build the LoRA page URL that opens one model.
 * @param {string} hash - Full sha256 of the model.
 * @returns {string} Base-path aware URL.
 */
export function buildLoraPageUrl(hash) {
    if (!hash) return withBasePath(LORA_PAGE_PATH);
    return `${withBasePath(LORA_PAGE_PATH)}?${MODEL_QUERY_PARAM}=${encodeURIComponent(hash)}`;
}

/**
 * Navigate to the LoRA page with one model's modal open.
 * @param {string} hash - Full sha256 of the model.
 */
export function openModelInLoraPage(hash) {
    if (!hash) return;
    window.location.href = buildLoraPageUrl(hash);
}

/**
 * Read the requested model hash out of a query string.
 * @param {string} [search] - Query string (defaults to the current URL).
 * @returns {string} Normalized sha256, or '' when the parameter is absent.
 */
export function readRequestedModelHash(search) {
    const source = typeof search === 'string' ? search : window.location?.search || '';
    if (!source) return '';

    let params;
    try {
        params = new URLSearchParams(source.startsWith('?') ? source : `?${source}`);
    } catch (error) {
        console.warn('Unable to parse the deep link query string:', error);
        return '';
    }

    const value = params.get(MODEL_QUERY_PARAM);
    return value ? value.trim().toLowerCase() : '';
}

/**
 * Drop the `?model=` parameter from the address bar.
 *
 * Called before the lookup so a failed deep link does not fire again on
 * refresh, and so a successful one leaves a clean, shareable URL.
 */
export function stripRequestedModelFromUrl() {
    const { pathname, search, hash } = window.location;
    const params = new URLSearchParams(search || '');
    if (!params.has(MODEL_QUERY_PARAM)) return;

    params.delete(MODEL_QUERY_PARAM);
    const remaining = params.toString();
    window.history.replaceState(null, '', `${pathname}${remaining ? `?${remaining}` : ''}${hash || ''}`);
}

/**
 * Open the model a `?model=<sha256>` deep link asked for.
 *
 * Never throws: a failure is reported with a toast and the caller's page keeps
 * its normal listing.
 * @param {Object} [options]
 * @param {string} [options.search] - Query string to read (defaults to the URL).
 * @returns {Promise<Object|null>} The opened model, or null.
 */
export async function openDeepLinkedModel({ search } = {}) {
    const hash = readRequestedModelHash(search);
    if (!hash) return null;

    // Strip first: the failure path must not repeat on refresh.
    stripRequestedModelFromUrl();

    try {
        const model = await fetchModelByHash(hash);
        if (!model) {
            await toast(
                'toast.loras.deepLinkNotFound',
                {},
                'That LoRA is not in the library, so the normal list is shown.'
            );
            return null;
        }

        const { showModelModal } = await import('../components/shared/ModelModal.js');
        await showModelModal(model, 'loras');
        return model;
    } catch (error) {
        console.error('Error opening the deep-linked LoRA:', error);
        await toast(
            'toast.loras.deepLinkFailed',
            { message: error.message },
            `Could not open the linked LoRA: ${error.message}`
        );
        return null;
    }
}

/**
 * Report a deep link failure without ever throwing: a broken page is a far
 * worse outcome than a missing toast.
 * @param {string} key - i18n key.
 * @param {Object} params - Interpolation parameters.
 * @param {string} fallback - English fallback text.
 */
async function toast(key, params, fallback) {
    try {
        const { showToast } = await import('./uiHelpers.js');
        showToast(key, params, 'error', fallback);
    } catch (error) {
        console.error('Unable to show the deep link message:', error);
    }
}

/**
 * Fetch one LoRA by its sha256.
 * @param {string} hash - Full sha256 of the model.
 * @returns {Promise<Object|null>} The model record, or null when nothing matched.
 */
async function fetchModelByHash(hash) {
    const { getCompleteApiConfig } = await import('../api/apiConfig.js');
    const endpoint = getCompleteApiConfig('loras').endpoints.list;
    const query = new URLSearchParams({ page: '1', page_size: '1', hash });

    const response = await fetch(`${endpoint}?${query.toString()}`);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    const items = Array.isArray(data?.items) ? data.items : [];
    return items[0] || null;
}
