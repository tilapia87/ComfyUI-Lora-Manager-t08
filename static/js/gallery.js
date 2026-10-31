// Gallery page: browses the ComfyUI output folder, lets the user rate every
// image on a four-level scale (+3 / +1 / -1 / -3), and aggregates those
// ratings per artist and per LoRA.
//
// Artist names come from the Anima model's `@name` prompt syntax; the backend
// parses them out of each image's embedded metadata together with the LoRAs it
// used (see py/utils/artist_tags.py).
import { appCore } from './core.js';
import { state } from './state/index.js';
import { showToast } from './utils/uiHelpers.js';
import { translate } from './utils/i18nHelpers.js';
import { openMediaViewer, isMediaViewerOpen } from './components/shared/MediaViewer.js';
import { directoryPickerModal } from './components/DirectoryPickerModal.js';
import { openModelInLoraPage } from './utils/modelDeepLink.js';
import {
    fetchGalleryImages,
    fetchGalleryImagesForLora,
    setGalleryImageRating,
    fetchGallerySummary,
    fetchGalleryStats,
    fetchArtistPreview,
    startGalleryIndex,
    fetchGalleryIndexStatus,
    fetchGalleryConfig,
    fetchThumbnailCache,
    clearThumbnailCache,
} from './api/galleryApi.js';

const GALLERY_PAGE_SIZE = 40;
// The statistics ranking can be far longer than one screen (a large library has
// thousands of LoRAs), so it is paged independently of the image grid.
const STATS_PAGE_SIZE = 100;
// The animadex catalogue is mirrored in the background on first use, so the
// ranking polls until the size settles or the fetch gives up.
const ANIMADEX_RETRY_INTERVAL_MS = 1500;
const SCAN_POLL_INTERVAL_MS = 800;
const PROGRESS_HIDE_DELAY_MS = 8000;
const SEARCH_DEBOUNCE_MS = 300;
// Rating one card changes four facet counts and the distribution bar; a run of
// keyboard votes must not fire one request per image.
const SUMMARY_REFRESH_DEBOUNCE_MS = 400;

// Thumbnail density is a viewing preference, not a gallery setting, so it is
// remembered per browser instead of going through the settings API.
const DENSITY_STORAGE_KEY = 'gallery_card_density';
const DENSITY_LEVELS = ['compact', 'comfortable', 'large'];

function readGalleryDensity() {
    try {
        const stored = window.localStorage.getItem(DENSITY_STORAGE_KEY);
        if (DENSITY_LEVELS.includes(stored)) return stored;
    } catch (error) {
        // Private mode or disabled storage: fall through to the default.
    }
    return 'comfortable';
}

function formatBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const ORDER_STORAGE_KEY = 'gallery_order';
const ORDER_LEVELS = ['desc', 'asc'];

// The four rating levels the backend accepts, strongest first. The magnitude is
// the weight the preference statistics use: a +3 vote counts three +1 votes.
const RATING_LEVELS = [3, 1, -1, -3];
const RATING_LEVEL_CLASS = { 3: 'love', 1: 'like', '-1': 'dislike', '-3': 'hate' };
// Tooltip/aria label per level; each one also names its keyboard shortcut.
const RATING_HINT_KEYS = { 3: 'loveHint', 1: 'likeHint', '-1': 'dislikeHint', '-3': 'hateHint' };

/**
 * Signed display form of a rating value (+3, +1, -1, -3). Uses a real minus
 * sign so the numbers line up in the card footer.
 * @param {number} value - One of RATING_LEVELS.
 * @returns {string}
 */
function formatRatingValue(value) {
    const numeric = Number(value) || 0;
    return numeric > 0 ? `+${numeric}` : `−${Math.abs(numeric)}`;
}

/**
 * CSS modifier for a rating level, used by the buttons and the media badge.
 * @param {number} value - Rating value.
 * @returns {string} love|like|dislike|hate, or '' for unrated.
 */
function ratingLevelClass(value) {
    const key = String(Number(value));
    return RATING_LEVEL_CLASS[key] || '';
}

// Facet filters the sidebar offers, in display order. `all` is the catch-all and
// `unrated` the not-yet-voted bucket; the four exact levels sit between them.
const RATING_FILTERS = ['all', 'loved', 'like', 'dislike', 'hate', 'unrated'];
// Facet filter -> rating value it keeps (0 = unrated).
const RATING_FILTER_VALUES = { loved: 3, like: 1, dislike: -1, hate: -3, unrated: 0 };

/**
 * Whether a rating value passes the active facet filter.
 *
 * The backend filters the page, but a vote changes the value in place: a card
 * that no longer matches has to leave the grid without a full reload.
 * @param {number} rating - Current rating of the image.
 * @param {string} filter - One of RATING_FILTERS.
 * @returns {boolean}
 */
function ratingMatchesFilter(rating, filter) {
    if (!filter || filter === 'all') return true;
    const value = Number(rating) || 0;
    if (filter === 'unrated') return value === 0;
    return value === RATING_FILTER_VALUES[filter];
}

/**
 * Signed number for a weighted score, with a leading + for positive values.
 * @param {number} value - Weighted score.
 * @returns {string}
 */
function formatScore(value) {
    const numeric = Number(value) || 0;
    return numeric > 0 ? `+${numeric.toLocaleString()}` : numeric.toLocaleString();
}

function readGalleryOrder() {
    try {
        const stored = window.localStorage.getItem(ORDER_STORAGE_KEY);
        if (ORDER_LEVELS.includes(stored)) return stored;
    } catch (error) {
        // Private mode or disabled storage: fall through to the default.
    }
    return 'desc';
}

function persistGalleryOrder(order) {
    try {
        window.localStorage.setItem(ORDER_STORAGE_KEY, order);
    } catch (error) {
        // Best effort only.
    }
}

function persistGalleryDensity(density) {
    try {
        window.localStorage.setItem(DENSITY_STORAGE_KEY, density);
    } catch (error) {
        // Remembering the choice is best-effort only.
    }
}

const ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
};

