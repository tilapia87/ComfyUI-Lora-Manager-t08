// Card previews are drawn a few hundred pixels wide, but the preview endpoint
// serves the original file. Asking for a cached, downscaled copy keeps a large
// grid fast; modals and the showcase keep the untouched URL.

export const CARD_PREVIEW_SIZE = 512;

/**
 * Ask the preview endpoint for a downscaled copy of one image.
 *
 * Only `/api/lm/previews` understands `size`; static preview files under
 * `/loras_static/...` cannot be resized, and video previews must stay as they
 * are. The helper is idempotent so a re-render cannot stack parameters.
 * @param {string} url - Preview URL.
 * @param {number} [size] - Longest side in pixels.
 * @returns {string} URL to use on a card.
 */
export function withCardThumbnail(url, size = CARD_PREVIEW_SIZE) {
    if (typeof url !== 'string' || !url) return url;
    if (/\.(mp4|webm|gif)(\?|$)/i.test(url)) return url;
    if (!url.startsWith('/api/lm/previews')) return url;
    if (/([?&])size=/.test(url)) return url;
    return `${url}${url.includes('?') ? '&' : '?'}size=${size}`;
}

/**
 * Drop the `size` parameter again.
 * @param {string} url - Possibly downscaled preview URL.
 * @returns {string} URL of the original preview.
 */
export function withoutCardThumbnail(url) {
    if (typeof url !== 'string' || !url || !url.startsWith('/api/lm/previews')) return url;
    const [path, query = ''] = url.split('?');
    const params = new URLSearchParams(query);
    params.delete('size');
    const rest = params.toString();
    return rest ? `${path}?${rest}` : path;
}
