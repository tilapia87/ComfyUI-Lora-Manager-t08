import { appCore } from './core.js';
import { state } from './state/index.js';
import { updateCardsForBulkMode } from './components/shared/ModelCard.js';
import { createPageControls } from './components/controls/index.js';
import { confirmDelete, closeDeleteModal, confirmExclude, closeExcludeModal } from './utils/modalUtils.js';
import { ModelDuplicatesManager } from './components/ModelDuplicatesManager.js';
import { initActiveFiltersSync } from './utils/activeFiltersSync.js';
import { openDeepLinkedModel } from './utils/modelDeepLink.js';

// Initialize the LoRA page
export class LoraPageManager {
    constructor() {
        // Add bulk mode to state
        state.bulkMode = false;
        state.selectedLoras = new Set();
        
        // Initialize page controls
        this.pageControls = createPageControls('loras');
        
        // Initialize the ModelDuplicatesManager
        this.duplicatesManager = new ModelDuplicatesManager(this);
        
        // Expose necessary functions to the page that still need global access
        // These will be refactored in future updates
        this._exposeRequiredGlobalFunctions();
    }
    
    _exposeRequiredGlobalFunctions() {
        // Only expose what's still needed globally
        // Most functionality is now handled by the PageControls component
        window.confirmDelete = confirmDelete;
        window.closeDeleteModal = closeDeleteModal;
        window.confirmExclude = confirmExclude;
        window.closeExcludeModal = closeExcludeModal;
        
        // Expose duplicates manager
        window.modelDuplicatesManager = this.duplicatesManager;
    }
    
    async initialize() {
        // Initialize cards for current bulk mode state (should be false initially)
        updateCardsForBulkMode(state.bulkMode);

        // Initialize common page features (including context menus and virtual scroll)
        appCore.initializePageFeatures();

        // Mirror active filters to the backend for the ComfyUI-side autocomplete
        initActiveFiltersSync('loras');

        // `/loras?model=<sha256>` opens that model on top of the listing that
        // initializePageFeatures() just started. A hash that resolves to nothing
        // is reported and the normal listing stays as it is.
        await openDeepLinkedModel();
    }
}

export async function initializeLoraPage() {
    // Initialize core application
    await appCore.initialize();

    // Initialize page-specific functionality
    const loraPage = new LoraPageManager();
    await loraPage.initialize();

    return loraPage;
}

// Initialize everything when DOM is ready
document.addEventListener('DOMContentLoaded', initializeLoraPage);