let activeViewer = null;

function createMediaElement(item) {
    const { url, type = 'image' } = item;
    if (type === 'video') {
        const el = document.createElement('video');
        el.controls = true;
        el.autoplay = true;
        el.loop = true;
        el.muted = true;
        el.className = 'media-viewer-media media-viewer-video';
        el.src = url;
        return el;
    }
    const el = document.createElement('img');
    el.className = 'media-viewer-media media-viewer-image';
    el.src = url;
    el.alt = 'Full size preview';
    el.draggable = false;
    return el;
}

function preloadAdjacent(items, index) {
    [index - 1, index + 1].forEach(i => {
        if (i >= 0 && i < items.length && items[i].type !== 'video') {
            const preload = new Image();
            preload.src = items[i].url;
        }
    });
}

/**
 * Open the shared full-screen viewer.
 *
 * Besides the plain (url) and (items, index) forms the options object accepts
 * two optional hooks so a page can add its own controls without forking the
 * component:
 * - `footer(container, item, index)`: called on open and after every
 *   navigation; the container is emptied first, so the hook only renders.
 * - `onKey(event, index)`: called before the viewer's own shortcuts; returning
 *   true means "handled" and suppresses them (Escape still wins).
 * @param {string|Array} arg1 - URL, or the item array.
 * @param {number|Object} [arg2] - Index when arg1 is an array, options otherwise.
 * @param {Object} [arg3] - Options when arg1 is an array.
 */
export function openMediaViewer(arg1, arg2, arg3) {
    closeMediaViewer();

    let items, currentIndex, options;

    if (Array.isArray(arg1)) {
        items = arg1;
        currentIndex = typeof arg2 === 'number' ? arg2 : 0;
        options = arg3 || {};
    } else {
        items = [{ url: arg1, type: (arg2 && arg2.type) || 'image' }];
        currentIndex = 0;
        options = arg2 || {};
    }

    const title = options.title || '';
    const renderFooter = typeof options.footer === 'function' ? options.footer : null;
    const onKey = typeof options.onKey === 'function' ? options.onKey : null;

    if (currentIndex < 0 || currentIndex >= items.length) currentIndex = 0;

    const overlay = document.createElement('div');
    overlay.className = 'media-viewer-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-label', title || 'Media viewer');

    const closeBtn = document.createElement('button');
    closeBtn.className = 'media-viewer-close';
    closeBtn.innerHTML = '<i class="fas fa-times"></i>';
    closeBtn.title = 'Close (Esc)';
    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMediaViewer();
    });

    const contentContainer = document.createElement('div');
    contentContainer.className = 'media-viewer-content-container';

    let mediaElement = createMediaElement(items[currentIndex]);
    contentContainer.appendChild(mediaElement);

    const hasNavigation = items.length > 1;

    const counter = document.createElement('div');
    counter.className = 'media-viewer-counter';
    counter.textContent = hasNavigation ? `${currentIndex + 1} / ${items.length}` : '';
    contentContainer.appendChild(counter);

    if (title) {
        const titleBar = document.createElement('div');
        titleBar.className = 'media-viewer-title';
        titleBar.textContent = title;
        contentContainer.appendChild(titleBar);
    }

    // The optional footer belongs to the page that opened the viewer; the
    // viewer only reserves the slot and keeps it in sync with navigation.
    let footerContainer = null;
    const drawFooter = () => {
        if (!renderFooter) return;
        if (!footerContainer) {
            footerContainer = document.createElement('div');
            footerContainer.className = 'media-viewer-footer';
            contentContainer.appendChild(footerContainer);
            // The media already claims up to 85vh; a footer needs its own room
            // or the whole dialog overflows a short window.
            contentContainer.classList.add('has-footer');
        }
        footerContainer.innerHTML = '';
        renderFooter(footerContainer, items[currentIndex], currentIndex);
    };

    let prevBtn, nextBtn;
    if (hasNavigation) {
        prevBtn = document.createElement('button');
        prevBtn.className = 'media-viewer-nav media-viewer-prev';
        prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';
        prevBtn.title = 'Previous (←)';
        nextBtn = document.createElement('button');
        nextBtn.className = 'media-viewer-nav media-viewer-next';
        nextBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';
        nextBtn.title = 'Next (→)';

        const navigate = (delta) => {
            const newIndex = (currentIndex + delta + items.length) % items.length;
            currentIndex = newIndex;

            const oldMedia = contentContainer.querySelector('.media-viewer-media');
            const newMedia = createMediaElement(items[currentIndex]);

            if (oldMedia) {
                if (oldMedia.tagName === 'VIDEO') {
                    oldMedia.pause();
                    oldMedia.src = '';
                }
                oldMedia.replaceWith(newMedia);
            }
            mediaElement = newMedia;

            counter.textContent = `${currentIndex + 1} / ${items.length}`;
            preloadAdjacent(items, currentIndex);
            drawFooter();
        };

        prevBtn.addEventListener('click', (e) => { e.stopPropagation(); navigate(-1); });
        nextBtn.addEventListener('click', (e) => { e.stopPropagation(); navigate(1); });

        overlay.appendChild(prevBtn);
        overlay.appendChild(nextBtn);
    }

    overlay.appendChild(closeBtn);
    overlay.appendChild(contentContainer);
    document.body.appendChild(overlay);

    requestAnimationFrame(() => {
        overlay.classList.add('active');
    });

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            closeMediaViewer();
        }
    });

    const keyHandler = (e) => {
        if (e.key === 'Escape') {
            // Stop propagation so bubble-phase handlers (e.g. ModalManager's
            // Escape handler) do not also close the modal underneath.
            e.stopPropagation();
            e.preventDefault();
            closeMediaViewer();
            return;
        }
        // The page's own shortcuts take precedence over the viewer's navigation
        // keys, so a page can rate the current media with the arrow keys.
        if (onKey && onKey(e, currentIndex)) {
            e.stopPropagation();
            e.preventDefault();
            return;
        }
        if (hasNavigation) {
            if (e.key === 'ArrowLeft') {
                e.stopPropagation();
                e.preventDefault();
                prevBtn.click();
                return;
            }
            if (e.key === 'ArrowRight') {
                e.stopPropagation();
                e.preventDefault();
                nextBtn.click();
                return;
            }
        }
    };
    document.addEventListener('keydown', keyHandler, true);

    activeViewer = { overlay, keyHandler };
    preloadAdjacent(items, currentIndex);
    drawFooter();

    if (items[currentIndex].type === 'video') {
        const recipeVideo = document.getElementById('recipeModalVideo');
        if (recipeVideo && !recipeVideo.paused) {
            recipeVideo.pause();
        }
    }
}

export function closeMediaViewer() {
    if (!activeViewer) return;

    const { overlay, keyHandler } = activeViewer;

    const video = overlay.querySelector('video');
    if (video) {
        video.pause();
        video.src = '';
    }

    const img = overlay.querySelector('img');
    if (img) {
        img.src = '';
    }

    document.removeEventListener('keydown', keyHandler, true);

    overlay.classList.remove('active');
    overlay.addEventListener('transitionend', () => {
        if (overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
    }, { once: true });

    setTimeout(() => {
        if (overlay.parentNode) {
            overlay.parentNode.removeChild(overlay);
        }
    }, 500);

    activeViewer = null;
}

export function isMediaViewerOpen() {
    return activeViewer !== null;
}
