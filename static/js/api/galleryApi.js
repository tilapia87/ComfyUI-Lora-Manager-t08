// Gallery API client.
//
// Endpoints are root-absolute on purpose: a bootstrap shim (see
// templates/components/base_path_bootstrap.html) rewrites them when the app is
// served under a reverse-proxy sub-path, so no prefix may be hand-built here.
import { showToast } from '../utils/uiHelpers.js';

const GALLERY_ENDPOINTS = {
    images: '/api/lm/gallery/images',
    forLora: '/api/lm/gallery/for-lora',
    rating: '/api/lm/gallery/rating',
    stats: '/api/lm/gallery/stats',
    index: '/api/lm/gallery/index',
    indexStatus: '/api/lm/gallery/index/status',
    config: '/api/lm/gallery/config',
    image: '/api/lm/gallery/image',
};

// The backend caps page_size at 200; sending more is refused, not clamped.
export const GALLERY_MAX_PAGE_SIZE = 200;

/**
 * Build the URL that streams one image's raw bytes.
 * @param {string} imagePath - Absolute path of the image on the server.
 * @returns {string}
 */
export function buildGalleryImageUrl(imagePath) {
    if (!imagePath) return '';
    return `${GALLERY_ENDPOINTS.image}?path=${encodeURIComponent(imagePath)}`;
}

/**
 * Every gallery response is `{success, data}`; older/looser handlers may return
 * the payload unwrapped, so accept both shapes.
 * @param {Object} payload - Parsed JSON body.
 * @returns {Object}
 */
function unwrapPayload(payload) {
    if (payload && typeof payload === 'object' && payload.data !== undefined) {
        return payload.data;
    }
    return payload;
}

/**
 * Perform a JSON request and surface backend failures as thrown Errors.
 * @param {string} url - Root-absolute endpoint URL.
 * @param {RequestInit} [options] - fetch options.
 * @returns {Promise<Object>} The unwrapped `data` payload.
 */
async function requestJson(url, options = {}) {
    const response = await fetch(url, options);
    let payload = null;
    try {
        payload = await response.json();
    } catch (parseError) {
        payload = null;
    }

    if (!response.ok || (payload && payload.success === false)) {
        const message = (payload && payload.error) || response.statusText || `HTTP ${response.status}`;
        throw new Error(message);
    }

    return unwrapPayload(payload);
}

/**
 * Fetch one page of gallery images.
 * @param {Object} [params] - Query parameters.
 * @param {number} [params.page=1] - 1-based page number.
 * @param {number} [params.pageSize=40] - Items per page (max 200).
 * @param {string} [params.sort='newest'] - newest|oldest|rating_desc|rating_asc|name.
 * @param {string} [params.rating='all'] - all|liked|disliked|unrated.
 * @param {string} [params.metadata='all'] - all|with|without.
 * @param {string} [params.artist=''] - Exact artist name filter.
 * @param {string} [params.lora=''] - Exact LoRA name filter.
 * @param {string} [params.q=''] - Free-text substring filter.
 * @returns {Promise<{items: Array, totalItems: number, totalPages: number, currentPage: number, hasMore: boolean}>}
 */
export async function fetchGalleryImages(params = {}) {
    const {
        page = 1,
        pageSize = 40,
        sort = 'newest',
        rating = 'all',
        metadata = 'all',
        artist = '',
        lora = '',
        q = '',
    } = params;

    const query = new URLSearchParams({
        page: String(page),
        page_size: String(Math.min(Math.max(1, pageSize), GALLERY_MAX_PAGE_SIZE)),
        sort,
        rating,
        metadata,
    });

    if (artist) query.append('artist', artist);
    if (lora) query.append('lora', lora);
    if (q) query.append('q', q);

    try {
        const data = await requestJson(`${GALLERY_ENDPOINTS.images}?${query.toString()}`);
        const items = Array.isArray(data?.items) ? data.items : [];
        const totalPages = Number(data?.total_pages) || 0;
        return {
            items,
            totalItems: Number(data?.total) || 0,
            totalPages,
            currentPage: Number(data?.page) || page,
            hasMore: page < totalPages,
        };
    } catch (error) {
        console.error('Error fetching gallery images:', error);
        showToast('toast.gallery.fetchFailed', { message: error.message }, 'error');
        throw error;
    }
}

/**
 * Fetch the images that used one LoRA, together with their rating summary.
 *
 * `hash` is the preferred lookup key: a LoRA *name* can stand for more than one
 * local file, which the backend treats as unresolvable. `name` is the fallback
 * for a LoRA that is not in the local library at all — the backend answers with
 * an empty page rather than an error in both cases.
 * @param {Object} [params] - Query parameters.
 * @param {string} [params.hash=''] - Full sha256 of the LoRA.
 * @param {string} [params.name=''] - LoRA file name, used when no hash is known.
 * @param {number} [params.page=1] - 1-based page number.
 * @param {number} [params.pageSize=24] - Items per page (max 200).
 * @returns {Promise<{items: Array, total: number, totalPages: number, page: number, pageSize: number, summary: Object, lora: Object}>}
 */