function escapeHtml(value) {
    return String(value === null || value === undefined ? '' : value).replace(
        /[&<>"']/g,
        (char) => ESCAPE_MAP[char]
    );
}

/**
 * The effective gallery settings, defaulted the same way the backend does.
 * @returns {{outputPath: string, artistListPath: string, recursive: boolean, sort: string}}
 */
function readGallerySettings() {
    const settings = state.global?.settings || {};
    const sort = typeof settings.gallery_sort === 'string' && settings.gallery_sort
        ? settings.gallery_sort
        : 'newest';
    const thumbnailSize = Number(settings.gallery_thumbnail_size);
    return {
        outputPath: typeof settings.gallery_output_path === 'string' ? settings.gallery_output_path : '',
        artistListPath: typeof settings.gallery_artist_list_path === 'string'
            ? settings.gallery_artist_list_path
            : '',
        recursive: settings.gallery_recursive !== false,
        sort,
        thumbnailSize: [256, 512, 768, 1024].includes(thumbnailSize) ? thumbnailSize : 512,
    };
}

/**
 * Persist one gallery setting through the app's settings manager.
 *
 * `SettingsManager.saveSetting()` only POSTs keys that exist in the frontend
 * defaults map; the gallery keys live in the backend schema, so a save that the
 * manager treats as frontend-only is followed by the same POST the manager
 * would have made.
 * @param {string} key - Setting key.
 * @param {string|boolean} value - New value.
 * @returns {Promise<void>}
 */
async function persistGallerySetting(key, value) {
    const manager = window.settingsManager;
    if (manager && typeof manager.saveSetting === 'function') {
        await manager.saveSetting(key, value);
        if (typeof manager.isBackendSetting !== 'function' || manager.isBackendSetting(key)) {
            return;
        }
    } else {
        state.global.settings[key] = value;
    }

    const response = await fetch('/api/lm/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
    }
    const data = await response.json().catch(() => ({}));
    if (data && data.success === false) {
        throw new Error(data.error || 'Failed to save setting');
    }
}

export class GalleryPage {
    constructor() {
        this.el = {};
        this.items = [];
        this.config = null;

        this.view = 'images';
        this.page = 1;
        this.totalPages = 0;
        this.totalItems = 0;
        this.sort = 'newest';
        this.ratingFilter = 'all';
        this.metadataFilter = 'all';
        this.search = '';
        this.artist = '';
        this.lora = '';

        this.statsBy = 'artist';
        this.statsSort = 'score';
        this.statsLoaded = false;
        this.statsPage = 1;
        this.statsTotalPages = 0;
        // The animadex catalogue only covers artists, so the filter is offered
        // next to the "Artist" grouping and reset when the view switches to LoRAs.
        this.statsAnimadexOnly = false;
        this._animadexRetryTimer = null;
        this._animadexBusy = false;
        // Artist thumbnails come from animadex.net one lookup at a time; the
        // cache keeps a page change from asking again for the same artist.
        this.artistPreviews = new Map();
        this._artistPreviewToken = 0;

        this.scanTimer = null;
        this.searchTimer = null;
        this.progressTimer = null;
        this.isPolling = false;
        this.isLoading = false;
        this.pendingReload = false;
        this.density = readGalleryDensity();
        // The grid scrolls instead of paging, so the next page is appended.
        this.loadingMore = false;
        this.hasMoreImages = false;
        this.thumbnailCache = null;
        // Newest/highest first by default; the toggle walks everything from the
        // other end without changing the chosen sort key.
        this.order = readGalleryOrder();
        this._sentinelObserver = null;

        // Whole-gallery rating distribution, drawn by the sidebar facets. Null
        // until the first fetch so the facets can tell "unknown" from "zero".
        this.summary = null;
        this.summaryTimer = null;
        // The viewer's footer is re-rendered when a vote lands while it is open.
        this._viewerFooter = null;
        this._viewerItems = null;
    }

    /**
     * Wire the page up: settings, config, first image page.
     * @returns {Promise<void>}
     */
    async initialize() {
        this._cacheElements();
        if (!this.el.page) {
            console.warn('GalleryPage: gallery markup not found');
            return;
        }

        this._applySettingsToForm();
        this._bindEvents();
        this._applyDensity();
        this._syncOrderSwitch();
        this._syncStatsAnimadexToggle();
        this._setupInfiniteScroll();

        await this._loadConfig();
        await this.loadImages();
        await this.loadSummary();
        await this._resumeRunningScan();
    }

    _cacheElements() {
        const byId = (id) => document.getElementById(id);
        this.el = {
            page: byId('galleryPage'),
            viewSwitch: byId('galleryViewSwitch'),
            scanBtn: byId('galleryScanBtn'),
            settingsToggle: byId('gallerySettingsToggle'),
            settingsPanel: byId('gallerySettingsPanel'),
            outputPathInput: byId('galleryOutputPathInput'),
            outputPathBrowse: byId('galleryOutputPathBrowse'),
            artistListInput: byId('galleryArtistListInput'),
            artistListBrowse: byId('galleryArtistListBrowse'),
            recursiveToggle: byId('galleryRecursiveToggle'),
            settingsSave: byId('gallerySettingsSave'),
            effectivePath: byId('galleryEffectivePath'),
            progress: byId('galleryProgress'),
            progressFill: byId('galleryProgressFill'),
            progressText: byId('galleryProgressText'),
            imagesPanel: byId('galleryImagesPanel'),
            statsPanel: byId('galleryStatsPanel'),
            sortSelect: byId('gallerySortSelect'),
            densitySwitch: byId('galleryDensitySwitch'),
            orderSwitch: byId('galleryOrderSwitch'),
            ratingFacets: byId('galleryRatingFacets'),
            ratingScore: byId('galleryRatingScore'),
            ratingDistribution: byId('galleryRatingDistribution'),
            metadataSelect: byId('galleryMetadataSelect'),
            searchInput: byId('gallerySearchInput'),
            totalCount: byId('galleryTotalCount'),
            ratedProgress: byId('galleryRatedProgress'),
            filterBanner: byId('galleryFilterBanner'),
            filterBannerText: byId('galleryFilterBannerText'),
            filterClearBtn: byId('galleryFilterClearBtn'),
            grid: byId('galleryGrid'),
            loadMore: byId('galleryLoadMore'),
            loadMoreBtn: byId('galleryLoadMoreBtn'),
            loadMoreText: byId('galleryLoadMoreText'),
            status: byId('galleryStatus'),
            statusText: byId('galleryStatusText'),
            errorState: byId('galleryErrorState'),
            errorMessage: byId('galleryErrorMessage'),
            errorRetryBtn: byId('galleryErrorRetryBtn'),
            emptyState: byId('galleryEmptyState'),
            emptyTitle: byId('galleryEmptyTitle'),
            emptyMessage: byId('galleryEmptyMessage'),
            emptyScanBtn: byId('galleryEmptyScanBtn'),
            emptySettingsBtn: byId('galleryEmptySettingsBtn'),
            pagination: byId('galleryPagination'),
            pageInfo: byId('galleryPageInfo'),
            prevPage: byId('galleryPrevPage'),
            nextPage: byId('galleryNextPage'),
            statsBySwitch: byId('galleryStatsBySwitch'),
            statsSortPills: byId('galleryStatsSortPills'),
            statsSummary: byId('galleryStatsSummary'),
            statsTableWrap: byId('galleryStatsTableWrap'),
            statsBody: byId('galleryStatsBody'),
            statsStatus: byId('galleryStatsStatus'),
            statsEmpty: byId('galleryStatsEmpty'),
            statsPagination: byId('galleryStatsPagination'),
            statsPageInfo: byId('galleryStatsPageInfo'),
            statsPrevPage: byId('galleryStatsPrevPage'),
            statsNextPage: byId('galleryStatsNextPage'),
            statsAnimadexControl: byId('galleryStatsAnimadexControl'),
            statsAnimadexToggle: byId('galleryStatsAnimadexToggle'),
            statsAnimadexNote: byId('galleryStatsAnimadexNote'),
            thumbnailSizeSelect: byId('galleryThumbnailSizeSelect'),
            thumbnailCacheInfo: byId('galleryThumbnailCacheInfo'),
            thumbnailCacheClear: byId('galleryThumbnailCacheClear'),
        };
    }

    _bindEvents() {
        const el = this.el;

        el.scanBtn?.addEventListener('click', () => this.runScan());
        el.emptyScanBtn?.addEventListener('click', () => this.runScan());
        el.emptySettingsBtn?.addEventListener('click', () => this.openSettings());
        el.errorRetryBtn?.addEventListener('click', () => this.reload());

        el.settingsToggle?.addEventListener('click', () => this.toggleSettings());
        el.settingsSave?.addEventListener('click', () => this.saveSettings());
        el.outputPathBrowse?.addEventListener('click', () => this._browseFor('output'));
        el.artistListBrowse?.addEventListener('click', () => this._browseFor('artistList'));
        el.thumbnailSizeSelect?.addEventListener('change', () => this._setThumbnailSize());
        el.thumbnailCacheClear?.addEventListener('click', () => this._clearThumbnailCache());

        el.viewSwitch?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-view]');
            if (button) this.switchView(button.dataset.view);
        });

        el.densitySwitch?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-density]');
            if (button) this.setDensity(button.dataset.density);
        });

        el.orderSwitch?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-order]');
            if (button) this.setOrder(button.dataset.order);
        });

        el.sortSelect?.addEventListener('change', () => {
            this.sort = el.sortSelect.value;
            this.page = 1;
            persistGallerySetting('gallery_sort', this.sort).catch(() => {
                // Remembering the sort order is best-effort.
            });
            this.loadImages();
        });

        el.ratingFacets?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-rating-filter]');
            if (button) this.setRatingFilter(button.dataset.ratingFilter);
        });

        el.metadataSelect?.addEventListener('change', () => {
            this.metadataFilter = el.metadataSelect.value;
            this.page = 1;
            this.loadImages();
        });

        el.searchInput?.addEventListener('input', () => {
            clearTimeout(this.searchTimer);
            this.searchTimer = setTimeout(() => {
                this.search = el.searchInput.value.trim();
                this.page = 1;
                this.loadImages();
            }, SEARCH_DEBOUNCE_MS);
        });

        el.filterClearBtn?.addEventListener('click', () => this.clearChipFilter());

        el.prevPage?.addEventListener('click', () => this.goToPage(this.page - 1));
        el.nextPage?.addEventListener('click', () => this.goToPage(this.page + 1));

        // The scroll sentinel is the primary path; this button keeps the grid
        // usable with no IntersectionObserver (and for keyboard users).
        el.loadMoreBtn?.addEventListener('click', () => this.loadMoreImages());

        el.grid?.addEventListener('click', (event) => this._onGridClick(event));
        el.grid?.addEventListener('keydown', (event) => this._onGridKeydown(event));

        el.statsBySwitch?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-by]');
            if (!button) return;
            this.statsBy = button.dataset.by;
            this.statsLoaded = false;
            this.statsPage = 1;
            // The animadex catalogue only knows artists: leaving the artist
            // grouping drops the filter instead of keeping a hidden state.
            if (this.statsBy !== 'artist') this.statsAnimadexOnly = false;
            this._syncStatsBySwitch();
            this.loadStats();
        });

        el.statsSortPills?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-sort]');
            if (!button) return;
            this.setStatsSort(button.dataset.sort);
        });

        el.statsAnimadexToggle?.addEventListener('click', () => {
            this.statsAnimadexOnly = !this.statsAnimadexOnly;
            this.statsLoaded = false;
            this.statsPage = 1;
            this._syncStatsAnimadexToggle();
            this.loadStats();
        });

        el.statsPrevPage?.addEventListener('click', () => this.goToStatsPage(this.statsPage - 1));
        el.statsNextPage?.addEventListener('click', () => this.goToStatsPage(this.statsPage + 1));

        el.statsBody?.addEventListener('click', (event) => {
            const jumpButton = event.target.closest('.gallery-open-lora');
            if (jumpButton) {
                this.openStatRowInLoraPage(jumpButton);
                return;
            }
            // A metric is also a sort control: clicking the thumbs-up count
            // ranks by likes instead of filtering the grid.
            const metric = event.target.closest('[data-sort-metric]');
            if (metric) {
                this.setStatsSort(metric.dataset.sortMetric);
                return;
            }
            const row = event.target.closest('[data-key]');
            if (row) this._filterByStatRow(row.dataset.key);
        });

        // The ranking cards are focusable, so Enter/Space must do what a click
        // does. The jump button keeps its own native activation.
        el.statsBody?.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            if (event.target.closest('.gallery-open-lora')) return;
            const card = event.target.closest('[data-key]');
            if (!card) return;
            event.preventDefault();
            this._filterByStatRow(card.dataset.key);
        });
    }

    // ── Images ────────────────────────────────────────────────────────────

    /**
     * Reload the current page of images.
     * @returns {Promise<void>}
     */
    async reload() {
        await this.loadImages();
    }

    /**
     * Fetch and render the current image page.
     *
     * A request is already in flight while the user keeps flipping filters, so
     * the change is coalesced into one follow-up reload instead of being
     * dropped.
     * @returns {Promise<void>}
     */
    async loadImages({ append = false } = {}) {
        if (this.isLoading) {
            // A filter change must win over a half-finished append.
            if (!append) this.pendingReload = true;
            return;
        }
        if (append && !this.hasMoreImages) return;
        this.isLoading = true;
        this.el.grid?.setAttribute('aria-busy', 'true');
        if (append) {
            this.loadingMore = true;
            this.renderPagination();
        } else if (!this.items.length) {
            this._showSkeletons();
        }
        this._setBusy(true);

        try {
            const result = await fetchGalleryImages({
                page: this.page,
                pageSize: GALLERY_PAGE_SIZE,
                sort: this.sort,
                rating: this.ratingFilter,
                metadata: this.metadataFilter,
                artist: this.artist,
                lora: this.lora,
                q: this.search,
                order: this.order,
            });

            const incoming = result.items;
            const previousCount = append ? this.items.length : 0;
            this.items = append ? [...this.items, ...incoming] : incoming;
            this.totalItems = result.totalItems;
            this.totalPages = result.totalPages;
            this.page = result.currentPage || this.page;
            this.hasMoreImages = this.page < this.totalPages;

            this._hide(this.el.errorState);
            this.renderImages({ append, from: previousCount });
            this.renderPagination();
        } catch (error) {
            this.items = [];
            this.hasMoreImages = false;
            this.el.grid.innerHTML = '';
            this._hide(this.el.pagination);
            this._hide(this.el.loadMore);
            this._showError(error.message);
        } finally {
            this.isLoading = false;
            this.loadingMore = false;
            this.el.grid?.setAttribute('aria-busy', 'false');
            if (this.pendingReload) {
                this.pendingReload = false;
                this.loadImages();
            } else {
                this._setBusy(false);
            }
        }
    }

    /**
     * Pick how large the thumbnails are.
     * @param {string} density - compact|comfortable|large.
     */
    setDensity(density) {
        if (!DENSITY_LEVELS.includes(density) || density === this.density) return;
        this.density = density;
        persistGalleryDensity(density);
        this._applyDensity();
    }

    /**
     * Push the current density onto the page and the switch.
     *
     * The size lives on `.gallery-page` so the image grid, the card aspect
     * ratio and the statistics preview all follow one variable.
     */
    _applyDensity() {
        const page = this.el.page;
        const grid = this.el.grid;
        if (page) page.dataset.density = this.density;
        if (grid) grid.dataset.density = this.density;
        const buttons = this.el.densitySwitch
            ? this.el.densitySwitch.querySelectorAll('[data-density]')
            : [];
        buttons.forEach((button) => {
            const active = button.dataset.density === this.density;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });
    }

    /**
     * Render the image grid from `this.items`.
     */
    renderImages({ append = false, from = 0 } = {}) {
        if (!this.el.grid) return;

        this._updateTotalCount();
        this._updateFilterBanner();

        if (!this.items.length) {
            this.el.grid.innerHTML = '';
            this._renderEmptyState();
            return;
        }

        this._hide(this.el.emptyState);
        // On append only the incoming items are rendered: their indexes stay
        // absolute so `data-index` keeps pointing into `this.items`.
        const visible = append ? this.items.slice(from) : this.items;
        const markup = visible
            .map((item, offset) => this._renderCard(item, (append ? from : 0) + offset))
            .join('');
        // Appending keeps the cards that are already on screen (and their
        // thumbnails) untouched when the next page scrolls in.
        if (append) this.el.grid.insertAdjacentHTML('beforeend', markup);
        else this.el.grid.innerHTML = markup;
        this._wireCardImages();
        this._applyDensity();
    }

    /**
     * Load the next page of images and append it to the grid.
     * @returns {Promise<void>}
     */
    async loadMoreImages() {
        if (this.loadingMore || !this.hasMoreImages) return;
        this.page += 1;
        await this.loadImages({ append: true });
    }

    /**
     * Scroll-triggered loading.
     *
     * Falls back to the explicit button when the browser (or jsdom) has no
     * IntersectionObserver; the button is always in the DOM for keyboard users.
     */
    _setupInfiniteScroll() {
        if (typeof IntersectionObserver === 'undefined') return;
        const target = this.el.loadMoreBtn;
        if (!target) return;
        this._sentinelObserver = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) {
                    void this.loadMoreImages();
                }
            },
            { rootMargin: '600px 0px' }
        );
        this._sentinelObserver.observe(target);
    }

    /**
     * Reserve the grid so the first paint is not a flash of empty page.
     */
    _showSkeletons() {
        const grid = this.el.grid;
        if (!grid) return;
        const card = `
            <div class="gallery-card gallery-card-skeleton" aria-hidden="true">
                <div class="gallery-card-media is-loading"></div>
                <div class="gallery-card-body">
                    <span class="gallery-skeleton-line"></span>
                    <span class="gallery-skeleton-line is-short"></span>
                </div>
            </div>`;
        grid.innerHTML = card.repeat(8);
    }

    /**
     * Fade each card in once its thumbnail arrives.
     *
     * The grid is rendered as markup in one go, so the loading/loaded state is
     * attached afterwards instead of per card.
     */
    _wireCardImages() {
        const grid = this.el.grid;
        if (!grid) return;
        for (const image of grid.querySelectorAll('img.gallery-card-image')) {
            const media = image.closest('.gallery-card-media');
            const settle = (ok) => {
                if (!media) return;
                media.classList.remove('is-loading');
                media.classList.add(ok ? 'is-loaded' : 'is-failed');
            };
            if (image.complete && image.naturalWidth > 0) {
                settle(true);
                continue;
            }
            image.addEventListener('load', () => settle(true), { once: true });
            image.addEventListener('error', () => {
                // A thumbnail can be missing (cache cleared while the tab was
                // open, or Pillow refused the file): the original still works.
                const full = image.dataset.fullImage;
                if (full && image.src !== full && !image.dataset.retried) {
                    image.dataset.retried = 'true';
                    image.src = full;
                    image.addEventListener('load', () => settle(true), { once: true });
                    image.addEventListener('error', () => settle(false), { once: true });
                    return;
                }
                settle(false);
            }, { once: true });
        }
    }

    _renderCard(item, index) {
        const fileName = item.file_name || '';
        const dimensions = item.width && item.height
            ? `${item.width} × ${item.height}`
            : translate('gallery.card.unknownSize');
        const metaParts = [dimensions];
        if (item.mtime) {
            metaParts.push(new Date(item.mtime * 1000).toLocaleDateString());
        }

        const promptTitle = item.prompt
            ? ` title="${escapeHtml(item.prompt.slice(0, 400))}"`
            : '';

        return `
            <article class="gallery-card" data-index="${index}" data-path="${escapeHtml(item.image_path)}" tabindex="0">
                <div class="gallery-card-media is-loading">
                    <img class="gallery-card-image" src="${escapeHtml(item.thumb_url || item.image_url)}"
                        data-full-image="${escapeHtml(item.image_url || '')}"
                        alt="${escapeHtml(fileName)}" loading="lazy" decoding="async"${promptTitle}>
                    ${this._renderRatingBadge(item.rating)}
                </div>
                <div class="gallery-card-body">
                    <div class="gallery-card-name" title="${escapeHtml(item.image_path)}">${escapeHtml(fileName)}</div>
                    <div class="gallery-card-meta">${escapeHtml(metaParts.join(' · '))}</div>
                    ${this._renderChips(item)}
                    <div class="gallery-card-actions">${this._renderRatingButtons(item.rating)}</div>
                </div>
            </article>
        `;
    }

    /**
     * The four rating buttons of one card.
     *
     * Each button shows its own value instead of an icon pair: with four levels
     * a thumbs-up cannot say whether the vote is +1 or +3, and clicking the
     * active button again clears the rating.
     * @param {number} rating - Current rating value (0 when unrated).
     * @returns {string} Button markup.
     */
    _renderRatingButtons(rating) {
        const current = Number(rating) || 0;
        return RATING_LEVELS.map((value) => {
            const level = ratingLevelClass(value);
            const active = current === value;
            const hint = translate(`gallery.card.${RATING_HINT_KEYS[value]}`);
            return `
                <button type="button" class="gallery-rate-btn gallery-rate-${level}${active ? ' is-active' : ''}"
                    data-rating="${value}" aria-pressed="${active}"
                    aria-label="${escapeHtml(hint)}" title="${escapeHtml(hint)}">
                    ${formatRatingValue(value)}
                </button>`;
        }).join('');
    }

    _renderRatingBadge(rating) {
        const value = Number(rating) || 0;
        if (!value) return '';
        const level = ratingLevelClass(value);
        return `<span class="gallery-card-badge is-${level}">${formatRatingValue(value)}</span>`;
    }

    _renderChips(item) {
        const chips = [];

        if (item.has_metadata === false) {
            chips.push(
                `<span class="gallery-chip gallery-chip-muted" title="${escapeHtml(
                    translate('gallery.card.noMetadataHint')
                )}">${escapeHtml(translate('gallery.card.noMetadata'))}</span>`
            );
            return `<div class="gallery-card-chips">${chips.join('')}</div>`;
        }

        (item.artists || []).forEach((artist) => {
            const label = artist.canonical || artist.name || '';
            const known = artist.known !== false;
            const title = known
                ? translate('gallery.card.artistHint', { name: label })
                : translate('gallery.card.unknownArtistHint', { name: label });
            chips.push(
                `<button type="button" class="gallery-chip gallery-chip-artist${
                    known ? '' : ' is-unknown'
                }" data-artist="${escapeHtml(artist.name || label)}" title="${escapeHtml(title)}">@${escapeHtml(label)}</button>`
            );
        });

        (item.loras || []).forEach((lora) => {
            const name = lora.name || '';
            const missing = lora.exists_locally === false;
            const weight = typeof lora.weight === 'number' ? lora.weight.toFixed(2) : '';
            const title = missing
                ? translate('gallery.card.loraMissingHint', { name })
                : translate('gallery.card.loraHint', { name });
            chips.push(
                `<button type="button" class="gallery-chip gallery-chip-lora${
                    missing ? ' is-missing' : ''
                }" data-lora="${escapeHtml(name)}" title="${escapeHtml(title)}">${escapeHtml(name)}${
                    weight ? `<span class="gallery-chip-weight">${weight}</span>` : ''
                }</button>` + this._renderLoraJump(lora)
            );
        });

        if (!chips.length) return '';
        return `<div class="gallery-card-chips">${chips.join('')}</div>`;
    }

    /**
     * The chip's second, explicit affordance: open the LoRA itself instead of
     * filtering the grid by it.
     *
     * Only a LoRA the gallery resolved to a local model has a page to open, so
     * an unresolved name (or one that matched several files) gets no button.
     * @param {Object} lora - LoRA entry of an image record.
     * @returns {string} Button markup, or '' when the LoRA is not linkable.
     */
    _renderLoraJump(lora) {
        const hash = typeof lora?.hash === 'string' ? lora.hash.trim() : '';
        if (!hash || lora.exists_locally === false) return '';

        const label = translate('gallery.actions.openInLoraPage');
        // `gallery-open-lora` is the shared hook for "this opens the model":
        // the statistics row uses it too, so page code and tests can look for
        // one class instead of the two different button shapes.
        return `<button type="button" class="gallery-chip gallery-chip-jump gallery-open-lora" data-lora-hash="${escapeHtml(
            hash
        )}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}"><i class="fas fa-external-link-alt" aria-hidden="true"></i></button>`;
    }

    _onGridClick(event) {
        const card = event.target.closest('.gallery-card');
        if (!card) return;

        const index = Number(card.dataset.index);

        const rateBtn = event.target.closest('.gallery-rate-btn');
        if (rateBtn) {
            const item = this.items[index];
            if (item) this.toggleRating(item, Number(rateBtn.dataset.rating));
            return;
        }

        // Before either chip action: the jump button sits next to the LoRA chip
        // and must not also trigger the chip's grid filter.
        const loraJump = event.target.closest('[data-lora-hash]');
        if (loraJump) {
            openModelInLoraPage(loraJump.dataset.loraHash);
            return;
        }

        const artistChip = event.target.closest('[data-artist]');
        if (artistChip) {
            this.applyChipFilter('artist', artistChip.dataset.artist);
            return;
        }

        const loraChip = event.target.closest('[data-lora]');
        if (loraChip) {
            this.applyChipFilter('lora', loraChip.dataset.lora);
            return;
        }

        if (event.target.closest('.gallery-card-image')) {
            this.openViewerAt(index);
        }
    }

    _onGridKeydown(event) {
        const card = event.target.closest('.gallery-card');
        if (!card) return;
        // The full-size viewer owns the keyboard while it is open.
        if (isMediaViewerOpen()) return;

        const index = Number(card.dataset.index);
        const item = this.items[index];
        if (!item) return;

        const key = event.key;

        // Roving focus: Left/Right/Home/End move between the cards without
        // leaving the grid, so rating a run of images is a keyboard-only task.
        if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End') {
            const cards = Array.from(this.el.grid.querySelectorAll('.gallery-card'));
            const position = cards.indexOf(card);
            let next = position;
            if (key === 'ArrowLeft') next = position - 1;
            else if (key === 'ArrowRight') next = position + 1;
            else if (key === 'Home') next = 0;
            else next = cards.length - 1;
            if (next >= 0 && next < cards.length && next !== position) {
                event.preventDefault();
                cards[next].focus();
            }
            return;
        }

        // Two shortcuts per side: the plain key is the mild vote, Shift (or the
        // letter next to it on the home row) is the strong one.
        const strong = event.shiftKey;
        if (key === 'ArrowUp' || key === 'u' || key === 'U') {
            event.preventDefault();
            this.toggleRating(item, strong ? 3 : 1);
        } else if (key === 'ArrowDown' || key === 'd' || key === 'D') {
            event.preventDefault();
            this.toggleRating(item, strong ? -3 : -1);
        } else if (key === 'i' || key === 'I') {
            event.preventDefault();
            this.toggleRating(item, 3);
        } else if (key === 'k' || key === 'K') {
            event.preventDefault();
            this.toggleRating(item, -3);
        } else if (key === 'Enter' && event.target === card) {
            event.preventDefault();
            this.openViewerAt(index);
        }
    }

    /**
     * Apply (or clear) a rating for one image, optimistically.
     * @param {Object} item - Image record from the current page.
     * @param {number} value - One of +3, +1, -1, -3.
     * @returns {Promise<void>}
     */
    async toggleRating(item, value) {
        const previous = item.rating || 0;
        // Clicking the active button clears the rating.
        const next = previous === value ? 0 : value;

        item.rating = next;
        this._updateCardRating(item);
        this._refreshViewerFooter();

        try {
            await setGalleryImageRating(item.image_path, next);
            // Statistics and the sidebar distribution are now stale.
            this.statsLoaded = false;
            this._scheduleSummaryRefresh();
            this._dropCardWhenFilteredOut(item);
        } catch (error) {
            // fetchGalleryImages/setGalleryImageRating already surfaced a toast.
            item.rating = previous;
            this._updateCardRating(item);
            this._refreshViewerFooter();
        }
    }

    /**
     * Remove a voted card that no longer passes the active facet.
     *
     * The grid is filtered on the server, so without this an "unrated" page
     * would keep showing an image the user just rated. Reloading instead would
     * throw away the scroll position and the focus.
     * @param {Object} item - The image that was just voted on.
     */
    _dropCardWhenFilteredOut(item) {
        if (ratingMatchesFilter(item.rating, this.ratingFilter)) return;
        const card = this._findCard(item.image_path);
        if (!card) return;

        card.remove();
        this.items = this.items.filter((entry) => entry !== item);
        this.totalItems = Math.max(0, this.totalItems - 1);
        this._updateTotalCount();
        // `data-index` points into `this.items`; renumber so later clicks and
        // keyboard navigation still address the right record.
        this.el.grid
            ?.querySelectorAll('.gallery-card')
            .forEach((node, index) => {
                node.dataset.index = String(index);
            });
        if (!this.items.length) this.renderImages();
    }

    _updateCardRating(item) {
        const card = this._findCard(item.image_path);
        if (!card) return;

        card.querySelectorAll('.gallery-rate-btn').forEach((button) => {
            const active = Number(button.dataset.rating) === item.rating;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', String(active));
        });

        const media = card.querySelector('.gallery-card-media');
        const existing = media?.querySelector('.gallery-card-badge');
        if (existing) existing.remove();
        if (media) media.insertAdjacentHTML('beforeend', this._renderRatingBadge(item.rating));
    }

    _findCard(imagePath) {
        const cards = this.el.grid ? this.el.grid.querySelectorAll('.gallery-card') : [];
        for (const card of cards) {
            if (card.dataset.path === imagePath) return card;
        }
        return null;
    }

    /**
     * Open the shared media viewer with the whole page for prev/next navigation.
     *
     * The viewer reserves a footer for pages that need their own controls, which
     * is where the four rating buttons live: judging a picture means looking at
     * it full size, so rating must not require closing the viewer first.
     * @param {number} index - Index of the clicked image.
     */
    openViewerAt(index) {
        if (!this.items.length) return;
        const items = this.items.map((item) => ({
            url: item.image_url,
            type: 'image',
            // The record itself travels with the viewer item so the footer and
            // the keyboard hook can vote on the exact row that is on screen.
            record: item,
        }));
        const safeIndex = index >= 0 && index < items.length ? index : 0;
        this._viewerItems = items;
        this._preloadViewerNeighbours(safeIndex);
        openMediaViewer(items, safeIndex, {
            title: this.items[safeIndex]?.file_name || '',
            footer: (container, item) => this._renderViewerRating(container, item),
            onKey: (event, viewerIndex) => this._onViewerKeydown(event, viewerIndex),
        });
    }

    /**
     * Fill the viewer's footer with the rating strip.
     * @param {HTMLElement} container - Footer slot owned by the viewer.
     * @param {Object} item - Viewer item being shown.
     */
    _renderViewerRating(container, item) {
        const record = item?.record;
        if (!record) return;

        this._viewerFooter = { container, record };
        const current = Number(record.rating) || 0;
        const level = ratingLevelClass(current);
        const buttons = RATING_LEVELS.map((value) => {
            const buttonLevel = ratingLevelClass(value);
            const active = current === value;
            const hint = translate(`gallery.card.${RATING_HINT_KEYS[value]}`);
            return `<button type="button" class="gallery-viewer-rate-btn gallery-rate-${buttonLevel}${
                active ? ' is-active' : ''
            }" data-rating="${value}" aria-pressed="${active}" aria-label="${escapeHtml(
                hint
            )}" title="${escapeHtml(hint)}">${formatRatingValue(value)}</button>`;
        }).join('');

        container.innerHTML = `
            <div class="gallery-viewer-rate" role="group" aria-label="${escapeHtml(
                translate('gallery.rating.label')
            )}">
                <span class="gallery-viewer-rate-value${level ? ` is-${level}` : ''}">${
                    current ? formatRatingValue(current) : escapeHtml(translate('gallery.rating.unrated'))
                }</span>
                <div class="gallery-viewer-rate-actions">${buttons}</div>
                <span class="gallery-viewer-rate-hint">${escapeHtml(translate('gallery.viewer.hint'))}</span>
            </div>`;

        if (container.dataset.bound !== 'true') {
            container.dataset.bound = 'true';
            container.addEventListener('click', (event) => {
                const button = event.target.closest('[data-rating]');
                const record = this._viewerFooter?.record;
                if (!button || !record) return;
                event.stopPropagation();
                void this.toggleRating(record, Number(button.dataset.rating));
            });
        }
    }

    /**
     * Re-render the open viewer footer after a vote landed.
     */
    _refreshViewerFooter() {
        if (!this._viewerFooter || !isMediaViewerOpen()) return;
        const { container, record } = this._viewerFooter;
        this._renderViewerRating(container, { record });
    }

    /**
     * Rating shortcuts while the viewer is open.
     *
     * The viewer calls this before its own shortcuts; Left/Right still page
     * through the images. Returns true when the key was consumed.
     * @param {KeyboardEvent} event - Key event.
     * @param {number} viewerIndex - Index of the viewer item on screen.
     * @returns {boolean}
     */
    _onViewerKeydown(event, viewerIndex) {
        const record = this._viewerItems?.[viewerIndex]?.record;
        if (!record) return false;

        const key = event.key;
        const strong = event.shiftKey;
        let value = null;
        if (key === 'ArrowUp' || key === 'u' || key === 'U') value = strong ? 3 : 1;
        else if (key === 'ArrowDown' || key === 'd' || key === 'D') value = strong ? -3 : -1;
        else if (key === 'i' || key === 'I') value = 3;
        else if (key === 'k' || key === 'K') value = -3;

        if (value === null) return false;
        void this.toggleRating(record, value);
        return true;
    }

    /**
     * Warm the browser cache for the images the viewer opens next.
     *
     * The viewer shows full-resolution files, which are heavy; having the
     * neighbours already decoded makes stepping through a page feel immediate.
     * @param {number} index - Index of the image being opened.
     */
    _preloadViewerNeighbours(index) {
        if (typeof Image === 'undefined') return;
        for (const offset of [-1, 1, 2]) {
            const item = this.items[index + offset];
            if (!item?.image_url) continue;
            const image = new Image();
            image.decoding = 'async';
            image.src = item.image_url;
        }
    }

    // ── Filters ───────────────────────────────────────────────────────────

    /**
     * Filter the grid by an artist or a LoRA chip.
     * @param {'artist'|'lora'} kind - Which chip was clicked.
     * @param {string} value - Exact artist/LoRA name.
     */
    applyChipFilter(kind, value) {
        if (!value) return;
        if (kind === 'artist') {
            this.artist = value;
            this.lora = '';
        } else {
            this.lora = value;
            this.artist = '';
        }
        this.page = 1;
        this.switchView('images');
        this.loadImages();
    }

    /**
     * Drop the artist/LoRA chip filter.
     */
    clearChipFilter() {
        if (!this.artist && !this.lora) return;
        this.artist = '';
        this.lora = '';
        this.page = 1;
        this.loadImages();
    }

    /**
     * Switch the rating facet.
     *
     * Clicking the facet that is already active clears the filter again, the
     * same toggle behaviour as the card's rating buttons.
     * @param {string} filter - all|loved|like|dislike|hate|unrated.
     */
    setRatingFilter(filter) {
        if (!RATING_FILTERS.includes(filter)) return;
        const next = filter === this.ratingFilter && filter !== 'all' ? 'all' : filter;
        if (next === this.ratingFilter) return;
        this.ratingFilter = next;
        this.page = 1;
        this._syncRatingFacets();
        this.loadImages();
    }

    _syncRatingFacets() {
        const group = this.el.ratingFacets;
        if (!group) return;
        for (const button of group.querySelectorAll('[data-rating-filter]')) {
            const active = button.dataset.ratingFilter === this.ratingFilter;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        }
    }

    // ── Rating distribution ───────────────────────────────────────────────

    /**
     * Fetch the whole-gallery rating distribution and paint the facets.
     *
     * A failure is not surfaced: the grid still works, the counts simply stay
     * at "–" instead of claiming a number they do not know.
     * @returns {Promise<void>}
     */
    async loadSummary() {
        try {
            this.summary = await fetchGallerySummary();
        } catch (error) {
            this.summary = null;
        }
        this._renderRatingFacets();
    }

    /**
     * Re-fetch the summary after a vote, coalescing a run of keyboard votes into
     * one request.
     */
    _scheduleSummaryRefresh() {
        clearTimeout(this.summaryTimer);
        this.summaryTimer = setTimeout(() => {
            void this.loadSummary();
        }, SUMMARY_REFRESH_DEBOUNCE_MS);
    }

    /**
     * Paint the facet counts, the headline weighted score and the bar.
     */
    _renderRatingFacets() {
        const summary = this.summary;
        const counts = {
            all: summary ? summary.images : null,
            love: summary ? summary.levels.love : null,
            like: summary ? summary.levels.like : null,
            dislike: summary ? summary.levels.dislike : null,
            hate: summary ? summary.levels.hate : null,
            unrated: summary ? summary.unrated : null,
        };

        const group = this.el.ratingFacets;
        if (group) {
            for (const chip of group.querySelectorAll('[data-facet-count]')) {
                const value = counts[chip.dataset.facetCount];
                chip.textContent =
                    value === null || value === undefined ? '–' : value.toLocaleString();
            }
        }

        if (this.el.ratingScore) {
            const score = summary ? Number(summary.score) || 0 : null;
            this.el.ratingScore.textContent = score === null ? '' : formatScore(score);
            this.el.ratingScore.classList.toggle('is-positive', Math.sign(score) > 0);
            this.el.ratingScore.classList.toggle('is-negative', Math.sign(score) < 0);
        }

        // How much of the library is still unvoted: the single number that says
        // whether the ranking can be trusted yet.
        if (this.el.ratedProgress) {
            this.el.ratedProgress.textContent = summary
                ? translate('gallery.rating.progress', {
                      rated: summary.rated.toLocaleString(),
                      images: summary.images.toLocaleString(),
                  })
                : '';
        }

        this._renderRatingDistribution(summary);
        this._syncRatingFacets();
    }

    /**
     * Whole-gallery distribution bar: one segment per exact level, with the
     * unrated remainder left as the bare track so the rated share stands out.
     * @param {Object|null} summary - Gallery summary payload.
     */
    _renderRatingDistribution(summary) {
        const bar = this.el.ratingDistribution;
        if (!bar) return;
        if (!summary || !summary.images) {
            bar.innerHTML = '';
            bar.removeAttribute('title');
            bar.classList.add('is-empty');
            return;
        }

        const levels = summary.levels;
        const parts = [
            ['love', levels.love],
            ['like', levels.like],
            ['dislike', levels.dislike],
            ['hate', levels.hate],
            ['unrated', summary.unrated],
        ];
        bar.classList.toggle(
            'is-empty',
            levels.love + levels.like + levels.dislike + levels.hate === 0
        );
        bar.innerHTML = parts
            .filter(([, count]) => count > 0)
            .map(
                ([level, count]) =>
                    `<span class="gallery-level-seg is-${level}" style="flex:${count} 1 0"></span>`
            )
            .join('');
        bar.title = translate('gallery.rating.distribution', {
            love: levels.love,
            like: levels.like,
            dislike: levels.dislike,
            hate: levels.hate,
            unrated: summary.unrated,
        });
    }

    _updateFilterBanner() {
        const parts = [];
        if (this.artist) parts.push(translate('gallery.filter.artist', { name: this.artist }));
        if (this.lora) parts.push(translate('gallery.filter.lora', { name: this.lora }));

        if (!parts.length) {
            this._hide(this.el.filterBanner);
            return;
        }
        if (this.el.filterBannerText) this.el.filterBannerText.textContent = parts.join(' · ');
        this._show(this.el.filterBanner);
    }

    _updateTotalCount() {
        if (!this.el.totalCount) return;
        this.el.totalCount.textContent = translate('gallery.pagination.total', { total: this.totalItems });
    }

    goToPage(page) {
        if (page < 1) return;
        if (this.totalPages && page > this.totalPages) return;
        if (page === this.page) return;
        this.page = page;
        this.loadImages();
        this.el.page?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    renderPagination() {
        // The grid appends instead of paging, so the pager stays hidden; the
        // load-more block is its replacement.
        if (this.el.pagination) this._hide(this.el.pagination);

        const block = this.el.loadMore;
        if (!block) return;
        if (!this.hasMoreImages) {
            this._hide(block);
            return;
        }
        this._show(block);
        if (this.el.loadMoreText) {
            this.el.loadMoreText.textContent = translate(
                this.loadingMore ? 'gallery.actions.loadingMore' : 'gallery.actions.loadMore'
            );
        }
        if (this.el.loadMoreBtn) this.el.loadMoreBtn.disabled = this.loadingMore;
    }

    // ── Empty / error states ──────────────────────────────────────────────

    _renderEmptyState() {
        const el = this.el;
        this._hide(el.errorState);

        const filtersActive = Boolean(this.artist || this.lora || this.search) ||
            this.ratingFilter !== 'all' ||
            this.metadataFilter !== 'all';
        const outputUnset = !this.config || this.config.output_path_source === 'unset' || !this.config.output_path;

        if (filtersActive) {
            el.emptyTitle.textContent = translate('gallery.empty.noMatchesTitle');
            el.emptyMessage.textContent = translate('gallery.empty.noMatchesMessage');
        } else if (outputUnset) {
            el.emptyTitle.textContent = translate('gallery.empty.unsetTitle');
            el.emptyMessage.textContent = translate('gallery.empty.unsetMessage');
        } else {
            el.emptyTitle.textContent = translate('gallery.empty.noImagesTitle');
            el.emptyMessage.textContent = translate('gallery.empty.noImagesMessage');
        }

        this._show(el.emptyState);
    }

    _showError(message) {
        if (!this.el.errorState) return;
        this._hide(this.el.emptyState);
        if (this.el.errorMessage) {
            this.el.errorMessage.textContent = message || translate('gallery.error.unknown');
        }
        this._show(this.el.errorState);
    }

    _setBusy(busy) {
        if (!this.el.status) return;
        if (busy) {
            if (this.el.statusText) this.el.statusText.textContent = translate('gallery.status.loading');
            this._show(this.el.status);
        } else {
            this._hide(this.el.status);
        }
    }

    // ── Statistics ────────────────────────────────────────────────────────

    /**
     * Fetch and render the aggregated statistics table.
     * @returns {Promise<void>}
     */
    async loadStats() {
        this._clearAnimadexRetry();
        this._show(this.el.statsStatus);
        this._hide(this.el.statsEmpty);

        try {
            const offset = Math.max(0, (this.statsPage - 1) * STATS_PAGE_SIZE);
            const data = await fetchGalleryStats({
                by: this.statsBy,
                sort: this.statsSort,
                limit: STATS_PAGE_SIZE,
                offset,
                order: this.order,
                animadexOnly: this.statsBy === 'artist' && this.statsAnimadexOnly,
            });
            this.statsLoaded = true;
            this._renderAnimadexNote(data.animadex);

            // ``total`` is the number of ranked rows, so a library with more
            // than one page of LoRAs can be browsed end to end.
            const totalRows = Math.max(0, Number(data.total) || 0);
            this.statsTotalPages = Math.max(1, Math.ceil(totalRows / STATS_PAGE_SIZE));

            // A rescan can shrink the ranking under the current page; land on
            // the last page rather than showing an empty table.
            if (this.statsPage > this.statsTotalPages) {
                this.statsPage = this.statsTotalPages;
                await this.loadStats();
                return;
            }

            this.renderStats(data);
            this.renderStatsPagination();
            this._scheduleAnimadexRetry(data.animadex);
        } catch (error) {
            this.el.statsBody.innerHTML = '';
            this._hide(this.el.statsTableWrap);
            this._hide(this.el.statsPagination);
            this._show(this.el.statsEmpty);
        } finally {
            this._hide(this.el.statsStatus);
        }
    }

    /**
     * Render the summary row and the ranking table.
     * @param {{totals: Object, items: Array}} data - Stats payload.
     */
    renderStats(data) {
        const totals = data?.totals || {};
        const items = data?.items || [];

        // The headline is the weighted score, not the raw vote count: that is
        // where the strong levels actually change the ranking. The four exact
        // levels stay so the scale is never reduced to a single number.
        const totalsLevels = {
            love: Number(totals.levels?.love ?? totals.loved) || 0,
            like: Number(totals.levels?.like) || 0,
            dislike: Number(totals.levels?.dislike) || 0,
            hate: Number(totals.levels?.hate ?? totals.hated) || 0,
        };
        // An older payload only carries the two side counts; split the mild
        // levels out of them so the row still adds up.
        if (!totals.levels) {
            totalsLevels.like = Math.max(0, (Number(totals.liked) || 0) - totalsLevels.love);
            totalsLevels.dislike = Math.max(0, (Number(totals.disliked) || 0) - totalsLevels.hate);
        }

        const summaryEntries = [
            { key: 'images', value: Number(totals.images || 0).toLocaleString() },
            { key: 'rated', value: Number(totals.rated || 0).toLocaleString() },
            { key: 'love', value: totalsLevels.love.toLocaleString(), tone: ' is-level-love' },
            { key: 'like', value: totalsLevels.like.toLocaleString(), tone: ' is-level-like' },
            { key: 'dislike', value: totalsLevels.dislike.toLocaleString(), tone: ' is-level-dislike' },
            { key: 'hate', value: totalsLevels.hate.toLocaleString(), tone: ' is-level-hate' },
            { key: 'score', value: formatScore(totals.score), tone: this._scoreTone(totals.score) },
        ];

        this.el.statsSummary.innerHTML = summaryEntries
            .map(
                (entry) => `
                <div class="gallery-stats-card">
                    <div class="gallery-stats-card-value${entry.tone || ''}">${escapeHtml(entry.value)}</div>
                    <div class="gallery-stats-card-label">${escapeHtml(
                        translate(`gallery.stats.summary.${entry.key}`)
                    )}</div>
                </div>`
            )
            .join('');

        if (!items.length) {
            this.el.statsBody.innerHTML = '';
            this._hide(this.el.statsTableWrap);
            this._hide(this.el.statsPagination);
            if (this.statsBy === 'artist' && this.statsAnimadexOnly) {
                // The generic "nothing rated yet" copy would be wrong here: the
                // filter, not an empty library, is why the table is empty.
                this._hide(this.el.statsEmpty);
                this._renderAnimadexNoMatch();
            } else {
                this._show(this.el.statsEmpty);
            }
            return;
        }

        this._show(this.el.statsTableWrap);
        this._hide(this.el.statsEmpty);

        // Ranks are global, so page 2 starts at 101 instead of restarting at 1.
        const rankOffset = Math.max(0, (this.statsPage - 1) * STATS_PAGE_SIZE);

        this.el.statsBody.innerHTML = items
            .map((row, index) => {
                const score = Number(row.score) || 0;
                const scoreClass = this._scoreTone(score);
                const hasRatio = row.like_ratio !== null && row.like_ratio !== undefined;
                const ratioPercent = hasRatio ? Math.round(Number(row.like_ratio) * 100) : null;
                const ratio = hasRatio
                    ? `${ratioPercent}%`
                    : translate('gallery.stats.noRatio');
                const unknownClass = row.known === false ? ' is-unknown' : '';
                const label = row.label || row.key || '';
                const artistAttr = this.statsBy === 'artist' ? ` data-artist="${escapeHtml(label)}"` : '';
                const total = Number(row.total) || 0;
                // The sub-line repeats the sample size next to the name so a
                // card can be judged without reading the metric row.
                const sub = `${total} ${translate('gallery.stats.columns.total')}`;
                const rank = rankOffset + index + 1;
                const levelBar = this._levelBarMarkup(row.levels);
                const tooltip = (key) => escapeHtml(translate(`gallery.stats.columns.${key}`));
                const levelTitle = (key) => escapeHtml(translate(`gallery.rating.${key}`));
                const levels = row.levels || {};
                // With four levels the old thumbs-up/down pair no longer says
                // enough, so each exact level is its own metric and its own
                // sort control (clicking +3 ranks by the strong votes).
                const levelMetric = (level, label, sortKey, titleKey) => `
                    <span class="gallery-metric gallery-level-metric is-${level}" data-sort-metric="${sortKey}"
                        title="${levelTitle(titleKey)}">
                        <span class="gallery-level-tag">${label}</span>${Number(levels[level]) || 0}
                    </span>`;

                return `
                    <article class="gallery-rank-card${unknownClass}" data-key="${escapeHtml(row.key || label)}"${artistAttr}
                        tabindex="0" title="${escapeHtml(translate('gallery.stats.rowHint'))}">
                        <div class="gallery-rank-media">
                            ${this._statsThumbMarkup(row)}
                            <span class="gallery-rank-badge">${rank}</span>
                            ${this._renderStatRowJump(row, label)}
                        </div>
                        <div class="gallery-rank-body">
                            <div class="gallery-rank-head">
                                <div class="gallery-rank-title">
                                    <div class="gallery-stat-label" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
                                    <div class="gallery-stat-sub">${escapeHtml(sub)}</div>
                                </div>
                                <!-- The weighted score is the headline of the
                                     ranking, so it gets its own large, tinted
                                     block instead of sharing the small metric
                                     row: a leaderboard is read by this number. -->
                                <span class="gallery-rank-score${scoreClass}" title="${tooltip('score')}">
                                    <b class="gallery-col-score${scoreClass}" data-sort-metric="score"
                                        title="${tooltip('score')}">${formatScore(score)}</b>
                                    <span class="gallery-rank-score-label">${escapeHtml(
                                        translate('gallery.stats.summary.score')
                                    )}</span>
                                </span>
                            </div>
                            <div class="gallery-rank-metrics">
                                ${levelMetric('love', '+3', 'loved', 'loved')}
                                ${levelMetric('like', '+1', 'liked', 'like')}
                                ${levelMetric('dislike', '−1', 'disliked', 'dislike')}
                                ${levelMetric('hate', '−3', 'hated', 'hated')}
                                <span class="gallery-metric gallery-col-unrated" title="${tooltip('unrated')}">
                                    <i class="fas fa-minus" aria-hidden="true"></i>${Number(row.unrated) || 0}
                                </span>
                            </div>
                            <div class="gallery-col-levels">
                                ${levelBar}
                                <span class="gallery-ratio-value">${escapeHtml(ratio)}</span>
                            </div>
                        </div>
                    </article>
                `;
            })
            .join('');

        this._wireThumbFallbacks();
        this._applyArtistPreviews(items);
        this._syncStatsSortPills();
    }

    /**
     * CSS modifier for a signed value (weighted score or net).
     * @param {number} value - Signed number.
     * @returns {string} ' is-positive' | ' is-negative' | ''
     */
    _scoreTone(value) {
        const numeric = Number(value) || 0;
        if (numeric > 0) return ' is-positive';
        if (numeric < 0) return ' is-negative';
        return '';
    }

    /**
     * Distribution bar of the four rating levels for one ranking row.
     *
     * The segments are proportional to the exact level counts, so a rank whose
     * top-rated images dominate reads as a mostly-green bar without having to
     * compare four separate numbers. The tooltip carries the exact counts.
     * @param {{love?: number, like?: number, dislike?: number, hate?: number}} [levels]
     * @returns {string} Bar markup.
     */
    _levelBarMarkup(levels) {
        const counts = ['love', 'like', 'dislike', 'hate'].map(
            (key) => Number(levels?.[key]) || 0
        );
        const voteTotal = counts.reduce((sum, count) => sum + count, 0);
        const title = ['+3', '+1', '−1', '−3']
            .map((label, index) => `${label} ${counts[index]}`)
            .join(' · ');

        if (!voteTotal) {
            return `<span class="gallery-level-bar is-empty" title="${escapeHtml(title)}"></span>`;
        }

        const segments = ['love', 'like', 'dislike', 'hate']
            .map((level, index) =>
                counts[index]
                    ? `<span class="gallery-level-seg is-${level}" style="flex:${counts[index]} 1 0"></span>`
                    : ''
            )
            .join('');

        return `<span class="gallery-level-bar" title="${escapeHtml(title)}">${segments}</span>`;
    }

    /**
     * Fall back to the gallery image when a model preview fails to load.
     *
     * Previews can go stale (a LoRA was moved or its preview deleted), and a
     * broken `<img>` in the ranking looks worse than the gallery thumbnail.
     */
    _wireThumbFallbacks() {
        const body = this.el.statsBody;
        if (!body) return;
        for (const img of body.querySelectorAll('img.gallery-stats-thumb[data-fallback]')) {
            if (!img.dataset.fallback) continue;
            img.addEventListener(
                'error',
                () => {
                    const fallback = img.dataset.fallback;
                    img.dataset.fallback = '';
                    if (fallback) img.src = fallback;
                },
                { once: true }
            );
        }
    }

    /**
     * Thumbnail cell for one ranking row.
     *
     * A LoRA row reuses the LoRA page's own preview (video previews fall back
     * to the gallery image, since an `<img>` cannot show a clip). An artist row
     * starts from the gallery image and is upgraded by `_applyArtistPreviews`
     * once animadex answers.
     * @param {Object} row - Statistics row.
     * @returns {string} Cell markup.
     */
    _statsThumbMarkup(row) {
        const galleryThumb = row?.images?.[0]?.thumb_url || row?.images?.[0]?.image_url || '';
        const rawPreview = typeof row?.preview_url === 'string' ? row.preview_url : '';
        const isVideo = /\.(mp4|webm)(\?|$)/i.test(rawPreview);
        const src = (isVideo ? '' : rawPreview) || galleryThumb;
        if (!src) {
            return '<span class="gallery-stats-thumb is-placeholder" aria-hidden="true"></span>';
        }
        const fallback = galleryThumb && galleryThumb !== src ? escapeHtml(galleryThumb) : '';
        return `<img class="gallery-stats-thumb" src="${escapeHtml(src)}" alt="" loading="lazy"
            data-fallback="${fallback}">`;
    }

    /**
     * Serve already-known artist thumbnails and start the missing lookups.
     * @param {Array} items - Statistics rows of the current page.
     */
    _applyArtistPreviews(items) {
        if (this.statsBy !== 'artist') return;
        const missing = [];
        for (const row of items) {
            const label = row?.label || row?.key || '';
            if (!label) continue;
            const cached = this.artistPreviews.get(label);
            if (cached) {
                if (cached.thumb_url) this._setArtistThumb(label, cached.thumb_url);
            } else {
                missing.push(label);
            }
        }
        if (missing.length) {
            void this._loadArtistPreviews(missing);
        }
    }

    /**
     * Look up missing artist thumbnails with a small, bounded concurrency.
     * @param {string[]} names - Artist names to resolve.
     * @returns {Promise<void>}
     */
    async _loadArtistPreviews(names) {
        const token = ++this._artistPreviewToken;
        const queue = names.slice();
        const worker = async () => {
            while (queue.length) {
                const name = queue.shift();
                if (!name || this.artistPreviews.has(name)) continue;
                const preview = await fetchArtistPreview(name);
                this.artistPreviews.set(name, preview);
                // A newer render (page/sort change) owns the table now.
                if (token !== this._artistPreviewToken) return;
                if (preview.thumb_url) this._setArtistThumb(name, preview.thumb_url);
            }
        };
        await Promise.all([worker(), worker(), worker()]);
    }

    /**
     * Swap one artist row's thumbnail once animadex has an answer.
     * @param {string} name - Artist name as rendered in the row.
     * @param {string} url - Thumbnail URL.
     */
    _setArtistThumb(name, url) {
        const body = this.el.statsBody;
        if (!body || !url) return;
        for (const card of body.querySelectorAll('[data-artist]')) {
            if (card.dataset.artist !== name) continue;
            const media = card.querySelector('.gallery-rank-media');
            if (!media) return;
            const image = media.querySelector('img.gallery-stats-thumb');
            const markup = `<img class="gallery-stats-thumb gallery-rank-thumb" src="${escapeHtml(url)}" alt="" loading="lazy">`;
            if (!image) {
                // The card started as an empty frame: swap it for the sample.
                const placeholder = media.querySelector('.gallery-stats-thumb.is-placeholder');
                if (placeholder) {
                    placeholder.outerHTML = markup;
                } else {
                    media.insertAdjacentHTML('afterbegin', markup);
                }
                return;
            }
            image.classList.add('gallery-rank-thumb');
            image.src = url;
            return;
        }
    }

    /**
     * Show the statistics pager, mirroring the image grid's pager.
     */
    renderStatsPagination() {
        const el = this.el;
        if (!el.statsPagination) return;

        if (this.statsTotalPages <= 1) {
            this._hide(el.statsPagination);
            return;
        }

        this._show(el.statsPagination);
        if (el.statsPageInfo) {
            el.statsPageInfo.textContent = translate('gallery.pagination.page', {
                page: this.statsPage,
                total: this.statsTotalPages,
            });
        }
        if (el.statsPrevPage) el.statsPrevPage.disabled = this.statsPage <= 1;
        if (el.statsNextPage) el.statsNextPage.disabled = this.statsPage >= this.statsTotalPages;
    }

    /**
     * Move the statistics table to another page.
     * @param {number} page - Target page (1-based).
     * @returns {Promise<void>}
     */
    async goToStatsPage(page) {
        if (!Number.isFinite(page) || page < 1) return;
        if (this.statsTotalPages && page > this.statsTotalPages) return;
        if (page === this.statsPage) return;
        this.statsPage = page;
        await this.loadStats();
    }

    /**
     * Sort the ranking by one metric.
     * @param {string} sort - score|netted counts|exact levels|total|ratio.
     */
    setStatsSort(sort) {
        const allowed = ['score', 'loved', 'liked', 'disliked', 'hated', 'likes', 'dislikes', 'total', 'ratio'];
        if (!allowed.includes(sort) || sort === this.statsSort) return;
        this.statsSort = sort;
        this.statsPage = 1;
        this._syncStatsSortPills();
        this.loadStats();
    }

    /**
     * Walk the listing/ranking from the other end.
     * @param {string} order - desc (default) or asc (reversed).
     */
    setOrder(order) {
        if (!ORDER_LEVELS.includes(order) || order === this.order) return;
        this.order = order;
        persistGalleryOrder(order);
        this._syncOrderSwitch();
        this.page = 1;
        this.statsPage = 1;
        this.statsLoaded = false;
        this.loadImages();
        if (this.view === 'stats') this.loadStats();
    }

    _syncOrderSwitch() {
        const group = this.el.orderSwitch;
        if (!group) return;
        for (const button of group.querySelectorAll('[data-order]')) {
            const active = button.dataset.order === this.order;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        }
    }

    _syncStatsSortPills() {
        const pills = this.el.statsSortPills;
        if (!pills) return;
        for (const button of pills.querySelectorAll('[data-sort]')) {
            const active = button.dataset.sort === this.statsSort;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        }
    }

    /**
     * Change the side of the grid thumbnails, then reload so the URLs follow.
     * @returns {Promise<void>}
     */
    async _setThumbnailSize() {
        const select = this.el.thumbnailSizeSelect;
        if (!select) return;
        const size = Number(select.value);
        if (![256, 512, 768, 1024].includes(size)) return;
        try {
            await persistGallerySetting('gallery_thumbnail_size', size);
        } catch (error) {
            console.debug('Could not remember the thumbnail size:', error);
        }
        this.thumbnailCache = null;
        this.page = 1;
        await this.loadImages();
        await this._refreshThumbnailCacheInfo();
    }

    /**
     * Show how much disk the on-demand thumbnail cache uses.
     * @returns {Promise<void>}
     */
    async _refreshThumbnailCacheInfo() {
        const label = this.el.thumbnailCacheInfo;
        if (!label) return;
        try {
            const info = await fetchThumbnailCache();
            this.thumbnailCache = info;
            label.textContent = translate('gallery.settings.thumbnailCacheValue', {
                count: info.count,
                size: formatBytes(info.bytes),
            });
        } catch (error) {
            label.textContent = translate('gallery.settings.thumbnailCacheUnavailable');
        }
    }

    async _clearThumbnailCache() {
        const button = this.el.thumbnailCacheClear;
        if (button) button.disabled = true;
        try {
            const result = await clearThumbnailCache();
            showToast('toast.gallery.cacheCleared', { count: result.removed }, 'success');
            await this._refreshThumbnailCacheInfo();
        } catch (error) {
            showToast('toast.gallery.cacheClearFailed', { message: error.message }, 'error');
        } finally {
            if (button) button.disabled = false;
        }
    }

    /**
     * The row's second, explicit affordance: open the LoRA on the LoRA page
     * instead of filtering the grid by it.
     *
     * Only the LoRA grouping tracks models the library can open, and only a
     * resolved LoRA has a page; an artist row gets nothing.
     * @param {Object} row - Statistics row.
     * @param {string} label - Displayed row name.
     * @returns {string} Button markup, or '' when the row is not linkable.
     */
    _renderStatRowJump(row, label) {
        if (this.statsBy !== 'lora' || row.known === false) return '';

        const hash = typeof row.hash === 'string' ? row.hash.trim() : '';
        const title = translate('gallery.actions.openInLoraPage');
        return `<button type="button" class="gallery-btn gallery-btn-small gallery-open-lora"
            data-lora-hash="${escapeHtml(hash)}" data-lora-name="${escapeHtml(label)}"
            title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}"><i class="fas fa-external-link-alt" aria-hidden="true"></i></button>`;
    }

    /**
     * Open the LoRA behind a statistics row on the LoRA page.
     *
     * `/loras?model=<sha256>` addresses a model by hash, so a row that only
     * knows the LoRA name (the statistics payload is keyed by name) resolves it
     * through the gallery index first - the same name-to-hash resolution the
     * image grid relies on.
     * @param {HTMLElement} button - The clicked jump button.
     * @returns {Promise<void>}
     */
    async openStatRowInLoraPage(button) {
        const name = button.dataset.loraName || '';
        const hash = button.dataset.loraHash || (await this._resolveLoraHashByName(name));
        if (!hash) {
            showToast('toast.gallery.loraLinkFailed', { name }, 'error');
            return;
        }
        openModelInLoraPage(hash);
    }

    /**
     * Look up a LoRA's sha256 from the images that used it.
     * @param {string} name - Exact LoRA file name.
     * @returns {Promise<string>} The hash, or '' when it cannot be resolved.
     */
    async _resolveLoraHashByName(name) {
        if (!name) return '';
        try {
            const result = await fetchGalleryImagesForLora({ name, pageSize: 1 });
            const entry = (result.items[0]?.loras || []).find((lora) => lora.name === name);
            return typeof entry?.hash === 'string' ? entry.hash.trim() : '';
        } catch (error) {
            console.error('Error resolving the LoRA hash for the statistics row:', error);
            return '';
        }
    }

    _syncStatsBySwitch() {
        this.el.statsBySwitch?.querySelectorAll('[data-by]').forEach((button) => {
            button.classList.toggle('active', button.dataset.by === this.statsBy);
        });
        this._syncStatsAnimadexToggle();
    }

    /**
     * Reflect the animadex filter state on its toggle, and hide the control
     * while ranking LoRAs (the catalogue only lists artists).
     */
    _syncStatsAnimadexToggle() {
        const available = this.statsBy === 'artist';
        const control = this.el.statsAnimadexControl;
        const toggle = this.el.statsAnimadexToggle;
        if (control) control.classList.toggle('hidden', !available);
        if (!toggle) return;
        const active = available && this.statsAnimadexOnly;
        toggle.setAttribute('aria-pressed', String(active));
        toggle.classList.toggle('is-on', active);
        if (!active) this._hide(this.el.statsAnimadexNote);
    }

    /**
     * Explain the state of the animadex catalogue mirror above the table.
     * @param {Object|null} status - The `animadex` block of the stats payload.
     */
    _renderAnimadexNote(status) {
        const note = this.el.statsAnimadexNote;
        const active = this.statsBy === 'artist' && this.statsAnimadexOnly;
        this._animadexBusy = Boolean(active && status && !status.ready && (status.loading || status.error));
        if (!note) return;
        if (!active || !status || status.ready) {
            note.textContent = '';
            this._hide(note);
            return;
        }
        const failed = Boolean(status.error);
        note.classList.toggle('is-error', failed);
        if (failed) {
            note.textContent = translate('gallery.stats.animadex.failed');
        } else {
            const done = Number(status.progress?.done) || 0;
            const total = Number(status.progress?.total) || 0;
            note.textContent = translate('gallery.stats.animadex.loading', { done, total });
        }
        this._show(note);
    }

    /**
     * Once the catalogue is ready the filtered table may legitimately have no
     * row: say so instead of falling back to the library-wide empty state.
     */
    _renderAnimadexNoMatch() {
        if (this._animadexBusy) return;
        const note = this.el.statsAnimadexNote;
        if (!note) return;
        note.classList.remove('is-error');
        note.textContent = translate('gallery.stats.animadex.noMatch');
        this._show(note);
    }

    /**
     * Poll the stats endpoint while the catalogue mirror is still being built.
     * @param {Object|null} status - The `animadex` block of the stats payload.
     */
    _scheduleAnimadexRetry(status) {
        this._clearAnimadexRetry();
        if (this.statsBy !== 'artist' || !this.statsAnimadexOnly) return;
        if (!status || status.ready || !status.loading) return;
        this._animadexRetryTimer = window.setTimeout(() => {
            this._animadexRetryTimer = null;
            if (this.view === 'stats' && this.statsAnimadexOnly) this.loadStats();
        }, ANIMADEX_RETRY_INTERVAL_MS);
    }

    _clearAnimadexRetry() {
        if (this._animadexRetryTimer === null) return;
        window.clearTimeout(this._animadexRetryTimer);
        this._animadexRetryTimer = null;
    }

    _filterByStatRow(key) {
        if (!key) return;
        if (this.statsBy === 'lora') {
            this.lora = key;
            this.artist = '';
        } else {
            this.artist = key;
            this.lora = '';
        }
        this.page = 1;
        this.switchView('images');
        this.loadImages();
    }

    // ── Views ─────────────────────────────────────────────────────────────

    /**
     * Switch between the image grid and the statistics table.
     * @param {'images'|'stats'} view - Target view.
     */
    switchView(view) {
        if (view !== 'images' && view !== 'stats') return;
        this.view = view;

        this.el.viewSwitch?.querySelectorAll('[data-view]').forEach((button) => {
            const active = button.dataset.view === view;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
        });

        if (view === 'stats') {
            this._hide(this.el.imagesPanel);
            this._show(this.el.statsPanel);
            if (!this.statsLoaded) this.loadStats();
        } else {
            this._clearAnimadexRetry();
            this._hide(this.el.statsPanel);
            this._show(this.el.imagesPanel);
        }
    }

    // ── Scan + progress ───────────────────────────────────────────────────

    /**
     * Start a background scan and poll its progress.
     * @returns {Promise<void>}
     */
    async runScan() {
        try {
            const result = await startGalleryIndex(false);
            if (!result.started) {
                showToast('toast.gallery.scanAlreadyRunning', {}, 'info');
                this._startScanPolling();
                return;
            }
            showToast('toast.gallery.scanStarted', {}, 'info');
            this.renderProgress({ running: true, stage: 'walking', progress: 0 });
            this._startScanPolling();
        } catch (error) {
            this.renderProgress({ running: false, stage: 'error', error: error.message });
            this._showError(error.message);
        }
    }

    async _resumeRunningScan() {
        try {
            const status = await fetchGalleryIndexStatus();
            if (status && status.running) {
                this.renderProgress(status);
                this._startScanPolling();
            } else if (status && status.error) {
                this.renderProgress(status);
            }
        } catch (error) {
            // Progress reporting is best-effort; the grid already loaded.
        }
    }

    _startScanPolling() {
        clearInterval(this.scanTimer);
        this.scanTimer = setInterval(() => this._pollScanStatus(), SCAN_POLL_INTERVAL_MS);
        this._pollScanStatus();
    }

    _stopScanPolling() {
        clearInterval(this.scanTimer);
        this.scanTimer = null;
    }

    async _pollScanStatus() {
        if (this.isPolling) return;
        this.isPolling = true;
        try {
            const status = await fetchGalleryIndexStatus();
            this.renderProgress(status);
            if (!status || !status.running) {
                this._stopScanPolling();
                if (status && status.error) {
                    showToast('toast.gallery.scanError', { message: status.error }, 'error');
                } else {
                    showToast(
                        'toast.gallery.scanComplete',
                        {
                            added: status?.added || 0,
                            updated: status?.updated || 0,
                            removed: status?.removed || 0,
                        },
                        'success'
                    );
                }
                await this._refreshAfterScan();
            }
        } catch (error) {
            this._stopScanPolling();
        } finally {
            this.isPolling = false;
        }
    }

    async _refreshAfterScan() {
        await this._loadConfig();
        this.statsLoaded = false;
        await this.loadImages();
        await this.loadSummary();
        if (this.view === 'stats') await this.loadStats();
    }

    /**
     * Paint the scan progress bar and its caption.
     * @param {Object} status - Payload from GET /api/lm/gallery/index/status.
     */
    renderProgress(status) {
        const el = this.el;
        if (!el.progress) return;

        const running = Boolean(status && status.running);
        if (!status) {
            this._hide(el.progress);
            return;
        }

        if (el.progressFill) {
            const percent = Number(status.progress);
            el.progressFill.style.width = `${Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0))}%`;
        }

        if (el.progressText) {
            const stageLabel = translate(`gallery.progress.stage.${status.stage || 'idle'}`);
            const parts = [stageLabel];
            if (status.total) {
                parts.push(translate('gallery.progress.counts', { indexed: status.indexed || 0, total: status.total }));
            }
            if (!running && status.stage === 'completed') {
                parts.push(
                    translate('gallery.progress.details', {
                        added: status.added || 0,
                        updated: status.updated || 0,
                        removed: status.removed || 0,
                        failed: status.failed || 0,
                    })
                );
            }
            if (status.error) parts.push(status.error);
            el.progressText.textContent = parts.join(' · ');
        }

        el.progress.classList.toggle('is-error', status.stage === 'error');
        this._show(el.progress);

        clearTimeout(this.progressTimer);
        if (!running && status.stage === 'completed') {
            this.progressTimer = setTimeout(() => this._hide(el.progress), PROGRESS_HIDE_DELAY_MS);
        }
    }

    // ── Settings ──────────────────────────────────────────────────────────

    async _loadConfig() {
        try {
            this.config = await fetchGalleryConfig();
        } catch (error) {
            this.config = null;
        }
        this._renderConfigSummary();
    }

    _renderConfigSummary() {
        const config = this.config;
        const target = this.el.effectivePath;
        if (!target) return;

        const sourceKey = `gallery.settings.source.${config?.output_path_source || 'unset'}`;
        if (config && config.output_path) {
            target.textContent = translate('gallery.settings.effectivePath', {
                path: config.output_path,
                source: translate(sourceKey),
            });
        } else {
            target.textContent = translate('gallery.settings.effectivePathUnset');
        }
    }

    _applySettingsToForm() {
        const settings = readGallerySettings();
        this.sort = settings.sort;

        if (this.el.sortSelect) this.el.sortSelect.value = settings.sort;
        if (this.el.outputPathInput) this.el.outputPathInput.value = settings.outputPath;
        if (this.el.artistListInput) this.el.artistListInput.value = settings.artistListPath;
        if (this.el.recursiveToggle) this.el.recursiveToggle.checked = settings.recursive;
        if (this.el.thumbnailSizeSelect) this.el.thumbnailSizeSelect.value = String(settings.thumbnailSize);
    }

    toggleSettings() {
        const panel = this.el.settingsPanel;
        if (!panel) return;
        const willShow = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !willShow);
        this.el.settingsToggle?.setAttribute('aria-expanded', String(willShow));
        if (willShow) void this._refreshThumbnailCacheInfo();
    }

    openSettings() {
        const panel = this.el.settingsPanel;
        if (!panel) return;
        panel.classList.remove('hidden');
        this.el.settingsToggle?.setAttribute('aria-expanded', 'true');
        this.el.outputPathInput?.focus();
        void this._refreshThumbnailCacheInfo();
    }

    _browseFor(target) {
        const input = target === 'artistList' ? this.el.artistListInput : this.el.outputPathInput;
        directoryPickerModal.open({
            initialPath: input ? input.value.trim() : '',
            onSelect: (pickedPath) => {
                if (input) input.value = pickedPath;
            },
        });
    }

    /**
     * Persist the settings form, then re-read the resolved config.
     * @returns {Promise<void>}
     */
    async saveSettings() {
        try {
            await persistGallerySetting('gallery_output_path', this.el.outputPathInput?.value.trim() || '');
            await persistGallerySetting('gallery_artist_list_path', this.el.artistListInput?.value.trim() || '');
            await persistGallerySetting('gallery_recursive', Boolean(this.el.recursiveToggle?.checked));

            showToast('toast.gallery.settingsSaved', {}, 'success');
            await this._loadConfig();
            await this.loadImages();
            await this.loadSummary();
        } catch (error) {
            showToast('toast.gallery.settingsSaveFailed', { message: error.message }, 'error');
        }
    }

    // ── Small helpers ─────────────────────────────────────────────────────

    _show(element) {
        element?.classList.remove('hidden');
    }

    _hide(element) {
        element?.classList.add('hidden');
    }

    destroy() {
        this._stopScanPolling();
        this._clearAnimadexRetry();
        clearTimeout(this.searchTimer);
        clearTimeout(this.progressTimer);
        clearTimeout(this.summaryTimer);
        this._sentinelObserver?.disconnect();
        this._sentinelObserver = null;
        this._viewerFooter = null;
        this._viewerItems = null;
    }
}

/**
 * Boot the gallery page once the app core is ready.
 * @returns {Promise<GalleryPage|null>}
 */
export async function initializeGalleryPage() {
    await appCore.initialize();

    const page = new GalleryPage();
    await page.initialize();

    window.galleryPage = page;
    return page;
}

document.addEventListener('DOMContentLoaded', () => {
    initializeGalleryPage().catch((error) => {
        console.error('Failed to initialize the gallery page:', error);
    });
});
