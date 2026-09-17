import {
    initDownloadManagerOverlay,
    openDownloadManagerOverlay
} from './download-overlay.js';

// Legacy/debug page wrapper. The production Download Manager now runs as an
// in-sidepanel overlay, but download-manager.html can still open this module.
initDownloadManagerOverlay();
openDownloadManagerOverlay('queue');
