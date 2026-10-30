/**
 * GalleryTab - Handles the gallery tab in model modals.
 *
 * Modelled on RecipeTab: the tab renders a loading state, then either the
 * loaded content or an inline error state, and it never toasts on failure.
 *
 * Unlike recipes (which the modal loads on open), this tab is filled the first
 * time the user actually opens it: ModelModal calls `loadGalleryForModel` from
 * `setupTabSwitching`'s onTabChange hook. The guard below makes repeat visits
 * to the same tab free.
 *
 * The gallery only indexes LoRAs, so ModelModal offers the tab for LoRAs only.
 */
import { openMediaViewer } from './MediaViewer.js';
import { translate } from '../../utils/i18nHelpers.js';
import { fetchGalleryImagesForLora } from '../../api/galleryApi.js';

// A quick look at what the LoRA produced, not a replacement for the gallery
// page: one page of thumbnails, no pagination.
const TAB_PAGE_SIZE = 60;

/**
 * Loads the gallery images that used the specified model and renders them in
 * the tab.
 * @param {Object} options
 * @param {string} options.loraName - The file name of the LoRA
 * @param {string} options.sha256 - The SHA256 hash of the LoRA
 */
export function loadGalleryForModel({ loraName = '', sha256 = '' } = {}) {
    const galleryTab = document.getElementById('gallery-tab');
    if (!galleryTab) return;

    const normalizedHash = typeof sha256 === 'string' ? sha256.trim().toLowerCase() : '';
    // A hash resolves one model even when several files share a name; the name
    // is only the fallback the backend accepts for an unresolvable LoRA.
    const lookupKey = normalizedHash ? `hash:${normalizedHash}` : `name:${loraName}`;

    // Loading happens once per rendered tab pane: the pane element is recreated
    // every time the modal is (re)opened, so the guard never spans two models.
    if (
        galleryTab.dataset.galleryLoaded === lookupKey ||
        galleryTab.dataset.galleryLoading === lookupKey
    ) {
        return;
    }
    galleryTab.dataset.galleryLoading = lookupKey;

    galleryTab.innerHTML = `
        <div class="recipes-loading">
            <i class="fas fa-spinner fa-spin"></i> ${translate('gallery.status.loading', {}, 'Loading images...')}
        </div>
    `;

    fetchGalleryImagesForLora({ hash: normalizedHash, name: loraName, pageSize: TAB_PAGE_SIZE })
        .then((result) => {
            if (!isCurrentPane(galleryTab, lookupKey)) return;
            galleryTab.dataset.galleryLoaded = lookupKey;
            renderGallery(galleryTab, result);
        })
        .catch((error) => {
            console.error('Error loading gallery images for LoRA:', error);
            if (!isCurrentPane(galleryTab, lookupKey)) return;
            renderError(galleryTab);
        })
        .finally(() => {
            if (galleryTab.dataset.galleryLoading === lookupKey) {
                delete galleryTab.dataset.galleryLoading;
            }
        });
}

/**
 * Whether the pane this request started for is still the rendered one.
 * A modal reopened on another model replaces the element, and the stale
 * response must not paint into the detached pane.
 * @param {HTMLElement} pane - The pane the request started from
 * @param {string} lookupKey - The model this request was issued for
 * @returns {boolean}
 */
function isCurrentPane(pane, lookupKey) {
    return (
        document.getElementById('gallery-tab') === pane &&
        pane.dataset.galleryLoading === lookupKey
    );
}

/**
 * Renders the summary line and the thumbnail grid.
 * @param {HTMLElement} tabElement - The tab element to render into
 * @param {Object} result - Payload from fetchGalleryImagesForLora
 */
