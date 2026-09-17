import { i18n, logMessage, updateLiveStatus, setGlobalLang } from './utils.js';
import { translations, AUTHOR_API_URL } from './config.js';
import { getAiRetryModelLabel, validateGeminiApiKey } from './gemini-client.js';

// Global state references
let state = {
    isRunning: false,
    isPaused: false,
    imageFileList: [],
    fetchedToolsList: [],
    naturalSortCollator: new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
};

// DYNAMIC CONFIG TEMPLATE with Internal CSS
const CONFIG_HTML = `
<style>
  .mode-btn { flex: 1; border: 1px solid transparent; background: transparent; color: #0369A1; border-radius: 6px; padding: 8px; cursor: pointer; font-weight: 600; font-size: 0.85rem; transition: all 0.2s; }
  .mode-btn.active { background: #0284C7; color: white; box-shadow: 0 1px 2px rgba(0,0,0,0.1); }
  .mode-btn:hover:not(.active) { background: #E0F2FE; }
  .ratio-row { display: flex; align-items: center; justify-content: space-between; padding: 7px 2px; border-top: 1px solid #E0F2FE; margin-top: 2px; }
  .ratio-row label { font-size: 0.82rem; font-weight: 600; color: #0369A1; display: flex; align-items: center; gap: 5px; }
  .ratio-select { border: 1.5px solid #BAE6FD; border-radius: 8px; background: #fff; color: #0369A1; font-weight: 600; font-size: 0.82rem; padding: 4px 10px; cursor: pointer; outline: none; transition: border-color 0.2s; }
  .ratio-select:focus { border-color: #0284C7; }
</style>

<div class="ui-card" id="dynamicConfigCard" style="background: #F0F9FF; border: 1px solid #BAE6FD;">
  <div class="section-header">
     <span class="section-label" style="color: #0369A1;">Prompt Configuration</span>
  </div>
  
  <!-- OUTPUT MODE BUTTONS -->
  <div class="setting-row">
      <div class="setting-info">
        <span class="material-symbols-rounded setting-icon-small" style="color: #0284C7;">category</span>
        <span class="setting-name">Output Mode</span>
      </div>
      <div id="mode-toggle-group" style="display: flex; background: #E0F2FE; border-radius: 8px; padding: 4px; gap: 4px; width: 160px;">
          <button id="mode-video" class="mode-btn">Video</button>
          <button id="mode-image" class="mode-btn">Image</button>
      </div>
  </div>
  <!-- VIDEO RATIO — visible when Video mode is selected -->
  <div id="videoRatioRow" class="ratio-row" style="display:none;">
    <label>
      <span class="material-symbols-rounded" style="font-size:15px;">aspect_ratio</span>
      Video Ratio
    </label>
    <select id="videoAspectRatioSelector" class="ratio-select">
      <option value="16:9">16:9 &nbsp;Landscape</option>
      <option value="9:16" selected>9:16 &nbsp;Portrait</option>
    </select>
  </div>

  <!-- IMAGE RATIO — visible when Image mode is selected -->
  <div id="imageRatioRow" class="ratio-row" style="display:none;">
    <label>
      <span class="material-symbols-rounded" style="font-size:15px;">crop</span>
      Image Ratio
    </label>
    <select id="imageAspectRatioSelector" class="ratio-select">
      <option value="1:1">1:1 &nbsp;Square</option>
      <option value="4:3">4:3 &nbsp;Landscape</option>
      <option value="3:4">3:4 &nbsp;Portrait</option>
      <option value="16:9">16:9 &nbsp;Wide</option>
      <option value="9:16" selected>9:16 &nbsp;Tall</option>
    </select>
  </div>

</div>
`;

// Functions to be exposed to Core
export function syncState(newState) {
    Object.assign(state, newState);
}

function openFolderDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('autoMetaCopyFileSystem', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('handles');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function saveDirectoryHandle(handle) {
    const db = await openFolderDb();
    await new Promise((resolve, reject) => {
        const tx = db.transaction('handles', 'readwrite');
        tx.objectStore('handles').put(handle, 'downloadDirectory');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
    });
    db.close();
}

// CRITICAL FIX: Re-added updateImageSummary to prevent import errors and crashes
export function updateImageSummary(count, isStopped) {
    const summary = document.getElementById('imageFileSummary');
    const badge = document.getElementById('imageCount');
    if (summary) {
        if (count > 0) summary.innerText = `${count} Images Selected`;
        else summary.innerText = "No images selected";
    }
    if (badge) badge.innerText = count > 0 ? count : "";
}

export async function initializeUI(callbacks) {
    const elements = {
        mainActionButton: document.getElementById('mainActionButton'),
        stopButton: document.getElementById('stopButton'),
        promptsTextarea: document.getElementById('prompts'),
        uploadPromptButton: document.getElementById('uploadPromptButton'),
        fileInput: document.getElementById('fileInput'),
        progressBar: document.getElementById('progressBar'),
        liveStatus: document.getElementById('liveStatus'),
        logDisplay: document.getElementById('logDisplay'),
        mainInterface: document.getElementById('main-interface'),
        wrongPageInterface: document.getElementById('wrong-page-interface'),
        navigateToFlowButton: document.getElementById('navigateToFlowButton'),
        automationPageTab: document.getElementById('automationPageTab'),
        failedPromptsTopTab: document.getElementById('failedPromptsTopTab'),
        galleryPageTab: document.getElementById('galleryPageTab'),
        automationPage: document.getElementById('automationPage'),
        failedPromptsPage: document.getElementById('failedPromptsPage'),
        galleryPage: document.getElementById('galleryPage'),
        bottomBar: document.querySelector('.bottom-bar'),
        startFromInput: document.getElementById('startFromInput'),
        imageUploadDelayInput: document.getElementById('imageUploadDelayInput'),
        autoDownloadCheckbox: document.getElementById('autoDownloadCheckbox'),
        openDownloadManagerButton: document.getElementById('openDownloadManagerButton'),
        openMediaGalleryButton: document.getElementById('openMediaGalleryButton'),
        fitDownloadManagerButton: document.getElementById('fitDownloadManagerButton'),
        downloadFolderInput: document.getElementById('downloadFolderInput'),
        uploadImageButton: document.getElementById('uploadImageButton'),
        imageInput: document.getElementById('imageInput'),
        imageFileSummary: document.getElementById('imageFileSummary'),
        imageCount: document.getElementById('imageCount'),
        imageSortSelector: document.getElementById('imageSortSelector'),
        clearImagesButton: document.getElementById('clearImagesButton'),
        loadGalleryButton: document.getElementById('loadGalleryButton'),
        initialGalleryScanButton: document.getElementById('initialGalleryScanButton'),
        initialGalleryOkButton: document.getElementById('initialGalleryOkButton'),
        galleryFilter: document.getElementById('galleryFilter'),
        galleryDateFilter: document.getElementById('galleryDateFilter'),
        galleryCalendarDate: document.getElementById('galleryCalendarDate'),
        galleryScanSpeed: document.getElementById('galleryScanSpeed'),
        generationFlowSelector: document.getElementById('generationFlowSelector'),
        settingsHeader: document.getElementById('settingsHeader'),
        headerSettingsBtn: document.getElementById('headerSettingsBtn'),
        configContainer: document.getElementById('config-container'),
        speedPresetSelector: document.getElementById('speedPresetSelector'),
        minInitialWait_image: document.getElementById('minInitialWait_image'),
        maxInitialWait_image: document.getElementById('maxInitialWait_image'),
        minInitialWait_text: document.getElementById('minInitialWait_text'),
        maxInitialWait_text: document.getElementById('maxInitialWait_text'),
        languageSelector: document.getElementById('languageSelector'),
        advancedSettingsHeader: document.getElementById('advancedSettingsHeader')
    };

    // Attach Listeners
    if (elements.mainActionButton) elements.mainActionButton.addEventListener('click', callbacks.onMainAction);
    if (elements.stopButton) elements.stopButton.addEventListener('click', callbacks.onStop);

    const handleDroppedImages = (files) => {
        const imageFiles = Array.from(files || []).filter(file =>
            file?.type?.startsWith('image/') || /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file?.name || '')
        );
        if (!imageFiles.length) {
            logMessage('Drop ignored: no image files found.', 'warn');
            return;
        }
        callbacks.onImageSelect({ target: { files: imageFiles } });
        if (elements.imageInput) elements.imageInput.value = '';
        setTimeout(() => updateConfigurationVisibility(elements), 100);
    };

    if (elements.uploadImageButton) {
        elements.uploadImageButton.addEventListener('click', () => elements.imageInput?.click());
        ['dragenter', 'dragover'].forEach(type => {
            elements.uploadImageButton.addEventListener(type, (event) => {
                event.preventDefault();
                event.stopPropagation();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
                elements.uploadImageButton.classList.add('drag-over');
            });
        });
        ['dragleave', 'dragend'].forEach(type => {
            elements.uploadImageButton.addEventListener(type, (event) => {
                event.preventDefault();
                event.stopPropagation();
                elements.uploadImageButton.classList.remove('drag-over');
            });
        });
        elements.uploadImageButton.addEventListener('drop', (event) => {
            event.preventDefault();
            event.stopPropagation();
            elements.uploadImageButton.classList.remove('drag-over');
            handleDroppedImages(event.dataTransfer?.files);
        });
    }
    if (elements.imageInput) elements.imageInput.addEventListener('change', (e) => {
        callbacks.onImageSelect(e);
        elements.imageInput.value = '';
        setTimeout(() => updateConfigurationVisibility(elements), 100);
    });
    if (elements.clearImagesButton) elements.clearImagesButton.addEventListener('click', () => {
        callbacks.onClearImages();
        setTimeout(() => updateConfigurationVisibility(elements), 100);
    });
    if (elements.imageSortSelector) elements.imageSortSelector.addEventListener('change', callbacks.onSortChange);

    if (elements.loadGalleryButton && callbacks.onScanGallery) {
        elements.loadGalleryButton.addEventListener('click', callbacks.onScanGallery);
    }
    if (elements.initialGalleryScanButton && callbacks.onScanGallery) {
        elements.initialGalleryScanButton.addEventListener('click', () => callbacks.onScanGallery({ initialSetup: true }));
    }
    if (elements.initialGalleryOkButton) {
        elements.initialGalleryOkButton.addEventListener('click', () => {
            document.getElementById('gallerySetupOverlay')?.classList.remove('active');
        });
    }
    if (elements.galleryFilter && callbacks.onGalleryFilter) {
        elements.galleryFilter.addEventListener('change', (e) => {
            chrome.storage.local.set({ galleryFilter: e.target.value });
            callbacks.onGalleryFilter(e);
        });
    }
    if (elements.galleryDateFilter && callbacks.onGalleryDateFilter) {
        elements.galleryDateFilter.addEventListener('change', (e) => {
            if (elements.galleryCalendarDate && e.target.value !== 'all') elements.galleryCalendarDate.value = '';
            chrome.storage.local.set({ galleryDateFilter: e.target.value });
            callbacks.onGalleryDateFilter(e);
        });
    }
    if (elements.galleryCalendarDate && callbacks.onGalleryDateFilter) {
        elements.galleryCalendarDate.addEventListener('change', (e) => {
            const value = e.target.value ? `calendar:${e.target.value}` : 'all';
            chrome.storage.local.set({ galleryDateFilter: value });
            if (elements.galleryDateFilter) elements.galleryDateFilter.value = 'all';
            callbacks.onGalleryDateFilter({ target: { value } });
        });
    }
    if (elements.galleryScanSpeed) {
        elements.galleryScanSpeed.addEventListener('change', () => {
            chrome.storage.local.set({ galleryScanSpeed: elements.galleryScanSpeed.value });
        });
    }

    if (elements.uploadPromptButton) elements.uploadPromptButton.addEventListener('click', () => elements.fileInput.click());
    if (elements.fileInput) elements.fileInput.addEventListener('change', (e) => {
        callbacks.onTxtImport(e);
        setTimeout(() => updateConfigurationVisibility(elements), 500);
    });

    if (elements.promptsTextarea) {
        // PERSISTENCE REMOVED: Prompts Queue behavior (IMPORTANT) - Auto clear on session
        // No auto-saving to storage

        // Function to update prompt counter
        const updatePromptCounter = () => {
            const raw = elements.promptsTextarea.value.trim();
            if (!raw) {
                const counterElement = document.getElementById('promptCounter');
                if (counterElement) counterElement.textContent = '(0)';
                return;
            }
            // Normalize line endings
            const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            let prompts;
            // Check if prompts are numbered (e.g., "1. ...", "2. ...")
            if (/^\d+\.\s/m.test(text)) {
                prompts = text.split(/\n(?=\d+\.\s)/).filter(p => p.trim() !== '');
            } else if (text.includes('\n\n')) {
                prompts = text.split(/\n\s*\n/).filter(p => p.trim() !== '');
            } else {
                prompts = text.split('\n').filter(p => p.trim() !== '');
            }
            const count = prompts.length;
            const counterElement = document.getElementById('promptCounter');
            if (counterElement) {
                counterElement.textContent = `(${count})`;
            }
        };

        // Update counter on input
        elements.promptsTextarea.addEventListener('input', () => {
            updatePromptCounter();
            updateConfigurationVisibility(elements);
        });

        // Initialize counter on page load
        updatePromptCounter();
    }

    if (elements.startFromInput) elements.startFromInput.addEventListener('input', () => chrome.storage.local.set({ startFrom: elements.startFromInput.value }));

    // Save autoDownload state when toggled
    if (elements.autoDownloadCheckbox) {
        elements.autoDownloadCheckbox.addEventListener('change', () => {
            chrome.storage.local.set({ autoDownload: elements.autoDownloadCheckbox.checked });
        });
    }
    if (elements.openDownloadManagerButton) {
        elements.openDownloadManagerButton.addEventListener('click', () => {
            window.parent?.postMessage({ source: 'autoMetaCopy', type: 'OPEN_FLOATING_MANAGER', tab: 'queue' }, '*');
        });
    }
    if (elements.openMediaGalleryButton) {
        elements.openMediaGalleryButton.addEventListener('click', () => {
            window.parent?.postMessage({ source: 'autoMetaCopy', type: 'OPEN_FLOATING_MANAGER', tab: 'queue' }, '*');
        });
    }
    if (elements.fitDownloadManagerButton) {
        elements.fitDownloadManagerButton.addEventListener('click', () => {
            window.parent?.postMessage({ source: 'autoMetaCopy', type: 'FLOATING_FIT_TO_SCREEN' }, '*');
        });
    }
    if (elements.downloadFolderInput) {
        elements.downloadFolderInput.addEventListener('input', () => {
            chrome.storage.local.set({ downloadFolder: elements.downloadFolderInput.value });
        });
    }
    if (elements.generationFlowSelector) {
        elements.generationFlowSelector.addEventListener('change', () => {
            chrome.storage.local.set({ generationFlow: elements.generationFlowSelector.value });
        });
    }

    // Settings Toggle
    const toggleSettings = () => {
        const content = document.getElementById('settingsContent');
        const chevron = document.getElementById('settingsChevron');
        if (content) content.classList.toggle('open');
        if (chevron) chevron.classList.toggle('rotate-180');
    };
    if (elements.settingsHeader) elements.settingsHeader.addEventListener('click', toggleSettings);
    if (elements.headerSettingsBtn) elements.headerSettingsBtn.addEventListener('click', toggleSettings);

    if (elements.navigateToFlowButton) elements.navigateToFlowButton.addEventListener('click', callbacks.onNavigate);

    const showPage = (pageName) => {
        const isGallery = pageName === 'gallery';
        const isFailed = pageName === 'failed';
        if (elements.automationPage) elements.automationPage.style.display = (!isGallery && !isFailed) ? 'flex' : 'none';
        if (elements.failedPromptsPage) elements.failedPromptsPage.style.display = isFailed ? 'flex' : 'none';
        if (elements.galleryPage) elements.galleryPage.style.display = isGallery ? 'flex' : 'none';
        if (elements.automationPageTab) elements.automationPageTab.classList.toggle('active', !isGallery && !isFailed);
        if (elements.failedPromptsTopTab) elements.failedPromptsTopTab.classList.toggle('active', isFailed);
        if (elements.galleryPageTab) elements.galleryPageTab.classList.toggle('active', isGallery);
        if (elements.bottomBar) elements.bottomBar.style.display = isGallery ? 'none' : 'flex';
        chrome.storage.local.set({ activePage: pageName });
    };
    if (elements.automationPageTab) elements.automationPageTab.addEventListener('click', () => showPage('automation'));
    if (elements.failedPromptsTopTab) elements.failedPromptsTopTab.addEventListener('click', () => showPage('failed'));
    if (elements.galleryPageTab) elements.galleryPageTab.addEventListener('click', () => showPage('gallery'));

    // Speed Preset Handler
    if (elements.speedPresetSelector) {
        elements.speedPresetSelector.addEventListener('change', (e) => {
            applySpeedPreset(e.target.value, elements);
        });
    }

    // Language Selector
    if (elements.languageSelector) {
        elements.languageSelector.addEventListener('change', (e) => {
            const lang = e.target.value;
            setGlobalLang(lang);
            updateLanguageUI(lang);
            chrome.storage.local.set({ language: lang });
        });
    }

    // Save advanced settings to storage
    if (elements.minInitialWait_image) elements.minInitialWait_image.addEventListener('input', () =>
        chrome.storage.local.set({ minInitialWait_image: elements.minInitialWait_image.value }));
    if (elements.maxInitialWait_image) elements.maxInitialWait_image.addEventListener('input', () =>
        chrome.storage.local.set({ maxInitialWait_image: elements.maxInitialWait_image.value }));
    if (elements.minInitialWait_text) elements.minInitialWait_text.addEventListener('input', () =>
        chrome.storage.local.set({ minInitialWait_text: elements.minInitialWait_text.value }));
    if (elements.maxInitialWait_text) elements.maxInitialWait_text.addEventListener('input', () =>
        chrome.storage.local.set({ maxInitialWait_text: elements.maxInitialWait_text.value }));

    // Post-Download Wait
    const postDownloadWaitInput = document.getElementById('postDownloadWait');
    if (postDownloadWaitInput) {
        postDownloadWaitInput.addEventListener('input', () =>
            chrome.storage.local.set({ postDownloadWait: postDownloadWaitInput.value }));
    }

    // Generation Wait
    const generationWaitInput = document.getElementById('generationWait');
    if (generationWaitInput) {
        generationWaitInput.addEventListener('input', () =>
            chrome.storage.local.set({ generationWait: generationWaitInput.value }));
    }

    // Optional Create page refresh after prompt submit
    const refreshAfterPromptToggle = document.getElementById('refreshAfterPromptToggle');
    if (refreshAfterPromptToggle) {
        refreshAfterPromptToggle.addEventListener('change', () => {
            const delayInput = document.getElementById('refreshAfterPromptWait');
            const currentDelay = Math.max(10, Number(delayInput?.value) || 0);
            const nextDelay = refreshAfterPromptToggle.checked && currentDelay < 20 ? 20 : currentDelay || 20;
            if (delayInput) delayInput.value = nextDelay;
            chrome.storage.local.set({
                refreshAfterPrompt: refreshAfterPromptToggle.checked,
                autoRefreshAfterPrompt: refreshAfterPromptToggle.checked,
                refreshAfterPromptWait: nextDelay,
                autoRefreshDelay: nextDelay
            });
        });
    }

    const refreshAfterPromptWaitInput = document.getElementById('refreshAfterPromptWait');
    if (refreshAfterPromptWaitInput) {
        refreshAfterPromptWaitInput.addEventListener('input', () => {
            const clamped = Math.max(10, Number(refreshAfterPromptWaitInput.value) || 20);
            if (String(refreshAfterPromptWaitInput.value) !== String(clamped)) refreshAfterPromptWaitInput.value = clamped;
            chrome.storage.local.set({
                refreshAfterPromptWait: clamped,
                autoRefreshDelay: clamped
            });
        });
    }
    const autoDownloadModeInput = document.getElementById('autoDownloadMode');
    if (autoDownloadModeInput) {
        autoDownloadModeInput.addEventListener('change', () =>
            chrome.storage.local.set({ autoDownloadMode: autoDownloadModeInput.value }));
    }
    const autoArchiveSessionToggle = document.getElementById('autoArchiveSessionToggle');
    if (autoArchiveSessionToggle) {
        autoArchiveSessionToggle.addEventListener('change', () =>
            chrome.storage.local.set({ autoArchiveSession: autoArchiveSessionToggle.checked }));
    }
    const scanSpeedInput = document.getElementById('scanSpeed');
    if (scanSpeedInput) {
        scanSpeedInput.addEventListener('change', () =>
            chrome.storage.local.set({ scanSpeed: scanSpeedInput.value }));
    }

    [
        ['preserveSessionAfterRefresh', 'checkbox'],
        ['thumbnailMode', 'select'],
        ['detectTimeoutMinutes', 'number'],
        ['retryOnTimeout', 'checkbox'],
        ['maxRetryAttempts', 'number'],
        ['retryRecentGraceSec', 'number'],
        ['retryOldPromptWindow', 'number'],
        ['retryPartialPrompts', 'checkbox'],
        ['maxPerPromptRetries', 'number'],
        ['perAttemptMinTimeoutSec', 'number'],
        ['perAttemptTimeoutSec', 'number'],
        ['captureFirstFrame', 'checkbox']
    ].forEach(([id, type]) => {
        const el = document.getElementById(id);
        if (!el) return;
        const eventName = type === 'number' ? 'input' : 'change';
        el.addEventListener(eventName, () => {
            let value = type === 'checkbox' ? el.checked : el.value;
            if (id === 'perAttemptMinTimeoutSec' || id === 'perAttemptTimeoutSec') {
                value = Math.max(10, Math.min(300, Number(value) || 60));
                if (String(el.value) !== String(value)) el.value = value;
                const minEl = document.getElementById('perAttemptMinTimeoutSec');
                const maxEl = document.getElementById('perAttemptTimeoutSec');
                if (minEl && maxEl) {
                    let minVal = Math.max(10, Math.min(300, Number(minEl.value) || 60));
                    let maxVal = Math.max(10, Math.min(300, Number(maxEl.value) || 60));
                    if (minVal > maxVal) {
                        if (id === 'perAttemptMinTimeoutSec') maxVal = minVal;
                        else minVal = maxVal;
                        minEl.value = minVal;
                        maxEl.value = maxVal;
                    }
                    chrome.storage.local.set({ perAttemptMinTimeoutSec: minVal, perAttemptTimeoutSec: maxVal });
                    return;
                }
            }
            chrome.storage.local.set({ [id]: value });
        });
    });

    // Image Generation Select
    const imageGenSelectInput = document.getElementById('imageGenerationSelect');
    if (imageGenSelectInput) {
        imageGenSelectInput.addEventListener('change', () =>
            chrome.storage.local.set({ imageGenerationSelect: imageGenSelectInput.value }));
    }

    // Video Generation Select
    const videoGenSelectInput = document.getElementById('videoGenerationSelect');
    if (videoGenSelectInput) {
        videoGenSelectInput.addEventListener('change', () =>
            chrome.storage.local.set({ videoGenerationSelect: videoGenSelectInput.value }));
    }
    const secondaryVideoGenSelectInput = document.getElementById('secondaryVideoGenerationSelect');
    if (secondaryVideoGenSelectInput) {
        secondaryVideoGenSelectInput.addEventListener('change', () =>
            chrome.storage.local.set({ secondaryVideoGenerationSelect: secondaryVideoGenSelectInput.value }));
    }

    // Refresh After All Done toggle — auto-save on change
    const refreshAfterAllDoneToggle = document.getElementById('refreshAfterAllDoneToggle');
    if (refreshAfterAllDoneToggle) {
        refreshAfterAllDoneToggle.addEventListener('change', () =>
            chrome.storage.local.set({ refreshAfterAllDone: refreshAfterAllDoneToggle.checked }));
    }

    // Validation Warnings for Low Values
    function validateWaitInput(input, minSafe) {
        const value = parseInt(input.value);
        if (value < minSafe) {
            input.classList.add('warning');
            // Show warning icon if not already present
            if (!input.nextElementSibling || !input.nextElementSibling.classList.contains('warning-icon')) {
                const icon = document.createElement('span');
                icon.className = 'material-symbols-rounded warning-icon';
                icon.textContent = 'warning';
                icon.title = `⚠️ Kam value risky hai! Minimum ${minSafe}s recommended.`;
                input.parentNode.insertBefore(icon, input.nextSibling);
            }
        } else {
            input.classList.remove('warning');
            // Remove warning icon
            if (input.nextElementSibling && input.nextElementSibling.classList.contains('warning-icon')) {
                input.nextElementSibling.remove();
            }
        }
    }

    // Attach validation to wait time inputs
    const waitInputs = [
        { id: 'imageUploadDelayInput', minSafe: 5 },
        { id: 'minInitialWaitTime', minSafe: 7 },
        { id: 'maxInitialWaitTime', minSafe: 10 },
        { id: 'minInitialWait_image', minSafe: 7 },
        { id: 'maxInitialWait_image', minSafe: 10 },
        { id: 'minInitialWait_text', minSafe: 10 },
        { id: 'maxInitialWait_text', minSafe: 15 },
        { id: 'refreshAfterPromptWait', minSafe: 10 }
    ];

    waitInputs.forEach(({ id, minSafe }) => {
        const input = document.getElementById(id);
        if (input) {
            input.addEventListener('input', () => validateWaitInput(input, minSafe));
            // Validate on load
            validateWaitInput(input, minSafe);
        }
    });

    // --- LOG BUTTONS LOGIC ---
    const copyBtn = document.getElementById('copyLogBtn');
    const clearBtn = document.getElementById('clearLogBtn');

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            const display = document.getElementById('logDisplay');
            if (display) display.innerHTML = '';
            chrome.storage.local.remove('autoMetaCopy_activityLog');
        });
    }

    if (copyBtn) {
        copyBtn.addEventListener('click', async () => {
            const logText = document.getElementById('logDisplay')?.innerText || "";
            if (!logText) return;

            const showSuccess = () => {
                const icon = copyBtn.querySelector('span');
                if (!icon) return;
                icon.innerText = 'check';
                icon.style.color = '#10B981';
                setTimeout(() => {
                    icon.innerText = 'content_copy';
                    icon.style.color = '';
                }, 1500);
            };

            let copied = false;

            // Method 1: Clipboard API
            try {
                if (navigator.clipboard && navigator.clipboard.writeText) {
                    await navigator.clipboard.writeText(logText);
                    showSuccess();
                    copied = true;
                }
            } catch (e) {
                console.warn("Clipboard API failed:", e);
            }

            // Method 2: execCommand fallback
            if (!copied) {
                try {
                    const textArea = document.createElement("textarea");
                    textArea.value = logText;
                    textArea.style.position = "fixed";
                    textArea.style.opacity = "0";
                    document.body.appendChild(textArea);
                    textArea.focus();
                    textArea.select();
                    copied = document.execCommand('copy');
                    document.body.removeChild(textArea);
                    if (copied) showSuccess();
                } catch (e) {
                    console.warn("execCommand copy failed:", e);
                }
            }

            // Method 3: Save as .txt file (guaranteed to work)
            if (!copied) {
                try {
                    const blob = new Blob([logText], { type: 'text/plain' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `auto_meta_log_${Date.now()}.txt`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    showSuccess();
                } catch (e) {
                    console.error("All copy methods failed:", e);
                }
            }
        });
    }

    await loadSettings(elements);
    callbacks.checkVisibility();
    setTimeout(() => updateConfigurationVisibility(elements), 500);

    // ── AI Auto-Retry Toggle + Gemini Overlay logic ───────────────────────────
    initAiRetryToggle();
    initRetryEnabledToggle();

    return elements;
}

// STRICT UI RULE: Configuration panel visibility
// MOUNT if: promptText.length > 0 AND images.length === 0
// UNMOUNT if: images.length > 0 OR promptText.length === 0
function updateConfigurationVisibility(elements) {
    if (!elements.configContainer) return;

    const hasImages = state.imageFileList && state.imageFileList.length > 0;
    const promptVal = elements.promptsTextarea ? elements.promptsTextarea.value.trim() : "";
    const hasPrompts = promptVal.length > 0;

    // CASE 1: NO PROMPT -> HIDE ALL (and Block Start in core.js)
    if (!hasPrompts) {
        unmountConfiguration(elements);
        return;
    }

    // CASE 3: PROMPT + IMAGE -> HIDE CONFIG (Force Image->Video)
    if (hasImages) {
        unmountConfiguration(elements);
        return;
    }

    // CASE 2: PROMPT ONLY -> SHOW CONFIG
    mountConfiguration(elements);
}

function mountConfiguration(elements) {
    if (elements.configContainer.innerHTML.trim() !== "") return; // Already mounted

    elements.configContainer.innerHTML = CONFIG_HTML;

    // --- STATE VARIABLES ---
    let outputMode = "video"; // default
    let aspectRatio = "9:16"; // hidden default for compatibility

    // --- ELEMENTS (must be after innerHTML is set) ---
    const btnVideo    = document.getElementById('mode-video');
    const btnImage    = document.getElementById('mode-image');
    const videoRatioRow = document.getElementById('videoRatioRow');
    const imageRatioRow = document.getElementById('imageRatioRow');
    const videoRatioSel = document.getElementById('videoAspectRatioSelector');
    const imageRatioSel = document.getElementById('imageAspectRatioSelector');

    // --- UPDATE ACTIVE MODE (buttons + ratio row visibility) ---
    const setActiveMode = () => {
        if (btnVideo) btnVideo.classList.toggle('active', outputMode === 'video');
        if (btnImage) btnImage.classList.toggle('active', outputMode === 'image');
        // Show correct ratio row
        if (videoRatioRow) videoRatioRow.style.display = outputMode === 'video' ? 'flex' : 'none';
        if (imageRatioRow) imageRatioRow.style.display = outputMode === 'image' ? 'flex' : 'none';
    };

    // --- READ ACTIVE RATIO FROM VISIBLE SELECTOR ---
    const updateAspectRatio = () => {
        if (outputMode === 'image' && imageRatioSel) aspectRatio = imageRatioSel.value;
        else if (videoRatioSel) aspectRatio = videoRatioSel.value;
    };

    // --- SAVE STATE ---
    const saveState = () => {
        updateAspectRatio();
        chrome.storage.local.set({
            outputMode,
            aspectRatio,
            videoAspectRatio: videoRatioSel?.value || '9:16',
            imageAspectRatio: imageRatioSel?.value || '9:16'
        });

        // Inject hidden inputs so core.js DOM reads still work
        let hiddenMode = document.getElementById('outputModeSelector');
        if (!hiddenMode) {
            hiddenMode = document.createElement('input');
            hiddenMode.id = 'outputModeSelector';
            hiddenMode.type = 'hidden';
            document.getElementById('dynamicConfigCard')?.appendChild(hiddenMode);
        }
        hiddenMode.value = outputMode;

        let hiddenRatio = document.getElementById('aspectRatioSelector');
        if (!hiddenRatio) {
            hiddenRatio = document.createElement('input');
            hiddenRatio.id = 'aspectRatioSelector';
            hiddenRatio.type = 'hidden';
            document.getElementById('dynamicConfigCard')?.appendChild(hiddenRatio);
        }
        hiddenRatio.value = aspectRatio;
    };

    // --- BUTTON LISTENERS ---
    if (btnVideo) btnVideo.onclick = () => {
        outputMode = 'video';
        setActiveMode();
        saveState();
    };

    if (btnImage) btnImage.onclick = () => {
        outputMode = 'image';
        setActiveMode();
        saveState();
    };

    // Ratio dropdown change listeners
    if (videoRatioSel) videoRatioSel.addEventListener('change', saveState);
    if (imageRatioSel) imageRatioSel.addEventListener('change', saveState);

    // --- INITIAL LOAD FROM STORAGE ---
    chrome.storage.local.get(['outputMode', 'aspectRatio', 'videoAspectRatio', 'imageAspectRatio'], (res) => {
        if (res.outputMode) outputMode = res.outputMode;
        if (res.videoAspectRatio && videoRatioSel) videoRatioSel.value = res.videoAspectRatio;
        if (res.imageAspectRatio && imageRatioSel) imageRatioSel.value = res.imageAspectRatio;
        if (res.aspectRatio) aspectRatio = res.aspectRatio;

        setActiveMode(); // show correct button + ratio row
        saveState();     // ensure hidden inputs exist immediately
    });
}


function unmountConfiguration(elements) {
    if (elements.configContainer.innerHTML.trim() === "") return;
    elements.configContainer.innerHTML = "";
}

async function loadSettings(elements) {
    const browserLang = chrome.i18n.getUILanguage().split('-')[0];
    const initialLang = browserLang === 'vi' ? 'vi' : 'en';

    // We used to pass 'defaults' to get() but if we want to be strict,
    // we can request just the keys we care about to see if they exist.
    // However, get(defaults) is standard.

    const defaults = {
        prompts: '',
        startFrom: 1,
        language: initialLang,
        minInitialWait_image: 10,
        maxInitialWait_image: 20,
        minInitialWait_text: 15,
        maxInitialWait_text: 30,
        autoDownload: true,
        autoDownloadMode: 'afterReady',
        autoArchiveSession: false,
        scanSpeed: 'balanced',
        saveGallery: true,
        preserveSessionAfterRefresh: true,
        thumbnailMode: 'hover',
        downloadFolder: 'meta-videos',
        imageSort: 'az',
        imageUploadDelay: 10,
        generationFlow: 'create',
        speedPreset: 'normal',
        postDownloadWait: 3,
        generationWait: 5,
        refreshAfterPrompt: false,
        autoRefreshAfterPrompt: false,
        refreshAfterPromptWait: 20,
        autoRefreshDelay: 20,
        refreshAfterAllDone: false,
        detectTimeoutMinutes: 2,
        retryOnTimeout: true,
        maxRetryAttempts: 3,
        retryRecentGraceSec: 60,
        retryOldPromptWindow: 6,
        retryPartialPrompts: true,
        aiRetryAttemptRetryEnabled: false,
        aiRetryAttemptRetries: 1,
        maxPerPromptRetries: 3,
        perAttemptMinTimeoutSec: 60,
        perAttemptTimeoutSec: 60,
        captureFirstFrame: false,
        imageGenerationSelect: 'auto',
        videoGenerationSelect: 'auto',
        secondaryVideoGenerationSelect: 'auto',
        galleryScanSpeed: 'medium',
        galleryFilter: 'all',
        galleryDateFilter: 'all',
        activePage: 'automation'
    };

    chrome.storage.local.get(null, (result) => {
        // Get EVERYTHING to debug
        // Merge defaults manually to respect existing "" empty strings if set
        const final = { ...defaults, ...result };
        const minTimeoutSec = Number(final.perAttemptMinTimeoutSec);
        const timeoutSec = Number(final.perAttemptTimeoutSec);
        if (!minTimeoutSec || minTimeoutSec < 10 || minTimeoutSec > 300) {
            final.perAttemptMinTimeoutSec = 60;
            chrome.storage.local.set({ perAttemptMinTimeoutSec: 60 });
        }
        if (!timeoutSec || timeoutSec < 10 || timeoutSec > 300 || Number(final.perAttemptMinTimeoutSec) > timeoutSec) {
            final.perAttemptTimeoutSec = Math.max(Number(final.perAttemptMinTimeoutSec) || 60, 60);
            chrome.storage.local.set({ perAttemptTimeoutSec: final.perAttemptTimeoutSec });
        }

        if (elements.promptsTextarea) {
            // PERSISTENCE REMOVED: Always empty on load
            elements.promptsTextarea.value = "";
            updateConfigurationVisibility(elements);
        }
        if (elements.startFromInput) elements.startFromInput.value = final.startFrom;
        if (elements.imageUploadDelayInput) elements.imageUploadDelayInput.value = final.imageUploadDelay;
        if (elements.autoDownloadCheckbox) elements.autoDownloadCheckbox.checked = final.autoDownload;
        if (elements.downloadFolderInput) elements.downloadFolderInput.value = final.downloadFolder;
        if (elements.generationFlowSelector) elements.generationFlowSelector.value = final.generationFlow;
        if (elements.galleryScanSpeed) elements.galleryScanSpeed.value = final.galleryScanSpeed;
        if (elements.galleryFilter) elements.galleryFilter.value = final.galleryFilter;
        if (elements.galleryDateFilter) elements.galleryDateFilter.value = final.galleryDateFilter;
        if (elements.galleryCalendarDate && typeof final.galleryDateFilter === 'string' && final.galleryDateFilter.startsWith('calendar:')) {
            elements.galleryCalendarDate.value = final.galleryDateFilter.slice(9);
        }
        if (elements.imageSortSelector) elements.imageSortSelector.value = final.imageSort;
        if (elements.speedPresetSelector) elements.speedPresetSelector.value = final.speedPreset;

        // Load advanced settings
        if (elements.minInitialWait_image) elements.minInitialWait_image.value = final.minInitialWait_image;
        if (elements.maxInitialWait_image) elements.maxInitialWait_image.value = final.maxInitialWait_image;
        if (elements.minInitialWait_text) elements.minInitialWait_text.value = final.minInitialWait_text;
        if (elements.maxInitialWait_text) elements.maxInitialWait_text.value = final.maxInitialWait_text;
        if (elements.languageSelector) elements.languageSelector.value = final.language;

        // Load Post-Download Wait
        const postDownloadWaitInput = document.getElementById('postDownloadWait');
        if (postDownloadWaitInput) postDownloadWaitInput.value = final.postDownloadWait;

        // Load Generation Wait
        const generationWaitInput = document.getElementById('generationWait');
        if (generationWaitInput) generationWaitInput.value = final.generationWait;

        const refreshAfterPromptToggle = document.getElementById('refreshAfterPromptToggle');
        if (refreshAfterPromptToggle) {
            refreshAfterPromptToggle.checked = final.autoRefreshAfterPrompt === true || final.autoRefreshAfterPrompt === 'true' || final.refreshAfterPrompt === true || final.refreshAfterPrompt === 'true';
        }

        const refreshAfterPromptWaitInput = document.getElementById('refreshAfterPromptWait');
        if (refreshAfterPromptWaitInput) refreshAfterPromptWaitInput.value = Math.max(10, Number(result.autoRefreshDelay !== undefined ? final.autoRefreshDelay : final.refreshAfterPromptWait) || 20);
        const autoDownloadModeInput = document.getElementById('autoDownloadMode');
        if (autoDownloadModeInput) {
            const normalizedMode = (final.autoDownloadMode === 'afterAllReadyZip' || final.autoDownloadMode === 'afterAllComplete-zip')
                ? 'afterAllReadyZip'
                : 'afterReady';
            autoDownloadModeInput.value = normalizedMode;
            if (final.autoDownloadMode !== normalizedMode) chrome.storage.local.set({ autoDownloadMode: normalizedMode });
        }
        const autoArchiveSessionToggle = document.getElementById('autoArchiveSessionToggle');
        if (autoArchiveSessionToggle) autoArchiveSessionToggle.checked = final.autoArchiveSession === true || final.autoArchiveSession === 'true';
        const scanSpeedInput = document.getElementById('scanSpeed');
        if (scanSpeedInput) scanSpeedInput.value = final.scanSpeed;
        const preserveSessionAfterRefreshInput = document.getElementById('preserveSessionAfterRefresh');
        if (preserveSessionAfterRefreshInput) preserveSessionAfterRefreshInput.checked = final.preserveSessionAfterRefresh !== false && final.preserveSessionAfterRefresh !== 'false';
        const thumbnailModeInput = document.getElementById('thumbnailMode');
        if (thumbnailModeInput) thumbnailModeInput.value = final.thumbnailMode === 'selected' ? 'hover' : final.thumbnailMode;

        [
            ['detectTimeoutMinutes', 'value'],
            ['maxRetryAttempts', 'value'],
            ['retryRecentGraceSec', 'value'],
            ['retryOldPromptWindow', 'value'],
            ['maxPerPromptRetries', 'value'],
            ['perAttemptMinTimeoutSec', 'value'],
            ['perAttemptTimeoutSec', 'value']
        ].forEach(([id]) => {
            const el = document.getElementById(id);
            if (el && final[id] !== undefined) el.value = final[id];
        });
        [
            'retryOnTimeout',
            'retryPartialPrompts',
            'captureFirstFrame'
        ].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.checked = final[id] === true || final[id] === 'true';
        });

        // Load Image Generation Select
        const imageGenSelectInput = document.getElementById('imageGenerationSelect');
        if (imageGenSelectInput) imageGenSelectInput.value = final.imageGenerationSelect;

        // Load Video Generation Select
        const videoGenSelectInput = document.getElementById('videoGenerationSelect');
        if (videoGenSelectInput) videoGenSelectInput.value = final.videoGenerationSelect;
        const secondaryVideoGenSelectInput = document.getElementById('secondaryVideoGenerationSelect');
        if (secondaryVideoGenSelectInput) secondaryVideoGenSelectInput.value = final.secondaryVideoGenerationSelect;

        // Load refreshAfterAllDone toggle
        const refreshAfterAllDoneToggleEl = document.getElementById('refreshAfterAllDoneToggle');
        if (refreshAfterAllDoneToggleEl) refreshAfterAllDoneToggleEl.checked = !!final.refreshAfterAllDone;

        // Load AI Auto-Retry toggle
        const aiRetryToggleEl = document.getElementById('aiRetryToggle');
        if (aiRetryToggleEl) aiRetryToggleEl.checked = final.aiRetryEnabled === true || final.aiRetryEnabled === 'true';

        // Load Max Retry Attempts (visible input) — synced with hidden maxPerPromptRetries
        const maxRetryVisible = document.getElementById('maxRetryAttemptsVisible');
        const maxRetryHidden  = document.getElementById('maxPerPromptRetries');
        const savedMaxRetry   = parseInt(final.maxPerPromptRetries ?? 3, 10);
        if (maxRetryVisible) maxRetryVisible.value = savedMaxRetry;
        if (maxRetryHidden)  maxRetryHidden.value  = savedMaxRetry;

        setGlobalLang(final.language);
        updateLanguageUI(final.language);

        const isGallery = final.activePage === 'gallery';
        const isFailed = final.activePage === 'failed';
        if (elements.automationPage) elements.automationPage.style.display = (!isGallery && !isFailed) ? 'flex' : 'none';
        if (elements.failedPromptsPage) elements.failedPromptsPage.style.display = isFailed ? 'flex' : 'none';
        if (elements.galleryPage) elements.galleryPage.style.display = isGallery ? 'flex' : 'none';
        if (elements.automationPageTab) elements.automationPageTab.classList.toggle('active', !isGallery && !isFailed);
        if (elements.failedPromptsTopTab) {
            elements.failedPromptsTopTab.style.display = 'flex';
            elements.failedPromptsTopTab.classList.toggle('active', isFailed);
        }
        if (elements.galleryPageTab) elements.galleryPageTab.classList.toggle('active', isGallery);
        if (elements.bottomBar) elements.bottomBar.style.display = isGallery ? 'none' : 'flex';
    });

}


