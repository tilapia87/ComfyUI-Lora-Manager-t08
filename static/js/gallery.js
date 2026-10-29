// Gallery page: browses the ComfyUI output folder, lets the user rate every
// image up/down, and aggregates those ratings per artist and per LoRA.
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
    fetchGalleryStats,
    fetchArtistPreview,
    startGalleryIndex,
    fetchGalleryIndexStatus,
    fetchGalleryConfig,
} from './api/galleryApi.js';

const GALLERY_PAGE_SIZE = 40;
// The statistics ranking can be far longer than one screen (a large library has
// thousands of LoRAs), so it is paged independently of the image grid.
const STATS_PAGE_SIZE = 100;
const SCAN_POLL_INTERVAL_MS = 800;
const PROGRESS_HIDE_DELAY_MS = 8000;
const SEARCH_DEBOUNCE_MS = 300;

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
    return {
        outputPath: typeof settings.gallery_output_path === 'string' ? settings.gallery_output_path : '',
        artistListPath: typeof settings.gallery_artist_list_path === 'string'
            ? settings.gallery_artist_list_path
            : '',
        recursive: settings.gallery_recursive !== false,
        sort,
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
        this.statsSort = 'net';
        this.statsLoaded = false;
        this.statsPage = 1;
        this.statsTotalPages = 0;
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

        await this._loadConfig();
        await this.loadImages();
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
            ratingSelect: byId('galleryRatingSelect'),
            metadataSelect: byId('galleryMetadataSelect'),
            searchInput: byId('gallerySearchInput'),
            totalCount: byId('galleryTotalCount'),
            filterBanner: byId('galleryFilterBanner'),
            filterBannerText: byId('galleryFilterBannerText'),
            filterClearBtn: byId('galleryFilterClearBtn'),
            grid: byId('galleryGrid'),
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
            statsSortSelect: byId('galleryStatsSortSelect'),
            statsSummary: byId('galleryStatsSummary'),
            statsTableWrap: byId('galleryStatsTableWrap'),
            statsBody: byId('galleryStatsBody'),
            statsStatus: byId('galleryStatsStatus'),
            statsEmpty: byId('galleryStatsEmpty'),
            statsPagination: byId('galleryStatsPagination'),
            statsPageInfo: byId('galleryStatsPageInfo'),
            statsPrevPage: byId('galleryStatsPrevPage'),
            statsNextPage: byId('galleryStatsNextPage'),
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

        el.viewSwitch?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-view]');
            if (button) this.switchView(button.dataset.view);
        });

        el.densitySwitch?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-density]');
            if (button) this.setDensity(button.dataset.density);
        });

        el.sortSelect?.addEventListener('change', () => {
            this.sort = el.sortSelect.value;
            this.page = 1;
            persistGallerySetting('gallery_sort', this.sort).catch(() => {
                // Remembering the sort order is best-effort.
            });
            this.loadImages();
        });

        el.ratingSelect?.addEventListener('change', () => {
            this.ratingFilter = el.ratingSelect.value;
            this.page = 1;
            this.loadImages();
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

        el.grid?.addEventListener('click', (event) => this._onGridClick(event));
        el.grid?.addEventListener('keydown', (event) => this._onGridKeydown(event));

        el.statsBySwitch?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-by]');
            if (!button) return;
            this.statsBy = button.dataset.by;
            this.statsLoaded = false;
            this.statsPage = 1;
            this._syncStatsBySwitch();
            this.loadStats();
        });

        el.statsSortSelect?.addEventListener('change', () => {
            this.statsSort = el.statsSortSelect.value;
            this.statsPage = 1;
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
            const row = event.target.closest('[data-key]');
            if (row) this._filterByStatRow(row.dataset.key);
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
    async loadImages() {
        if (this.isLoading) {
            this.pendingReload = true;
            return;
        }
        this.isLoading = true;
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
            });

            this.items = result.items;
            this.totalItems = result.totalItems;
            this.totalPages = result.totalPages;
            this.page = result.currentPage || this.page;

            this._hide(this.el.errorState);
            this.renderImages();
            this.renderPagination();
        } catch (error) {
            this.items = [];
            this.el.grid.innerHTML = '';
            this._hide(this.el.pagination);
            this._showError(error.message);
        } finally {
            this.isLoading = false;
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
    renderImages() {
        if (!this.el.grid) return;

        this._updateTotalCount();
        this._updateFilterBanner();

        if (!this.items.length) {
            this.el.grid.innerHTML = '';
            this._renderEmptyState();
            return;
        }

        this._hide(this.el.emptyState);
        this.el.grid.innerHTML = this.items.map((item, index) => this._renderCard(item, index)).join('');
        this._applyDensity();
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
                <div class="gallery-card-media">
                    <img class="gallery-card-image" src="${escapeHtml(item.image_url)}"
                        alt="${escapeHtml(fileName)}" loading="lazy" decoding="async"${promptTitle}>
                    ${this._renderRatingBadge(item.rating)}
                    <div class="gallery-card-overlay">
                        <button type="button" class="gallery-rate-btn gallery-rate-up${item.rating === 1 ? ' is-active' : ''}"
                            data-rating="1" aria-pressed="${item.rating === 1}"
                            title="${escapeHtml(translate('gallery.card.likeHint'))}">
                            <i class="fas fa-thumbs-up"></i>
                        </button>
                        <button type="button" class="gallery-rate-btn gallery-rate-down${item.rating === -1 ? ' is-active' : ''}"
                            data-rating="-1" aria-pressed="${item.rating === -1}"
                            title="${escapeHtml(translate('gallery.card.dislikeHint'))}">
                            <i class="fas fa-thumbs-down"></i>
                        </button>
                    </div>
                </div>
                <div class="gallery-card-body">
                    <div class="gallery-card-name" title="${escapeHtml(item.image_path)}">${escapeHtml(fileName)}</div>
                    <div class="gallery-card-meta">${escapeHtml(metaParts.join(' · '))}</div>
                    ${this._renderChips(item)}
                </div>
            </article>
        `;
    }

    _renderRatingBadge(rating) {
        if (rating === 1) {
            return '<span class="gallery-card-badge is-like"><i class="fas fa-thumbs-up"></i></span>';
        }
        if (rating === -1) {
            return '<span class="gallery-card-badge is-dislike"><i class="fas fa-thumbs-down"></i></span>';
        }
        return '';
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
        if (key === 'ArrowUp' || key === 'u' || key === 'U') {
            event.preventDefault();
            this.toggleRating(item, 1);
        } else if (key === 'ArrowDown' || key === 'd' || key === 'D') {
            event.preventDefault();
            this.toggleRating(item, -1);
        } else if (key === 'Enter' && event.target === card) {
            event.preventDefault();
            this.openViewerAt(index);
        }
    }

    /**
     * Apply (or clear) a rating for one image, optimistically.
     * @param {Object} item - Image record from the current page.
     * @param {number} value - 1 for like, -1 for dislike.
     * @returns {Promise<void>}
     */
    async toggleRating(item, value) {
        const previous = item.rating || 0;
        // Clicking the active button clears the rating.
        const next = previous === value ? 0 : value;

        item.rating = next;
        this._updateCardRating(item);

        try {
            await setGalleryImageRating(item.image_path, next);
            // Statistics are now stale for this artist/LoRA.
            this.statsLoaded = false;
        } catch (error) {
            // fetchGalleryImages/setGalleryImageRating already surfaced a toast.
            item.rating = previous;
            this._updateCardRating(item);
        }
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
     * @param {number} index - Index of the clicked image.
     */
    openViewerAt(index) {
        if (!this.items.length) return;
        const items = this.items.map((item) => ({ url: item.image_url, type: 'image' }));
        const safeIndex = index >= 0 && index < items.length ? index : 0;
        openMediaViewer(items, safeIndex, { title: this.items[safeIndex]?.file_name || '' });
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
        if (!this.el.pagination) return;
        if (this.totalPages <= 1) {
            this._hide(this.el.pagination);
            return;
        }
        this._show(this.el.pagination);
        if (this.el.pageInfo) {
            this.el.pageInfo.textContent = translate('gallery.pagination.page', {
                page: this.page,
                total: this.totalPages,
            });
        }
        if (this.el.prevPage) this.el.prevPage.disabled = this.page <= 1;
        if (this.el.nextPage) this.el.nextPage.disabled = this.page >= this.totalPages;
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
        this._show(this.el.statsStatus);
        this._hide(this.el.statsEmpty);

        try {
            const offset = Math.max(0, (this.statsPage - 1) * STATS_PAGE_SIZE);
            const data = await fetchGalleryStats({
                by: this.statsBy,
                sort: this.statsSort,
                limit: STATS_PAGE_SIZE,
                offset,
            });
            this.statsLoaded = true;

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

        this.el.statsSummary.innerHTML = [
            { key: 'images', value: totals.images || 0 },
            { key: 'rated', value: totals.rated || 0 },
            { key: 'liked', value: totals.liked || 0 },
            { key: 'disliked', value: totals.disliked || 0 },
        ]
            .map(
                (entry) => `
                <div class="gallery-stats-card">
                    <div class="gallery-stats-card-value">${Number(entry.value).toLocaleString()}</div>
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
            this._show(this.el.statsEmpty);
            return;
        }

        this._show(this.el.statsTableWrap);
        this._hide(this.el.statsEmpty);

        // Ranks are global, so page 2 starts at 101 instead of restarting at 1.
        const rankOffset = Math.max(0, (this.statsPage - 1) * STATS_PAGE_SIZE);

        this.el.statsBody.innerHTML = items
            .map((row, index) => {
                const net = Number(row.net) || 0;
                const netClass = net > 0 ? ' is-positive' : net < 0 ? ' is-negative' : '';
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
                // row can be judged without reading across to the numbers.
                const sub = `${total} ${translate('gallery.stats.columns.total')}`;
                const rank = rankOffset + index + 1;
                const ratioBar = hasRatio
                    ? `<span class="gallery-ratio-track"><span class="gallery-ratio-fill" style="width:${ratioPercent}%"></span></span>`
                    : '';

                return `
                    <tr class="gallery-stats-row${unknownClass}" data-key="${escapeHtml(row.key || label)}"${artistAttr}
                        tabindex="0" title="${escapeHtml(translate('gallery.stats.rowHint'))}">
                        <td class="gallery-col-thumb">${this._statsThumbMarkup(row)}</td>
                        <td class="gallery-col-rank"><span class="gallery-rank-badge">${rank}</span></td>
                        <td class="gallery-col-name">
                            <div class="gallery-stat-label">${escapeHtml(label)}</div>
                            <div class="gallery-stat-sub">${escapeHtml(sub)}</div>
                        </td>
                        <td class="gallery-col-num gallery-col-liked">${Number(row.likes) || 0}</td>
                        <td class="gallery-col-num gallery-col-disliked">${Number(row.dislikes) || 0}</td>
                        <td class="gallery-col-num gallery-col-unrated">${Number(row.unrated) || 0}</td>
                        <td class="gallery-col-num gallery-col-total">${total}</td>
                        <td class="gallery-col-num gallery-col-net${netClass}">${net > 0 ? `+${net}` : net}</td>
                        <td class="gallery-col-num gallery-col-ratio">${ratioBar}<span class="gallery-ratio-value">${escapeHtml(ratio)}</span></td>
                        <td class="gallery-col-actions">${this._renderStatRowJump(row, label)}</td>
                    </tr>
                `;
            })
            .join('');

        this._wireThumbFallbacks();
        this._applyArtistPreviews(items);
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
        const galleryThumb = row?.images?.[0]?.image_url || '';
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
        const rows = body.querySelectorAll('tr[data-artist]');
        for (const row of rows) {
            if (row.dataset.artist !== name) continue;
            const cell = row.querySelector('.gallery-col-thumb');
            if (!cell) return;
            cell.innerHTML = `<img class="gallery-stats-thumb" src="${escapeHtml(url)}" alt="" loading="lazy">`;
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
    }

    toggleSettings() {
        const panel = this.el.settingsPanel;
        if (!panel) return;
        const willShow = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !willShow);
        this.el.settingsToggle?.setAttribute('aria-expanded', String(willShow));
    }

    openSettings() {
        const panel = this.el.settingsPanel;
        if (!panel) return;
        panel.classList.remove('hidden');
        this.el.settingsToggle?.setAttribute('aria-expanded', 'true');
        this.el.outputPathInput?.focus();
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
        clearTimeout(this.searchTimer);
        clearTimeout(this.progressTimer);
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