export async function fetchGalleryImagesForLora(params = {}) {
    const { hash = '', name = '', page = 1, pageSize = 24 } = params;
    const safePage = Math.max(1, Number(page) || 1);
    const safePageSize = Math.min(Math.max(1, Number(pageSize) || 24), GALLERY_MAX_PAGE_SIZE);

    const query = new URLSearchParams({
        page: String(safePage),
        page_size: String(safePageSize),
    });
    if (hash) {
        query.append('hash', hash);
    } else if (name) {
        query.append('name', name);
    } else {
        // Nothing to look up: an unknown LoRA is an empty result, not an error.
        return emptyForLoraResult(safePage, safePageSize, { hash, name });
    }

    // No toast here: the LoRA modal's gallery tab renders its own failure state,
    // the same way the recipes tab does.
    const data = await requestJson(`${GALLERY_ENDPOINTS.forLora}?${query.toString()}`);
    const items = Array.isArray(data?.items) ? data.items : [];
    const totalPages = Number(data?.total_pages) || 0;
    return {
        items,
        total: Number(data?.total) || 0,
        totalPages,
        page: Number(data?.page) || safePage,
        pageSize: Number(data?.page_size) || safePageSize,
        summary: data?.summary || emptyForLoraSummary(),
        lora: data?.lora || { name, hash: hash || null },
    };
}

/**
 * The zero-value payload an unknown LoRA resolves to.
 * @param {number} page - Requested page.
 * @param {number} pageSize - Requested page size.
 * @param {{hash: string, name: string}} key - What was asked for.
 * @returns {Object}
 */
function emptyForLoraResult(page, pageSize, key) {
    return {
        items: [],
        total: 0,
        totalPages: 0,
        page,
        pageSize,
        summary: emptyForLoraSummary(),
        lora: { name: key.name || '', hash: key.hash || null },
    };
}

function emptyForLoraSummary() {
    return { total: 0, liked: 0, disliked: 0, unrated: 0, net: 0 };
}

/**
 * Persist a single image rating.
 * @param {string} imagePath - Absolute path of the image.
 * @param {number} rating - 1 (liked), -1 (disliked) or 0 (unrated).
 * @returns {Promise<{image_path: string, rating: number}>}
 */
export async function setGalleryImageRating(imagePath, rating) {
    try {
        const data = await requestJson(GALLERY_ENDPOINTS.rating, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image_path: imagePath, rating }),
        });
        return {
            image_path: data?.image_path || imagePath,
            rating: typeof data?.rating === 'number' ? data.rating : rating,
        };
    } catch (error) {
        console.error('Error saving gallery rating:', error);
        showToast('toast.gallery.ratingFailed', { message: error.message }, 'error');
        throw error;
    }
}

/**
 * Fetch the aggregated like/dislike statistics.
 * @param {Object} [params] - Query parameters.
 * @param {string} [params.by='artist'] - artist|lora.
 * @param {string} [params.sort='net'] - net|likes|dislikes|total|ratio.
 * @param {number} [params.limit=200] - Maximum number of rows.
 * @param {number} [params.minTotal=1] - Minimum rated+unrated total per row.
 * @returns {Promise<{by: string, totals: Object, items: Array}>}
 */
export async function fetchGalleryStats(params = {}) {
    const { by = 'artist', sort = 'net', limit = 200, minTotal = 1 } = params;

    const query = new URLSearchParams({
        by,
        sort,
        limit: String(limit),
        min_total: String(minTotal),
    });

    try {
        const data = await requestJson(`${GALLERY_ENDPOINTS.stats}?${query.toString()}`);
        return {
            by: data?.by || by,
            totals: data?.totals || { images: 0, rated: 0, liked: 0, disliked: 0 },
            items: Array.isArray(data?.items) ? data.items : [],
        };
    } catch (error) {
        console.error('Error fetching gallery statistics:', error);
        showToast('toast.gallery.statsFailed', { message: error.message }, 'error');
        throw error;
    }
}

/**
 * Start a background scan of the output directory.
 * @param {boolean} [force=false] - Re-parse images that are already indexed.
 * @returns {Promise<{started: boolean, reason?: string}>}
 */
export async function startGalleryIndex(force = false) {
    try {
        const data = await requestJson(`${GALLERY_ENDPOINTS.index}?force=${force ? 'true' : 'false'}`, {
            method: 'POST',
        });
        return {
            started: data?.started !== false,
            reason: data?.reason || null,
        };
    } catch (error) {
        console.error('Error starting gallery scan:', error);
        showToast('toast.gallery.scanFailed', { message: error.message }, 'error');
        throw error;
    }
}

/**
 * Read the current scan progress.
 * @returns {Promise<Object>} Index status payload.
 */
export async function fetchGalleryIndexStatus() {
    try {
        const data = await requestJson(GALLERY_ENDPOINTS.indexStatus);
        return data || {};
    } catch (error) {
        console.error('Error fetching gallery scan status:', error);
        throw error;
    }
}

/**
 * Read the resolved gallery configuration (output directory, artist list, ...).
 * @returns {Promise<Object>} Gallery config payload.
 */
export async function fetchGalleryConfig() {
    try {
        const data = await requestJson(GALLERY_ENDPOINTS.config);
        return data || {};
    } catch (error) {
        console.error('Error fetching gallery config:', error);
        showToast('toast.gallery.configFailed', { message: error.message }, 'error');
        throw error;
    }
}

export { GALLERY_ENDPOINTS };