// ── Retry Engine Toggle → show/hide Max Retries sub-row ──────────────────
function initRetryEnabledToggle() {
    const toggle    = document.getElementById('retryEnabledToggle');
    const subRow    = document.getElementById('retryMaxSubRow');
    const maxInput  = document.getElementById('maxRetryAttemptsVisible');
    const hiddenMax = document.getElementById('maxPerPromptRetries');
    if (!toggle || !subRow || !maxInput) return;

    function syncVisibility() {
        const on = toggle.checked;
        subRow.style.display = on ? 'block' : 'none';

        if (!on) {
            // Retry disabled → save 0 to storage
            if (hiddenMax) hiddenMax.value = '0';
            chrome.storage.local.set({ maxPerPromptRetries: 0 });
        } else {
            // Retry enabled → restore visible value
            const val = Math.max(1, parseInt(maxInput.value) || 3);
            maxInput.value = val;
            if (hiddenMax) hiddenMax.value = String(val);
            chrome.storage.local.set({ maxPerPromptRetries: val });
        }
    }

    // Load saved state
    chrome.storage.local.get({ retryEnabled: true, maxPerPromptRetries: 3 }, (data) => {
        toggle.checked = data.retryEnabled !== false && data.maxPerPromptRetries > 0;
        if (data.maxPerPromptRetries > 0) maxInput.value = data.maxPerPromptRetries;
        syncVisibility();
    });

    toggle.addEventListener('change', () => {
        chrome.storage.local.set({ retryEnabled: toggle.checked });
        syncVisibility();
    });

    maxInput.addEventListener('change', () => {
        const val = Math.max(1, parseInt(maxInput.value) || 3);
        maxInput.value = val;
        if (hiddenMax) hiddenMax.value = String(val);
        chrome.storage.local.set({ maxPerPromptRetries: val });
    });
}