function renderGallery(tabElement, result) {
    const items = Array.isArray(result?.items) ? result.items : [];

    if (!items.length) {
        tabElement.replaceChildren(createStateBlock('recipes-empty', 'fa-images',
            translate('gallery.loraTab.empty', {}, 'No gallery images use this LoRA yet.')));
        return;
    }

    const headerElement = document.createElement('div');
    headerElement.className = 'recipes-header';

    const headerText = document.createElement('div');
    headerText.className = 'recipes-header__text';

    const eyebrow = document.createElement('span');
    eyebrow.className = 'recipes-header__eyebrow';
    eyebrow.textContent = translate('gallery.loraTab.title', {}, 'Gallery');
    headerText.appendChild(eyebrow);

    const summary = document.createElement('p');
    summary.className = 'recipes-header__description gallery-tab-summary';
    const counts = result?.summary || {};
    // Exact four-level counts; an older payload only carries the two sides, so
    // split the mild levels out of them instead of repeating a side count.
    const levels = counts.levels || {
        love: Number(counts.loved) || 0,
        like: Math.max(0, (Number(counts.liked) || 0) - (Number(counts.loved) || 0)),
        dislike: Math.max(0, (Number(counts.disliked) || 0) - (Number(counts.hated) || 0)),
        hate: Number(counts.hated) || 0,
    };
    summary.textContent = translate(
        'gallery.loraTab.summary',
        {
            total: Number(counts.total) || items.length,
            loved: Number(levels.love) || 0,
            like: Number(levels.like) || 0,
            dislike: Number(levels.dislike) || 0,
            hated: Number(levels.hate) || 0,
            unrated: Number(counts.unrated) || 0,
        },
        ''
    );
    headerText.appendChild(summary);
    headerElement.appendChild(headerText);

    const grid = document.createElement('div');
    grid.className = 'gallery-strip gallery-tab-grid';
    // `.gallery-strip` is the modal's horizontal thumbnail strip; the tab shows
    // a wrapped grid of the same thumbs instead.
    grid.style.flexWrap = 'wrap';
    grid.style.overflowX = 'visible';

    // The whole loaded set goes to the viewer so prev/next walks the tab.
    const viewerItems = items.map((item) => ({ url: item.image_url, type: 'image' }));

    items.forEach((item, index) => {
        grid.appendChild(createThumb(item, index, viewerItems));
    });

    tabElement.replaceChildren(headerElement, grid);
}

/**
 * Renders the inline failure state.
 * @param {HTMLElement} tabElement - The tab element to render into
 */
function renderError(tabElement) {
    tabElement.replaceChildren(createStateBlock('recipes-error', 'fa-exclamation-circle',
        translate('gallery.loraTab.loadFailed', {}, 'Failed to load the gallery images. Please try again later.')));
}

/**
 * Builds one icon + message block.
 * @param {string} className - State class (shares the modal's pane state styles)
 * @param {string} iconClass - Font Awesome icon name
 * @param {string} message - Already translated message
 * @returns {HTMLElement}
 */
function createStateBlock(className, iconClass, message) {
    const block = document.createElement('div');
    block.className = className;

    const icon = document.createElement('i');
    icon.className = `fas ${iconClass}`;
    icon.setAttribute('aria-hidden', 'true');

    const text = document.createElement('p');
    text.textContent = message;

    block.append(icon, text);
    return block;
}

/**
 * Builds one thumbnail button.
 * @param {Object} item - Gallery image record
 * @param {number} index - Position inside the loaded set
 * @param {Array} viewerItems - Media viewer items for the whole set
 * @returns {HTMLButtonElement}
 */
function createThumb(item, index, viewerItems) {
    const fileName = item.file_name || '';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gallery-thumb gallery-tab-thumb';
    button.dataset.index = String(index);
    button.title = fileName;
    button.setAttribute('aria-label', fileName || translate('gallery.loraTab.title', {}, 'Gallery'));

    const image = document.createElement('img');
    image.className = 'thumb-media';
    // Attributes, not properties: `img.loading` is not reflected everywhere.
    image.setAttribute('loading', 'lazy');
    image.setAttribute('decoding', 'async');
    image.src = item.image_url || '';
    image.alt = fileName;
    button.appendChild(image);

    button.addEventListener('click', () => {
        openMediaViewer(viewerItems, index, { title: fileName });
    });

    return button;
}
