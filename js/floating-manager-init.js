// floating-manager-init.js
// Entry point for the floating Download Manager iframe.
// This file is referenced as an external module from floating-manager.html
// to comply with Chrome MV3 CSP (no inline scripts allowed).

import { initDownloadManagerOverlay } from './download-overlay.js';
initDownloadManagerOverlay();