// ── AI Auto-Retry Toggle & Key Overlay ─────────────────────────────────────
function initAiRetryToggle() {
    const toggle      = document.getElementById('aiRetryToggle');
    const overlay     = document.getElementById('geminiApiKeyOverlay');
    const keyInput    = document.getElementById('geminiApiKeyInput');
    const saveBtn     = document.getElementById('geminiKeySaveBtn');
    const cancelBtn   = document.getElementById('geminiKeyCancelBtn');
    const keyError    = document.getElementById('geminiKeyError');
    const keyValidating = document.getElementById('geminiKeyValidating');
    const subSettings = document.getElementById('aiRetrySubSettings');
    const detectWait  = document.getElementById('aiRetryDetectWait');
    const attemptToggle = document.getElementById('aiRetryAttemptToggle');
    const attemptCountRow = document.getElementById('aiRetryAttemptCountRow');
    const attemptRetries = document.getElementById('aiRetryAttemptRetries');
    const modelSelect = document.getElementById('aiRetryModel');
    const changeKeyBtn = document.getElementById('changeAiApiKeyBtn');
    const statusPanel = document.getElementById('aiRetryStatusPanel');
    const failedTopTab = document.getElementById('failedPromptsTopTab');

    if (!toggle || !overlay) return;

    // ── Show/hide sub-settings based on toggle state ──
    function syncSubSettings() {
        if (!subSettings) return;
        subSettings.style.display = toggle.checked ? 'flex' : 'none';
        if (failedTopTab) {
            failedTopTab.style.display = toggle.checked ? 'flex' : 'none';
        }
        if (!toggle.checked && statusPanel) {
            statusPanel.style.display = 'none';
        }
    }

    // ── Load persisted AI settings into UI ──
    async function loadAiSettings() {
        const data = await chrome.storage.local.get({
            aiRetryEnabled: false,
            aiRetryRounds: 3,
            aiRetryModel: 'deepseek',
            aiRetryDetectWait: 180,
            aiRetryAttemptRetryEnabled: false,
            aiRetryAttemptRetries: 1
        });
        toggle.checked = !!data.aiRetryEnabled;
        if (modelSelect) modelSelect.value = ['qwen', 'deepseek'].includes(data.aiRetryModel) ? data.aiRetryModel : 'deepseek';
        if (detectWait) detectWait.value = String(data.aiRetryDetectWait || 180);
        if (attemptToggle) attemptToggle.checked = data.aiRetryAttemptRetryEnabled === true;
        if (attemptRetries) attemptRetries.value = String(Math.max(1, Math.min(2, Number(data.aiRetryAttemptRetries) || 1)));
        if (attemptCountRow) attemptCountRow.style.display = attemptToggle?.checked ? 'flex' : 'none';
        await chrome.storage.local.set({ aiRetryRounds: 3 });
        syncSubSettings();
    }

    loadAiSettings();

    // ── Auto-save rounds setting ──
    // ── Auto-save detection wait setting ──
    if (detectWait) {
        detectWait.addEventListener('change', () => {
            const val = Math.max(30, parseInt(detectWait.value, 10) || 180);
            detectWait.value = val;
            chrome.storage.local.set({ aiRetryDetectWait: val });
            logMessage(`AI Detection Wait set to ${val}s.`, 'info');
        });
    }

    if (modelSelect) {
        modelSelect.addEventListener('change', () => {
            const modelId = ['qwen', 'deepseek'].includes(modelSelect.value) ? modelSelect.value : 'deepseek';
            chrome.storage.local.set({ aiRetryModel: modelId });
            logMessage(`AI Auto-Retry model set to ${getAiRetryModelLabel(modelId)}.`, 'info');
        });
    }

    if (attemptToggle) {
        attemptToggle.addEventListener('change', () => {
            const enabled = attemptToggle.checked;
            if (attemptCountRow) attemptCountRow.style.display = enabled ? 'flex' : 'none';
            const retries = Math.max(1, Math.min(2, parseInt(attemptRetries?.value, 10) || 1));
            if (attemptRetries) attemptRetries.value = String(retries);
            chrome.storage.local.set({
                aiRetryAttemptRetryEnabled: enabled,
                aiRetryAttemptRetries: retries
            });
            logMessage(enabled
                ? `AI edited prompt extra retries enabled (${retries}).`
                : 'AI edited prompt extra retries disabled.',
                'info');
        });
    }

    if (attemptRetries) {
        attemptRetries.addEventListener('change', () => {
            const retries = Math.max(1, Math.min(2, parseInt(attemptRetries.value, 10) || 1));
            attemptRetries.value = String(retries);
            chrome.storage.local.set({ aiRetryAttemptRetries: retries });
            logMessage(`AI edited prompt extra retries set to ${retries}.`, 'info');
        });
    }

    function showOverlay() {
        if (keyInput) keyInput.value = '';
        if (keyError) keyError.textContent = '';
        if (keyInput) keyInput.classList.remove('key-valid', 'key-invalid');
        overlay.classList.add('active');
        setTimeout(() => keyInput?.focus(), 100);
    }
    function hideOverlay() {
        overlay.classList.remove('active');
    }

    toggle.addEventListener('change', async () => {
        if (!toggle.checked) {
            await chrome.storage.local.set({ aiRetryEnabled: false });
            syncSubSettings();
            return;
        }
        const data = await chrome.storage.local.get('geminiApiKey');
        if (data.geminiApiKey && data.geminiApiKey.length > 10) {
            await chrome.storage.local.set({ aiRetryEnabled: true, aiRetryRounds: 3 });
            syncSubSettings();
            logMessage('AI Auto-Retry enabled (API key found).', 'success');
        } else {
            toggle.checked = false;
            syncSubSettings();
            showOverlay();
        }
    });

    if (changeKeyBtn) {
        changeKeyBtn.addEventListener('click', () => {
            showOverlay();
        });
    }

    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const key = keyInput?.value?.trim();
            if (!key || key.length < 10) {
                if (keyError) keyError.textContent = 'Please enter a valid API key.';
                if (keyInput) keyInput.classList.add('key-invalid');
                return;
            }
            if (keyValidating) keyValidating.style.display = 'flex';
            if (keyError) keyError.textContent = '';
            saveBtn.disabled = true;
            if (keyInput) keyInput.classList.remove('key-valid', 'key-invalid');

            const modelId = modelSelect?.value || 'deepseek';
            const result = await validateGeminiApiKey(key, modelId);

            if (keyValidating) keyValidating.style.display = 'none';
            saveBtn.disabled = false;

            if (!result.valid) {
                if (keyError) keyError.textContent = result.error || 'Invalid API key.';
                if (keyInput) keyInput.classList.add('key-invalid');
                return;
            }
            if (keyInput) keyInput.classList.add('key-valid');
            await chrome.storage.local.set({ geminiApiKey: key, aiRetryEnabled: true, aiRetryRounds: 3, aiRetryModel: modelId });
            toggle.checked = true;
            syncSubSettings();
            logMessage(`${getAiRetryModelLabel(modelId)} API key saved. AI Auto-Retry enabled!`, 'success');
            setTimeout(() => hideOverlay(), 400);
        });
    }

    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            toggle.checked = false;
            syncSubSettings();
            chrome.storage.local.set({ aiRetryEnabled: false });
            hideOverlay();
        });
    }

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) {
            toggle.checked = false;
            syncSubSettings();
            chrome.storage.local.set({ aiRetryEnabled: false });
            hideOverlay();
        }
    });

    if (keyInput) {
        keyInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') saveBtn?.click();
        });
    }
}


// Speed Preset Application Function
function applySpeedPreset(preset, elements) {
    const presets = {
        normal: {
            imageUploadDelay: 10,
            minInitialWaitTime: 10,
            maxInitialWaitTime: 20,
            minInitialWait_image: 10,
            maxInitialWait_image: 20,
            minInitialWait_text: 15,
            maxInitialWait_text: 30
        },
        fast: {
            imageUploadDelay: 7,
            minInitialWaitTime: 7,
            maxInitialWaitTime: 12,
            minInitialWait_image: 7,
            maxInitialWait_image: 12,
            minInitialWait_text: 10,
            maxInitialWait_text: 18
        },
        ultra: {
            imageUploadDelay: 5,
            minInitialWaitTime: 5,
            maxInitialWaitTime: 8,
            minInitialWait_image: 5,
            maxInitialWait_image: 8,
            minInitialWait_text: 5,
            maxInitialWait_text: 10
        }
    };

    const config = presets[preset] || presets.normal;

    // Apply to UI
    if (elements.imageUploadDelayInput) elements.imageUploadDelayInput.value = config.imageUploadDelay;

    const minWaitInput = document.getElementById('minInitialWaitTime');
    const maxWaitInput = document.getElementById('maxInitialWaitTime');
    if (minWaitInput) minWaitInput.value = config.minInitialWaitTime;
    if (maxWaitInput) maxWaitInput.value = config.maxInitialWaitTime;

    if (elements.minInitialWait_image) elements.minInitialWait_image.value = config.minInitialWait_image;
    if (elements.maxInitialWait_image) elements.maxInitialWait_image.value = config.maxInitialWait_image;
    if (elements.minInitialWait_text) elements.minInitialWait_text.value = config.minInitialWait_text;
    if (elements.maxInitialWait_text) elements.maxInitialWait_text.value = config.maxInitialWait_text;

    // Save to storage
    chrome.storage.local.set({
        speedPreset: preset,
        imageUploadDelay: config.imageUploadDelay,
        minInitialWait_image: config.minInitialWait_image,
        maxInitialWait_image: config.maxInitialWait_image,
        minInitialWait_text: config.minInitialWait_text,
        maxInitialWait_text: config.maxInitialWait_text
    });

    logMessage(`Speed preset applied: ${preset.toUpperCase()}`, 'success');
}

export function updateLanguageUI(lang) {
    const langDict = translations[lang] || translations['en'];
    const fallbackDict = translations['en'] || {};
    document.querySelectorAll('[data-lang-key]').forEach(el => {
        const key = el.getAttribute('data-lang-key');
        if (langDict[key]) {
            el.innerText = langDict[key];
        } else if (fallbackDict[key]) {
            el.innerText = fallbackDict[key];
        }
    });

    // Config Panel Translations (Dynamic)
    const modeLabel = document.querySelector('.setting-name');
    if (modeLabel && modeLabel.innerText === "Output Mode" && lang === 'vi') modeLabel.innerText = "Chế độ đầu ra";

    const prompts = document.getElementById('prompts');
    if (prompts) {
        if (state.imageFileList && state.imageFileList.length > 0) {
            prompts.placeholder = i18n('prompt_placeholder_image');
        } else {
            prompts.placeholder = i18n('prompt_placeholder_text');
        }
    }
}

// UPDATE: Accept isStopped param
export function updateButtonStates(isRunning, isPaused, hasDownloads, isStopped = false) {
    const mainBtn = document.getElementById('mainActionButton');
    const stopBtn = document.getElementById('stopButton');
    const inputs = document.querySelectorAll('input, textarea, select, button:not(#mainActionButton):not(#stopButton):not(#openDownloadManagerButton):not(#openMediaGalleryButton):not(.header-action):not(.page-tab):not(.failed-copy-action):not(.ai-retry-copy-btn)');
    document.body.classList.toggle('automation-running', !!isRunning);

    if (mainBtn) {
        // With auto-reset, isStopped should be false when this is called at end of session.
        // So this block handles the brief moment during stop processing if desired, or if checks persist.
        if (isStopped) {
            mainBtn.disabled = true;
            mainBtn.style.opacity = '0.5';
            mainBtn.style.cursor = 'not-allowed';
        } else {
            mainBtn.disabled = false; // Always enabled if ready/running (Pause available)
            mainBtn.style.opacity = '1';
            mainBtn.style.cursor = 'pointer';
        }

        mainBtn.style.display = 'flex';

        const icon = mainBtn.querySelector('.material-symbols-rounded');
        const text = mainBtn.querySelector('span:last-child');
        if (icon && text) {
            if (isRunning) {
                if (isPaused) {
                    mainBtn.className = 'action-btn paused';
                    icon.innerText = 'play_arrow';
                    text.innerText = "Resume"; // HARDCODED
                } else {
                    mainBtn.className = 'action-btn running';
                    icon.innerText = 'pause';
                    text.innerText = "Pause"; // HARDCODED
                }
            } else {
                mainBtn.className = 'action-btn start';
                icon.innerText = 'play_arrow';
                text.innerText = "Start"; // HARDCODED
            }
        }
    }

    if (stopBtn) {
        if (isRunning) {
            stopBtn.style.display = 'flex';
            stopBtn.disabled = false;
        } else {
            stopBtn.style.display = 'none';
        }
    }

    inputs.forEach(el => {
        el.disabled = isRunning;
    });

    document.querySelectorAll('.page-tab, .failed-copy-action, .ai-retry-copy-btn').forEach(el => {
        el.disabled = false;
        el.style.pointerEvents = 'auto';
        el.style.cursor = 'pointer';
    });
}
