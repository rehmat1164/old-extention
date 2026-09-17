import {
    i18n, logMessage, updateLiveStatus, readFileAsDataURL,
    interruptibleSleep, getRandomWait, setGlobalLang, restoreLogMessages
} from './utils.js';
import {
    initializeUI, updateButtonStates, updateImageSummary,
    updateLanguageUI, syncState
} from './ui.js';
import { SELECTORS_CONFIG_URL, META_MEDIA_URL } from './config.js';
import {
    openDownloadManagerOverlay,
    runRealtimeDetectionScan,
    startQueuedDownloads
} from './download-overlay.js';
import { archiveSessionToHistory, getPreferredOutput, REFRESH_FLAG_KEY, FINAL_REFRESH_FLAG_KEY } from './download-state.js';
import {
    openGateForPrompt, waitForPromptGate, clearAllGates, reportDetectedSlots, GATE_STATUS
} from './prompt-gate.js';
import { callGemini, callGeminiBatch, getAiRetryModelLabel } from './gemini-client.js';


let isRunning = false;
let isPaused = false;
let stopRequested = false;
let isStopped = false;
let imageFileList = [];
let currentIndex = 0;
let promptList = [];
let currentMode = 'image-to-video';
let downloadedMediaSet = new Set();
let createGalleryItems = [];
let createGalleryScanned = false;
let gallerySetupComplete = false;
let createGalleryFilter = 'all';
let createGalleryDateFilter = 'all';
let isGalleryScanning = false;
let activeGalleryScanSession = null;
let resumePendingAfterSubmit = false;
let createRefreshHandoff = false;
let failedDetectionRefreshCount = 0;
let activeCreateBaselineSignatures = [];

// Constants
const META_AI_HOME = "https://www.meta.ai/";
const META_AI_CREATE = "https://www.meta.ai/create";
const STORAGE_KEY = 'autoMetaCopy_resumeState';
const GALLERY_STORAGE_KEY = 'autoMetaCopy_createGallery';
const GALLERY_SETUP_KEY = 'autoMetaCopy_gallerySetupComplete';
const DOWNLOAD_SESSION_KEY = 'autoMetaCopy_downloadSession';
const DETECTED_OUTPUTS_KEY = 'autoMetaCopy_detectedOutputs';
const MANAGER_EVENTS_KEY = 'autoMetaCopy_managerEvents';
const RESUME_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const CREATE_REFRESH_HANDOFF_ERROR = 'AUTO_META_CREATE_REFRESH_HANDOFF';
const DEFAULT_REFRESH_AFTER_PROMPT_WAIT = 20;

syncState({ isRunning, isPaused, imageFileList });

async function getCreateModeConfig() {
    const data = await chrome.storage.local.get({
        outputMode: 'video',
        aspectRatio: '9:16',
        videoAspectRatio: '9:16',
        imageAspectRatio: '9:16'
    });
    const domMode = document.getElementById('outputModeSelector')?.value;
    const outputMode = ['image', 'video'].includes(domMode)
        ? domMode
        : (['image', 'video'].includes(data.outputMode) ? data.outputMode : 'video');
    const domRatio = document.getElementById('aspectRatioSelector')?.value;
    const storedRatio = outputMode === 'image'
        ? (data.imageAspectRatio || data.aspectRatio)
        : (data.videoAspectRatio || data.aspectRatio);
    return {
        outputMode,
        aspectRatio: domRatio || storedRatio || '9:16'
    };
}

function expectedCountForMode(mode) {
    return mode === 'image-to-video' ? 1 : 4;
}

function getPromptForIndex(index) {
    if (!promptList.length) return '';
    if (currentMode === 'image-to-video') {
        return promptList[index] || promptList[index % promptList.length] || '';
    }
    return promptList[index] || '';
}

function getActivePromptListForMode() {
    if (currentMode !== 'image-to-video') return promptList;
    return imageFileList.map((_, index) => getPromptForIndex(index));
}

function getTotalForMode() {
    return currentMode === 'image-to-video' ? imageFileList.length : promptList.length;
}

function isCompletedIdleSession(session) {
    return !!session?.id
        && Array.isArray(session.prompts)
        && session.prompts.length > 0
        && (!!session.completedAt || (session.running === false && session.allPromptsSubmitted === true));
}

function isSessionInProgress(session) {
    if (!session?.id || !Array.isArray(session.prompts) || !session.prompts.length) return false;
    const aiPhase = session.aiRetryState?.phase || '';
    const aiRetryActive = session.aiRetryState?.enabled === true && aiPhase && aiPhase !== 'done';
    return session.active === true
        && session.downloadsDone !== true
        && (!session.completedAt || aiRetryActive)
        && (session.running !== false || session.allPromptsSubmitted === true || aiRetryActive);
}

async function preserveCompletedIdleSession(session) {
    if (!isCompletedIdleSession(session)) return false;
    if (session.active !== true || session.running !== false) {
        await chrome.storage.local.set({
            [DOWNLOAD_SESSION_KEY]: { ...session, active: true, running: false }
        });
    }
    return true;
}

async function preserveCurrentSession(session) {
    if (!session?.id) return false;
    if (session.active !== true) {
        await chrome.storage.local.set({
            [DOWNLOAD_SESSION_KEY]: { ...session, active: true }
        });
    }
    return true;
}

async function maybeAutoArchiveIdleSession(session, source = 'startup') {
    if (!isCompletedIdleSession(session)) return false;

    const pref = await chrome.storage.local.get({ autoArchiveSession: false });
    const enabled = pref.autoArchiveSession === true || pref.autoArchiveSession === 'true';
    if (!enabled) return false;

    await archiveSessionToHistory(session);
    await chrome.storage.local.remove([DOWNLOAD_SESSION_KEY, 'autoMetaCopy_downloadedOutputs', DETECTED_OUTPUTS_KEY]);
    logMessage(`Session auto-archived to history on ${source}.`, 'info');
    return true;
}

// ========== STATE PERSISTENCE (survives page reload) ==========
async function saveAutomationState(extraData = {}) {
    const autoDownloadCheckbox = document.getElementById('autoDownloadCheckbox');
    const modeConfig = await getCreateModeConfig();
    const state = {
        isRunning: true,
        currentIndex,
        currentMode,
        promptList,
        aspectRatio: modeConfig.aspectRatio,
        uploadDelay: parseInt(document.getElementById('imageUploadDelayInput')?.value || '10', 10),
        generationFlow: document.getElementById('generationFlowSelector')?.value || 'create',
        autoDownload: autoDownloadCheckbox ? autoDownloadCheckbox.checked : true,
        downloadFolder: document.getElementById('downloadFolderInput')?.value || 'meta-videos',
        refreshAfterPrompt: document.getElementById('refreshAfterPromptToggle')?.checked || false,
        refreshAfterPromptWait: Math.max(10, parseInt(document.getElementById('refreshAfterPromptWait')?.value || `${DEFAULT_REFRESH_AFTER_PROMPT_WAIT}`, 10)),
        refreshAfterAllDone: document.getElementById('refreshAfterAllDoneToggle')?.checked || false,
        failedDetectionRefreshCount,
        activeCreateBaselineSignatures,
        status: extraData.status || 'running',
        savedAt: Date.now(),
        ...extraData
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: state });
    console.log('[AutoMeta-Copy] State saved. Index:', state.currentIndex, 'Mode:', state.currentMode, 'AutoDL:', state.autoDownload);
}

async function loadAutomationState() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return data[STORAGE_KEY] || null;
}

async function clearAutomationState() {
    await chrome.storage.local.remove(STORAGE_KEY);
    console.log('[AutoMeta-Copy] Saved state cleared.');
}

async function startDownloadSession(preserveStartedAt = false) {
    // Clear gate state for fresh sessions â€” don't clear on resume (gates may still be valid)
    if (!preserveStartedAt) {
        try { await clearAllGates(); } catch (e) { /* non-critical */ }
        lastManagerEventId = '';
    }
    const saved = await chrome.storage.local.get({
        downloadFolder: 'meta-videos',
        imageGenerationSelect: 'auto',
        videoGenerationSelect: 'auto',
        secondaryVideoGenerationSelect: 'auto',
        autoDownload: true,
        autoDownloadMode: 'afterReady',
        autoArchiveSession: false,
        selectionMode: 'default',
        customSelections: {},
        scanSpeed: 'balanced',
        saveGallery: true,
        preserveSessionAfterRefresh: true,
        [DOWNLOAD_SESSION_KEY]: null
    });
    const modeConfig = await getCreateModeConfig();
    const previousSession = saved[DOWNLOAD_SESSION_KEY] || {};
    if (!preserveStartedAt && previousSession?.id && Array.isArray(previousSession.prompts) && previousSession.prompts.length) {
        try {
            await archiveSessionToHistory(previousSession);
            logMessage('Previous session archived to history before starting a new session.', 'info');
        } catch (e) {
            console.warn('[AutoMeta] Could not archive previous session before new start:', e.message);
        }
    }
    const folder = document.getElementById('downloadFolderInput')?.value || saved.downloadFolder || 'meta-videos';
    const imageSelect = document.getElementById('imageGenerationSelect')?.value || saved.imageGenerationSelect || 'auto';
    const videoSelect = document.getElementById('videoGenerationSelect')?.value || saved.videoGenerationSelect || 'auto';
    const secondaryVideoSelect = document.getElementById('secondaryVideoGenerationSelect')?.value || saved.secondaryVideoGenerationSelect || 'auto';
    const autoDownloadEnabled = document.getElementById('autoDownloadCheckbox')?.checked ?? !!saved.autoDownload;
    const rawAutoDownloadMode = document.getElementById('autoDownloadMode')?.value || saved.autoDownloadMode;
    const autoDownloadMode = (rawAutoDownloadMode === 'afterAllReadyZip' || rawAutoDownloadMode === 'afterAllComplete-zip')
        ? 'afterAllReadyZip'
        : 'afterReady';
    const autoArchiveSession = document.getElementById('autoArchiveSessionToggle')?.checked ?? (saved.autoArchiveSession === true || saved.autoArchiveSession === 'true');
    const activePromptList = getActivePromptListForMode();
    const previousPrompts = new Map((previousSession.prompts || []).map(prompt => [Number(prompt.index), prompt]));
    const expectedCount = expectedCountForMode(currentMode);
    const sessionPrompts = activePromptList.map((prompt, index) => {
        const previousPrompt = previousPrompts.get(index) || {};
        const base = {
            index,
            prompt,
            mode: currentMode,
            expected: expectedCount,
            status: preserveStartedAt ? (previousPrompt.status || 'queued') : 'queued',
            outputs: preserveStartedAt && Array.isArray(previousPrompt.outputs) ? previousPrompt.outputs : []
        };
        // Preserve retry & timing fields across page refreshes
        if (preserveStartedAt) {
            base.retryCount = Number(previousPrompt.retryCount || 0);
            base.retryReason = previousPrompt.retryReason || '';
            base.lastRetryAt = previousPrompt.lastRetryAt || null;
            base.submittedAt = previousPrompt.submittedAt || null;
            base.detectedAt = previousPrompt.detectedAt || null;
            base.downloadedAt = previousPrompt.downloadedAt || null;
            base.selectedPosition = previousPrompt.selectedPosition || null;
            base.secondaryPosition = previousPrompt.secondaryPosition || null;
            base.resolvedPosition = previousPrompt.resolvedPosition || null;
            base.resolvedReason = previousPrompt.resolvedReason || '';
        }
        return base;
    });

    // â”€â”€ For FRESH sessions: collect baseline BEFORE saving â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // This ensures old videos already on Meta page are ignored by the detector.
    let sessionBaseline = Array.isArray(previousSession.baselineSignatures) ? previousSession.baselineSignatures : [];
    if (!preserveStartedAt) {
        try {
            const pageBaseline = await injectScript(collectCreateMediaBaselineSignatures, []);
            if (pageBaseline?.signatures?.length) {
                const baseSet = new Set(sessionBaseline);
                pageBaseline.signatures.forEach(sig => baseSet.add(sig));
                sessionBaseline = Array.from(baseSet);
                activeCreateBaselineSignatures = sessionBaseline;
                console.log(`[AutoMeta] Session baseline pre-locked: ${sessionBaseline.length} existing media will be ignored.`);
            }
        } catch (e) {
            console.warn('[AutoMeta] Could not collect baseline signatures:', e.message);
        }
    }

    await chrome.storage.local.set({
        autoDownloadMode,
        autoDownload: autoDownloadEnabled,
        autoArchiveSession,
        ...(preserveStartedAt ? {} : { [MANAGER_EVENTS_KEY]: [] }),
        [DOWNLOAD_SESSION_KEY]: {
            id: preserveStartedAt && previousSession.id ? previousSession.id : `session_${Date.now()}`,
            active: true,
            startedAt: preserveStartedAt && previousSession.startedAt ? previousSession.startedAt : Date.now(),
            aspectRatio: modeConfig.aspectRatio,
            baselineSignatures: sessionBaseline,
            currentIndex,
            folder,
            imageSelect,
            videoSelect,
            secondaryVideoSelect,
            autoDownload: autoDownloadEnabled,
            autoDownloadMode,
            autoArchiveSession,
            settings: {
                autoDownload: autoDownloadEnabled,
                autoDownloadMode,
                autoArchiveSession,
                downloadFolder: folder,
                imageGenerationSelect: imageSelect,
                videoGenerationSelect: videoSelect,
                secondaryVideoGenerationSelect: secondaryVideoSelect,
                customSelections: saved.customSelections || {}
            },
            selectionMode: saved.selectionMode || 'default',
            customSelections: saved.customSelections || {},
            scanSpeed: saved.scanSpeed || 'balanced',
            saveGallery: saved.saveGallery !== false,
            preserveSessionAfterRefresh: saved.preserveSessionAfterRefresh !== false,
            downloadStartRequested: false,
            mode: currentMode,
            prompts: sessionPrompts
        },
        ...(preserveStartedAt ? {} : { [DETECTED_OUTPUTS_KEY]: {} })
    });
}

async function syncDownloadSession(extra = {}) {
    const data = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
    const current = data[DOWNLOAD_SESSION_KEY] || {};
    if (!current.active) return;
    const activePromptList = getActivePromptListForMode();
    const previousPrompts = new Map((current.prompts || []).map(prompt => [Number(prompt.index), prompt]));
    const expectedCount = expectedCountForMode(currentMode);
    await chrome.storage.local.set({
        [DOWNLOAD_SESSION_KEY]: {
            ...current,
            active: true,
            currentIndex,
            mode: currentMode,
            prompts: activePromptList.map((prompt, index) => {
                const previousPrompt = previousPrompts.get(index) || {};
                return {
                    index,
                    prompt,
                    mode: currentMode,
                    expected: expectedCount,
                    status: previousPrompt.status || 'queued',
                    outputs: Array.isArray(previousPrompt.outputs) ? previousPrompt.outputs : [],
                    // Preserve retry & timing fields
                    retryCount: Number(previousPrompt.retryCount || 0),
                    retryReason: previousPrompt.retryReason || '',
                    lastRetryAt: previousPrompt.lastRetryAt || null,
                    submittedAt: previousPrompt.submittedAt || null,
                    detectedAt: previousPrompt.detectedAt || null,
                    downloadedAt: previousPrompt.downloadedAt || null,
                    selectedPosition: previousPrompt.selectedPosition || null,
                    secondaryPosition: previousPrompt.secondaryPosition || null,
                    resolvedPosition: previousPrompt.resolvedPosition || null,
                    resolvedReason: previousPrompt.resolvedReason || ''
                };
            }),
            ...extra
        }
    });
}

async function updateDownloadPromptState(index, patch = {}) {
    const data = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
    const current = data[DOWNLOAD_SESSION_KEY] || {};
    if (!current.active || !Array.isArray(current.prompts)) return;
    current.prompts = current.prompts.map(prompt => {
        if (Number(prompt.index) !== Number(index)) return prompt;
        return {
            ...prompt,
            ...patch,
            outputs: Array.isArray(prompt.outputs) ? prompt.outputs : []
        };
    });
        await chrome.storage.local.set({ [DOWNLOAD_SESSION_KEY]: current });
        await runRealtimeDetectionScan('prompt-state');
}

document.addEventListener('DOMContentLoaded', async () => {
    await initializeUI({
        onMainAction: handleMainAction,
        onStop: handleStop,
        onImageSelect: handleImageSelect,
        onClearImages: handleClearImages,
        onSortChange: handleSortChange,
        onTxtImport: handleTxtImport,
        onNavigate: handleNavigate,
        onScanGallery: handleScanGallery,
        onGalleryFilter: handleGalleryFilter,
        onGalleryDateFilter: handleGalleryDateFilter,
        checkVisibility: updateInterfaceVisibility
    });
    installDownloadManagerLogBridge();
    await restoreLogMessages();
    await loadGalleryState();
    chrome.tabs.onActivated.addListener(updateInterfaceVisibility);
    chrome.tabs.onUpdated.addListener(updateInterfaceVisibility);

    // ===== AUTO-RESUME: Check for saved state after page reload =====
    const savedState = await loadAutomationState();
    if (savedState && savedState.isRunning) {
        const ageMs = Date.now() - (savedState.savedAt || 0);
        if (ageMs < RESUME_MAX_AGE_MS) {
            const savedTotal = Array.isArray(savedState.promptList) ? savedState.promptList.length : 0;
            if (savedTotal > 0 && Number(savedState.currentIndex || 0) >= savedTotal && !savedState.pendingAfterSubmit) {
                const data = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
                const session = data[DOWNLOAD_SESSION_KEY] || {};
                if (isSessionInProgress(session)) {
                    logMessage('Saved automation is past the last prompt, but the current Download Manager session is still running. Keeping session alive.', 'info');
                    await preserveCurrentSession(session);
                } else {
                    logMessage('Saved automation was already past the last prompt. Clearing stale resume state.', 'info');
                    await clearAutomationState();
                }
            } else {
            logMessage('ðŸ”„ Resuming automation after page reload...', 'system');
            logMessage(`Restoring: prompt ${savedState.currentIndex + 1}, mode=${savedState.currentMode}`, 'info');

            // Restore state
            currentMode = savedState.currentMode;
            currentIndex = savedState.currentIndex;
            promptList = savedState.promptList;
            resumePendingAfterSubmit = !!savedState.pendingAfterSubmit;
            try {
                const sessionData = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
                const resumeSession = sessionData[DOWNLOAD_SESSION_KEY] || {};
                const resumePrompt = (resumeSession.prompts || []).find(p => Number(p.index) === Number(currentIndex));
                const promptAlreadySubmitted = ['submitted', 'ready', 'downloaded'].includes(String(resumePrompt?.status || ''));
                const promptNeedsDetection = promptAlreadySubmitted && !['downloaded', 'failed'].includes(String(resumePrompt?.status || ''));
                if (!resumePendingAfterSubmit && promptNeedsDetection) {
                    resumePendingAfterSubmit = true;
                    logMessage(`Resume guard: prompt ${currentIndex + 1} was already submitted, continuing detection without re-send.`, 'info');
                }
            } catch (e) {
                console.warn('[AutoMeta] Resume guard check failed:', e.message);
            }
            failedDetectionRefreshCount = parseInt(savedState.failedDetectionRefreshCount || 0, 10) || 0;
            activeCreateBaselineSignatures = Array.isArray(savedState.activeCreateBaselineSignatures) ? savedState.activeCreateBaselineSignatures : [];
            const aspectRatio = savedState.aspectRatio || '9:16';
            const uploadDelay = savedState.uploadDelay || 10;

            // Restore prompts into textarea
            const textarea = document.getElementById('prompts');
            if (textarea && promptList.length > 0) {
                textarea.value = promptList.join('\n');
                // Trigger input event so prompt counter updates
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // Update prompt counter manually as well
            const counterElement = document.getElementById('promptCounter');
            if (counterElement) {
                counterElement.textContent = `(${promptList.length})`;
            }

            // Wait for page to be fully ready
            logMessage('â³ Waiting for page to be ready...', 'info');
            await new Promise(r => setTimeout(r, 5000));

            // Show progress
            const total = promptList.length;
            updateProgress(currentIndex, total);
            logMessage(`âœ… Resuming: ${currentMode}, prompt ${currentIndex + 1}/${total}`, 'success');

            // Restore autoDownload setting
            const autoDownloadCheckbox = document.getElementById('autoDownloadCheckbox');
            if (autoDownloadCheckbox && savedState.autoDownload !== undefined) {
                autoDownloadCheckbox.checked = savedState.autoDownload;
                chrome.storage.local.set({ autoDownload: savedState.autoDownload });
            }

            const refreshAfterPromptToggle = document.getElementById('refreshAfterPromptToggle');
            if (refreshAfterPromptToggle) refreshAfterPromptToggle.checked = !!savedState.refreshAfterPrompt;
            const refreshAfterPromptWaitInput = document.getElementById('refreshAfterPromptWait');
            if (refreshAfterPromptWaitInput && savedState.refreshAfterPromptWait !== undefined) {
                refreshAfterPromptWaitInput.value = savedState.refreshAfterPromptWait;
            }
            const downloadFolderInput = document.getElementById('downloadFolderInput');
            if (downloadFolderInput && savedState.downloadFolder !== undefined) {
                downloadFolderInput.value = savedState.downloadFolder;
            }
            const refreshAfterAllDoneToggle = document.getElementById('refreshAfterAllDoneToggle');
            if (refreshAfterAllDoneToggle && savedState.refreshAfterAllDone !== undefined) {
                refreshAfterAllDoneToggle.checked = !!savedState.refreshAfterAllDone;
            }

            // Check if this is a detection-only refresh (vs a real crash-resume)
            const rfData = await chrome.storage.local.get(REFRESH_FLAG_KEY);
            const isDetectionRefresh = !!rfData[REFRESH_FLAG_KEY];
            if (isDetectionRefresh) {
                await chrome.storage.local.remove(REFRESH_FLAG_KEY);
            }

            // Start automation with skipNewChat=true (page already reloaded = fresh chat)
            isRunning = true; stopRequested = false; isPaused = false; isStopped = false;
            downloadedMediaSet = new Set();
            updateButtonStates(true, false, false, false);
            await startDownloadSession(true);
            logMessage('Download Manager session re-synced after refresh.', 'system');

            if (isDetectionRefresh) {
                // This was our intentional detection refresh â€” just scan, don't re-submit prompts
                logMessage('Detection refresh: scanning for videos (no re-submission).', 'info');
                const total = promptList.length || 1;
                await waitForDownloadManagerCompletion(total);
                // â”€â”€ Cleanup: reset UI state properly â”€â”€
                isRunning = false; isStopped = false; stopRequested = false;
                await clearAutomationState();
                updateLiveStatus(i18n('status_ready'), 'info');
                updateButtonStates(false, false, false, false);
                logMessage('Session Ended. Ready.', 'info');
            } else {
                try {
                    if (savedState.generationFlow === 'create') {
                        await mainCreateLoop(uploadDelay * 1000, aspectRatio);
                    } else {
                        await mainLoop(uploadDelay * 1000, aspectRatio, true);
                    }
                    if (stopRequested || isStopped) {
                        logMessage(i18n('reset_user_stop'), 'warn');
                    } else {
                        logMessage(i18n('log_completed'), 'success');
                        updateProgress(100, 100, 'Completed!');
                    }
                } catch (e) {
                    if (e?.message === CREATE_REFRESH_HANDOFF_ERROR || createRefreshHandoff) {
                        logMessage('Create page refreshing. Automation will continue after reload.', 'info');
                        return;
                    }
                    logMessage(`Error: ${e.message}`, 'error');
                    console.error(e);
                } finally {
                    if (createRefreshHandoff) {
                        updateButtonStates(true, false, false, false);
                        return;
                    }
                    isRunning = false; isStopped = false; stopRequested = false;
                    await clearAutomationState();
                    updateLiveStatus(i18n('status_ready'), 'info');
                    updateButtonStates(false, false, false, false);
                    logMessage('Session Ended/Stopped. Ready.', 'info');
                }
            }
            return; // Don't show "System Ready" message
            }
        } else {
            logMessage('âš ï¸ Found old saved state (>5 min). Clearing...', 'warn');
            await clearAutomationState();
        }
    }

    // Normal startup â€” deactivate stale session UNLESS this was an intentional page refresh
    try {
        const freshData = await chrome.storage.local.get(['autoMetaCopy_downloadSession', REFRESH_FLAG_KEY, FINAL_REFRESH_FLAG_KEY]);
        const staleSession = freshData['autoMetaCopy_downloadSession'];
        const isIntentionalRefresh = !!freshData[REFRESH_FLAG_KEY];
        const isFinalRefresh = !!freshData[FINAL_REFRESH_FLAG_KEY];
        if (isFinalRefresh) {
            // Extension triggered this refresh after completion â€” keep session open, go idle
            await chrome.storage.local.remove(FINAL_REFRESH_FLAG_KEY);
            if (await maybeAutoArchiveIdleSession(staleSession, 'refresh')) return;
            await preserveCompletedIdleSession(staleSession);
            logMessage('ðŸ”„ Final refresh complete. Session preserved. Ready.', 'info');
            // Don't deactivate session â€” user can still browse Download Manager
        } else if (isIntentionalRefresh) {
            // This was a planned refresh â€” clear the flag and let detection resume
            await chrome.storage.local.remove(REFRESH_FLAG_KEY);
            logMessage('ðŸ”„ Page refreshed for video detection â€” session resumed.', 'info');
        } else if (await maybeAutoArchiveIdleSession(staleSession, 'refresh')) {
            console.log('[AutoMeta] Completed idle session auto-archived on fresh load.');
        } else if (await preserveCompletedIdleSession(staleSession)) {
            console.log('[AutoMeta] Completed idle session preserved on fresh load.');
        } else if (isSessionInProgress(staleSession)) {
            await preserveCurrentSession(staleSession);
            console.log('[AutoMeta] Active Download Manager session preserved on fresh load.');
        } else if (staleSession?.active) {
            await chrome.storage.local.set({ autoMetaCopy_downloadSession: { ...staleSession, active: false } });
            console.log('[AutoMeta] Stale active session deactivated on fresh load.');
        }
    } catch (e) { /* non-critical */ }

    logMessage('System Ready. Configure and Click Start.', 'system');
});

let lastManagerEventId = '';
function installDownloadManagerLogBridge() {
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[MANAGER_EVENTS_KEY]) return;
        const events = Array.isArray(changes[MANAGER_EVENTS_KEY].newValue) ? changes[MANAGER_EVENTS_KEY].newValue : [];
        const fresh = [];
        for (let i = events.length - 1; i >= 0; i--) {
            const ev = events[i];
            if (!ev?.id || ev.id === lastManagerEventId) break;
            fresh.unshift(ev);
        }
        fresh.slice(-8).forEach(ev => {
            lastManagerEventId = ev.id;
            const level = ev.level === 'success' ? 'success' : ev.level === 'warn' ? 'warn' : ev.level === 'error' ? 'error' : 'info';
            logMessage(`[DM -> Main] ${ev.message}`, level);
        });
    });
    chrome.storage.onChanged.addListener(async (changes, area) => {
        if (area !== 'local' || !changes.autoMetaCopy_retryRequest?.newValue) return;
        const data = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
        const session = data[DOWNLOAD_SESSION_KEY] || {};
        const total = Array.isArray(session.prompts) ? session.prompts.length : promptList.length;
        if (!total) return;
        logMessage('[DM -> Main] Manual Retry Undetected requested.', 'warn');
        await runPowerRetryEngine(total, Number(document.getElementById('imageUploadDelayInput')?.value || 10) * 1000, document.getElementById('aspectRatioSelector')?.value || '9:16');
    });
}

// Helper: Update Progress Bar
function updateProgress(current, total, statusText = null) {
    const progressBar = document.getElementById('progressBar');
    const liveStatus = document.getElementById('liveStatus');

    if (progressBar && total > 0) {
        const percentage = Math.round((current / total) * 100);
        progressBar.value = percentage;
    }

    if (liveStatus && statusText) {
        liveStatus.textContent = statusText;
    } else if (liveStatus && total > 0) {
        const percentage = Math.round((current / total) * 100);
        liveStatus.textContent = `Processing ${current}/${total} (${percentage}%)`;
    }
}

function handleMainAction() {
    if (isStopped) return;

    if (isRunning) {
        isPaused = !isPaused;
        updateButtonStates(isRunning, isPaused, false, isStopped);
        logMessage(isPaused ? i18n('log_paused') : i18n('log_resumed'), isPaused ? 'warn' : 'info');
    } else {
        startAutomation();
    }
}

function handleStop() {
    stopRequested = true;
    isStopped = true;
    isRunning = false;
    clearAutomationState(); // Prevent zombie resume after stop
    logMessage(i18n('log_stop_request'), 'warn');
    updateButtonStates(isRunning, isPaused, false, isStopped);
}

function handleImageSelect(e) {
    if (e.target.files) {
        imageFileList = Array.from(e.target.files);
        isStopped = false;
        updateImageSummary(imageFileList.length, isStopped);
        syncState({ imageFileList });
        handleSortChange({ target: { value: 'az' } });
        updateLanguageUI(chrome.i18n.getUILanguage().split('-')[0] === 'vi' ? 'vi' : 'en');
        updateButtonStates(isRunning, isPaused, false, isStopped);
    }
}

function handleClearImages() {
    imageFileList = [];
    isStopped = false;
    updateImageSummary(0, isStopped);
    syncState({ imageFileList });
    updateButtonStates(isRunning, isPaused, false, isStopped);
}

function handleSortChange(e) {
    const sortOrder = e.target.value;
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    if (sortOrder === 'az') imageFileList.sort((a, b) => collator.compare(a.name, b.name));
    else if (sortOrder === 'za') imageFileList.sort((a, b) => collator.compare(b.name, a.name));
    else if (sortOrder === 'newest') imageFileList.sort((a, b) => b.lastModified - a.lastModified);
    else if (sortOrder === 'oldest') imageFileList.sort((a, b) => a.lastModified - b.lastModified);
    logMessage(`Sorted ${imageFileList.length} images (${sortOrder}).`, 'info');
}

function handleTxtImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
        const textarea = document.getElementById('prompts');
        textarea.value = (textarea.value + "\n" + ev.target.result).trim();
        // PERSISTENCE REMOVED: Do not save imported prompts to storage
        // chrome.storage.local.set({ prompts: textarea.value });

        // Update prompt counter
        const text = textarea.value.trim();
        const lines = text ? text.split('\n').filter(line => line.trim() !== '') : [];
        const count = lines.length;
        const counterElement = document.getElementById('promptCounter');
        if (counterElement) {
            counterElement.textContent = `(${count})`;
        }

        isStopped = false;
        updateButtonStates(isRunning, isPaused, false, isStopped);
    };
    reader.readAsText(file);
    e.target.value = null;
}

async function handleNavigate() {
    chrome.tabs.create({ url: META_AI_CREATE });
}

async function loadGalleryState() {
    const data = await chrome.storage.local.get([GALLERY_STORAGE_KEY, GALLERY_SETUP_KEY]);
    const saved = data[GALLERY_STORAGE_KEY];
    gallerySetupComplete = data[GALLERY_SETUP_KEY] === true || saved?.setupComplete === true;
    if (saved && Array.isArray(saved.items)) {
        createGalleryItems = dedupeGalleryItems(saved.items);
        createGalleryScanned = !!saved.scannedAt || gallerySetupComplete;
    }
    renderCreateGallery();
    updateGallerySetupGate();
}

let galleryAutoSyncTimer = null;
function startGalleryAutoSync() {
    // Auto-sync disabled â€” enable by removing this return if needed
    return;
    if (galleryAutoSyncTimer) clearInterval(galleryAutoSyncTimer);
    galleryAutoSyncTimer = setInterval(async () => {
        if (isGalleryScanning) return;
        const galleryPage = document.getElementById('galleryPage');
        if (!galleryPage || galleryPage.style.display === 'none') return;
        try {
            const tabs = await chrome.tabs.query({ url: 'https://www.meta.ai/create*' });
            if (!tabs || tabs.length === 0) return;
            const result = await injectScript(scanCreateGalleryPage, [false, null, 'fast']);
            if (!result?.items?.length) return;
            const before = createGalleryItems.length;
            createGalleryItems = dedupeGalleryItems([...createGalleryItems, ...result.items]);
            if (createGalleryItems.length > before) {
                createGalleryScanned = true;
                await saveGalleryState();
                renderCreateGallery();
                logMessage(`Auto-sync added ${createGalleryItems.length - before} new gallery item(s).`, 'success');
            }
        } catch (e) {
            console.warn('[Gallery auto-sync] skipped:', e.message);
        }
    }, 60000);
}

async function saveGalleryState(options = {}) {
    if (options.setupComplete === true) {
        gallerySetupComplete = true;
    }
    await chrome.storage.local.set({
        [GALLERY_SETUP_KEY]: gallerySetupComplete,
        [GALLERY_STORAGE_KEY]: {
            scannedAt: Date.now(),
            setupComplete: gallerySetupComplete,
            items: createGalleryItems
        }
    });
    updateGallerySetupGate();
}

function updateGallerySetupGate() {
    const overlay = document.getElementById('gallerySetupOverlay');
    if (!overlay) return;
    const videos = createGalleryItems.filter(item => item.type === 'video').length;
    const images = createGalleryItems.filter(item => item.type === 'image').length;
    const videoEl = document.getElementById('setupVideoCount');
    const imageEl = document.getElementById('setupImageCount');
    if (videoEl) videoEl.textContent = videos;
    if (imageEl) imageEl.textContent = images;
    if (!gallerySetupComplete) {
        overlay.classList.add('active');
    } else {
        overlay.classList.remove('active');
    }
}

function renderCreateGallery() {
    const summary = document.getElementById('gallerySummary');
    const container = document.getElementById('galleryItems');
    const scanIndicator = document.getElementById('scanIndicator');
    const scanProgressText = document.getElementById('scanProgressText');
    const videoCountEl = document.getElementById('galleryVideoCount');
    const imageCountEl = document.getElementById('galleryImageCount');
    const visibleCountEl = document.getElementById('galleryVisibleCount');
    if (!summary || !container) return;
    const typeSelect = document.getElementById('galleryFilter');
    const dateSelect = document.getElementById('galleryDateFilter');
    const calendarInput = document.getElementById('galleryCalendarDate');
    if (typeSelect) createGalleryFilter = typeSelect.value || createGalleryFilter || 'all';
    if (dateSelect) createGalleryDateFilter = dateSelect.value || createGalleryDateFilter || 'all';
    if (calendarInput?.value) createGalleryDateFilter = `calendar:${calendarInput.value}`;

    const videos = createGalleryItems.filter(item => item.type === 'video').length;
    const images = createGalleryItems.filter(item => item.type === 'image').length;
    const lastScanLabel = createGalleryScanned ? getLastScanLabel() : '';
    summary.textContent = createGalleryScanned
        ? `${videos} videos / ${images} images saved${lastScanLabel ? ` - ${lastScanLabel}` : ''}`
        : 'Not scanned';
    if (videoCountEl) videoCountEl.textContent = videos;
    if (imageCountEl) imageCountEl.textContent = images;
    if (scanIndicator) scanIndicator.classList.toggle('active', isGalleryScanning);
    if (scanProgressText) scanProgressText.textContent = `Scanning... ${createGalleryItems.length} total`;
    const scanBtn = document.getElementById('loadGalleryButton');
    if (scanBtn) {
        const icon = scanBtn.querySelector('.material-symbols-rounded');
        const text = scanBtn.querySelector('span:last-child');
        if (icon) icon.textContent = gallerySetupComplete ? 'lock' : (isGalleryScanning ? 'stop_circle' : 'sync');
        if (text) text.textContent = gallerySetupComplete ? 'Indexed' : (isGalleryScanning ? 'Stop' : 'Scan');
        scanBtn.disabled = gallerySetupComplete;
        scanBtn.classList.toggle('running', isGalleryScanning);
    }

    if (dateSelect) {
        const currentValue = dateSelect.value || createGalleryDateFilter;
        const dateLabels = Array.from(new Set(createGalleryItems.map(item => item.metaDate).filter(Boolean)))
            .sort((a, b) => (Date.parse(b) || 0) - (Date.parse(a) || 0));
        const existing = new Set(Array.from(dateSelect.options).map(option => option.value));
        dateLabels.forEach(label => {
            if (!existing.has(`date:${label}`)) {
                const option = document.createElement('option');
                option.value = `date:${label}`;
                option.textContent = label;
                dateSelect.appendChild(option);
            }
        });
        dateSelect.value = Array.from(dateSelect.options).some(option => option.value === currentValue) ? currentValue : 'all';
    }

    const now = Date.now();
    const todayString = new Date(now).toDateString();
    const matchesDate = (item) => {
        if (createGalleryDateFilter === 'all') return true;
        const metaTime = item.metaDate ? Date.parse(item.metaDate) : 0;
        if (!metaTime) return false;
        const age = now - metaTime;
        if (createGalleryDateFilter === 'today') {
            return new Date(metaTime).toDateString() === todayString;
        }
        if (createGalleryDateFilter === '7d') return age <= 7 * 24 * 60 * 60 * 1000;
        if (createGalleryDateFilter === '30d') return age <= 30 * 24 * 60 * 60 * 1000;
        if (createGalleryDateFilter.startsWith('date:')) return item.metaDate === createGalleryDateFilter.slice(5);
        if (createGalleryDateFilter.startsWith('calendar:')) {
            const picked = new Date(`${createGalleryDateFilter.slice(9)}T00:00:00`);
            return Number.isFinite(picked.getTime()) && new Date(metaTime).toDateString() === picked.toDateString();
        }
        return true;
    };

    const visible = createGalleryItems
        .filter(item => createGalleryFilter === 'all' || item.type === createGalleryFilter)
        .filter(matchesDate);
    if (visibleCountEl) visibleCountEl.textContent = visible.length;
    const visibleLimited = visible.slice(0, container.classList.contains('gallery-grid-large') ? 120 : 60);

    container.innerHTML = '';
    const largeGallery = container.classList.contains('gallery-grid-large');
    if (visibleLimited.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'gallery-empty';
        empty.textContent = createGalleryItems.length > 0 ? 'No media matches these filters.' : 'No saved media yet. Run Scan once.';
        container.appendChild(empty);
        return;
    }

    visibleLimited.forEach((item) => {
        const btn = document.createElement('button');
        btn.className = 'gallery-thumb';
        btn.title = item.prompt || item.type;
        btn.dataset.signature = item.signature;
        btn.style.position = 'relative';
        btn.style.width = '100%';
        btn.style.height = largeGallery ? '118px' : '62px';
        btn.style.padding = '0';
        btn.style.overflow = 'hidden';
        btn.style.borderRadius = '6px';
        btn.style.border = '1px solid #E5E7EB';
        btn.style.background = '#F9FAFB';

        const media = document.createElement(item.type === 'video' ? 'video' : 'img');
        media.src = item.src;
        media.style.width = '100%';
        media.style.height = '100%';
        media.style.objectFit = 'cover';
        media.style.display = 'block';
        media.muted = true;
        media.playsInline = true;
        if (item.type === 'video') media.preload = 'none';
        if (item.type === 'image') media.loading = 'lazy';

        const badge = document.createElement('span');
        badge.className = 'material-symbols-rounded';
        badge.textContent = item.type === 'video' ? 'play_circle' : 'image';
        badge.style.position = 'absolute';
        badge.style.right = '4px';
        badge.style.bottom = '4px';
        badge.style.fontSize = '17px';
        badge.style.color = '#FFFFFF';
        badge.style.textShadow = '0 1px 3px rgba(0,0,0,0.7)';

        btn.appendChild(media);
        btn.appendChild(badge);
        if (item.metaDate) {
            const dateBadge = document.createElement('span');
            dateBadge.textContent = item.metaDate;
            dateBadge.style.position = 'absolute';
            dateBadge.style.left = '4px';
            dateBadge.style.top = '4px';
            dateBadge.style.padding = '2px 5px';
            dateBadge.style.borderRadius = '6px';
            dateBadge.style.background = 'rgba(0,0,0,0.62)';
            dateBadge.style.color = '#fff';
            dateBadge.style.fontSize = '0.62rem';
            dateBadge.style.fontWeight = '800';
            btn.appendChild(dateBadge);
        }
        btn.addEventListener('click', () => openGalleryItem(item));
        container.appendChild(btn);
    });
}

function getLastScanLabel() {
    const times = createGalleryItems.map(item => item.savedAt || item.detectedAt || 0).filter(Boolean);
    if (times.length === 0) return '';
    return `last saved ${new Date(Math.max(...times)).toLocaleDateString()}`;
}

function handleGalleryFilter(e) {
    createGalleryFilter = e.target.value || 'all';
    renderCreateGallery();
}

function handleGalleryDateFilter(e) {
    createGalleryDateFilter = e.target.value || 'all';
    renderCreateGallery();
}

async function handleScanGallery(options = {}) {
    const isInitialSetup = !!options?.initialSetup;
    if (!isInitialSetup && gallerySetupComplete) {
        logMessage('Gallery index is already built. New media will come from Download Manager.', 'info');
        return;
    }
    const loadBtn = document.getElementById('loadGalleryButton');
    if (isGalleryScanning && activeGalleryScanSession) {
        await chrome.storage.local.set({
            autoMetaCopy_scanControl: {
                sessionId: activeGalleryScanSession,
                stop: true,
                requestedAt: Date.now()
            }
        });
        logMessage('Stop requested for gallery scan...', 'warn');
        return;
    }
    isGalleryScanning = true;
    renderCreateGallery();
    const initialBtn = document.getElementById('initialGalleryScanButton');
    const initialOk = document.getElementById('initialGalleryOkButton');
    const initialSummary = document.getElementById('gallerySetupSummary');
    if (initialBtn) {
        initialBtn.disabled = true;
        initialBtn.querySelector('span:last-child').textContent = 'Scanning...';
    }
    try {
        logMessage('Opening Create page for gallery scan...', 'system');
        await ensureCreateTab();
        const sessionId = `scan_${Date.now()}`;
        activeGalleryScanSession = sessionId;
        const scanSpeed = isInitialSetup ? 'sonic' : (document.getElementById('galleryScanSpeed')?.value || 'medium');
        logMessage(`Scanning Create gallery (${scanSpeed} speed). Please wait...`, 'info');
        let progressTimer = null;
        const scanLoggedSignatures = new Set(createGalleryItems.map(item => item.signature));
        await chrome.storage.local.set({
            autoMetaCopy_scanProgress: { sessionId, items: createGalleryItems, done: false },
            autoMetaCopy_scanControl: { sessionId, stop: false }
        });
        progressTimer = setInterval(async () => {
            const data = await chrome.storage.local.get('autoMetaCopy_scanProgress');
            const progress = data.autoMetaCopy_scanProgress;
            if (!progress || progress.sessionId !== sessionId || !Array.isArray(progress.items)) return;
            const mergedItems = dedupeGalleryItems([...createGalleryItems, ...progress.items]);
            mergedItems.forEach(item => {
                if (!scanLoggedSignatures.has(item.signature)) {
                    scanLoggedSignatures.add(item.signature);
                    const label = item.type === 'video' ? 'New video found' : 'New image found';
                    const promptPreview = item.prompt ? ` - ${item.prompt.slice(0, 70)}` : '';
                    logMessage(`${label}${promptPreview}`, item.type === 'video' ? 'success' : 'info');
                }
            });
            createGalleryItems = mergedItems;
            createGalleryScanned = createGalleryItems.length > 0;
            renderCreateGallery();
            const videos = progress.videoCount ?? createGalleryItems.filter(item => item.type === 'video').length;
            const images = progress.imageCount ?? createGalleryItems.filter(item => item.type === 'image').length;
            updateLiveStatus(`Scanning gallery: ${videos} videos / ${images} images`, 'info');
        }, 700);

        const result = await injectScript(scanCreateGalleryPage, [true, sessionId, scanSpeed]);
        if (progressTimer) clearInterval(progressTimer);
        if (!result || !Array.isArray(result.items)) {
            logMessage('Gallery scan failed. Open Meta Create page and try again.', 'error');
            return;
        }
        createGalleryItems = dedupeGalleryItems([...createGalleryItems, ...result.items]);
        createGalleryItems.forEach(item => {
            if (!scanLoggedSignatures.has(item.signature)) {
                scanLoggedSignatures.add(item.signature);
                const label = item.type === 'video' ? 'New video found' : 'New image found';
                const promptPreview = item.prompt ? ` - ${item.prompt.slice(0, 70)}` : '';
                logMessage(`${label}${promptPreview}`, item.type === 'video' ? 'success' : 'info');
            }
        });
        createGalleryScanned = true;
        await saveGalleryState({ setupComplete: isInitialSetup });
        renderCreateGallery();
        if (isInitialSetup) {
            const videos = createGalleryItems.filter(item => item.type === 'video').length;
            const images = createGalleryItems.filter(item => item.type === 'image').length;
            document.getElementById('setupVideoCount').textContent = videos;
            document.getElementById('setupImageCount').textContent = images;
            initialSummary?.classList.add('active');
            if (initialBtn) initialBtn.style.display = 'none';
            if (initialOk) initialOk.style.display = 'flex';
        }
        logMessage(
            result.stopped
                ? `Gallery scan stopped: ${result.videoCount} videos, ${result.imageCount} images.`
                : `Gallery scanned to end: ${result.videoCount} videos, ${result.imageCount} images.`,
            result.stopped ? 'warn' : 'success'
        );
    } finally {
        isGalleryScanning = false;
        activeGalleryScanSession = null;
        const data = await chrome.storage.local.get('autoMetaCopy_scanProgress');
        if (data.autoMetaCopy_scanProgress?.done) {
            await chrome.storage.local.remove('autoMetaCopy_scanProgress');
        }
        await chrome.storage.local.remove('autoMetaCopy_scanControl');
        renderCreateGallery();
        if (initialBtn && initialBtn.style.display !== 'none') {
            initialBtn.disabled = false;
            initialBtn.querySelector('span:last-child').textContent = 'Scan Gallery';
        }
    }
}

async function openGalleryItem(item) {
    await ensureCreateTab();
    const result = await injectScript(scrollToCreateGalleryItem, [item]);
    if (result?.success) {
        logMessage('Gallery item opened on Create page.', 'success');
    } else {
        logMessage('Could not find that item. It may not be loaded on the current Create page yet.', 'warn');
    }
}

function dedupeGalleryItems(items) {
    const map = new Map();
    items.forEach(item => {
        if (!item || !item.signature) return;
        const normalizedType = item.type === 'video' ? 'video' : 'image';
        const normalized = {
            ...item,
            type: normalizedType,
            savedAt: item.savedAt || Date.now(),
            detectedAt: item.detectedAt || item.savedAt || Date.now()
        };
        if (!map.has(item.signature)) {
            map.set(item.signature, normalized);
        } else {
            map.set(item.signature, { ...map.get(item.signature), ...normalized });
        }
    });
    return Array.from(map.values()).sort((a, b) => (b.detectedAt || 0) - (a.detectedAt || 0));
}

async function updateInterfaceVisibility() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isMeta = tab?.url?.includes("meta.ai");
    const mainUI = document.getElementById('main-interface');
    const wrongUI = document.getElementById('wrong-page-interface');
    if (mainUI && wrongUI) {
        mainUI.style.display = isMeta ? 'flex' : 'none';
        wrongUI.style.display = isMeta ? 'none' : 'flex';
    }
}

async function startAutomation() {
    stopRequested = false;
    isStopped = false;
    isRunning = true;
    isPaused = false;
    createRefreshHandoff = false;

    // Update status to show automation is starting
    updateProgress(0, 100, "Starting automation...");

    const promptsTextarea = document.getElementById('prompts');
    const rawText = promptsTextarea ? promptsTextarea.value.trim() : '';
    // Normalize line endings
    const promptsText = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Smart split: numbered prompts > blank lines > single lines
    if (/^\d+\.\s/m.test(promptsText)) {
        promptList = promptsText.split(/\n(?=\d+\.\s)/).filter(p => p.trim());
    } else if (promptsText.includes('\n\n')) {
        promptList = promptsText.split(/\n\s*\n/).filter(p => p.trim());
    } else {
        promptList = promptsText.split('\n').filter(p => p.trim());
    }

    const imageUploadDelayInput = document.getElementById('imageUploadDelayInput');
    const uploadDelay = imageUploadDelayInput ? parseInt(imageUploadDelayInput.value) || 10 : 10;

    const modeConfig = await getCreateModeConfig();
    const aspectRatio = modeConfig.aspectRatio;

    // Determine currentMode
    if (imageFileList.length > 0) {
        currentMode = 'image-to-video';
        logMessage("Mode: Image-to-Video (images detected)", 'info');
    } else {
        const storedMode = modeConfig.outputMode;

        logMessage(`Mode selector value: ${storedMode}`, 'info');

        if (storedMode === 'image') {
            currentMode = 'prompt-to-image';
            logMessage("Mode: Prompt-to-Image", 'info');
        } else {
            currentMode = 'prompt-to-video';
            logMessage("Mode: Prompt-to-Video", 'info');
        }
    }

    if (promptList.length === 0) {
        logMessage("Please add at least one prompt to start.", 'error');
        updateButtonStates(false, false, false, false); // Reset buttons if validation fails
        return;
    }

    if (currentMode === 'image-to-video' && imageFileList.length === 0) {
        return;
    }

    const total = getTotalForMode();

    // READ START INDEX from UI (1-based input â†’ 0-based internal)
    const startFromRaw = parseInt(document.getElementById('startFromInput')?.value || '1', 10);
    const startFrom = Math.max(0, Math.min(startFromRaw - 1, total - 1)); // Clamp to valid range
    currentIndex = startFrom;

    // RESET REGISTRY
    downloadedMediaSet = new Set();
    logMessage("Session media registry initialized", 'system');

    logMessage(`Starting: ${currentMode}`, 'system');
    logMessage(`Total Items: ${total}`, 'info');
    if (startFrom > 0) {
        logMessage(`Starting from item ${startFrom + 1} (skipping first ${startFrom})`, 'info');
    }

    isRunning = true;
    stopRequested = false;
    isPaused = false;
    isStopped = false; // Reset stop state

    updateButtonStates(true, false, false, isStopped);
    const generationFlow = document.getElementById('generationFlowSelector')?.value || 'create';
    if (generationFlow === 'create') {
        logMessage('Opening Meta AI Create page before starting session...', 'info');
        await ensureCreateTab();
    }
    await startDownloadSession();
    openDownloadManagerOverlay('queue');
    logMessage('Download Manager opened and linked to session.', 'system');

    try {
        if (generationFlow === 'create') {
            await mainCreateLoop(uploadDelay * 1000, aspectRatio);
        } else {
            await mainLoop(uploadDelay * 1000, aspectRatio); // Convert to milliseconds
        }
        if (stopRequested || isStopped) {
            logMessage(i18n('reset_user_stop'), 'warn');
        } else {
            logMessage(i18n('log_completed'), 'success');
            updateProgress(100, 100, "Completed!");
        }
    } catch (e) {
        if (e?.message === CREATE_REFRESH_HANDOFF_ERROR || createRefreshHandoff) {
            logMessage('Create page refreshing. Automation will continue after reload.', 'info');
            return;
        }
        logMessage(`Error: ${e.message}`, 'error');
        console.error(e);
    } finally {
        if (createRefreshHandoff) {
            updateButtonStates(true, false, false, false);
            return;
        }
        isRunning = false;
        isStopped = false;
        stopRequested = false;
        await clearAutomationState(); // Clear state on completion
        updateLiveStatus(i18n('status_ready'), 'info');
        updateButtonStates(false, false, false, false);
        logMessage("Session Ended/Stopped. Ready.", 'info');
    }
}

// Reliable download helper â€” fetches as blob, downloads with correct filename
async function downloadMedia(url, filename) {
    // Check if auto-download is enabled
    const autoDownloadCheckbox = document.getElementById('autoDownloadCheckbox');
    if (autoDownloadCheckbox && !autoDownloadCheckbox.checked) {
        logMessage(`â­ï¸ Auto-download OFF â€” skipping ${filename}`, 'info');
        return { success: true, skipped: true };
    }

    const dmData = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
    if (dmData[DOWNLOAD_SESSION_KEY]?.active) {
        logMessage(`Download Manager active — selected-slot queue will handle ${filename}`, 'info');
        return { success: true, skipped: true, delegatedToDownloadManager: true };
    }
    if (dmData[DOWNLOAD_SESSION_KEY]?.autoDownloadMode === 'afterAllReadyZip' || dmData[DOWNLOAD_SESSION_KEY]?.settings?.autoDownloadMode === 'afterAllReadyZip') {
        logMessage(`ZIP mode active — skipping individual download for ${filename}`, 'info');
        return { success: true, skipped: true, delegatedToZip: true };
    }

    // Direct-download the detected media URL (for videos this is Meta's data-video-url / fbcdn MP4).
    try {
        const downloadId = await new Promise((resolve, reject) => {
            chrome.downloads.download({
                url: url,
                filename: filename,
                conflictAction: 'uniquify'
            }, (id) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message));
                } else {
                    resolve(id);
                }
            });
        });

        if (downloadId !== undefined) {
            const completed = await waitForDownloadCompletion(downloadId, 120000);
            return { success: completed.success, downloadId, method: 'direct-url', error: completed.error };
        }
    } catch (directErr) {
        console.warn('[downloadMedia] Direct URL download failed:', directErr.message);
    }

    // Fallback: same original URL through background.js, still no Meta page button click.
    try {
        const result = await chrome.runtime.sendMessage({
            type: 'downloadFile',
            url: url,
            filename: filename
        });
        if (result && result.success) {
            const completed = await waitForDownloadCompletion(result.downloadId, 120000);
            return { success: completed.success, downloadId: result.downloadId, method: 'bg-fallback', error: completed.error };
        }
    } catch (e) {
        console.error('[downloadMedia] All methods failed:', e.message);
    }

    return { success: false, error: 'All download methods failed' };
}

function getDownloadFolder() {
    const raw = document.getElementById('downloadFolderInput')?.value || 'meta-videos';
    const cleaned = raw
        .replace(/\\/g, '/')
        .split('/')
        .map(part => part.replace(/[<>:"|?*\x00-\x1F]/g, '').trim())
        .filter(Boolean)
        .join('/');
    return cleaned || 'meta-videos';
}

function getSelectedMediaNumber(targetType) {
    const selectorId = targetType === 'video' ? 'videoGenerationSelect' : 'imageGenerationSelect';
    const value = document.getElementById(selectorId)?.value || 'auto';
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

function buildDownloadFilename(targetType, promptIndex, ext) {
    const folder = getDownloadFolder();
    const mediaNumber = getSelectedMediaNumber(targetType);
    const typeFolder = targetType === 'video' ? 'videos' : 'images';
    return `${folder}/${typeFolder}/prompt ${promptIndex + 1} - ${targetType} ${mediaNumber}.${ext}`;
}

function waitForDownloadCompletion(downloadId, timeoutMs = 120000) {
    return new Promise((resolve) => {
        if (downloadId === undefined || downloadId === null) {
            resolve({ success: false, error: 'download id missing' });
            return;
        }

        let done = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            chrome.downloads.onChanged.removeListener(onChanged);
            resolve(result);
        };
        const timer = setTimeout(() => finish({ success: false, error: 'download completion timeout' }), timeoutMs);
        const onChanged = (delta) => {
            if (delta.id !== downloadId || !delta.state) return;
            if (delta.state.current === 'complete') finish({ success: true });
            if (delta.state.current === 'interrupted') finish({ success: false, error: 'download interrupted' });
        };
        chrome.downloads.onChanged.addListener(onChanged);
        chrome.downloads.search({ id: downloadId }, (items) => {
            const item = items?.[0];
            if (item?.state === 'complete') finish({ success: true });
            if (item?.state === 'interrupted') finish({ success: false, error: item.error || 'download interrupted' });
        });
    });
}

async function ensureCreateTab() {
    const tabs = await chrome.tabs.query({ url: 'https://www.meta.ai/*' });
    let tab = tabs?.[0];
    if (!tab) {
        tab = await chrome.tabs.create({ url: META_AI_CREATE, active: true });
    } else if (!tab.url || !tab.url.includes('/create')) {
        await chrome.tabs.update(tab.id, { url: META_AI_CREATE, active: true });
    } else {
        await chrome.tabs.update(tab.id, { active: true });
    }
    await new Promise(r => setTimeout(r, 3500));
    return tab;
}

async function refreshCreateTabAfterSubmit() {
    // Read delay from DM settings (storage) OR from side-panel DOM
    const storedDelay = (await chrome.storage.local.get({ autoRefreshDelay: DEFAULT_REFRESH_AFTER_PROMPT_WAIT })).autoRefreshDelay;
    const domDelay = parseInt(document.getElementById('refreshAfterPromptWait')?.value || '0', 10) || 0;
    const waitSeconds = Math.max(10, domDelay || storedDelay || DEFAULT_REFRESH_AFTER_PROMPT_WAIT);
    await chrome.storage.local.set({ autoRefreshDelay: waitSeconds, refreshAfterPromptWait: waitSeconds });
    logMessage(`Waiting ${waitSeconds}s before refresh...`, 'info');
    await interruptibleSleep(waitSeconds * 1000, () => stopRequested || isStopped);
    if (stopRequested || isStopped) return false;
    const tabs = await chrome.tabs.query({ url: 'https://www.meta.ai/*' });
    const tab = tabs?.find(t => t.url && t.url.includes('/create')) || tabs?.[0];
    if (!tab?.id) return false;
    logMessage('Refreshing Create page before detection...', 'info');
    createRefreshHandoff = true;
    await chrome.tabs.reload(tab.id);
    await new Promise(r => setTimeout(r, 3500));
    createRefreshHandoff = false;
    return true;
}

async function getPromptDetectedOutput(promptIndex, settings = {}, publishToGate = false) {
    const data = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
    const session = data[DOWNLOAD_SESSION_KEY] || {};
    const prompt = (session.prompts || []).find(p => Number(p.index) === Number(promptIndex));
    if (!prompt) return null;
    const outputs = (prompt.outputs || []).filter(item => item?.src);
    if (publishToGate && outputs.length) {
        await reportDetectedSlots(Number(promptIndex), outputs);
    }
    return getPreferredOutput(prompt, settings) || outputs[0] || null;
}

async function hasPromptDetectedOutput(promptIndex, settings = {}) {
    return !!(await getPromptDetectedOutput(promptIndex, settings));
}

async function smartRefreshCreateTabAfterSubmit(promptIndex) {
    const stored = await chrome.storage.local.get({
        autoRefreshDelay: DEFAULT_REFRESH_AFTER_PROMPT_WAIT,
        videoGenerationSelect: 'auto',
        secondaryVideoGenerationSelect: 'auto',
        imageGenerationSelect: 'auto',
        customSelections: {}
    });
    const domDelay = parseInt(document.getElementById('refreshAfterPromptWait')?.value || '0', 10) || 0;
    const waitSeconds = Math.max(10, domDelay || Number(stored.autoRefreshDelay) || DEFAULT_REFRESH_AFTER_PROMPT_WAIT);
    await chrome.storage.local.set({ autoRefreshDelay: waitSeconds, refreshAfterPromptWait: waitSeconds });
    logMessage(`Smart refresh: waiting up to ${waitSeconds}s for prompt ${promptIndex + 1} detection...`, 'info');

    const started = Date.now();
    while (!stopRequested && !isStopped && Date.now() - started < waitSeconds * 1000) {
        await runRealtimeDetectionScan('smart-refresh-after-prompt');
        if (await hasPromptDetectedOutput(promptIndex, stored)) {
            logMessage(`Smart refresh skipped: prompt ${promptIndex + 1} video detected.`, 'success');
            return 'skipped';
        }
        const sleepRes = await interruptibleSleep(1000, () => stopRequested || isStopped);
        if (sleepRes === 'STOPPED') return false;
    }

    if (stopRequested || isStopped) return false;
    if (await hasPromptDetectedOutput(promptIndex, stored)) {
        logMessage(`Smart refresh skipped: prompt ${promptIndex + 1} video detected.`, 'success');
        return 'skipped';
    }

    logMessage(`Smart refresh: no video detected for prompt ${promptIndex + 1}; refreshing Create page.`, 'warn');
    const tabs = await chrome.tabs.query({ url: 'https://www.meta.ai/*' });
    const tab = tabs?.find(t => t.url && t.url.includes('/create')) || tabs?.[0];
    if (!tab?.id) return false;
    createRefreshHandoff = true;
    await chrome.tabs.reload(tab.id);
    await new Promise(r => setTimeout(r, 3500));
    createRefreshHandoff = false;
    return 'refreshed';
}

function getImageModeSettleWaitMs() {
    const value = parseInt(document.getElementById('generationWait')?.value || '5', 10);
    return Math.max(2, Number.isFinite(value) ? value : 5) * 1000;
}

async function refreshCreateTabForFailedDetection(attempt, maxAttempts) {
    logMessage(`No download detected. Refresh recovery ${attempt}/${maxAttempts}: waiting 10s...`, 'warn');
    await interruptibleSleep(10000, () => stopRequested || isStopped);
    if (stopRequested || isStopped) return false;
    const tabs = await chrome.tabs.query({ url: 'https://www.meta.ai/*' });
    const tab = tabs?.find(t => t.url && t.url.includes('/create')) || tabs?.[0];
    if (!tab?.id) return false;
    logMessage(`Refresh recovery ${attempt}/${maxAttempts}: reloading Create page...`, 'info');
    createRefreshHandoff = true;
    await chrome.tabs.reload(tab.id);
    await new Promise(r => setTimeout(r, 3500));
    createRefreshHandoff = false;
    return true;
}

async function mainCreateLoop(uploadDelay, aspectRatio) {
    await loadGalleryState();
    if (!gallerySetupComplete) {
        logMessage('Please complete the one-time gallery scan first.', 'error');
        updateLiveStatus('Scan gallery first', 'error');
        updateGallerySetupGate();
        return;
    }

    // â”€â”€ LIVE RETRY LISTENER: react instantly when detector flags a timeout â”€â”€
    let liveRetryRunning = false;
    const retryListener = async (changes, area) => {
        if (area !== 'local' || !changes.autoMetaCopy_retryTrigger) return;
        const trigger = changes.autoMetaCopy_retryTrigger.newValue;
        if (!trigger?.indices?.length || liveRetryRunning || stopRequested || isStopped) return;
        liveRetryRunning = true;
        try {
            const settings = await getRetrySettings();
            if (!settings.enabled) return;
            for (const idx of trigger.indices) {
                if (stopRequested || isStopped) break;
                const data = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
                const sess = data[DOWNLOAD_SESSION_KEY] || {};
                const prompt = (sess.prompts || []).find(p => Number(p.index) === idx);
                if (!prompt || prompt.status !== 'timeout') continue;
                if (Number(prompt.retryCount || 0) >= settings.maxAttempts) continue;
                logMessage(`âš¡ Instant retry: prompt ${idx + 1} timed out â€” re-submitting now`, 'warn');
                await retryCreatePrompt({
                    index: idx, prompt: prompt.prompt, mode: prompt.mode || currentMode,
                    expected: Number(prompt.expected) || expectedCountForMode(prompt.mode || currentMode), detected: 0,
                    reason: 'timeout_instant', retryCount: Number(prompt.retryCount || 0)
                }, uploadDelay, aspectRatio);
                await runRealtimeDetectionScan('live-retry');
                const retryWaitMs = getImageModeSettleWaitMs();
                logMessage(`Retry prompt ${idx + 1} submitted. Next retry in ${Math.round(retryWaitMs / 1000)}s.`, 'info');
                const sleepRes = await interruptibleSleep(retryWaitMs, () => stopRequested || isStopped);
                if (sleepRes === 'STOPPED') break;
            }
        } catch (e) { console.warn('[AutoMeta] Live retry error:', e.message); }
        finally { liveRetryRunning = false; }
    };
    // Gate retry is the single retry engine for Create flow; adding this listener can double-submit.
    // chrome.storage.onChanged.addListener(retryListener);

    await ensureCreateTab();
    const baseline = new Set(createGalleryItems.map(item => item.signature));
    activeCreateBaselineSignatures.forEach(signature => baseline.add(signature));
    const total = getTotalForMode();
    const failedPrompts = [];

    if (currentMode === 'image-to-video' && imageFileList.length !== promptList.length) {
        logMessage(`Image-to-video: ${imageFileList.length} images and ${promptList.length} prompt(s). Prompts will repeat for extra images.`, 'warn');
    }

    const openRes = await injectScript(prepareCreateComposer, []);
    if (openRes?.logs) openRes.logs.forEach(l => logMessage(l, openRes.success ? 'info' : 'warn'));
    if (activeCreateBaselineSignatures.length === 0) {
        const pageBaseline = await injectScript(collectCreateMediaBaselineSignatures, []);
        if (pageBaseline?.signatures?.length) {
            pageBaseline.signatures.forEach(signature => baseline.add(signature));
            activeCreateBaselineSignatures = Array.from(baseline);
            await syncDownloadSession({ baselineSignatures: activeCreateBaselineSignatures });
            logMessage(`Session baseline locked once: ${pageBaseline.signatures.length} existing media ignored.`, 'info');
        }
    }

    while (currentIndex < total && !stopRequested && !isStopped) {
        while (isPaused && !stopRequested && !isStopped) await new Promise(r => setTimeout(r, 500));
        if (stopRequested || isStopped) break;

        const prompt = getPromptForIndex(currentIndex);
        const isImageMode = currentMode === 'prompt-to-image';
        const targetType = isImageMode ? 'image' : 'video';
        const command = isImageMode ? '/image' : '/video';
        let submitRes = null;
        let submittedStateAlreadyUpdated = false;

        updateProgress(currentIndex + 1, total);
        logMessage(`[Create Flow] ${currentIndex + 1}/${total} ${targetType}`, 'info');
        await syncDownloadSession({ currentIndex });

        if (resumePendingAfterSubmit) {
            logMessage('Resume phase: prompt was already sent before refresh. Starting detection...', 'info');
            submitRes = { success: true, logs: [] };
            resumePendingAfterSubmit = false;
            await saveAutomationState({
                generationFlow: 'create',
                pendingAfterSubmit: false,
                uploadDelay: uploadDelay / 1000,
                aspectRatio,
                status: 'detecting'
            });
        } else {
            if (currentMode === 'image-to-video') {
                if (!prompt || !String(prompt).trim()) {
                    logMessage(`Prompt ${currentIndex + 1} missing. Skipping image ${currentIndex + 1}.`, 'warn');
                    await updateDownloadPromptState(currentIndex, {
                        status: 'failed',
                        mode: currentMode,
                        expected: 1,
                        retryReason: 'missing_prompt'
                    });
                    failedPrompts.push({ index: currentIndex, prompt: '', reason: 'missing prompt' });
                    currentIndex++;
                    await syncDownloadSession({ currentIndex });
                    continue;
                }
                const expectedImage = findImageForPromptIndex(currentIndex);
                if (!expectedImage) {
                    logMessage(`Image ${currentIndex + 1} missing. Skipping prompt ${currentIndex + 1}.`, 'warn');
                    failedPrompts.push({ index: currentIndex, prompt, reason: 'missing image' });
                    currentIndex++;
                    continue;
                }

                const base64 = await readFileAsDataURL(expectedImage);
                submitRes = await injectScript(submitCreatePrompt, [{
                    command,
                    prompt,
                    imageBase64: base64,
                    imageName: expectedImage.name,
                    uploadDelay
                }]);
            } else {
                submitRes = await injectScript(submitCreatePrompt, [{ command, prompt, uploadDelay }]);
            }

            if (submitRes?.logs) submitRes.logs.forEach(l => logMessage(l, /\[fail\]/i.test(l) ? 'error' : 'info'));
            if (!submitRes?.success) {
                const submitError = submitRes?.error || 'unknown error';
                logMessage(`[Main] Prompt ${currentIndex + 1} submit failed: ${submitError}.`, 'error');
                failedPrompts.push({ index: currentIndex, prompt, reason: submitRes?.error || 'submit failed' });
                if (currentMode === 'image-to-video' && /image .*confirm|image .*missing|file input missing|upload/i.test(submitError)) {
                    await updateDownloadPromptState(currentIndex, {
                        status: 'failed',
                        mode: currentMode,
                        expected: 1,
                        retryReason: submitError
                    });
                    logMessage('Image-to-video stopped: image upload was not confirmed, so no prompt was sent without an image.', 'error');
                    stopRequested = true;
                    await saveAutomationState({
                        generationFlow: 'create',
                        pendingAfterSubmit: false,
                        uploadDelay: uploadDelay / 1000,
                        aspectRatio,
                        status: 'image-upload-failed'
                    });
                    break;
                }
                currentIndex++;
                continue;
            }

            // Read from DOM (side panel) OR from DM storage â€” DM settings take priority if side panel closed
            await updateDownloadPromptState(currentIndex, {
                status: 'submitted',
                submittedAt: Date.now(),
                mode: currentMode,
                expected: expectedCountForMode(currentMode),
                selectedPosition: currentMode === 'image-to-video' ? 1 : null,
                secondaryPosition: currentMode === 'image-to-video' ? 1 : null,
                resolvedPosition: null,
                resolvedReason: ''
            });
            submittedStateAlreadyUpdated = true;

            const storedRefresh = (await chrome.storage.local.get({ autoRefreshAfterPrompt: false })).autoRefreshAfterPrompt;
            const domRefresh = document.getElementById('refreshAfterPromptToggle')?.checked || false;
            const refreshAfterPrompt = domRefresh || storedRefresh;

            if (refreshAfterPrompt) {
                await saveAutomationState({
                    generationFlow: 'create',
                    pendingAfterSubmit: true,
                    uploadDelay: uploadDelay / 1000,
                    aspectRatio,
                    status: 'refreshing'
                });
                const refreshed = await smartRefreshCreateTabAfterSubmit(currentIndex);
                if (!refreshed && (stopRequested || isStopped)) break;
                if (refreshed === 'skipped') {
                    await saveAutomationState({
                        generationFlow: 'create',
                        pendingAfterSubmit: false,
                        uploadDelay: uploadDelay / 1000,
                        aspectRatio,
                        status: 'detecting'
                    });
                }
            } else {
                await saveAutomationState({
                    generationFlow: 'create',
                    pendingAfterSubmit: false,
                    uploadDelay: uploadDelay / 1000,
                    aspectRatio,
                    status: 'detecting'
                });
            }
        }

        if (!submittedStateAlreadyUpdated) {
            await updateDownloadPromptState(currentIndex, {
                status: 'submitted',
                submittedAt: Date.now(),
                mode: currentMode,
                expected: expectedCountForMode(currentMode),
                selectedPosition: currentMode === 'image-to-video' ? 1 : null,
                secondaryPosition: currentMode === 'image-to-video' ? 1 : null,
                resolvedPosition: null,
                resolvedReason: ''
            });
        }

        // â”€â”€ GATE: Wait for the selected slot to be detected before advancing â”€â”€â”€â”€â”€
        // Gate waits for the selected output slot in image, video, and image-to-video modes.
        const isGateMode = true;

        if (isGateMode) {
            // Read gate settings
            const gateSettingsData = await chrome.storage.local.get({
                imageGenerationSelect: 'auto',
                videoGenerationSelect: 'auto',
                secondaryVideoGenerationSelect: 'auto',
                maxPerPromptRetries: 3,
                perAttemptMinTimeoutSec: 60,
                perAttemptTimeoutSec: 60,
                customSelections: {}
            });
            const expectedSlot = (() => {
                const custom = gateSettingsData.customSelections?.[currentIndex];
                if (custom && custom !== 'auto') return Number(custom);
                const stored = targetType === 'image'
                    ? gateSettingsData.imageGenerationSelect
                    : gateSettingsData.videoGenerationSelect;
                if (stored && stored !== 'auto') return Number(stored);
                return currentMode === 'image-to-video' ? 1 : 4; // default: last slot
            })();
            const secondarySlot = (() => {
                if (targetType === 'image' || currentMode === 'image-to-video') return expectedSlot;
                const stored = gateSettingsData.secondaryVideoGenerationSelect;
                if (stored && stored !== 'auto') return Number(stored);
                return 4;
            })();

            // Fix: use ?? not || so that 0 (retry disabled) is respected, not fallen back to 3
            const rawMaxRetries = gateSettingsData.maxPerPromptRetries;
            const gateMaxRetries = (rawMaxRetries !== undefined && rawMaxRetries !== null && rawMaxRetries !== '')
                ? Number(rawMaxRetries)
                : 3;
            const gateMinTimeoutSec = Math.max(10, Number(gateSettingsData.perAttemptMinTimeoutSec) || 60);
            const gateMaxTimeoutSec = Math.max(gateMinTimeoutSec, Number(gateSettingsData.perAttemptTimeoutSec) || 60);
            const gateTimeoutSec = Math.floor(gateMinTimeoutSec + Math.random() * (gateMaxTimeoutSec - gateMinTimeoutSec + 1));
            const gateTimeoutMs = gateTimeoutSec * 1000;

            const sessionBeforeGate = (await chrome.storage.local.get(DOWNLOAD_SESSION_KEY))[DOWNLOAD_SESSION_KEY] || {};
            const promptBeforeGate = (sessionBeforeGate.prompts || []).find(p => Number(p.index) === Number(currentIndex));
            const existingRetryCount = Math.max(0, Number(promptBeforeGate?.retryCount || 0));
            const detectedBeforeGate = await getPromptDetectedOutput(currentIndex, gateSettingsData, false);
            if (!detectedBeforeGate?.src && existingRetryCount >= gateMaxRetries) {
                logMessage(`Prompt ${currentIndex + 1} reached ${existingRetryCount}/${gateMaxRetries} retries. Marking failed and moving next.`, 'error');
                await updateDownloadPromptState(currentIndex, {
                    status: 'failed',
                    selectedPosition: expectedSlot,
                    secondaryPosition: secondarySlot,
                    resolvedPosition: null,
                    resolvedReason: 'max_attempts_reached',
                    retryCount: existingRetryCount,
                    retryReason: 'max_attempts_reached'
                });
                currentIndex++;
                await syncDownloadSession({ currentIndex });
                await saveAutomationState({
                    generationFlow: 'create',
                    pendingAfterSubmit: false,
                    uploadDelay: uploadDelay / 1000,
                    aspectRatio,
                    status: 'detecting'
                });
                continue;
            }

            // Open the gate for this prompt
            await openGateForPrompt(currentIndex, expectedSlot, {
                maxRetries: gateMaxRetries,
                secondarySlot,
                retryCount: existingRetryCount
            });

            logMessage(`â³ Prompt ${currentIndex + 1} submitted â€” waiting for slot ${expectedSlot} (max ${gateMaxRetries} retries, ${gateMinTimeoutSec}-${gateMaxTimeoutSec}s/attempt)...`, 'info');

            await runRealtimeDetectionScan('gate-open-existing-output');
            let gateResult = null;
            const alreadyDetected = await getPromptDetectedOutput(currentIndex, gateSettingsData, true);
            if (alreadyDetected?.src) {
                gateResult = {
                    status: Number(alreadyDetected.position) === Number(expectedSlot) ? GATE_STATUS.READY : GATE_STATUS.FALLBACK,
                    slot: alreadyDetected,
                    retryCount: existingRetryCount
                };
                logMessage(`Prompt ${currentIndex + 1} already detected in Download Manager - skipping retry wait.`, 'success');
            }

            // Define retry function â€” called by waitForPromptGate when timeout hits
            const gateRetryFn = async (retryCount) => {
                if (stopRequested || isStopped) return false;
                await runRealtimeDetectionScan('gate-before-retry-force-scan');
                await interruptibleSleep(3000, () => stopRequested || isStopped);
                if (stopRequested || isStopped) return false;
                await runRealtimeDetectionScan('gate-before-retry-settle-scan');
                const beforeRetryDetected = await getPromptDetectedOutput(currentIndex, gateSettingsData, true);
                if (beforeRetryDetected?.src) {
                    logMessage(`Retry cancelled: prompt ${currentIndex + 1} is already detected.`, 'success');
                    return true;
                }
                logMessage(`ðŸ”„ Prompt ${currentIndex + 1} slot ${expectedSlot} not detected â€” retry ${retryCount}/${gateMaxRetries}`, 'warn');

                // Lock fresh baseline before retry
                await lockFreshRetryBaseline(currentIndex + 1);

                // Re-submit the same prompt
                let retrySubmitRes;
                if (currentMode === 'image-to-video') {
                    const retryImage = findImageForPromptIndex(currentIndex);
                    if (!retryImage) {
                        logMessage(`Retry skipped: image ${currentIndex + 1} missing.`, 'error');
                        return false;
                    }
                    const base64 = await readFileAsDataURL(retryImage);
                    retrySubmitRes = await injectScript(submitCreatePrompt, [{
                        command: '/video', prompt: getPromptForIndex(currentIndex),
                        imageBase64: base64, imageName: retryImage.name, uploadDelay
                    }]);
                } else {
                    retrySubmitRes = await injectScript(submitCreatePrompt, [{
                        command, prompt: getPromptForIndex(currentIndex), uploadDelay
                    }]);
                }

                if (retrySubmitRes?.logs) retrySubmitRes.logs.forEach(l => logMessage(`[Retry] ${l}`, /\[fail\]/i.test(l) ? 'error' : 'info'));
                if (!retrySubmitRes?.success) {
                    logMessage(`Retry submit failed for prompt ${currentIndex + 1}: ${retrySubmitRes?.error || 'unknown'}`, 'error');
                    return false;
                }

                // Update download session state
                await updateDownloadPromptState(currentIndex, {
                    status: 'submitted',
                    submittedAt: Date.now(),
                    retryCount: retryCount,
                    lastRetryAt: Date.now(),
                    retryReason: `slot_${expectedSlot}_not_detected`
                });

                logMessage(`Prompt ${currentIndex + 1} re-submitted (attempt ${retryCount}). Watching for slot ${expectedSlot}...`, 'info');
                await runRealtimeDetectionScan('gate-retry-submit');
                const storedRefresh = (await chrome.storage.local.get({ autoRefreshAfterPrompt: false })).autoRefreshAfterPrompt;
                const domRefresh = document.getElementById('refreshAfterPromptToggle')?.checked || false;
                if ((domRefresh || storedRefresh) && Number(retryCount) < gateMaxRetries) {
                    await saveAutomationState({
                        generationFlow: 'create',
                        pendingAfterSubmit: true,
                        uploadDelay: uploadDelay / 1000,
                        aspectRatio,
                        status: 'refreshing'
                    });
                    const refreshed = await smartRefreshCreateTabAfterSubmit(currentIndex);
                    if (!refreshed && (stopRequested || isStopped)) return false;
                    if (refreshed === 'skipped') {
                        await saveAutomationState({
                            generationFlow: 'create',
                            pendingAfterSubmit: false,
                            uploadDelay: uploadDelay / 1000,
                            aspectRatio,
                            status: 'detecting'
                        });
                    }
                    await runRealtimeDetectionScan('gate-retry-smart-refresh');
                }
                return true;
            };

            // Block until gate opens (selected slot detected) or max retries exhausted
            if (!gateResult) {
                gateResult = await waitForPromptGate(currentIndex, {
                    perAttemptTimeoutMs: gateTimeoutMs,
                    retryFn: gateRetryFn,
                    shouldStop: () => stopRequested || isStopped
                });
            }

            if (stopRequested || isStopped) break;

            if (gateResult.status === GATE_STATUS.READY) {
                logMessage(`âœ… Prompt ${currentIndex + 1} â€” slot ${expectedSlot} detected! Advancing.`, 'success');
                await updateDownloadPromptState(currentIndex, {
                    status: 'ready',
                    detectedAt: Date.now(),
                    selectedPosition: expectedSlot,
                    secondaryPosition: secondarySlot,
                    resolvedPosition: Number(gateResult.slot?.position || expectedSlot),
                    resolvedReason: 'primary_slot_detected',
                    retryCount: gateResult.retryCount || 0
                });
            } else if (gateResult.status === GATE_STATUS.FALLBACK) {
                const fbSlot = gateResult.slot?.position;
                await updateDownloadPromptState(currentIndex, {
                    status: 'ready',
                    detectedAt: Date.now(),
                    selectedPosition: expectedSlot,
                    secondaryPosition: secondarySlot,
                    resolvedPosition: Number(fbSlot || secondarySlot),
                    resolvedReason: 'secondary_slot_detected',
                    retryCount: gateResult.retryCount || 0
                });
                logMessage(`âš ï¸ Prompt ${currentIndex + 1} â€” slot ${expectedSlot} not found. Using slot ${fbSlot} as fallback.`, 'warn');
            } else {
                logMessage(`âŒ Prompt ${currentIndex + 1} â€” not detected after ${gateMaxRetries} retries. Skipping.`, 'error');
                await updateDownloadPromptState(currentIndex, {
                    status: 'failed',
                    selectedPosition: expectedSlot,
                    secondaryPosition: secondarySlot,
                    resolvedPosition: null,
                    resolvedReason: 'no_primary_or_secondary_slot',
                    retryCount: gateResult.retryCount || gateMaxRetries,
                    retryReason: 'max_attempts_reached'
                });
            }
        }

        currentIndex++;
        await syncDownloadSession({ currentIndex });
        await saveAutomationState({
            generationFlow: 'create',
            pendingAfterSubmit: false,
            uploadDelay: uploadDelay / 1000,
            aspectRatio
        });
    }


    if (retryListener) chrome.storage.onChanged.removeListener(retryListener);

    if (!stopRequested && !isStopped) {
        await waitForDownloadManagerCompletion(total, uploadDelay, aspectRatio);
    }
}

function findImageForPromptIndex(index) {
    const expected = index + 1;
    return imageFileList.find(file => {
        const match = file.name.match(/(\d+)/);
        return match && parseInt(match[1], 10) === expected;
    }) || imageFileList[index] || null;
}

async function refreshGalleryBaseline(baseline) {
    const result = await injectScript(scanCreateGalleryPage, [false]);
    if (!result?.items) return;
    createGalleryItems = dedupeGalleryItems([...createGalleryItems, ...result.items]);
    createGalleryItems.forEach(item => baseline.add(item.signature));
    createGalleryScanned = true;
    await saveGalleryState();
    renderCreateGallery();
}

function registerGeneratedOutput(type, src, prompt, baseline) {
    if (!src) return;
    const cleanPrompt = (prompt || '').replace(/\s+/g, ' ').trim();
    const signature = `${type}|${(src || '').split('#')[0].split('?')[0]}|${cleanPrompt.slice(0, 160)}`;
    baseline?.add(signature);
    activeCreateBaselineSignatures = baseline ? Array.from(baseline) : activeCreateBaselineSignatures;
    const item = {
        type,
        src,
        prompt: cleanPrompt,
        signature,
        detectedAt: Date.now(),
        savedAt: Date.now(),
        metaDate: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        source: 'automation'
    };
    createGalleryItems = dedupeGalleryItems([...createGalleryItems, item]);
    createGalleryScanned = true;
    saveGalleryState();
    renderCreateGallery();
}

async function waitForCreateMediaByPrompt(prompt, targetType, baseline, maxWait = 90000) {
    const start = Date.now();
    let loadingSeen = false;
    let articleSeen = false;
    let lifecycleLogShown = false;
    const promptIndex = currentIndex;
    const detectionKey = `${promptIndex}:${targetType}`;
    while (Date.now() - start < maxWait) {
        if (stopRequested || isStopped) return null;
        while (isPaused && !stopRequested && !isStopped) await new Promise(r => setTimeout(r, 500));
        if (stopRequested || isStopped) return null;

        const detectedData = await chrome.storage.local.get(DETECTED_OUTPUTS_KEY);
        const managerDetected = detectedData[DETECTED_OUTPUTS_KEY]?.[detectionKey];
        if (managerDetected?.src) {
            const signature = managerDetected.signature || `${targetType}|${(managerDetected.src || '').split('#')[0].split('?')[0]}|download-manager`;
            baseline.add(signature);
            activeCreateBaselineSignatures = Array.from(baseline);
            await syncDownloadSession({ baselineSignatures: activeCreateBaselineSignatures });
            logMessage(`Download Manager detected prompt ${promptIndex + 1} ${targetType}. Moving next.`, 'success');
            return managerDetected.src;
        }

        const selectionMode = targetType === 'video'
            ? (document.getElementById('videoGenerationSelect')?.value || 'auto')
            : (document.getElementById('imageGenerationSelect')?.value || 'auto');
        const result = await injectScript(findCreateMediaForPrompt, [prompt, targetType, Array.from(baseline), selectionMode]);
        if (result?.articleMatched) articleSeen = true;
        if (result?.loading) {
            loadingSeen = true;
            if (!lifecycleLogShown) {
                logMessage('Fresh generation loading detected. Waiting for selected output...', 'info');
                lifecycleLogShown = true;
            }
        }
        if (result?.mediaUrl) {
            const waitedMs = Date.now() - start;
            if (!loadingSeen && articleSeen && waitedMs < 15000) {
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }
            baseline.add(result.signature);
            activeCreateBaselineSignatures = Array.from(baseline);
            await syncDownloadSession({ baselineSignatures: activeCreateBaselineSignatures });
            return result.mediaUrl;
        }
        await new Promise(r => setTimeout(r, 1000));
    }
    return null;
}

async function getRetrySettings() {
    const data = await chrome.storage.local.get({
        retryOnTimeout: true,
        maxRetryAttempts: 3,
        retryRecentGraceSec: 60,
        retryOldPromptWindow: 6,
        retryPartialPrompts: true
    });
    return {
        enabled: data.retryOnTimeout !== false && data.retryOnTimeout !== 'false',
        maxAttempts: Math.max(0, Number(data.maxRetryAttempts) || 3),
        graceMs: Math.max(120000, (Number(data.retryRecentGraceSec) || 60) * 1000),
        oldWindow: Math.max(1, Number(data.retryOldPromptWindow) || 6),
        retryPartial: data.retryPartialPrompts !== false && data.retryPartialPrompts !== 'false'
    };
}

function getPromptRetryState(prompt) {
    if (['ready', 'downloaded', 'failed'].includes(prompt.status)) {
        return { expected: Number(prompt.expected) || 1, detected: (prompt.outputs || []).filter(o => o.src).length, missing: 0, complete: true };
    }
    const expected = Number(prompt.expected) || expectedCountForMode(prompt.mode);
    const outputs = Array.isArray(prompt.outputs) ? prompt.outputs.filter(o => o.src) : [];
    const detected = outputs.length;
    return {
        expected,
        detected,
        missing: Math.max(0, expected - detected),
        complete: detected >= expected
    };
}

async function getRetryCandidates(totalPrompts, settings, force = false) {
    const data = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
    const session = data[DOWNLOAD_SESSION_KEY] || {};
    const prompts = Array.isArray(session.prompts) ? session.prompts.slice(0, totalPrompts) : [];
    const now = Date.now();
    const candidates = [];
    const waiting = [];
    prompts.forEach(prompt => {
        const state = getPromptRetryState(prompt);
        if (state.complete) return;
        if (!settings.retryPartial && state.detected > 0) return;
        const retryCount = Number(prompt.retryCount || 0);
        if (retryCount >= settings.maxAttempts) return;
        const index = Number(prompt.index);
        const isRecent = index >= Math.max(0, totalPrompts - settings.oldWindow);
        const age = prompt.submittedAt ? now - prompt.submittedAt : Number.MAX_SAFE_INTEGER;
        const reason = state.detected === 0 ? 'missing_all' : `partial_${state.detected}_${state.expected}`;
        const item = { index, prompt: prompt.prompt, mode: prompt.mode || currentMode, expected: state.expected, detected: state.detected, reason, retryCount, ageMs: age };
        // SKIP grace window for prompts already marked 'timeout' â€” they already waited
        const alreadyTimedOut = prompt.status === 'timeout';
        if (!force && !alreadyTimedOut && isRecent && age < settings.graceMs) waiting.push({ ...item, waitMs: settings.graceMs - age });
        else candidates.push(item);
    });
    return { candidates, waiting, session };
}

async function lockFreshRetryBaseline(promptNumber) {
    const pageBaseline = await injectScript(collectCreateMediaBaselineSignatures, []);
    const signatures = new Set(activeCreateBaselineSignatures);
    (pageBaseline?.signatures || []).forEach(signature => signatures.add(signature));
    activeCreateBaselineSignatures = Array.from(signatures);
    await syncDownloadSession({ baselineSignatures: activeCreateBaselineSignatures });
    logMessage(`[Main -> DM] Fresh retry baseline locked for prompt ${promptNumber}: ${pageBaseline?.signatures?.length || 0} loaded media ignored.`, 'info');
}

async function retryCreatePrompt(candidate, uploadDelay, aspectRatio) {
    const promptNumber = Number(candidate.index) + 1;
    const mode = candidate.mode || currentMode;
    const isImageMode = mode === 'prompt-to-image';
    const command = isImageMode ? '/image' : '/video';
    await lockFreshRetryBaseline(promptNumber);
    await updateDownloadPromptState(candidate.index, {
        status: 'retrying',
        retryReason: candidate.reason,
        retryCount: Number(candidate.retryCount || 0) + 1,
        lastRetryAt: Date.now()
    });

    const aiReason = String(candidate.reason || '').match(/^ai_retry_step_(\d+)_attempt_(\d+)$/)
        || String(candidate.reason || '').match(/^ai_retry_step_(\d+)_extra_(\d+)$/);
    if (aiReason) {
        logMessage(`AI Retry Step ${aiReason[1]}/3: submitting prompt ${promptNumber} attempt ${Number(candidate.retryCount || 0) + 1}.`, 'warn');
    } else {
        logMessage(`[Main -> DM] Retry submit prompt ${promptNumber}: ${candidate.reason}, attempt ${Number(candidate.retryCount || 0) + 1}.`, 'warn');
    }
    let submitRes;
    if (mode === 'image-to-video') {
        const expectedImage = findImageForPromptIndex(candidate.index);
        if (!expectedImage) {
            await updateDownloadPromptState(candidate.index, { status: 'failed', retryReason: 'missing_retry_image' });
            logMessage(`[Main] Retry skipped prompt ${promptNumber}: matching image missing.`, 'error');
            return false;
        }
        const base64 = await readFileAsDataURL(expectedImage);
        submitRes = await injectScript(submitCreatePrompt, [{ command: '/video', prompt: candidate.prompt, imageBase64: base64, imageName: expectedImage.name, uploadDelay }]);
    } else {
        submitRes = await injectScript(submitCreatePrompt, [{ command, prompt: candidate.prompt, uploadDelay }]);
    }
    if (submitRes?.logs) submitRes.logs.forEach(l => logMessage(`[Meta -> Main] ${l}`, /\[fail\]/i.test(l) ? 'error' : 'info'));
    if (!submitRes?.success) {
        await updateDownloadPromptState(candidate.index, { status: 'timeout', retryReason: submitRes?.error || 'retry_submit_failed' });
        logMessage(`[Main -> DM] Retry submit failed for prompt ${promptNumber}: ${submitRes?.error || 'unknown'}.`, 'error');
        return false;
    }
    await updateDownloadPromptState(candidate.index, {
        status: 'submitted',
        submittedAt: Date.now(),
        mode,
        expected: expectedCountForMode(mode),
        retryReason: candidate.reason
    });
    await runRealtimeDetectionScan('retry-submit');
    return true;
}

async function runPowerRetryEngine(totalPrompts, uploadDelay = 0, aspectRatio = '9:16') {
    const settings = await getRetrySettings();
    if (!settings.enabled || settings.maxAttempts <= 0) {
        logMessage('[Main] Power retry disabled in Download Manager settings.', 'info');
        return;
    }
    await runRealtimeDetectionScan('retry-preflight');
    let { candidates, waiting } = await getRetryCandidates(totalPrompts, settings);
    if (waiting.length) {
        const waitMs = Math.min(Math.max(...waiting.map(w => w.waitMs)), settings.graceMs);
        logMessage(`[Main] Recent missing prompts still inside grace window. Waiting ${Math.ceil(waitMs / 1000)}s before any retry.`, 'info');
        await interruptibleSleep(waitMs, () => stopRequested || isStopped);
        await runRealtimeDetectionScan('retry-grace-scan');
        ({ candidates, waiting } = await getRetryCandidates(totalPrompts, settings));
    }
    let round = 0;
    while (!stopRequested && !isStopped && candidates.length && round < settings.maxAttempts) {
        round++;
        const summary = candidates.map(c => `${c.index + 1}(${c.reason})`).join(', ');
        logMessage(`[Main -> DM] Power retry round ${round}: ${candidates.length} prompt(s): ${summary}`, 'system');
        for (const candidate of candidates) {
            if (stopRequested || isStopped) return;
            // Force re-scan before retrying â€” may have been detected while waiting
            await runRealtimeDetectionScan('retry-pre-check');
            const freshCheck = await getRetryCandidates(totalPrompts, settings);
            if (!freshCheck.candidates.some(c => c.index === candidate.index)) {
                logMessage(`[Main] Prompt ${candidate.index + 1} detected before retry â€” skipping.`, 'success');
                continue;
            }
            await retryCreatePrompt(candidate, uploadDelay, aspectRatio);
            const retryWaitMs = getImageModeSettleWaitMs();
            logMessage(`[Main -> DM] Waiting ${Math.round(retryWaitMs / 1000)}s before next retry prompt.`, 'info');
            await interruptibleSleep(retryWaitMs, () => stopRequested || isStopped);
            // Forced re-scan after each individual retry to catch outputs before retrying next
            await runRealtimeDetectionScan('retry-post-submit');
        }
        // Brief pause between rounds, then re-scan and re-evaluate
        await interruptibleSleep(3000, () => stopRequested || isStopped);
        await runRealtimeDetectionScan('retry-round-final');
        ({ candidates } = await getRetryCandidates(totalPrompts, settings));
    }
    await runRealtimeDetectionScan('retry-final-settle');
    let finalData = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
    let finalSession = finalData[DOWNLOAD_SESSION_KEY] || {};
    let maybeFailed = (Array.isArray(finalSession.prompts) ? finalSession.prompts.slice(0, totalPrompts) : [])
        .filter(prompt => {
            const state = getPromptRetryState(prompt);
            return !state.complete && Number(prompt.retryCount || 0) >= settings.maxAttempts;
        });
    if (maybeFailed.length) {
        const settleMs = Math.max(settings.graceMs, getImageModeSettleWaitMs() * 2);
        logMessage(`[DM -> Main] Retry attempts sent. Waiting ${Math.ceil(settleMs / 1000)}s for late detections before marking failed.`, 'info');
        await interruptibleSleep(settleMs, () => stopRequested || isStopped);
        await runRealtimeDetectionScan('retry-final-late-scan');
    }

    finalData = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
    finalSession = finalData[DOWNLOAD_SESSION_KEY] || {};
    const failed = (Array.isArray(finalSession.prompts) ? finalSession.prompts.slice(0, totalPrompts) : [])
        .filter(prompt => {
            const state = getPromptRetryState(prompt);
            return !state.complete && Number(prompt.retryCount || 0) >= settings.maxAttempts;
        });
    if (failed.length) {
        logMessage(`[DM -> Main] Retry max reached for prompt(s): ${failed.map(f => Number(f.index) + 1).join(', ')}. Marking as failed.`, 'error');
        // Mark failed prompts so they don't block session completion
        const updatedPrompts = (finalSession.prompts || []).map(p => {
            if (failed.some(f => Number(f.index) === Number(p.index))) {
                return { ...p, status: 'failed', retryReason: 'max_attempts_reached' };
            }
            return p;
        });
        await chrome.storage.local.set({ [DOWNLOAD_SESSION_KEY]: { ...finalSession, prompts: updatedPrompts } });
    } else {
        logMessage('[DM -> Main] Power retry check complete. No retry candidates pending.', 'success');
    }
}

// ── AI Auto-Retry Engine (NVIDIA Qwen-powered prompt repair) ─────────────────
async function runAiRetryEngine(session, totalPrompts, uploadDelay = 0, aspectRatio = '9:16') {
    // Check if AI retry is enabled and read user-configured settings
    const storedSettings = await chrome.storage.local.get({
        aiRetryEnabled: false,
        geminiApiKey: '',
        aiRetryModel: 'deepseek',
        aiRetryRounds: 3,
        aiRetryDetectWait: 180,    // seconds per prompt detection wait
        aiRetryAttemptRetryEnabled: false,
        aiRetryAttemptRetries: 1
    });
    if (!storedSettings.aiRetryEnabled || !storedSettings.geminiApiKey) return false;

    const apiKey       = storedSettings.geminiApiKey;
    const aiModelLabel = getAiRetryModelLabel(storedSettings.aiRetryModel);
    const maxRounds    = 3;
    const detectWaitMs = Math.max(30, Number(storedSettings.aiRetryDetectWait) || 180) * 1000;
    const extraAttemptRetries = storedSettings.aiRetryAttemptRetryEnabled === true
        ? Math.max(1, Math.min(2, Number(storedSettings.aiRetryAttemptRetries) || 1))
        : 0;
    const totalAttemptsPerStep = 1 + extraAttemptRetries;
    logMessage(`AI Auto-Retry plan: Step 1 strict safe rewrite, Step 2 safer rewrite, Step 3 object-only fallback. Each edited prompt gets ${totalAttemptsPerStep} submit attempt(s).`, 'system');

    logMessage(`🤖 AI Auto-Retry: ${maxRounds} round(s), ${Math.round(detectWaitMs/1000)}s detection wait per prompt.`, 'system');

    // Collect all failed prompts from the current session
    const sessionData = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
    const currentSession = sessionData[DOWNLOAD_SESSION_KEY] || {};
    const allPrompts = Array.isArray(currentSession.prompts)
        ? currentSession.prompts.slice(0, totalPrompts)
        : [];
    const failedList = allPrompts
        .filter(p => ['failed', 'timeout', 'unrecoverable'].includes(p.status))
        .map(p => ({
            index: Number(p.index),
            promptNumber: Number(p.index) + 1,
            prompt: p.aiEditedPrompt || p.prompt || '',
            mode: p.mode || currentMode,
            originalPrompt: p.originalPrompt || p.prompt || '',
            previousEditedPrompt: p.aiEditedPrompt || '',
            round: 1,
            status: 'queued',
            retryReason: p.retryReason || ''
        }));

    if (failedList.length === 0) return false;

    logMessage(`AI Auto-Retry: ${failedList.length} failed prompt(s) found. Sending to ${aiModelLabel} for Step 1 rewrite...`, 'system');

    // Persist initial AI retry state to session so Download Manager can show it
    await chrome.storage.local.set({
        [DOWNLOAD_SESSION_KEY]: {
            ...currentSession,
            aiRetryState: { enabled: true, phase: 'sending', failedPrompts: failedList }
        }
    });

    // Helper: update individual prompt in the aiRetryState failedPrompts array
    async function updateAiPromptStatus(index, fields) {
        const d = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
        const s = d[DOWNLOAD_SESSION_KEY] || {};
        const fps = (s.aiRetryState?.failedPrompts || []).map(fp =>
            fp.index === index ? { ...fp, ...fields } : fp
        );
        await chrome.storage.local.set({
            [DOWNLOAD_SESSION_KEY]: {
                ...s,
                aiRetryState: { ...s.aiRetryState, failedPrompts: fps }
            }
        });
    }

    async function updateAiPhase(phase) {
        const d = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
        const s = d[DOWNLOAD_SESSION_KEY] || {};
        await chrome.storage.local.set({
            [DOWNLOAD_SESSION_KEY]: {
                ...s,
                aiRetryState: { ...(s.aiRetryState || {}), enabled: true, phase }
            }
        });
    }

    async function getAiDetectionSettings() {
        return await chrome.storage.local.get({
            videoGenerationSelect: 'auto',
            secondaryVideoGenerationSelect: 'auto',
            imageGenerationSelect: 'auto',
            customSelections: {},
            autoRefreshAfterPrompt: false,
            refreshAfterPrompt: false,
            autoRefreshDelay: DEFAULT_REFRESH_AFTER_PROMPT_WAIT,
            refreshAfterPromptWait: DEFAULT_REFRESH_AFTER_PROMPT_WAIT
        });
    }

    function buildObjectOnlyFallbackPrompt(promptNumber) {
        return `[CAMERA] Smooth slow push forward at eye level with stable cinematic framing. [PLACE] Neutral public building exterior in clear daylight with clean pavement, planters, windows, and simple architectural details. [SUBJECT] Object-only scene with no people: a small table, neatly arranged papers, a water bottle, soft fabric swatches, and flowers near the entrance. [ACTION] Papers shift gently in a light breeze while sunlight moves across the pavement and glass. [PHYSICS] Natural daylight reflections, subtle fabric movement, realistic shadows, shallow depth of field. [MOOD] Calm ordinary daytime atmosphere, safe, neutral, non-threatening. [TECH] Cinematic 4K, 9:16 vertical, photorealistic, hyperrealistic motion, film grain, no text, no captions, no watermarks, no AI artifacts.`;
    }

    async function markAiPromptFixedIfDetected(fp, scanReason, roundNum) {
        await runRealtimeDetectionScan(scanReason);
        const detectionSettings = await getAiDetectionSettings();
        const detectedOutput = await getPromptDetectedOutput(fp.index, detectionSettings, true);
        if (!detectedOutput?.src) return false;
        await updateAiPromptStatus(fp.index, { status: 'success', round: roundNum });
        await updateDownloadPromptState(fp.index, {
            status: 'ready',
            aiRetryFixed: true,
            detectedAt: Date.now(),
            resolvedPosition: Number(detectedOutput.position || 1),
            retryReason: `ai_retry_r${roundNum}_fixed_late_detection`
        });
        logMessage(`AI Retry Step ${roundNum}/3: Prompt ${fp.index + 1} was already detected. Skipping next submit.`, 'success');
        return true;
    }

    async function waitForMainDetection(promptIndex, roundNum, label, waitMs) {
        const deadline = Date.now() + waitMs;
        while (!stopRequested && !isStopped && Date.now() < deadline) {
            if (await markAiPromptFixedIfDetected({ index: promptIndex }, label, roundNum)) return true;
            await interruptibleSleep(1000, () => stopRequested || isStopped);
        }
        return false;
    }

    // Round helper
    async function processRound(promptsToProcess, roundNum) {
        const stillFailed = [];
        if (!promptsToProcess.length) return stillFailed;

        await updateAiPhase(roundNum === 1 ? 'sending' : roundNum === 2 ? 'round2' : 'round3');
        const activePrompts = [];
        for (const fp of promptsToProcess) {
            if (await markAiPromptFixedIfDetected(fp, `ai-retry-step-${roundNum}-precheck`, roundNum)) continue;
            activePrompts.push(fp);
            await updateAiPromptStatus(fp.index, { status: 'sending', round: roundNum });
        }
        if (!activePrompts.length) return stillFailed;

        const batchPayload = activePrompts.map(fp => ({
            promptNumber: fp.promptNumber || fp.index + 1,
            prompt: fp.prompt || '',
            originalPrompt: fp.originalPrompt || fp.prompt || '',
            failedReason: fp.retryReason || 'generation_or_detection_failed',
            previousEditedPrompt: fp.previousEditedPrompt || '',
            round: roundNum
        }));
        const editsByNumber = new Map();

        if (roundNum >= 3) {
            batchPayload.forEach(item => {
                editsByNumber.set(Number(item.promptNumber), buildObjectOnlyFallbackPrompt(item.promptNumber));
            });
            logMessage(`AI Retry R${roundNum}: using object-only fallback for ${batchPayload.length} prompt(s).`, 'warn');
        } else {
            const batchResult = await callGeminiBatch(apiKey, batchPayload, roundNum);
            if (batchResult.success) {
                batchResult.edits.forEach(item => editsByNumber.set(Number(item.promptNumber), item.editedPrompt));
                logMessage(`AI Retry R${roundNum}: ${aiModelLabel} returned ${batchResult.edits.length} numbered edit(s).`, 'info');
            } else {
                for (const fp of activePrompts) {
                    await waitForMainDetection(fp.index, roundNum, `ai-retry-step-${roundNum}-batch-failed-settle`, 4000);
                }
                logMessage(`AI Retry R${roundNum}: Batch repair failed (${batchResult.error}). Falling back one-by-one.`, 'warn');
            }
        }
        await updateAiPhase(roundNum === 1 ? 'retrying' : roundNum === 2 ? 'retrying2' : 'retrying3');

        for (const fp of activePrompts) {
            if (stopRequested || isStopped) return [];
            if (await markAiPromptFixedIfDetected(fp, `ai-retry-step-${roundNum}-after-ai-response`, roundNum)) continue;

            const promptNumber = fp.promptNumber || fp.index + 1;
            let result = { success: false, editedPrompt: editsByNumber.get(promptNumber), error: '' };
            if (result.editedPrompt) {
                result.success = true;
            } else {
                if (await markAiPromptFixedIfDetected(fp, `ai-retry-step-${roundNum}-before-single-rewrite`, roundNum)) continue;
                result = await callGemini(apiKey, fp.prompt, promptNumber, fp.retryReason || 'generation_or_detection_failed', roundNum);
            }

            if (!result.success) {
                logMessage(`AI Retry Step ${roundNum}/3: ${aiModelLabel} rewrite failed for prompt ${fp.index + 1}: ${result.error}`, 'warn');
                await updateAiPromptStatus(fp.index, { status: roundNum === maxRounds ? 'unrecoverable' : 'failed2', round: roundNum });
                await updateDownloadPromptState(fp.index, {
                    status: roundNum === maxRounds ? 'unrecoverable' : 'failed',
                    retryReason: `ai_retry_r${roundNum}_no_edit`,
                    originalPrompt: fp.originalPrompt || fp.prompt || ''
                });
                stillFailed.push(fp);
                continue;
            }

            const editedPrompt = result.editedPrompt;
            logMessage(`AI Retry Step ${roundNum}/3: Prompt ${fp.index + 1} will try edited prompt (${totalAttemptsPerStep} total attempt(s)).`, 'info');
            logMessage(`AI Retry Step ${roundNum}/3: Prompt ${fp.index + 1} rewrite ready. Retrying through main detection flow...`, 'success');
            await updateAiPromptStatus(fp.index, { status: 'retrying', editedPrompt, round: roundNum });

            // Submit the AI-edited prompt using the existing retry mechanism
            const candidate = {
                index: fp.index,
                prompt: editedPrompt,
                mode: fp.mode || currentMode,
                expected: expectedCountForMode(fp.mode || currentMode),
                reason: `ai_retry_step_${roundNum}_attempt_1`,
                retryCount: 0
            };

            // Reset the prompt status so the retry engine treats it as fresh
            await updateDownloadPromptState(fp.index, {
                status: 'submitted',
                submittedAt: Date.now(),
                retryCount: 0,
                aiEdited: true,
                aiEditedPrompt: editedPrompt,
                originalPrompt: fp.originalPrompt || fp.prompt || '',
                prompt: editedPrompt,
                retryReason: `ai_retry_step_${roundNum}_attempt_1`
            });

            let detected = false;
            const submitted = await retryCreatePrompt(candidate, uploadDelay, aspectRatio);
            if (!submitted) {
                for (let extraAttempt = 1; extraAttempt <= extraAttemptRetries && !detected && !stopRequested && !isStopped; extraAttempt++) {
                    const attemptNum = extraAttempt + 1;
                    if (await markAiPromptFixedIfDetected(fp, `ai-retry-step-${roundNum}-extra-${extraAttempt}-precheck`, roundNum)) {
                        detected = true;
                        break;
                    }
                    logMessage(`AI Retry Step ${roundNum}/3: Prompt ${fp.index + 1} extra retry ${extraAttempt}/${extraAttemptRetries} using the same AI edit.`, 'warn');
                    await updateDownloadPromptState(fp.index, {
                        status: 'submitted',
                        submittedAt: Date.now(),
                        retryCount: attemptNum - 1,
                        aiEdited: true,
                        aiEditedPrompt: editedPrompt,
                        originalPrompt: fp.originalPrompt || fp.prompt || '',
                        prompt: editedPrompt,
                        retryReason: `ai_retry_step_${roundNum}_extra_${extraAttempt}`
                    });
                    const submittedAgain = await retryCreatePrompt({
                        index: fp.index,
                        prompt: editedPrompt,
                        mode: fp.mode || currentMode,
                        expected: expectedCountForMode(fp.mode || currentMode),
                        reason: `ai_retry_step_${roundNum}_extra_${extraAttempt}`,
                        retryCount: attemptNum - 1
                    }, uploadDelay, aspectRatio);
                    if (!submittedAgain) continue;
                    const extraDeadline = Date.now() + detectWaitMs;
                    logMessage(`AI Retry Step ${roundNum}/3: Prompt ${fp.index + 1}, extra retry ${extraAttempt}/${extraAttemptRetries} waiting ${Math.round(detectWaitMs / 1000)}s for detection.`, 'info');
                    while (!stopRequested && !isStopped && Date.now() < extraDeadline) {
                        if (await markAiPromptFixedIfDetected(fp, `ai-retry-step-${roundNum}-extra-${extraAttempt}-wait`, roundNum)) {
                            detected = true;
                            break;
                        }
                        await interruptibleSleep(6000, () => stopRequested || isStopped);
                    }
                }
                if (detected) continue;
                const finalFail = roundNum === maxRounds;
                await updateAiPromptStatus(fp.index, { status: finalFail ? 'unrecoverable' : 'failed2', round: roundNum });
                stillFailed.push({ ...fp, prompt: editedPrompt, previousEditedPrompt: editedPrompt, editedPrompt, round: roundNum });
                continue;
            }
            await runRealtimeDetectionScan('ai-retry-submit');
            const refreshSettings = await getAiDetectionSettings();
            const shouldSmartRefresh = refreshSettings.autoRefreshAfterPrompt === true
                || refreshSettings.autoRefreshAfterPrompt === 'true'
                || refreshSettings.refreshAfterPrompt === true
                || refreshSettings.refreshAfterPrompt === 'true'
                || document.getElementById('refreshAfterPromptToggle')?.checked === true;
            if (shouldSmartRefresh) {
                const refreshResult = await smartRefreshCreateTabAfterSubmit(fp.index);
                if (refreshResult === 'skipped') detected = true;
            }

            // Wait for detection — uses user-configured aiRetryDetectWait setting
            const detectDeadline = Date.now() + detectWaitMs;
            while (!stopRequested && !isStopped && Date.now() < detectDeadline) {
                if (await markAiPromptFixedIfDetected(fp, `ai-retry-step-${roundNum}-detect-wait`, roundNum)) {
                    detected = true;
                    break;
                }
                await runRealtimeDetectionScan('ai-retry-detect-wait');
                const checkData = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
                const checkSession = checkData[DOWNLOAD_SESSION_KEY] || {};
                const checkPrompt = (checkSession.prompts || []).find(p => Number(p.index) === fp.index);
                if (checkPrompt) {
                    const anyOutput = (checkPrompt.outputs || []).find(item => item?.src);
                    if (anyOutput?.src || checkPrompt.status === 'ready') {
                        detected = true;
                        break;
                    }
                }
                await interruptibleSleep(6000, () => stopRequested || isStopped);
            }

            if (!detected) {
                for (let extraAttempt = 1; extraAttempt <= extraAttemptRetries && !detected && !stopRequested && !isStopped; extraAttempt++) {
                    const attemptNum = extraAttempt + 1;
                    if (await markAiPromptFixedIfDetected(fp, `ai-retry-step-${roundNum}-extra-${extraAttempt}-precheck`, roundNum)) {
                        detected = true;
                        break;
                    }
                    logMessage(`AI Retry Step ${roundNum}/3: Prompt ${fp.index + 1} extra retry ${extraAttempt}/${extraAttemptRetries} using the same AI edit.`, 'warn');
                    await updateDownloadPromptState(fp.index, {
                        status: 'submitted',
                        submittedAt: Date.now(),
                        retryCount: attemptNum - 1,
                        aiEdited: true,
                        aiEditedPrompt: editedPrompt,
                        originalPrompt: fp.originalPrompt || fp.prompt || '',
                        prompt: editedPrompt,
                        retryReason: `ai_retry_step_${roundNum}_extra_${extraAttempt}`
                    });
                    const submittedAgain = await retryCreatePrompt({
                        index: fp.index,
                        prompt: editedPrompt,
                        mode: fp.mode || currentMode,
                        expected: expectedCountForMode(fp.mode || currentMode),
                        reason: `ai_retry_step_${roundNum}_extra_${extraAttempt}`,
                        retryCount: attemptNum - 1
                    }, uploadDelay, aspectRatio);
                    if (!submittedAgain) continue;
                    const extraDeadline = Date.now() + detectWaitMs;
                    logMessage(`AI Retry Step ${roundNum}/3: Prompt ${fp.index + 1}, extra retry ${extraAttempt}/${extraAttemptRetries} waiting ${Math.round(detectWaitMs / 1000)}s for detection.`, 'info');
                    while (!stopRequested && !isStopped && Date.now() < extraDeadline) {
                        if (await markAiPromptFixedIfDetected(fp, `ai-retry-step-${roundNum}-extra-${extraAttempt}-wait`, roundNum)) {
                            detected = true;
                            break;
                        }
                        await interruptibleSleep(6000, () => stopRequested || isStopped);
                    }
                }
            }

            if (detected) {
                logMessage(`AI Retry Step ${roundNum}/3: Prompt ${fp.index + 1} detected by Download Manager. Marking fixed.`, 'success');
                await updateAiPromptStatus(fp.index, { status: 'success' });
                await updateDownloadPromptState(fp.index, {
                    status: 'ready',
                    aiRetryFixed: true,
                    retryReason: `ai_retry_r${roundNum}_fixed`
                });
            } else {
                logMessage(`AI Retry Step ${roundNum}/3: Prompt ${fp.index + 1} not detected after main detection wait. Moving to next safe step.`, 'error');
                const finalFail = roundNum === maxRounds;
                await updateAiPromptStatus(fp.index, { status: finalFail ? 'unrecoverable' : 'failed2', round: roundNum });
                await updateDownloadPromptState(fp.index, {
                    status: finalFail ? 'unrecoverable' : 'failed',
                    retryReason: `ai_retry_r${roundNum}_not_detected`,
                    aiEdited: true,
                    aiEditedPrompt: editedPrompt,
                    originalPrompt: fp.originalPrompt || fp.prompt || '',
                    prompt: editedPrompt
                });
                stillFailed.push({ ...fp, prompt: editedPrompt, previousEditedPrompt: editedPrompt, editedPrompt, round: roundNum });
            }
        }
        return stillFailed;
    }

    // Execute Round 1
    let remaining = await processRound(failedList, 1);

    // Execute subsequent rounds (up to maxRounds) for prompts that still failed
    for (let round = 2; round <= maxRounds && remaining.length > 0 && !stopRequested && !isStopped; round++) {
        const d = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
        const s = d[DOWNLOAD_SESSION_KEY] || {};
        await chrome.storage.local.set({
            [DOWNLOAD_SESSION_KEY]: {
                ...s,
                aiRetryState: { ...s.aiRetryState, phase: round === 2 ? 'round2' : 'round3' }
            }
        });
        logMessage(`🤖 AI Retry Round ${round}/${maxRounds}: ${remaining.length} prompt(s) still need repair.`, 'warn');
        remaining = await processRound(remaining, round);
    }

    // Mark complete in state
    const finalD = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
    const finalS = finalD[DOWNLOAD_SESSION_KEY] || {};
    await chrome.storage.local.set({
        [DOWNLOAD_SESSION_KEY]: {
            ...finalS,
            aiRetryState: { ...finalS.aiRetryState, phase: 'done' }
        }
    });

    // Export unrecoverable prompts to a text file if any remain
    if (remaining.length > 0) {
        // Final failed prompts stay in session; Download Manager includes failed-prompts.txt with the selected download flow.
        logMessage(`${remaining.length} unrecoverable prompt(s) will be included in failed-prompts.txt during auto-download.`, 'warn');
    } else {
        logMessage('✅ AI Auto-Retry complete! All failed prompts recovered.', 'success');
    }

    return true;
}

async function waitForDownloadManagerCompletion(totalPrompts, uploadDelay = 0, aspectRatio = '9:16') {
    logMessage(`All ${totalPrompts} prompts submitted. Download Manager now scanning...`, 'system');

    // â”€â”€ Mark session: all prompts submitted (Download Manager reads this) â”€â”€â”€â”€â”€â”€â”€â”€
    const sessionData = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
    const currentSession = sessionData[DOWNLOAD_SESSION_KEY] || {};
    await chrome.storage.local.set({
        [DOWNLOAD_SESSION_KEY]: { ...currentSession, allPromptsSubmitted: true, totalPromptsSubmitted: totalPrompts }
    });

    // â”€â”€ IMMEDIATE RETRY: re-submit any prompts already in 'timeout' state NOW â”€â”€
    // Don't wait for the retry engine â€” these prompts have been idle long enough.
    try {
        const preData = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
        const preSession = preData[DOWNLOAD_SESSION_KEY] || {};
        const preRetrySettings = await getRetrySettings();
        const timedOutNow = (preSession.prompts || []).filter(p =>
            p.status === 'timeout' && (p.outputs || []).length === 0 &&
            Number(p.retryCount || 0) < preRetrySettings.maxAttempts
        );
        if (timedOutNow.length > 0) {
            logMessage(`âš¡ ${timedOutNow.length} prompt(s) already timed out â€” retrying immediately before scan loop.`, 'warn');
            for (const prompt of timedOutNow) {
                if (stopRequested || isStopped) break;
                await retryCreatePrompt({
                    index: Number(prompt.index), prompt: prompt.prompt,
                    mode: prompt.mode || currentMode,
                    expected: Number(prompt.expected) || expectedCountForMode(prompt.mode || currentMode), detected: 0,
                    reason: 'timeout_pre_completion', retryCount: Number(prompt.retryCount || 0)
                }, uploadDelay, aspectRatio);
                await runRealtimeDetectionScan('pre-completion-retry');
                const retryWaitMs = getImageModeSettleWaitMs();
                logMessage(`[Main -> DM] Waiting ${Math.round(retryWaitMs / 1000)}s before next pre-completion retry.`, 'info');
                const sleepRes = await interruptibleSleep(retryWaitMs, () => stopRequested || isStopped);
                if (sleepRes === 'STOPPED') break;
            }
        }
    } catch (e) { console.warn('[AutoMeta] Pre-completion retry error:', e.message); }

    logMessage('[Main -> DM] All prompts submitted. Starting power retry pre-check.', 'system');
    await runPowerRetryEngine(totalPrompts, uploadDelay, aspectRatio);

    async function getCompletionSettings() {
        const settings = await chrome.storage.local.get({
            videoGenerationSelect: 'auto',
            secondaryVideoGenerationSelect: 'auto',
            imageGenerationSelect: 'auto',
            customSelections: {},
            autoDownload: true,
            autoDownloadMode: 'afterReady'
        });
        settings.autoDownloadMode = (settings.autoDownloadMode === 'afterAllReadyZip' || settings.autoDownloadMode === 'afterAllComplete-zip')
            ? 'afterAllReadyZip'
            : 'afterReady';
        return settings;
    }

    async function triggerDownloadsOrSkip(session, failedPrompts = []) {
        const settings = await getCompletionSettings();

        // ─ AI Auto-Retry gate: if enabled and there are failed prompts, run AI retry first
        const aiSettings = await chrome.storage.local.get({ aiRetryEnabled: false, geminiApiKey: '' });
        const hasFailedInSession = (session?.prompts || []).some(p => ['failed', 'timeout', 'unrecoverable'].includes(p.status));
        if (aiSettings.aiRetryEnabled && aiSettings.geminiApiKey && hasFailedInSession) {
            logMessage('🤖 AI Auto-Retry enabled — running before auto-download...', 'system');
            await runAiRetryEngine(session, totalPrompts, uploadDelay, aspectRatio);
            // Re-read session after AI retry completes
            const refreshed = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
            session = refreshed[DOWNLOAD_SESSION_KEY] || session;
            failedPrompts = (session.prompts || []).filter(p => ['failed', 'timeout', 'unrecoverable'].includes(p.status));
        }

        if (settings.autoDownload === false || settings.autoDownload === 'false') {
            logMessage('Auto-download is off/manual. Successful outputs are ready in Download Manager.', 'warn');
            await chrome.storage.local.set({ [DOWNLOAD_SESSION_KEY]: { ...session, downloadsDone: true, running: false, completedAt: Date.now() } });
            return true;
        }
        if (failedPrompts.length) {
            logMessage(`${failedPrompts.length} prompt(s) failed. Downloading successful selected outputs.`, 'warn');
        } else {
            logMessage('All selected outputs resolved. Download Manager is downloading...', 'success');
        }
        await chrome.storage.local.set({ [DOWNLOAD_SESSION_KEY]: { ...session, downloadStartRequested: true, running: false, completedAt: Date.now() } });
        await startQueuedDownloads();
        return await waitForDownloadsDone(session, failedPrompts);
    }

    // â”€â”€ Helper: check detection state per-prompt â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async function checkDetectionState() {
        const data = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
        const session = data[DOWNLOAD_SESSION_KEY] || {};
        const prompts = Array.isArray(session.prompts) ? session.prompts.slice(0, totalPrompts) : [];
        const missingPrompts = [];   // prompts with 0 outputs detected
        const partialPrompts = [];   // prompts with some but not all outputs
        const timedOutPrompts = [];  // prompts that have been submitted > 60s with no detection
        const now = Date.now();
        prompts.forEach(prompt => {
            // Skip permanently failed prompts â€” they should not block completion
            if (prompt.status === 'failed') return;
            if (prompt.status === 'ready' || prompt.status === 'downloaded') return;
            const expected = Number(prompt.expected) || expectedCountForMode(prompt.mode);
            const outputs = Array.isArray(prompt.outputs) ? prompt.outputs : [];
            const detected = outputs.filter(o => o.src).length;
            const submittedAt = prompt.submittedAt || 0;
            const elapsedSec = submittedAt ? Math.round((now - submittedAt) / 1000) : 0;
            if (detected === 0) {
                missingPrompts.push({ index: prompt.index, prompt: prompt.prompt, elapsedSec });
                if (submittedAt && (now - submittedAt) > 60000) {
                    timedOutPrompts.push({ index: prompt.index, prompt: prompt.prompt, elapsedSec });
                }
            } else if (detected < expected) {
                partialPrompts.push({ index: prompt.index, detected, expected });
            }
        });
        const allDetected = missingPrompts.length === 0 && partialPrompts.length === 0;
        return { allDetected, missingPrompts, partialPrompts, timedOutPrompts, session };
    }

    async function checkSelectedResolutionState() {
        const data = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
        const settings = await getCompletionSettings();
        const session = data[DOWNLOAD_SESSION_KEY] || {};
        const prompts = Array.isArray(session.prompts) ? session.prompts.slice(0, totalPrompts) : [];
        const missingPrompts = [];
        const partialPrompts = [];
        const timedOutPrompts = [];
        const failedPrompts = [];
        const readyPrompts = [];
        const now = Date.now();
        prompts.forEach(prompt => {
            if (['failed', 'timeout', 'unrecoverable'].includes(prompt.status)) {
                failedPrompts.push({ index: prompt.index, prompt: prompt.prompt });
                return;
            }
            const outputs = Array.isArray(prompt.outputs) ? prompt.outputs : [];
            const preferred = getPreferredOutput(prompt, settings);
            if (preferred?.src || prompt.status === 'ready' || prompt.status === 'downloaded') {
                readyPrompts.push({ index: prompt.index, prompt: prompt.prompt });
                return;
            }
            const detected = outputs.filter(o => o.src).length;
            const submittedAt = prompt.submittedAt || 0;
            const elapsedSec = submittedAt ? Math.round((now - submittedAt) / 1000) : 0;
            if (detected === 0) {
                missingPrompts.push({ index: prompt.index, prompt: prompt.prompt, elapsedSec });
                if (submittedAt && (now - submittedAt) > 60000) {
                    timedOutPrompts.push({ index: prompt.index, prompt: prompt.prompt, elapsedSec });
                }
            } else {
                partialPrompts.push({ index: prompt.index, detected, expected: Number(prompt.expected) || expectedCountForMode(prompt.mode), elapsedSec });
            }
        });
        const allResolved = missingPrompts.length === 0 && partialPrompts.length === 0;
        return { allDetected: allResolved, allResolved, missingPrompts, partialPrompts, timedOutPrompts, failedPrompts, readyPrompts, session };
    }

    // â”€â”€ Phase 1: Scan loop â€” up to 4 minutes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const phase1End = Date.now() + 4 * 60 * 1000;
    let lastLog = 0;
    let reportedTimeouts = new Set();

    logMessage('Waiting for Download Manager to detect selected outputs (max 4 min)...', 'info');

    while (!stopRequested && !isStopped && Date.now() < phase1End) {
        while (isPaused && !stopRequested && !isStopped) await new Promise(r => setTimeout(r, 500));
        if (stopRequested || isStopped) return false;

        await runRealtimeDetectionScan('completion-wait');
        const { allResolved, missingPrompts, partialPrompts, timedOutPrompts, failedPrompts, session } = await checkSelectedResolutionState();

        // Report newly timed-out prompts (60s with no detection)
        for (const tp of timedOutPrompts) {
            if (!reportedTimeouts.has(tp.index)) {
                reportedTimeouts.add(tp.index);
                logMessage(`âš ï¸ Prompt ${Number(tp.index)+1} not detected after ${tp.elapsedSec}s â€” will retry at end.`, 'warn');
            }
        }

        if (allResolved) return await triggerDownloadsOrSkip(session, failedPrompts);
        if (Date.now() - lastLog > 15000) {
            const parts = [];
            if (missingPrompts.length) parts.push(`${missingPrompts.length} prompt(s) with 0 detected`);
            if (partialPrompts.length) parts.push(`${partialPrompts.length} partial`);
            logMessage(`ðŸ” Still scanning: ${parts.join(', ')}`, 'warn');
            lastLog = Date.now();
        }
        await interruptibleSleep(5000, () => stopRequested || isStopped);
    }

    if (stopRequested || isStopped) return false;

    // â”€â”€ Phase 2: Not all detected â€” refresh page once â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    logMessage('Selected outputs not all detected. Refreshing page once...', 'info');
    try {
        const tabs = await chrome.tabs.query({ url: 'https://www.meta.ai/*' });
        const tab = tabs.find(t => t.url?.includes('/create')) || tabs[0];
        if (tab?.id) {
            await chrome.storage.local.set({ [REFRESH_FLAG_KEY]: true });
            chrome.tabs.reload(tab.id);
            await interruptibleSleep(10000, () => stopRequested || isStopped);
        }
    } catch (e) { logMessage('Could not refresh page: ' + e.message, 'warn'); }

    // â”€â”€ Phase 3: After refresh â€” scan again â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    logMessage('ðŸ” Scanning after page refresh...', 'system');
    const phase3End = Date.now() + 5 * 60 * 1000;
    lastLog = 0;

    while (!stopRequested && !isStopped && Date.now() < phase3End) {
        while (isPaused && !stopRequested && !isStopped) await new Promise(r => setTimeout(r, 500));
        if (stopRequested || isStopped) return false;

        await runRealtimeDetectionScan('post-refresh');
        const { allResolved, missingPrompts, timedOutPrompts, failedPrompts, session } = await checkSelectedResolutionState();

        for (const tp of timedOutPrompts) {
            if (!reportedTimeouts.has(tp.index)) {
                reportedTimeouts.add(tp.index);
                logMessage(`âš ï¸ Prompt ${Number(tp.index)+1} still undetected after refresh â€” marking for retry.`, 'warn');
            }
        }

        if (allResolved) return await triggerDownloadsOrSkip(session, failedPrompts);

        if (Date.now() - lastLog > 20000) {
            logMessage(`After refresh, still missing ${missingPrompts.length} prompt(s).`, 'warn');
            lastLog = Date.now();
        }
        await interruptibleSleep(6000, () => stopRequested || isStopped);
    }

    // â”€â”€ Timed out â€” end session anyway â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const { session, timedOutPrompts: finalTimeout } = await checkSelectedResolutionState();
    if (session) await chrome.storage.local.set({ [DOWNLOAD_SESSION_KEY]: { ...session, running: false, completedAt: Date.now() } });
    if (finalTimeout.length) {
        logMessage(`âš ï¸ Session ended. Undetected prompts: ${finalTimeout.map(t=>Number(t.index)+1).join(', ')}`, 'warn');
    } else {
        logMessage('âš ï¸ Some videos could not be detected. Session ended.', 'warn');
    }
    return false;
}

// â”€â”€ Wait for Download Manager to signal downloads complete â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function waitForDownloadsDone(session, timedOutPrompts) {
    logMessage('â³ Waiting for Download Manager to finish all downloads...', 'info');
    const deadline = Date.now() + 10 * 60 * 1000; // max 10 min for downloads
    let lastDownloadKick = 0;
    while (!stopRequested && !isStopped && Date.now() < deadline) {
        while (isPaused && !stopRequested && !isStopped) await new Promise(r => setTimeout(r, 500));
        if (stopRequested || isStopped) return false;
        const data = await chrome.storage.local.get(DOWNLOAD_SESSION_KEY);
        const s = data[DOWNLOAD_SESSION_KEY] || {};
        if (s.downloadsDone) {
            logMessage('âœ… Download Manager: all downloads complete! Stopping automation.', 'success');
            // Final refresh if enabled
            const rad = document.getElementById('refreshAfterAllDoneToggle')?.checked;
            if (rad) {
                const tabs = await chrome.tabs.query({ url: 'https://www.meta.ai/*' });
                const tab = tabs.find(t => t.url?.includes('/create')) || tabs[0];
                if (tab?.id) { await chrome.storage.local.set({ [FINAL_REFRESH_FLAG_KEY]: true }); chrome.tabs.reload(tab.id); }
            }
            return true;
        }
        if (Date.now() - lastDownloadKick > 2000) {
            lastDownloadKick = Date.now();
            await startQueuedDownloads();
        }
        await interruptibleSleep(1000, () => stopRequested || isStopped);
    }
    logMessage('âš ï¸ Download wait timed out. Stopping.', 'warn');
    return false;
}

async function recoverCreateMediaAfterFailedDetection(prompt, targetType, baseline, uploadDelay, aspectRatio) {
    const maxAttempts = 3;
    while (failedDetectionRefreshCount < maxAttempts && !stopRequested && !isStopped) {
        failedDetectionRefreshCount++;
        await saveAutomationState({
            generationFlow: 'create',
            pendingAfterSubmit: true,
            uploadDelay: uploadDelay / 1000,
            aspectRatio,
            failedDetectionRefreshCount,
            status: 'failed-detection-refresh'
        });

        const refreshed = await refreshCreateTabForFailedDetection(failedDetectionRefreshCount, maxAttempts);
        if (!refreshed && (stopRequested || isStopped)) return null;

        logMessage(`Refresh recovery ${failedDetectionRefreshCount}/${maxAttempts}: detecting again...`, 'info');
        const mediaUrl = await waitForCreateMediaByPrompt(prompt, targetType, baseline, 30000);
        if (mediaUrl) {
            failedDetectionRefreshCount = 0;
            await saveAutomationState({
                generationFlow: 'create',
                pendingAfterSubmit: false,
                uploadDelay: uploadDelay / 1000,
                aspectRatio,
                failedDetectionRefreshCount: 0,
                status: 'detecting'
            });
            return mediaUrl;
        }
    }
    failedDetectionRefreshCount = 0;
    await saveAutomationState({
        generationFlow: 'create',
        pendingAfterSubmit: false,
        uploadDelay: uploadDelay / 1000,
        aspectRatio,
        failedDetectionRefreshCount: 0,
        status: 'retry-queued'
    });
    return null;
}

async function mainLoop(uploadDelay, aspectRatio, skipNewChat = false) {
    const total = getTotalForMode();

    if (currentMode === 'image-to-video') {
        // Single Chat Start
        if (!skipNewChat) {
            logMessage("Starting New Chat (Single Session)...", 'system');
            // Save state BEFORE triggerNewChat (page will reload!)
            await saveAutomationState({ uploadDelay: uploadDelay / 1000, aspectRatio });
            const chatRes = await injectScript(triggerNewChat);
            if (chatRes && chatRes.logs) chatRes.logs.forEach(l => logMessage(l, 'info'));
            // Page may have reloaded â€” wait a moment to check
            await new Promise(r => setTimeout(r, 3000));
        } else {
            logMessage('â†ªï¸ Skipping New Chat (already on fresh page after reload)', 'info');
        }

        if (stopRequested || isStopped) return;

        while (currentIndex < total && !stopRequested && !isStopped) {
            while (isPaused && !stopRequested && !isStopped) await new Promise(r => setTimeout(r, 500));
            if (stopRequested || isStopped) break;

            // Update progress at start of each iteration
            updateProgress(currentIndex + 1, total);

            const image = imageFileList[currentIndex];

            // Extract ID from filename (e.g. "123.jpg" -> 123)
            // Use regex to find the first sequence of digits
            const nameMatch = image.name.match(/(\d+)/);
            let shouldProcess = false;
            let promptUsed = "";

            if (nameMatch) {
                const id = parseInt(nameMatch[0], 10); // 1-based index from filename

                // Validate ID range
                if (id >= 1 && promptList.length > 0) {
                    promptUsed = promptList[(id - 1) % promptList.length]; // 0-based access; repeat prompts when needed
                    shouldProcess = true;
                    logMessage(`Processing [${image.name}] with Prompt #${id}`, 'info');
                } else {
                    logMessage(`Skipping [${image.name}]: ID ${id} out of prompt range (1-${promptList.length})`, 'warn');
                    shouldProcess = false;
                }
            } else {
                if (promptList.length > 0) {
                    promptUsed = getPromptForIndex(currentIndex);
                    shouldProcess = true;
                    logMessage(`Processing [${image.name}] (Sequential) with Prompt #${currentIndex + 1}`, 'info');
                } else {
                    logMessage(`Skipping [${image.name}]: No prompt for index ${currentIndex}`, 'warn');
                    shouldProcess = false;
                }
            }

            if (shouldProcess) {
                if (stopRequested || isStopped) break;
                const base64 = await readFileAsDataURL(image);
                if (stopRequested || isStopped) break;

                if (base64) {
                    const res = await injectScript(processStrictImageToVideoTask, [base64, image.name, promptUsed, uploadDelay]);
                    let taskSuccess = false;
                    if (res) {
                        if (res.logs) res.logs.forEach(l => logMessage(l, 'info'));
                        if (res.success) taskSuccess = true;
                        else logMessage(`Task Failed: ${res.error}`, 'error');
                    }

                    if (taskSuccess) {
                        if (stopRequested || isStopped) break;
                        const mediaUrl = await processWaitForGeneration(false);
                        if (mediaUrl) {
                            let fname = buildDownloadFilename('video', currentIndex, 'mp4');
                            // Skip if Download Manager already downloaded this item
                            const doneData = await chrome.storage.local.get(['autoMetaCopy_downloadedOutputs', DOWNLOAD_SESSION_KEY]);
                            const doneSet = new Set(doneData['autoMetaCopy_downloadedOutputs'] || []);
                            const dmSession = doneData[DOWNLOAD_SESSION_KEY];
                            const dmAlready = dmSession?.prompts?.[currentIndex]?.outputs?.some(o => o.downloaded && o.src === mediaUrl);
                            const dlSig = `${currentIndex}|video|1|${mediaUrl}`;
                            if (doneSet.has(dlSig) || downloadedMediaSet.has(mediaUrl) || dmAlready) {
                                logMessage(`â­ï¸ Already downloaded by Download Manager â€” skipping`, 'info');
                            } else {
                                logMessage(`Downloading as ${fname}...`, 'success');
                                const dlResult = await downloadMedia(mediaUrl, fname);
                                if (dlResult && dlResult.success) {
                                    logMessage(`âœ… Downloaded: ${fname}`, 'success');
                                    downloadedMediaSet.add(mediaUrl);
                                } else {
                                    logMessage(`âš ï¸ Download may have failed: ${dlResult?.error || 'unknown'}`, 'warn');
                                }
                            }
                        } else {
                            logMessage("No video generated.", 'warn');
                        }
                    }
                }
            }

            const minWait = document.getElementById('imageUploadDelayInput')?.value || 10;
            const maxWait = document.getElementById('imageUploadDelayInput')?.value || 10;
            const waitTime = getRandomWait(minWait, maxWait);

            const sleepRes = await interruptibleSleep(waitTime, () => stopRequested || isStopped);
            if (sleepRes === 'STOPPED') break;

            currentIndex++;
        }
        return;
    }

    // PROMPT ONLY MODES
    const failedPrompts = []; // Track failed prompts for end-of-session retry

    while (currentIndex < total && !stopRequested && !isStopped) {
        while (isPaused && !stopRequested && !isStopped) await new Promise(r => setTimeout(r, 500));
        if (stopRequested || isStopped) break;

        let taskSuccess = false;
        let promptUsed = "";

        const handleResult = (res) => {
            if (res && res.logs) {
                res.logs.forEach(l => {
                    const type = l.toLowerCase().includes('[fail]') ? 'error' : (l.toLowerCase().includes('[success]') ? 'success' : 'info');
                    logMessage(l, type);
                });
            }
            return res ? res.success : false;
        };

        if (currentMode === 'prompt-to-video') {
            if (!skipNewChat) {
                logMessage("Starting New Chat...", 'system');
                // Save state BEFORE triggerNewChat â€” page will reload!
                await saveAutomationState({ uploadDelay: uploadDelay / 1000, aspectRatio });
                const chatRes = await injectScript(triggerNewChat);
                handleResult(chatRes);
                // After triggerNewChat, page may reload. Wait to check if we're still alive.
                await new Promise(r => setTimeout(r, 3000));
            } else {
                logMessage('â†ªï¸ Skipping New Chat (fresh page after reload)', 'info');
                skipNewChat = false; // Only skip ONCE (for the first prompt after resume)
            }

            if (stopRequested || isStopped) break;

            promptUsed = promptList[currentIndex];
            logMessage(`[Prompt->Video] ${currentIndex + 1}/${total}`, 'info');
            const res = await injectScript(processStrictPromptToVideoTask, [promptUsed]);
            taskSuccess = handleResult(res);
            if (!taskSuccess && res && res.error) {
                logMessage(`Failure Reason: ${res.error}`, 'error');
            }

        } else if (currentMode === 'prompt-to-image') {
            if (!skipNewChat) {
                logMessage("Starting New Chat...", 'system');
                await saveAutomationState({ uploadDelay: uploadDelay / 1000, aspectRatio });
                const chatRes = await injectScript(triggerNewChat);
                handleResult(chatRes);
                await new Promise(r => setTimeout(r, 3000));
            } else {
                logMessage('â†ªï¸ Skipping New Chat (fresh page after reload)', 'info');
                skipNewChat = false;
            }

            if (stopRequested || isStopped) break;

            promptUsed = promptList[currentIndex];
            logMessage(`[Prompt->Image] ${currentIndex + 1}/${total} (Ratio: ${aspectRatio})`, 'info');
            const res = await injectScript(processStrictPromptToImageTask, [promptUsed, aspectRatio]);
            taskSuccess = handleResult(res);
            if (!taskSuccess && res && res.error) {
                logMessage(`Failure Reason: ${res.error}`, 'error');
            }
        }

        if (taskSuccess) {
            logMessage("Monitoring DOM for media...", 'info');
            const isImageMode = (currentMode === 'prompt-to-image');

            if (stopRequested || isStopped) break;

            const mediaUrl = await processWaitForGeneration(isImageMode);

            if (mediaUrl) {
                const ext = isImageMode ? 'jpg' : 'mp4';
                let fname = buildDownloadFilename(isImageMode ? 'image' : 'video', currentIndex, ext);
                // Skip if Download Manager already downloaded this item
                const doneData2 = await chrome.storage.local.get(['autoMetaCopy_downloadedOutputs', DOWNLOAD_SESSION_KEY]);
                const doneSet2 = new Set(doneData2['autoMetaCopy_downloadedOutputs'] || []);
                const dmSession2 = doneData2[DOWNLOAD_SESSION_KEY];
                const dmAlready2 = dmSession2?.prompts?.[currentIndex]?.outputs?.some(o => o.downloaded && o.src === mediaUrl);
                const dlSig2 = `${currentIndex}|${isImageMode ? 'image' : 'video'}|1|${mediaUrl}`;
                if (doneSet2.has(dlSig2) || downloadedMediaSet.has(mediaUrl) || dmAlready2) {
                    logMessage(`â­ï¸ Already downloaded by Download Manager â€” skipping`, 'info');
                } else {
                    logMessage(`Downloading as ${fname}...`, 'success');
                    const dlResult = await downloadMedia(mediaUrl, fname);
                    if (dlResult && dlResult.success) {
                        logMessage(`âœ… Downloaded: ${fname}`, 'success');
                        downloadedMediaSet.add(mediaUrl);
                    } else {
                        logMessage(`âš ï¸ Download may have failed: ${dlResult?.error || 'unknown'}`, 'warn');
                    }
                }

                updateProgress(currentIndex + 1, total);
            } else {
                // Media not detected â€” add to failed list for end-of-session retry
                logMessage(`â­ï¸ Prompt ${currentIndex + 1} skipped (no media). Will retry at end.`, 'warn');
                failedPrompts.push({ index: currentIndex, prompt: promptList[currentIndex] });
            }

        } else {
            // Task itself failed (button not found, etc.) â€” add to failed list
            logMessage(`â­ï¸ Task ${currentIndex + 1} failed. Will retry at end.`, 'error');
            failedPrompts.push({ index: currentIndex, prompt: promptList[currentIndex] });
        }

        const minWait = document.getElementById('imageUploadDelayInput')?.value || 10;
        const maxWait = document.getElementById('imageUploadDelayInput')?.value || 10;
        const waitTime = getRandomWait(minWait, maxWait);
        logMessage(`Waiting ${waitTime / 1000}s...`, 'info');
        const sleepRes = await interruptibleSleep(waitTime, () => stopRequested || isStopped);
        if (sleepRes === 'STOPPED') break;
        currentIndex++;
        // Save progress after each prompt (crash recovery)
        await saveAutomationState({ uploadDelay: uploadDelay / 1000, aspectRatio });
    }

    // ========== END-OF-SESSION RETRY FOR FAILED PROMPTS (up to 2 rounds) ==========
    let retryList = [...failedPrompts];
    let retryRound = 0;
    const MAX_RETRIES = 2;

    while (retryList.length > 0 && retryRound < MAX_RETRIES && !stopRequested && !isStopped) {
        retryRound++;
        logMessage(`ðŸ”„ Retry Round ${retryRound}/${MAX_RETRIES}: ${retryList.length} failed prompt(s)...`, 'system');
        const stillFailed = [];

        for (let i = 0; i < retryList.length; i++) {
            if (stopRequested || isStopped) break;
            while (isPaused && !stopRequested && !isStopped) await new Promise(r => setTimeout(r, 500));
            if (stopRequested || isStopped) break;

            const { index, prompt } = retryList[i];
            const isImageMode = (currentMode === 'prompt-to-image');
            const ext = isImageMode ? 'jpg' : 'mp4';
            const fname = buildDownloadFilename(isImageMode ? 'image' : 'video', index, ext);

            logMessage(`ðŸ” Retry ${i + 1}/${retryList.length}: Prompt ${index + 1}`, 'info');

            // New chat
            const chatRes = await injectScript(triggerNewChat);
            if (chatRes && chatRes.logs) chatRes.logs.forEach(l => logMessage(l, 'info'));
            if (stopRequested || isStopped) break;

            // Submit prompt
            let taskSuccess = false;
            if (currentMode === 'prompt-to-video') {
                const res = await injectScript(processStrictPromptToVideoTask, [prompt]);
                if (res && res.logs) res.logs.forEach(l => logMessage(l, 'info'));
                taskSuccess = res ? res.success : false;
            } else if (currentMode === 'prompt-to-image') {
                const res = await injectScript(processStrictPromptToImageTask, [prompt, aspectRatio]);
                if (res && res.logs) res.logs.forEach(l => logMessage(l, 'info'));
                taskSuccess = res ? res.success : false;
            }

            if (taskSuccess) {
                logMessage("Monitoring DOM for media...", 'info');
                const mediaUrl = await processWaitForGeneration(isImageMode);
                if (mediaUrl) {
                    // Skip if Download Manager already downloaded this item
                    const doneData3 = await chrome.storage.local.get(['autoMetaCopy_downloadedOutputs', DOWNLOAD_SESSION_KEY]);
                    const doneSet3 = new Set(doneData3['autoMetaCopy_downloadedOutputs'] || []);
                    const dmSession3 = doneData3[DOWNLOAD_SESSION_KEY];
                    const dmAlready3 = dmSession3?.prompts?.[index]?.outputs?.some(o => o.downloaded && o.src === mediaUrl);
                    const dlSig3 = `${index}|${isImageMode ? 'image' : 'video'}|1|${mediaUrl}`;
                    if (doneSet3.has(dlSig3) || downloadedMediaSet.has(mediaUrl) || dmAlready3) {
                        logMessage(`â­ï¸ Already downloaded by Download Manager â€” skipping`, 'info');
                    } else {
                        logMessage(`Downloading as ${fname} (retry)...`, 'success');
                        const dlResult = await downloadMedia(mediaUrl, fname);
                        if (dlResult && dlResult.success) {
                            logMessage(`âœ… Downloaded: ${fname}`, 'success');
                            downloadedMediaSet.add(mediaUrl);
                        } else {
                            logMessage(`âš ï¸ Download may have failed: ${dlResult?.error || 'unknown'}`, 'warn');
                        }
                    }
                } else {
                    logMessage(`â­ï¸ Prompt ${index + 1} still no media. Will try again.`, 'warn');
                    stillFailed.push({ index, prompt });
                }
            } else {
                logMessage(`â­ï¸ Prompt ${index + 1} task failed. Will try again.`, 'warn');
                stillFailed.push({ index, prompt });
            }

            // Brief wait between retries
            if (i < retryList.length - 1) {
                await interruptibleSleep(getImageModeSettleWaitMs(), () => stopRequested || isStopped);
            }
        }

        retryList = stillFailed;
        if (retryList.length > 0 && retryRound < MAX_RETRIES) {
            logMessage(`â³ ${retryList.length} prompt(s) still pending. Starting next retry round in 10s...`, 'info');
            await new Promise(r => setTimeout(r, 10000));
        }
    }

    // ========== FINAL SUMMARY ==========
    if (retryList.length > 0) {
        const failedNums = retryList.map(f => f.index + 1).join(', ');
        logMessage(`ðŸ“‹ FAILED PROMPTS: ${failedNums} â€” use Start Index to re-run these later.`, 'error');
    } else if (failedPrompts.length > 0) {
        logMessage(`âœ… All failed prompts recovered successfully on retry!`, 'success');
    }
}

async function triggerNewChat() {
    console.log("[STEP] Clicking New Chat button");
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const logs = [];

    const newChatBtn = Array.from(document.querySelectorAll('button'))
        .find(b => b.innerText.toLowerCase().includes("new chat"));

    if (newChatBtn) {
        console.log("[OK] New Chat clicked");
        logs.push("[Step] New Chat button found and clicked.");
        newChatBtn.click();
    } else {
        console.log("[FALLBACK] New Chat button not found. Using keyboard shortcut Ctrl+Shift+O");
        logs.push("[Fallback] New Chat button not found. Triggering Ctrl+Shift+O...");

        // Simulate Ctrl+Shift+O keyboard shortcut
        const event = new KeyboardEvent('keydown', {
            key: 'o',
            code: 'KeyO',
            keyCode: 79,
            which: 79,
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(event);

        logs.push("[Success] Keyboard shortcut Ctrl+Shift+O triggered.");
    }

    await sleep(2000);
    return { success: true, logs: logs };
}

async function processStrictImageToVideoTask(base64, fileName, prompt, uploadDelay) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const hasAttachmentTileImage = () => Array.from(document.querySelectorAll('[class*="attachment-tile"] img, [class*="attachment-tile"] canvas, composer-render-mark img[src^="blob:"], composer-render-mark img[src^="data:image/"]'))
        .some(el => {
            if (!isVisible(el)) return false;
            const tile = el.closest?.('[class*="attachment-tile"]');
            const composer = el.closest?.('composer-render-mark, [data-testid*="composer" i], form');
            const text = `${el.alt || ''} ${el.getAttribute?.('aria-label') || ''} ${tile?.className || ''}`.toLowerCase();
            const src = String(el.currentSrc || el.src || el.getAttribute?.('src') || '');
            return !!tile || (!!composer && (src.startsWith('blob:') || src.startsWith('data:image/') || /image|photo|attachment/.test(text)));
        });
    const hasUploadedImage = () => {
        if (hasAttachmentTileImage()) return true;
        const textBox = document.querySelector("textarea, div[role='textbox']");
        const inputRect = textBox?.getBoundingClientRect?.() || { left: 0, right: innerWidth, top: innerHeight, bottom: innerHeight };
        const roots = [];
        let node = textBox;
        for (let i = 0; node && i < 10; i++, node = node.parentElement) roots.push(node);
        roots.push(document.querySelector('[data-testid*="composer" i]'), document.querySelector('form'), document.body);
        const candidates = Array.from(new Set(roots.filter(Boolean)))
            .flatMap(root => Array.from(root.querySelectorAll('img, canvas, [role="img"], [class*="attachment-tile"], [data-testid*="attachment" i], [aria-label*="remove" i], [aria-label*="image" i], [aria-label*="photo" i]')));
        const visiblePreview = candidates
            .some(el => {
                if (!isVisible(el)) return false;
                const rect = el.getBoundingClientRect();
                const nearComposer = rect.bottom >= inputRect.top - 180
                    && rect.top <= inputRect.bottom + 30
                    && rect.right >= inputRect.left - 80
                    && rect.left <= inputRect.right + 80;
                const text = `${el.alt || ''} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('data-testid') || ''} ${el.textContent || ''}`.toLowerCase();
                const klass = String(el.className || '').toLowerCase();
                const src = String(el.currentSrc || el.src || el.getAttribute?.('src') || '');
                return nearComposer && (src.startsWith('blob:') || src.startsWith('data:image/')
                    || /attachment|remove|image|photo|preview|uploaded/.test(`${text} ${klass}`));
            });
        const nameVisible = fileName && roots.some(root => root?.textContent?.toLowerCase?.().includes(String(fileName).toLowerCase()));
        return visiblePreview || nameVisible;
    };
    const waitForUploadedImage = async (maxWait = 20000) => {
        const start = performance.now();
        while (performance.now() - start < maxWait) {
            if (hasUploadedImage()) return true;
            await sleep(350);
        }
        return false;
    };

    async function clickSend(targetText = "Create") {
        console.log("[STEP] Clicking Send button");
        const localLogs = [];
        let btn = document.querySelector('button[aria-label="Send"]');
        if (!btn) {
            btn = Array.from(document.querySelectorAll('button'))
                .find(b => b.innerText.trim() === "Animate" || b.innerText.includes("Animate"));
        }
        if (btn) {
            const isDisabled = btn.disabled;
            const isAriaDisabled = btn.getAttribute("aria-disabled") === "true";

            if (!isDisabled && !isAriaDisabled) {
                console.log("[OK] Send/Animate button clicked");
                localLogs.push(`[Step] Clicking Send/Animate...`);
                btn.click();
                await sleep(2000);
                localLogs.push("[Success] Button clicked.");
                return { success: true, logs: localLogs };
            } else {
                localLogs.push("[Fail] Button disabled.");
                return { success: false, logs: localLogs, error: "Button disabled" };
            }
        }
        console.log("[FAIL] Send/Animate button not found or disabled at click time");
        localLogs.push("[Fail] Send/Animate element missing.");
        return { success: false, logs: localLogs, error: "Button missing" };
    }

    try {
        console.log("Brain: Image->Video (Loose Flow)");
        const vidBtn = Array.from(document.querySelectorAll('button'))
            .find(b => b.innerText.toLowerCase().includes("create video"));
        if (vidBtn) { vidBtn.click(); await sleep(2000); }

        const fileInput = document.querySelector("input[type='file']");
        if (fileInput) {
            const b64toBlob = (b64Data, contentType = '') => {
                const byteCharacters = atob(b64Data.split(',')[1]);
                const byteArrays = [];
                for (let offset = 0; offset < byteCharacters.length; offset += 512) {
                    const slice = byteCharacters.slice(offset, offset + 512);
                    const byteNumbers = new Array(slice.length);
                    for (let i = 0; i < slice.length; i++) byteNumbers[i] = slice.charCodeAt(i);
                    byteArrays.push(new Uint8Array(byteNumbers));
                }
                return new Blob(byteArrays, { type: contentType });
            }
            const mimeMatch = base64.match(/^data:([^;]+);/);
            const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';
            const blob = b64toBlob(base64, mimeType);
            const file = new File([blob], fileName, { type: mimeType });
            const dt = new DataTransfer(); dt.items.add(file);
            fileInput.files = dt.files;
            fileInput.dispatchEvent(new Event('change', { bubbles: true }));
            fileInput.dispatchEvent(new Event('input', { bubbles: true }));
            const uploaded = await waitForUploadedImage(Math.max(12000, Number(uploadDelay || 10000) + 8000));
            if (!uploaded) {
                return { success: false, logs: ["[Fail] Image upload was not confirmed. Prompt not sent."], error: "image upload not confirmed" };
            }
            await sleep(Math.min(2500, Math.max(500, Number(uploadDelay || 10000) / 4)));
        } else {
            return { success: false, logs: ["[Fail] File input missing. Prompt not sent."], error: "file input missing" };
        }

        if (!hasUploadedImage()) {
            return { success: false, logs: ["[Fail] Image missing before prompt paste. Prompt not sent."], error: "image missing before prompt paste" };
        }

        const textBox = document.querySelector("textarea, div[role='textbox']");
        if (textBox) {
            textBox.focus();
            textBox.value = prompt || "animate this";
            textBox.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(1000);
        }
        if (!hasUploadedImage()) {
            return { success: false, logs: ["[Fail] Image missing before send. Send cancelled."], error: "image missing before send" };
        }
        return await clickSend("Animate");
    } catch (e) {
        console.error("Task Error", e);
        return { success: false, logs: [], error: e.message };
    }
}

// ===== UI FLOW HELPERS =====
// Helper: Click the "+" (Add attachment) button
async function clickPlusIcon() {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const logs = [];

    // Method 1: Find by aria-label "Add attachment"
    let plusBtn = document.querySelector('button[aria-label*="Add attachment" i]');

    if (!plusBtn) {
        // Method 2: Find by looking for "+" text in buttons
        const allButtons = Array.from(document.querySelectorAll('button'));
        plusBtn = allButtons.find(btn => {
            const text = btn.innerText.trim();
            return text === '+' || text === 'ï¼‹';
        });
    }

    if (!plusBtn) {
        // Method 3: Find by SVG content (plus icon)
        const allButtons = Array.from(document.querySelectorAll('button'));
        plusBtn = allButtons.find(btn => {
            const svg = btn.querySelector('svg');
            if (!svg) return false;
            const svgContent = svg.innerHTML.toLowerCase();
            return svgContent.includes('plus') || svgContent.includes('add');
        });
    }

    if (plusBtn) {
        logs.push("[Step] '+' (Add attachment) button found and clicked.");
        plusBtn.click();
        await sleep(1500); // Wait for dropdown to appear
        return { success: true, logs };
    } else {
        logs.push("[Fail] '+' button not found.");
        return { success: false, logs, error: "Plus button not found" };
    }
}

// Helper: Select "Create" from the dropdown menu
async function selectCreateFromDropdown() {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const logs = [];

    // Wait a bit for dropdown to fully render
    await sleep(500);

    // Method 1: Find by text content "Create"
    const allButtons = Array.from(document.querySelectorAll('button, div[role="menuitem"], div[role="option"]'));
    let createBtn = allButtons.find(el => {
        const text = el.innerText.toLowerCase().trim();
        return text === 'create' || text.includes('create');
    });

    if (!createBtn) {
        // Method 2: Find by aria-label
        createBtn = document.querySelector('[aria-label*="Create" i]');
    }

    if (createBtn) {
        logs.push("[Step] 'Create' option found and clicked.");
        createBtn.click();
        await sleep(1500); // Wait for mode selection to appear
        return { success: true, logs };
    } else {
        logs.push("[Fail] 'Create' option not found in dropdown.");
        return { success: false, logs, error: "Create option not found" };
    }
}

// Helper: Select "Video" from the mode dropdown (for video mode)
async function selectVideoFromModeDropdown() {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const logs = [];

    // Wait a bit for mode dropdown to fully render
    await sleep(500);

    // Method 1: Find by text content "Video"
    const allElements = Array.from(document.querySelectorAll('button, div[role="menuitem"], div[role="option"], span'));
    let videoBtn = allElements.find(el => {
        const text = el.innerText.toLowerCase().trim();
        return text === 'video';
    });

    if (!videoBtn) {
        // Method 2: Find by aria-label
        videoBtn = document.querySelector('[aria-label*="Video" i]');
    }

    if (videoBtn) {
        logs.push("[Step] 'Video' mode selected from dropdown.");
        videoBtn.click();
        await sleep(1000);
        return { success: true, logs };
    } else {
        // Video might already be selected, check if we can proceed
        logs.push("[Info] 'Video' option not found - might already be selected.");
        return { success: true, logs };
    }
}

// ===== PROMPT â†’ VIDEO =====
async function processStrictPromptToVideoTask(prompt) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const logs = [];

    // === INLINED HELPERS (must be inside this function for chrome.scripting.executeScript) ===

    // Helper: Click the "+" (Add attachment) button
    async function clickPlusIcon() {
        const localLogs = [];
        let plusBtn = document.querySelector('button[aria-label*="Add attachment" i]');
        if (!plusBtn) {
            const allButtons = Array.from(document.querySelectorAll('button'));
            plusBtn = allButtons.find(btn => {
                const text = btn.innerText.trim();
                return text === '+' || text === 'ï¼‹';
            });
        }
        if (!plusBtn) {
            const allButtons = Array.from(document.querySelectorAll('button'));
            plusBtn = allButtons.find(btn => {
                const svg = btn.querySelector('svg');
                if (!svg) return false;
                const svgContent = svg.innerHTML.toLowerCase();
                return svgContent.includes('plus') || svgContent.includes('add');
            });
        }
        if (plusBtn) {
            localLogs.push("[Step] '+' (Add attachment) button found and clicked.");
            plusBtn.click();
            await sleep(1500);
            return { success: true, logs: localLogs };
        } else {
            localLogs.push("[Fail] '+' button not found.");
            return { success: false, logs: localLogs, error: "Plus button not found" };
        }
    }

    // Helper: Select "Create" from the dropdown menu
    async function selectCreateFromDropdown() {
        const localLogs = [];
        await sleep(500);
        const allButtons = Array.from(document.querySelectorAll('button, div[role="menuitem"], div[role="option"]'));
        let createBtn = allButtons.find(el => {
            const text = el.innerText.toLowerCase().trim();
            return text === 'create' || text.includes('create');
        });
        if (!createBtn) {
            createBtn = document.querySelector('[aria-label*="Create" i]');
        }
        if (createBtn) {
            localLogs.push("[Step] 'Create' option found and clicked.");
            createBtn.click();
            await sleep(1500);
            return { success: true, logs: localLogs };
        } else {
            localLogs.push("[Fail] 'Create' option not found in dropdown.");
            return { success: false, logs: localLogs, error: "Create option not found" };
        }
    }

    // Helper: Select "Video" from the mode dropdown
    async function selectVideoFromModeDropdown() {
        const localLogs = [];
        await sleep(500);
        const allElements = Array.from(document.querySelectorAll('button, div[role="menuitem"], div[role="option"], span'));
        let videoBtn = allElements.find(el => {
            const text = el.innerText.toLowerCase().trim();
            return text === 'video';
        });
        if (!videoBtn) {
            videoBtn = document.querySelector('[aria-label*="Video" i]');
        }
        if (videoBtn) {
            localLogs.push("[Step] 'Video' mode selected from dropdown.");
            videoBtn.click();
            await sleep(1000);
            return { success: true, logs: localLogs };
        } else {
            localLogs.push("[Info] 'Video' option not found - might already be selected.");
            return { success: true, logs: localLogs };
        }
    }

    // === END INLINED HELPERS ===

    async function waitForSendButtonEnabled() {
        console.log("[STEP] Looping for Send button enabled state");
        const localLogs = [];
        localLogs.push("[Step] Waiting for Send/Animate button...");
        return new Promise((resolve) => {
            const start = performance.now();
            const maxWait = 15000;
            const check = () => {
                let sendBtn = document.querySelector('button[aria-label="Send"]');
                if (!sendBtn) {
                    sendBtn = Array.from(document.querySelectorAll('button'))
                        .find(b => b.innerText.trim() === "Animate" || b.innerText.includes("Animate"));
                }
                if (sendBtn) {
                    const isDisabled = sendBtn.disabled;
                    const isAriaDisabled = sendBtn.getAttribute("aria-disabled") === "true";
                    if (!isDisabled && !isAriaDisabled) {
                        console.log("[OK] Button is READY");
                        localLogs.push("[Step] Button enabled.");
                        resolve({ success: true, logs: localLogs });
                        return;
                    }
                }
                if (performance.now() - start > maxWait) {
                    console.warn("Brain: Timeout waiting for Button.");
                    localLogs.push("[Fail] Timeout waiting for Send/Animate button.");
                    resolve({ success: false, logs: localLogs, error: "Send button timeout" });
                    return;
                }
                requestAnimationFrame(check);
            };
            check();
        });
    }

    async function clickSend(targetText = "Create") {
        console.log("[STEP] Clicking Send button");
        const localLogs = [];
        let btn = document.querySelector('button[aria-label="Send"]');
        if (!btn) {
            btn = Array.from(document.querySelectorAll('button'))
                .find(b => b.innerText.trim() === "Animate" || b.innerText.includes("Animate"));
        }
        if (btn) {
            const isDisabled = btn.disabled;
            const isAriaDisabled = btn.getAttribute("aria-disabled") === "true";
            if (!isDisabled && !isAriaDisabled) {
                console.log("[OK] Button clicked");
                localLogs.push(`[Step] Clicking button...`);
                btn.click();
                await sleep(2000);
                localLogs.push("[Success] Button clicked.");
                return { success: true, logs: localLogs };
            } else {
                localLogs.push("[Fail] Button disabled.");
                return { success: false, logs: localLogs, error: "Button disabled" };
            }
        }
        console.log("[FAIL] Button not found");
        localLogs.push("[Fail] Send/Animate element missing.");
        return { success: false, logs: localLogs, error: "Button missing" };
    }

    try {
        console.log("Brain: Promptâ†’Video (Strict Flow)");

        // ROBUST: Multiple methods to select video mode
        let vidBtn = Array.from(document.querySelectorAll('button'))
            .find(b => b.innerText.toLowerCase().includes("create video"));

        if (!vidBtn) {
            // Fallback 1: aria-label
            vidBtn = document.querySelector('button[aria-label*="video" i]');
        }

        if (!vidBtn) {
            // Fallback 2: Icon search
            const allButtons = Array.from(document.querySelectorAll('button'));
            vidBtn = allButtons.find(btn => {
                const svg = btn.querySelector('svg');
                return svg && svg.innerHTML.toLowerCase().includes('video');
            });
        }

        if (vidBtn) {
            console.log("[OK] Mode button clicked");
            logs.push("[Step] 'Create video' button clicked.");
            vidBtn.click(); await sleep(2000);
        } else {
            // Fallback 3: Real UI Flow - Click + icon and navigate dropdown
            console.log("[FALLBACK] Using + icon and dropdown navigation");
            logs.push("[Fallback] 'Create video' button not found. Using + icon flow...");

            const plusRes = await clickPlusIcon();
            logs.push(...plusRes.logs);
            if (!plusRes.success) {
                // Fallback 4: Keyboard shortcut as last resort
                console.log("[FALLBACK] Using Ctrl+Shift+V as last resort");
                logs.push("[Fallback] + icon not found. Triggering Ctrl+Shift+V...");
                const event = new KeyboardEvent('keydown', {
                    key: 'v', code: 'KeyV', keyCode: 86,
                    ctrlKey: true, shiftKey: true,
                    bubbles: true, cancelable: true
                });
                document.dispatchEvent(event);
                await sleep(2000);
                logs.push("[Success] Keyboard shortcut triggered.");
            } else {
                // Click "Create" from dropdown
                const createRes = await selectCreateFromDropdown();
                logs.push(...createRes.logs);
                if (!createRes.success) {
                    return { success: false, logs: logs, error: createRes.error };
                }

                // Select "Video" from mode dropdown
                const videoRes = await selectVideoFromModeDropdown();
                logs.push(...videoRes.logs);
                // Continue even if video selection fails (might already be selected)
            }
        }
        const textBox = document.querySelector("textarea, div[role='textbox']");
        console.log("[STEP] Locating textarea");
        if (textBox) {
            console.log("[OK] Textarea found");
            logs.push("[Step] Textarea found. Pasting prompt...");
            textBox.focus();
            textBox.value = prompt;
            textBox.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(1000);
        } else {
            console.log("[FAIL] Textarea missing or value empty");
            logs.push("[Fail] Textarea NOT found.");
            return { success: false, logs: logs, error: "Textarea missing" };
        }
        const waitRes = await waitForSendButtonEnabled();
        logs.push(...waitRes.logs);
        if (!waitRes.success) {
            return { success: false, logs: logs, error: waitRes.error };
        }
        const clickRes = await clickSend("Animate");
        logs.push(...clickRes.logs);
        if (!clickRes.success) {
            return { success: false, logs: logs, error: clickRes.error };
        }
        return { success: true, logs: logs };
    } catch (e) {
        console.error(e);
        return { success: false, logs: logs, error: e.message };
    }
}

// STRICT RATIO FIX: Text-Based Scanning (Mandatory)
async function processStrictPromptToImageTask(prompt, aspectRatio) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const logs = [];

    // === INLINED HELPERS (must be inside this function for chrome.scripting.executeScript) ===

    // Helper: Click the "+" (Add attachment) button
    async function clickPlusIcon() {
        const localLogs = [];
        let plusBtn = document.querySelector('button[aria-label*="Add attachment" i]');
        if (!plusBtn) {
            const allButtons = Array.from(document.querySelectorAll('button'));
            plusBtn = allButtons.find(btn => {
                const text = btn.innerText.trim();
                return text === '+' || text === 'ï¼‹';
            });
        }
        if (!plusBtn) {
            const allButtons = Array.from(document.querySelectorAll('button'));
            plusBtn = allButtons.find(btn => {
                const svg = btn.querySelector('svg');
                if (!svg) return false;
                const svgContent = svg.innerHTML.toLowerCase();
                return svgContent.includes('plus') || svgContent.includes('add');
            });
        }
        if (plusBtn) {
            localLogs.push("[Step] '+' (Add attachment) button found and clicked.");
            plusBtn.click();
            await sleep(1500);
            return { success: true, logs: localLogs };
        } else {
            localLogs.push("[Fail] '+' button not found.");
            return { success: false, logs: localLogs, error: "Plus button not found" };
        }
    }

    // Helper: Select "Create" from the dropdown menu
    async function selectCreateFromDropdown() {
        const localLogs = [];
        await sleep(500);
        const allButtons = Array.from(document.querySelectorAll('button, div[role="menuitem"], div[role="option"]'));
        let createBtn = allButtons.find(el => {
            const text = el.innerText.toLowerCase().trim();
            return text === 'create' || text.includes('create');
        });
        if (!createBtn) {
            createBtn = document.querySelector('[aria-label*="Create" i]');
        }
        if (createBtn) {
            localLogs.push("[Step] 'Create' option found and clicked.");
            createBtn.click();
            await sleep(1500);
            return { success: true, logs: localLogs };
        } else {
            localLogs.push("[Fail] 'Create' option not found in dropdown.");
            return { success: false, logs: localLogs, error: "Create option not found" };
        }
    }

    // === END INLINED HELPERS ===

    // --- HELPER: Strict Text-Based Selection (No Selectors) ---
    async function ensureAspectRatio(ratioStr) {
        console.log(`[STEP] Ensuring Aspect Ratio: ${ratioStr}`);
        const localLogs = [];
        const targetText = ratioStr; // e.g. "9:16"

        localLogs.push(`[Step] Setting ratio to "${targetText}"...`);

        // 1. FIND BUTTON (Combobox / Dropdown)
        // Meta often uses a button with aria-haspopup or similar, but aria-label is best bet if present.
        // If not, we look for a button containing "Aspect ratio" or the CURRENT ratio (e.g. "1:1").
        const knownRatios = ["9:16", "16:9", "1:1", "Aspect ratio"];

        // Strategy A: aria-label
        let menuBtn = document.querySelector('button[aria-label="Aspect ratio"]');

        if (!menuBtn) {
            // Strategy B: Visible Text Match
            menuBtn = Array.from(document.querySelectorAll('div[role="button"], button'))
                .find(b => {
                    const t = b.innerText?.trim() || "";
                    return knownRatios.includes(t) && b.offsetParent !== null; // Must be visible
                });
        }

        if (!menuBtn) {
            console.warn("[FAIL] Aspect Ratio button not found.");
            localLogs.push("[Info] Ratio dropdown not found. Using current.");
            // Per user: "DO NOT fail task if ratio selection is not possible" -> But allow try
            // Actually user said: "DO NOT fail if selector scan does not include ratio buttons" 
            // and "If dropdown opened successfully... consider ratio SET".
            // If we can't find the *opening* button, we can't do anything.
            return { success: true, logs: ["AspectRatio button missing. Skipping."] };
        }

        console.log("[STEP] Clicking Ratio Menu");
        menuBtn.click();
        await sleep(1200); // UI needs time to render the floating menu

        // 2. FIND OPTION BY EXACT TEXT
        // The menu options are likely <div> or <span> elements dynamically appended.
        // We scan for exact text match in the entire document (or reasonable container if we could guess).
        // Since it's a floating layer, it might be at body level.

        const allCandidates = Array.from(document.querySelectorAll('div, span, li, [role="menuitem"], [role="option"]'));

        // Filter for EXACT match and VISIBILITY
        const targetOption = allCandidates.find(el => {
            if (!el.offsetParent) return false; // Invisible
            const t = el.innerText?.trim();
            return t === targetText;
        });

        if (targetOption) {
            localLogs.push(`[Step] Found option "${targetText}". Clicking...`);
            targetOption.click();
            await sleep(800); // Wait for potential close/transition
        } else {
            console.warn(`[FAIL] Option '${targetText}' not found in open menu.`);
            localLogs.push(`[Info] Option '${targetText}' not visible. keeping current.`);
            // Try to close menu if we can (click button again)
            if (menuBtn) menuBtn.click();
        }

        return { success: true, logs: localLogs };
    }

    async function waitForSendButtonEnabled() {
        console.log("[STEP] Looping for Send button enabled state");
        const localLogs = [];
        localLogs.push("[Step] Waiting for Send button to enable...");
        return new Promise((resolve) => {
            const start = performance.now();
            const maxWait = 15000;
            const check = () => {
                const sendBtn = document.querySelector('button[aria-label="Send"]');
                if (sendBtn) {
                    const isDisabled = sendBtn.disabled;
                    const isAriaDisabled = sendBtn.getAttribute("aria-disabled") === "true";
                    if (!isDisabled && !isAriaDisabled) {
                        console.log("[OK] Send button is READY");
                        localLogs.push("[Step] Send button available.");
                        resolve({ success: true, logs: localLogs });
                        return;
                    }
                }
                if (performance.now() - start > maxWait) {
                    console.warn("Brain: Timeout waiting for Send Button.");
                    localLogs.push("[Fail] Timeout waiting for Send button.");
                    resolve({ success: false, logs: localLogs, error: "Send button timeout" });
                    return;
                }
                requestAnimationFrame(check);
            };
            check();
        });
    }

    async function clickSend(targetText = "Create") {
        console.log("[STEP] Clicking Send button");
        const localLogs = [];
        const btn = document.querySelector('button[aria-label="Send"]');
        if (btn) {
            const isDisabled = btn.disabled;
            const isAriaDisabled = btn.getAttribute("aria-disabled") === "true";
            if (!isDisabled && !isAriaDisabled) {
                console.log("[OK] Send button clicked");
                localLogs.push(`[Step] Clicking Send button (${targetText})...`);

                // Humanize
                btn.focus();
                await new Promise(r => setTimeout(r, Math.floor(Math.random() * 200) + 100)); // 100-300ms jitter

                btn.click();
                await sleep(3000); // Increased stability wait

                localLogs.push("[Success] Send button clicked.");
                return { success: true, logs: localLogs };
            } else {
                localLogs.push("[Fail] Send button disabled.");
                return { success: false, logs: localLogs, error: "Send button disabled" };
            }
        }
        console.log("[FAIL] Send button not found or disabled at click time");
        localLogs.push("[Fail] Send button element vanished before click.");
        return { success: false, logs: localLogs, error: "Send button missing" };
    }

    try {
        console.log("Brain: Promptâ†’Image (Strict Flow)");

        // ROBUST: Multiple methods to select image mode
        let imgBtn = Array.from(document.querySelectorAll('button'))
            .find(b => b.innerText.toLowerCase().includes("create image"));

        if (!imgBtn) {
            // Fallback 1: aria-label
            imgBtn = document.querySelector('button[aria-label*="image" i]');
        }

        if (!imgBtn) {
            // Fallback 2: Icon search
            const allButtons = Array.from(document.querySelectorAll('button'));
            imgBtn = allButtons.find(btn => {
                const svg = btn.querySelector('svg');
                return svg && svg.innerHTML.toLowerCase().includes('image');
            });
        }

        if (imgBtn) {
            logs.push("[Step] 'Create image' button clicked.");
            imgBtn.click(); await sleep(2000);
        } else {
            // Fallback 3: Real UI Flow - Click + icon and navigate dropdown
            logs.push("[Fallback] 'Create image' button not found. Using + icon flow...");

            const plusRes = await clickPlusIcon();
            logs.push(...plusRes.logs);
            if (!plusRes.success) {
                // Fallback 4: Keyboard shortcut as last resort
                logs.push("[Fallback] + icon not found. Triggering Ctrl+Shift+I...");
                const event = new KeyboardEvent('keydown', {
                    key: 'i', code: 'KeyI', keyCode: 73,
                    ctrlKey: true, shiftKey: true,
                    bubbles: true, cancelable: true
                });
                document.dispatchEvent(event);
                await sleep(2000);
                logs.push("[Success] Keyboard shortcut triggered.");
            } else {
                // Click "Create" from dropdown
                const createRes = await selectCreateFromDropdown();
                logs.push(...createRes.logs);
                if (!createRes.success) {
                    return { success: false, logs: logs, error: createRes.error };
                }
                // For image mode, we're done after clicking "Create"
                await sleep(1000);
            }
        }

        // 2. SET ASPECT RATIO (Strict, Before Prompt)
        // Note: Ratio button MUST appear after entering "Create Image" mode
        const ratioRes = await ensureAspectRatio(aspectRatio);
        logs.push(...ratioRes.logs);
        if (!ratioRes.success) {
            return { success: false, logs: logs, error: ratioRes.error }; // Stop if ratio fails
        }

        // 3. Paste Prompt
        console.log("[STEP] Locating textarea");
        const textBox = document.querySelector("textarea, div[role='textbox']");
        if (textBox) {
            logs.push("[Step] Textarea found. Pasting prompt...");
            textBox.focus();
            textBox.value = prompt;
            textBox.dispatchEvent(new Event('input', { bubbles: true }));
            await sleep(1000);
            logs.push(`[Step] Prompt pasted (${prompt.length} chars).`);
        } else {
            console.log("[FAIL] Textarea missing");
            logs.push("[Fail] Textarea NOT found.");
            return { success: false, logs: logs, error: "Textarea missing" };
        }

        // 4. Wait & Send
        const waitRes = await waitForSendButtonEnabled();
        logs.push(...waitRes.logs);
        if (!waitRes.success) return { success: false, logs: logs, error: waitRes.error };

        const clickRes = await clickSend("Create");
        logs.push(...clickRes.logs);
        if (!clickRes.success) return { success: false, logs: logs, error: clickRes.error };

        return { success: true, logs: logs };
    } catch (e) {
        console.error(e);
        return { success: false, logs: logs, error: e.message };
    }
}

// --- REFACTORED: Interruptible Wait (Polling) ---
// --- REFACTORED: Interruptible Wait (Polling) ---
// --- REFACTORED: Interruptible Wait (Polling) ---
async function processWaitForGeneration(isImageMode) {
    if (currentMode === 'image-to-video') {
        // IMAGE-TO-VIDEO: DOM TAGGING DEDUPLICATION
        console.log(`ðŸ”¥ CORE RELOADED: DOM Tagging Strategy (${Date.now()})`);

        logMessage("Waiting 3s warmup...", 'info');
        await new Promise(r => setTimeout(r, 3000));

        const maxWait = 180000;
        const start = Date.now();

        console.log("[START] Polling for UNMARKED video...");

        while (Date.now() - start < maxWait) {
            if (stopRequested || isStopped) return null;
            // Respect pause
            while (isPaused && !stopRequested && !isStopped) await new Promise(r => setTimeout(r, 500));
            if (stopRequested || isStopped) return null;

            // Phase 1: Check without marking
            const status = await injectScript(checkGenerationStatus, [false, false]);

            if (status && status.mediaUrl) {
                console.log("[PHASE 1] New Video Detected. Starting Buffer.");
                logMessage("New video detected (unique).", 'info');
                logMessage("Waiting 10s safety buffer...", 'info');
                await new Promise(r => setTimeout(r, 10000));

                // Phase 2: Final Scan & MARK AS SEEN
                logMessage("Final scan & tagging...", 'info');
                const finalStatus = await injectScript(checkGenerationStatus, [false, true]); // markAsSeen = true !

                if (finalStatus && finalStatus.mediaUrl) {
                    logMessage("Video tagged as seen.", 'success');
                    return finalStatus.mediaUrl;
                }
            }
            await new Promise(r => setTimeout(r, 800));
        }
        return null;
    }

    // PROMPT MODES (Standard Logic)
    console.log(`ðŸ”¥ CORE RELOADED: Standard Logic (${Date.now()})`);
    const generationWaitInput = document.getElementById('generationWait');
    const INITIAL_DETECTION_DELAY = (generationWaitInput?.value || 5) * 1000;
    logMessage(`Waiting ${INITIAL_DETECTION_DELAY / 1000}s for generation startup...`, 'info');
    await new Promise(r => setTimeout(r, INITIAL_DETECTION_DELAY));

    // Get user's selection mode (image or video)
    const selectionMode = isImageMode
        ? (document.getElementById('imageGenerationSelect')?.value || 'auto')
        : (document.getElementById('videoGenerationSelect')?.value || 'auto');

    // Log selection mode
    if (selectionMode !== 'auto') {
        logMessage(`Selecting position ${selectionMode}...`, 'info');
    }

    const maxWait = 180000;
    const start = Date.now();
    let lastLog = Date.now();

    while (Date.now() - start < maxWait) {
        if (stopRequested || isStopped) return null;
        // Respect pause
        while (isPaused && !stopRequested && !isStopped) await new Promise(r => setTimeout(r, 500));
        if (stopRequested || isStopped) return null;

        const status = await injectScript(checkGenerationStatus, [isImageMode, false, selectionMode]);

        if (status && status.mediaUrl) {
            logMessage("Generation complete. buffer...", 'info');
            await new Promise(r => setTimeout(r, 10000));

            logMessage("Final scan...", 'info');
            const finalStatus = await injectScript(checkGenerationStatus, [isImageMode, false, selectionMode]);
            if (finalStatus && finalStatus.mediaUrl) return finalStatus.mediaUrl;
        }

        // Show progress every 30 seconds so user knows it's still polling
        if (Date.now() - lastLog > 30000) {
            const elapsed = Math.round((Date.now() - start) / 1000);
            const remaining = Math.round((maxWait - (Date.now() - start)) / 1000);
            const dbg = status?.debug || {};
            logMessage(`â³ Polling: ${elapsed}s/${Math.round(maxWait / 1000)}s | Videos: ${dbg.totalVideos || 0} | Images: ${dbg.totalImages || 0} | DL btns: ${dbg.downloadBtns || 0}`, 'info');
            if (dbg.videoDetails?.length > 0) {
                dbg.videoDetails.forEach((v, i) => {
                    logMessage(`  ðŸŽ¥ Video ${i + 1}: ready=${v.readyState} src=${v.hasSrc} marked=${v.marked}`, 'info');
                });
            }
            lastLog = Date.now();
        }

        await new Promise(r => setTimeout(r, 800));
    }
    return null;
}


// INJECTED HELPER with DOM Marking, Position Selection, and Fallback Strategies
function checkGenerationStatus(isImageMode, markAsSeen = false, selectionMode = 'auto') {
    let mediaUrl = null;

    // ðŸŸ¢ POSITION-BASED SELECTION
    const getByPosition = (elements, position) => {
        if (elements.length === 0) return null;

        // No visibility filter â€” works in small windows too
        const sorted = elements.sort((a, b) => {
            return a.getBoundingClientRect().left - b.getBoundingClientRect().left;
        });

        // If position is a number (1-4), return that index (1-based to 0-based)
        if (position >= 1 && position <= 4) {
            return sorted[position - 1] || sorted[sorted.length - 1]; // Fallback to last if invalid
        }

        // Auto mode: randomly pick any of the available elements
        const randomIndex = Math.floor(Math.random() * sorted.length);
        return sorted[randomIndex];
    };

    // Helper: Get video src from element or its <source> children
    const getVideoSrc = (v) => {
        if (v.src) return v.src;
        if (v.currentSrc) return v.currentSrc;
        // Check <source> child elements (Meta AI often uses these)
        const source = v.querySelector('source');
        if (source && source.src) return source.src;
        return null;
    };

    // Parse selection mode
    const position = selectionMode === 'auto' ? 'auto' : parseInt(selectionMode);

    if (isImageMode) {
        // IMAGE MODE â€” Relaxed Filters
        const imgs = Array.from(document.querySelectorAll('img'))
            .filter(img => {
                const src = img.src || "";
                // EXCLUDE IF MARKED
                if (img.hasAttribute('data-autometacopy-seen')) return false;

                // Broad CDN pattern matching for Meta AI
                const isMetaMedia = (
                    src.startsWith('blob:') ||
                    src.includes('fbcdn') ||
                    src.includes('scontent') ||
                    src.includes('lookaside') ||
                    src.includes('static.xx') ||
                    src.includes('meta.ai')
                );

                return (
                    isMetaMedia &&
                    img.complete &&
                    img.naturalWidth > 0
                );
            });

        const selectedImg = getByPosition(imgs, position);
        if (selectedImg) {
            mediaUrl = selectedImg.src;
            if (markAsSeen) {
                selectedImg.setAttribute('data-autometacopy-seen', 'true');
            }
        }

    } else {
        // VIDEO MODE â€” Relaxed Filters + <source> Support
        const vids = Array.from(document.querySelectorAll('video'))
            .filter(v => {
                // EXCLUDE IF MARKED
                if (v.hasAttribute('data-autometacopy-seen')) return false;

                const src = getVideoSrc(v);
                return (
                    src &&
                    v.readyState >= 1  // Metadata loaded is enough
                );
            });

        const selectedVid = getByPosition(vids, position);
        if (selectedVid) {
            mediaUrl = getVideoSrc(selectedVid);
            // MARK IT IF REQUESTED
            if (markAsSeen) {
                selectedVid.setAttribute('data-autometacopy-seen', 'true');
            }
        }
    }

    // ðŸ”µ FALLBACK: Download Button Detection (from selectors.json)
    // If primary scan found nothing, check if a Download button appeared (= media exists)
    if (!mediaUrl) {
        const downloadBtns = Array.from(document.querySelectorAll('button[aria-label="Download"]'));

        if (downloadBtns.length > 0) {
            // Download button exists â€” media has been generated.
            // Walk up the DOM from the LAST download button to find the nearest video/img
            const lastBtn = downloadBtns[downloadBtns.length - 1];
            const container = lastBtn.closest('article') || lastBtn.closest('div[class*="flex"]') || lastBtn.parentElement?.parentElement?.parentElement?.parentElement;

            if (container) {
                if (!isImageMode) {
                    const vid = container.querySelector('video');
                    if (vid && !vid.hasAttribute('data-autometacopy-seen')) {
                        mediaUrl = getVideoSrc(vid);
                        if (mediaUrl && markAsSeen) {
                            vid.setAttribute('data-autometacopy-seen', 'true');
                        }
                    }
                } else {
                    const img = container.querySelector('img');
                    if (img && !img.hasAttribute('data-autometacopy-seen') && img.naturalWidth > 0) {
                        mediaUrl = img.src;
                        if (mediaUrl && markAsSeen) {
                            img.setAttribute('data-autometacopy-seen', 'true');
                        }
                    }
                }
            }
        }
    }

    return {
        mediaUrl,
        debug: {
            totalVideos: document.querySelectorAll('video').length,
            totalImages: document.querySelectorAll('img').length,
            downloadBtns: document.querySelectorAll('button[aria-label="Download"]').length,
            videoDetails: Array.from(document.querySelectorAll('video')).map(v => ({
                readyState: v.readyState,
                hasSrc: !!(v.src || v.currentSrc || v.querySelector('source')?.src),
                marked: v.hasAttribute('data-autometacopy-seen')
            }))
        }
    };
}

async function scanCreateGalleryPage(slowScroll = true, progressSessionId = null, scanSpeed = 'medium') {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const speedConfig = {
        sonic: { delay: 260, activeDelay: 180, stepRatio: 1.45, maxPasses: 2500, minPasses: 8, publishEvery: 2 },
        slow: { delay: 2300, activeDelay: 1550, stepRatio: 0.34, maxPasses: 10000, minPasses: 20, publishEvery: 1 },
        medium: { delay: 1700, activeDelay: 1150, stepRatio: 0.52, maxPasses: 10000, minPasses: 18, publishEvery: 1 },
        fast: { delay: 1250, activeDelay: 850, stepRatio: 0.72, maxPasses: 10000, minPasses: 15, publishEvery: 1 }
    }[scanSpeed] || { delay: 1700, activeDelay: 1150, stepRatio: 0.52, maxPasses: 10000, minPasses: 18, publishEvery: 1 };

    const getVideoSrc = (video) => video?.src || video?.currentSrc || video?.querySelector('source')?.src || '';
    const isReadyVideo = (video) => {
        const src = getVideoSrc(video);
        const duration = Number(video?.duration || 0);
        return !!src && video.readyState >= 1 && Number.isFinite(duration) && duration > 0.2;
    };
    const cleanPrompt = (text) => (text || '').replace(/\s+/g, ' ').trim();
    const signatureFor = (type, src, prompt) => `${type}|${(src || '').split('#')[0].split('?')[0]}|${cleanPrompt(prompt).slice(0, 160)}`;
    const datePattern = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}$/i;
    const parseMetaDate = (label) => {
        const time = Date.parse(label);
        return Number.isFinite(time) ? time : Date.now();
    };
    const isVisible = (el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };
    const isCentralMedia = (el) => {
        const rect = el.getBoundingClientRect();
        return rect.right > window.innerWidth * 0.18
            && rect.left < window.innerWidth * 0.84
            && rect.width >= 80
            && rect.height >= 80;
    };
    const getScrollableParent = (el) => {
        let parent = el?.parentElement;
        while (parent && parent !== document.body) {
            const style = getComputedStyle(parent);
            if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 100 && isVisible(parent)) {
                return parent;
            }
            parent = parent.parentElement;
        }
        return null;
    };
    const getScroller = () => {
        const mainRoot = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
        const isBadSidebar = (el) => {
            const badAncestor = el.closest('nav, aside, [aria-label*="History" i], [aria-label*="Sidebar" i], [aria-label*="Navigation" i]');
            if (badAncestor) return true;
            const text = cleanPrompt(el.innerText).toLowerCase();
            const rect = el.getBoundingClientRect();
            return rect.right < window.innerWidth * 0.22 && (text.includes('new chat') || text.includes('history'));
        };
        const hasCreateMediaNearby = (el) => {
            if (el.querySelector('article video, article img, video, img')) return true;
            const rect = el.getBoundingClientRect();
            return rect.left > window.innerWidth * 0.18 && rect.right < window.innerWidth * 0.86;
        };
        const candidates = [mainRoot, ...Array.from(mainRoot.querySelectorAll('main, [role="main"], div, section'))]
            .filter(el => {
                const style = getComputedStyle(el);
                const canScroll = /(auto|scroll)/.test(style.overflowY);
                return canScroll
                    && el.scrollHeight > el.clientHeight + 200
                    && isVisible(el)
                    && !isBadSidebar(el)
                    && hasCreateMediaNearby(el);
            })
            .sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
        const mediaParents = Array.from(mainRoot.querySelectorAll('video, img'))
            .filter(el => isVisible(el) && isCentralMedia(el))
            .map(getScrollableParent)
            .filter(Boolean)
            .filter(el => !isBadSidebar(el));
        const pageScroller = document.scrollingElement || document.documentElement;
        return mediaParents[0] || candidates[0] || pageScroller;
    };

    const getVisibleDateAnchors = (root) => {
        return Array.from(root.querySelectorAll('span, div, time'))
            .map(el => ({ el, text: cleanPrompt(el.innerText || el.textContent || '') }))
            .filter(item => datePattern.test(item.text) && isVisible(item.el))
            .map(item => ({
                label: item.text,
                top: item.el.getBoundingClientRect().top + window.scrollY,
                timestamp: parseMetaDate(item.text)
            }))
            .sort((a, b) => a.top - b.top);
    };

    const getMetaDateForTop = (top, anchors) => {
        let selected = null;
        for (const anchor of anchors) {
            if (anchor.top <= top + 20) selected = anchor;
            else break;
        }
        return selected || anchors[0] || null;
    };

    const collect = () => {
        const items = [];
        const mainRoot = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
        const dateAnchors = getVisibleDateAnchors(mainRoot);
        const addMediaItem = (type, el, prompt, articleIndex = -1, mediaIndex = -1) => {
            const src = type === 'video' ? getVideoSrc(el) : (el.src || '');
            if (!src) return;
            if (type === 'video' && !isReadyVideo(el)) return;
            if (!isVisible(el) || !isCentralMedia(el)) return;
            if (type === 'image' && (el.naturalWidth < 100 || el.naturalHeight < 100)) return;
            const top = el.getBoundingClientRect().top + window.scrollY;
            const metaDate = getMetaDateForTop(top, dateAnchors);
            const signature = signatureFor(type, src, prompt);
            items.push({
                type,
                src,
                prompt,
                signature,
                articleIndex,
                mediaIndex,
                top,
                detectedAt: metaDate?.timestamp || Date.now(),
                metaDate: metaDate?.label || null
            });
        };

        Array.from(mainRoot.querySelectorAll('video')).filter(isReadyVideo).forEach((video, mediaIndex) => {
            const card = video.closest('article, [data-testid]');
            const prompt = cleanPrompt(card?.innerText || '');
            addMediaItem('video', video, prompt, -2, mediaIndex);
        });
        Array.from(mainRoot.querySelectorAll('img')).forEach((img, mediaIndex) => {
            const card = img.closest('article, [data-testid]');
            const prompt = cleanPrompt(card?.innerText || '');
            addMediaItem('image', img, prompt, -2, mediaIndex);
        });
        return items;
    };

    const seen = new Map();
    const collectIntoSeen = () => {
        collect().forEach(item => {
            if (!seen.has(item.signature)) seen.set(item.signature, item);
        });
    };

    const publishProgress = async (done = false) => {
        if (!progressSessionId || !chrome?.storage?.local) return;
        const allItems = Array.from(seen.values());
        const items = allItems.slice(-1200);
        await chrome.storage.local.set({
            autoMetaCopy_scanProgress: {
                sessionId: progressSessionId,
                done,
                updatedAt: Date.now(),
                items,
                videoCount: allItems.filter(item => item.type === 'video').length,
                imageCount: allItems.filter(item => item.type === 'image').length
            }
        });
    };
    const shouldStop = async () => {
        if (!progressSessionId || !chrome?.storage?.local) return false;
        const data = await chrome.storage.local.get('autoMetaCopy_scanControl');
        const control = data.autoMetaCopy_scanControl;
        return !!(control && control.sessionId === progressSessionId && control.stop);
    };

    if (slowScroll) {
        const scroller = getScroller();
        try { scroller.scrollTop = 0; } catch (e) { }
        if (scroller === document.scrollingElement || scroller === document.documentElement) {
            window.scrollTo({ top: 0, behavior: 'instant' });
        }
        await sleep(1200);
        collectIntoSeen();
        await publishProgress(false);

        let stableRounds = 0;
        let lastTop = -1;
        let lastCount = seen.size;
        let stopped = false;

        for (let i = 0; i < speedConfig.maxPasses; i++) {
            if (i % 2 === 0 && await shouldStop()) {
                stopped = true;
                break;
            }
            try {
                const amount = Math.max(300, (scroller.clientHeight || window.innerHeight) * speedConfig.stepRatio);
                scroller.scrollTop += amount;
            } catch (e) {
                window.scrollBy({ top: Math.max(300, window.innerHeight * speedConfig.stepRatio), behavior: 'auto' });
            }
            await sleep(seen.size > lastCount ? speedConfig.activeDelay : speedConfig.delay);
            collectIntoSeen();
            if (i % speedConfig.publishEvery === 0 || seen.size !== lastCount) {
                await publishProgress(false);
            }

            const top = scroller.scrollTop || window.scrollY || 0;
            const height = scroller.scrollHeight || document.documentElement.scrollHeight;
            const viewport = scroller.clientHeight || window.innerHeight;
            const atBottom = top + viewport >= height - 30;
            if (seen.size === lastCount && Math.abs(top - lastTop) < 4) stableRounds++;
            else stableRounds = 0;
            if (i >= speedConfig.minPasses && atBottom && stableRounds >= 4) break;

            lastTop = top;
            lastCount = seen.size;
        }
        if (stopped) {
            const items = Array.from(seen.values());
            await publishProgress(true);
            return {
                success: true,
                stopped: true,
                items,
                videoCount: items.filter(item => item.type === 'video').length,
                imageCount: items.filter(item => item.type === 'image').length
            };
        }
    } else {
        collectIntoSeen();
        await publishProgress(false);
    }

    const items = Array.from(seen.values());
    await publishProgress(true);
    return {
        success: true,
        items,
        videoCount: items.filter(item => item.type === 'video').length,
        imageCount: items.filter(item => item.type === 'image').length
    };
}

async function scrollToCreateGalleryItem(targetItem) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const getVideoSrc = (video) => video?.src || video?.currentSrc || video?.querySelector('source')?.src || '';
    const cleanPrompt = (text) => (text || '').replace(/\s+/g, ' ').trim();
    const signatureFor = (type, src, prompt) => `${type}|${(src || '').split('#')[0].split('?')[0]}|${cleanPrompt(prompt).slice(0, 160)}`;
    const normalizeSrc = (src) => (src || '').split('#')[0].split('?')[0];
    const targetSignature = targetItem?.signature || '';
    const targetSrc = normalizeSrc(targetItem?.src || '');
    const mainRoot = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;

    const findScroller = () => {
        const media = Array.from(mainRoot.querySelectorAll('video, img')).find(el => {
            const rect = el.getBoundingClientRect();
            return rect.width > 80 && rect.height > 80;
        });
        let parent = media?.parentElement;
        while (parent && parent !== document.body) {
            const style = getComputedStyle(parent);
            if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 100) return parent;
            parent = parent.parentElement;
        }
        return document.scrollingElement || document.documentElement;
    };

    const findTarget = () => {
        const articleCandidates = Array.from(mainRoot.querySelectorAll('article'));
        const articles = articleCandidates.length > 0
            ? articleCandidates
            : Array.from(mainRoot.querySelectorAll('div, section')).filter(el => el.querySelector('video,img'));

        for (const article of articles) {
            const promptEl = Array.from(article.querySelectorAll('span[data-slot="text"], span, p, div'))
                .find(el => cleanPrompt(el.innerText).length > 20);
            const prompt = cleanPrompt(promptEl?.innerText || article.innerText || '');
            const media = [
                ...Array.from(article.querySelectorAll('video')).map(el => ({ type: 'video', el, src: getVideoSrc(el) })),
                ...Array.from(article.querySelectorAll('img')).map(el => ({ type: 'image', el, src: el.src || '' }))
            ];

            const found = media.find(item => {
                const sameType = !targetItem?.type || item.type === targetItem.type;
                const sameSignature = signatureFor(item.type, item.src, prompt) === targetSignature;
                const sameSrc = targetSrc && normalizeSrc(item.src) === targetSrc;
                return sameType && (sameSignature || sameSrc);
            });
            if (found) return found;
        }
        return null;
    };

    const reveal = (found) => {
        if (found) {
            found.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            let parent = found.el.parentElement;
            while (parent && parent !== document.body) {
                const style = getComputedStyle(parent);
                if (/(auto|scroll)/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight) {
                    const parentRect = parent.getBoundingClientRect();
                    const itemRect = found.el.getBoundingClientRect();
                    parent.scrollBy({ top: itemRect.top - parentRect.top - parent.clientHeight / 2, behavior: 'smooth' });
                    break;
                }
                parent = parent.parentElement;
            }
            found.el.style.outline = '3px solid #10B981';
            setTimeout(() => { found.el.style.outline = ''; }, 3000);
            return { success: true };
        }
        return null;
    };

    let found = findTarget();
    const immediate = reveal(found);
    if (immediate) return immediate;

    const scroller = findScroller();
    const startTop = scroller.scrollTop || 0;
    for (let i = 0; i < 90; i++) {
        try {
            scroller.scrollTop += Math.max(360, (scroller.clientHeight || window.innerHeight) * 0.7);
        } catch (e) {
            window.scrollBy({ top: Math.max(360, window.innerHeight * 0.7), behavior: 'auto' });
        }
        await sleep(450);
        found = findTarget();
        const result = reveal(found);
        if (result) return result;
        const top = scroller.scrollTop || window.scrollY || 0;
        const height = scroller.scrollHeight || document.documentElement.scrollHeight;
        const viewport = scroller.clientHeight || window.innerHeight;
        if (top + viewport >= height - 30) break;
    }
    try { scroller.scrollTop = startTop; } catch (e) { }
    return { success: false };
}

async function prepareCreateComposer() {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const logs = [];
    if (!location.href.includes('/create')) {
        location.href = 'https://www.meta.ai/create';
        await sleep(2500);
    }

    const createLink = Array.from(document.querySelectorAll('a, button, [role="button"]'))
        .find(el => /create/i.test(el.innerText || el.getAttribute('aria-label') || ''));
    if (createLink) {
        createLink.click();
        logs.push('[Step] Create section selected.');
        await sleep(1000);
    }

    return { success: true, logs };
}

async function submitCreatePrompt(options) {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const logs = [];
    const command = options.command || '/video';
    const prompt = options.prompt || '';
    const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 8 && rect.height > 8 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const isEnabled = (el) => !!el && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
    const hasAttachmentTileImage = () => Array.from(document.querySelectorAll('[class*="attachment-tile"] img, [class*="attachment-tile"] canvas, composer-render-mark img[src^="blob:"], composer-render-mark img[src^="data:image/"]'))
        .some(el => {
            if (!isVisible(el)) return false;
            const tile = el.closest?.('[class*="attachment-tile"]');
            const composer = el.closest?.('composer-render-mark, [data-testid*="composer" i], form');
            const text = `${el.alt || ''} ${el.getAttribute?.('aria-label') || ''} ${tile?.className || ''}`.toLowerCase();
            const src = String(el.currentSrc || el.src || el.getAttribute?.('src') || '');
            return !!tile || (!!composer && (src.startsWith('blob:') || src.startsWith('data:image/') || /image|photo|attachment/.test(text)));
        });
    const findSendButton = () => {
        const direct = document.querySelector([
            '[data-testid="composer-send-button"]',
            '[data-testid="composer-send-button"] svg',
            'button[aria-label="Send"]',
            'button[aria-label*="send" i]',
            '[role="button"][aria-label*="send" i]',
            'div.bottom-0 div.ms-auto svg'
        ].join(','));
        if (direct && isVisible(direct)) return direct.closest('button,[role="button"],[data-testid="composer-send-button"]') || direct;
        const composer = document.querySelector('[data-testid="composer"], form, [data-testid*="composer" i]') || document.body;
        const inputRect = input?.getBoundingClientRect?.() || { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
        return Array.from(composer.querySelectorAll('button,[role="button"]'))
            .filter(btn => isVisible(btn) && isEnabled(btn))
            .map(btn => {
                const text = `${btn.innerText || ''} ${btn.getAttribute('aria-label') || ''} ${btn.getAttribute('data-testid') || ''}`.toLowerCase();
                const rect = btn.getBoundingClientRect();
                const hasSendHint = /send|submit|create|arrow|composer-send/.test(text);
                const hasSvg = !!btn.querySelector('svg');
                const nearInput = rect.left >= inputRect.left - 40 && rect.top >= inputRect.top - 80 && rect.bottom <= inputRect.bottom + 120;
                const score = (hasSendHint ? 100 : 0) + (hasSvg ? 25 : 0) + (nearInput ? 40 : 0) - Math.abs(rect.right - inputRect.right) / 20;
                return { btn, score, text };
            })
            .filter(item => !/attach|upload|image|photo|plus|add|microphone|voice/.test(item.text))
            .sort((a, b) => b.score - a.score)[0]?.btn || null;
    };

    const textValue = `${command} ${prompt}`.trim();
    const input = document.querySelector('[data-testid="composer-input"], textarea, div[role="textbox"]');
    if (!input) return { success: false, logs: ['[Fail] Composer input missing.'], error: 'composer missing' };
    const hasComposerImageAttachment = (expectedName = '') => {
        if (hasAttachmentTileImage()) return true;
        const inputRect = input.getBoundingClientRect?.() || { left: 0, right: innerWidth, top: innerHeight, bottom: innerHeight };
        const roots = [];
        let node = input;
        for (let i = 0; node && i < 10; i++, node = node.parentElement) roots.push(node);
        roots.push(document.querySelector('[data-testid*="composer" i]'), document.querySelector('form'), document.body);
        const candidates = Array.from(new Set(roots.filter(Boolean)))
            .flatMap(root => Array.from(root.querySelectorAll('img, canvas, [role="img"], [class*="attachment-tile"], [data-testid*="attachment" i], [aria-label*="remove" i], [aria-label*="image" i], [aria-label*="photo" i]')));
        const visiblePreview = candidates
            .some(el => {
                if (!isVisible(el)) return false;
                const rect = el.getBoundingClientRect();
                const nearComposer = rect.bottom >= inputRect.top - 180
                    && rect.top <= inputRect.bottom + 30
                    && rect.right >= inputRect.left - 80
                    && rect.left <= inputRect.right + 80;
                const text = `${el.alt || ''} ${el.getAttribute?.('aria-label') || ''} ${el.getAttribute?.('data-testid') || ''} ${el.textContent || ''}`.toLowerCase();
                const klass = String(el.className || '').toLowerCase();
                const src = String(el.currentSrc || el.src || el.getAttribute?.('src') || '');
                return nearComposer && (src.startsWith('blob:') || src.startsWith('data:image/')
                    || /attachment|remove|image|photo|preview|uploaded/.test(`${text} ${klass}`));
            });
        const nameVisible = expectedName && roots.some(root => root?.textContent?.toLowerCase?.().includes(String(expectedName).toLowerCase()));
        return visiblePreview || nameVisible;
    };
    const waitForImageAttachment = async (expectedName = '', maxWait = 20000) => {
        const start = performance.now();
        while (performance.now() - start < maxWait) {
            if (hasComposerImageAttachment(expectedName)) return true;
            await sleep(350);
        }
        return false;
    };

    if (options.imageBase64) {
        let attachBtn = document.querySelector('[data-testid="composer-add-attachment-button"], button[aria-label*="Add attachment" i]');
        if (attachBtn) {
            attachBtn.click();
            logs.push('[Step] Add attachment clicked.');
            await sleep(800);
        }

        const fileInput = document.querySelector('input[type="file"]');
        if (!fileInput) return { success: false, logs, error: 'file input missing' };

        const b64toBlob = (b64Data, contentType = '') => {
            const byteCharacters = atob(b64Data.split(',')[1]);
            const byteArrays = [];
            for (let offset = 0; offset < byteCharacters.length; offset += 512) {
                const slice = byteCharacters.slice(offset, offset + 512);
                const byteNumbers = new Array(slice.length);
                for (let i = 0; i < slice.length; i++) byteNumbers[i] = slice.charCodeAt(i);
                byteArrays.push(new Uint8Array(byteNumbers));
            }
            return new Blob(byteArrays, { type: contentType });
        };
        const blob = b64toBlob(options.imageBase64, 'image/jpeg');
        const file = new File([blob], options.imageName || 'image.jpg', { type: 'image/jpeg' });
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));
        logs.push('[Step] Image attached.');
        const attached = await waitForImageAttachment(options.imageName || '', Math.max(12000, Number(options.uploadDelay || 10000) + 8000));
        if (!attached) {
            logs.push('[Fail] Image upload was not confirmed. Prompt not sent.');
            return { success: false, logs, error: 'image upload not confirmed' };
        }
        logs.push('[Step] Image upload confirmed.');
        await sleep(Math.min(2500, Math.max(500, Number(options.uploadDelay || 10000) / 4)));
    }

    if (options.imageBase64 && !hasComposerImageAttachment(options.imageName || '')) {
        logs.push('[Fail] Image disappeared before prompt paste. Prompt not sent.');
        return { success: false, logs, error: 'image missing before prompt paste' };
    }

    input.focus();
    const editableTarget = input.matches?.('textarea,input') ? input : (input.querySelector('p') || input);
    editableTarget.focus?.();
    if ('value' in editableTarget) {
        editableTarget.value = textValue;
        editableTarget.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textValue }));
        editableTarget.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
        const sel = window.getSelection?.();
        try {
            const range = document.createRange();
            range.selectNodeContents(editableTarget);
            sel?.removeAllRanges();
            sel?.addRange(range);
        } catch (e) { }
        let inserted = false;
        try { inserted = document.execCommand && document.execCommand('insertText', false, textValue); } catch (e) { inserted = false; }
        if (!inserted) {
            editableTarget.textContent = textValue;
        }
        editableTarget.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textValue }));
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: textValue }));
    }
    logs.push(`[Step] Prompt pasted with ${command}.`);
    await sleep(1200);

    if (options.imageBase64 && !hasComposerImageAttachment(options.imageName || '')) {
        logs.push('[Fail] Image missing before send. Send cancelled.');
        return { success: false, logs, error: 'image missing before send' };
    }

    let sendBtn = findSendButton();
    if (!sendBtn) {
        logs.push('[Warn] Send button not found; trying Enter key fallback.');
        editableTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        editableTarget.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        await sleep(1500);
        return { success: true, logs: [...logs, '[Success] Enter fallback sent.'] };
    }

    const start = performance.now();
    while (!isEnabled(sendBtn) && performance.now() - start < 15000) {
        await sleep(250);
        sendBtn = findSendButton() || sendBtn;
    }
    if (!isEnabled(sendBtn)) {
        logs.push('[Warn] Send button disabled; trying Enter key fallback.');
        editableTarget.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        editableTarget.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        await sleep(1500);
        return { success: true, logs: [...logs, '[Success] Enter fallback sent.'] };
    }

    sendBtn.focus?.();
    ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(type => {
        sendBtn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    });
    logs.push('[Success] Send clicked.');
    await sleep(1500);
    return { success: true, logs };
}

function collectCreateMediaBaselineSignatures() {
    const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();
    const getVideoSrc = (video) => video?.src || video?.currentSrc || video?.querySelector('source')?.src || '';
    const signatureFor = (type, src, promptText) => `${type}|${(src || '').split('#')[0].split('?')[0]}|${clean(promptText).slice(0, 160)}`;
    const signatures = [];
    Array.from(document.querySelectorAll('article')).forEach(article => {
        const promptText = clean(article.innerText || '');
        // Collect from <video> elements (video.src)
        Array.from(article.querySelectorAll('video')).forEach(video => {
            const src = getVideoSrc(video);
            if (src) signatures.push(signatureFor('video', src, promptText));
        });
        // Collect from data-video-url attributes (this is what the detector actually reads)
        Array.from(article.querySelectorAll('[data-testid="generated-video"], [data-video-url], [data-testid*="video" i]')).forEach(div => {
            const dvUrl = div.getAttribute('data-video-url') || '';
            if (dvUrl) signatures.push(signatureFor('video', dvUrl, promptText));
        });
        Array.from(article.querySelectorAll('a[href*=".mp4"], a[href*="fbcdn"], [href*=".mp4"], [href*="fbcdn"]')).forEach(link => {
            const href = link.getAttribute('href') || '';
            if (href) signatures.push(signatureFor('video', href, promptText));
        });
        Array.from(article.querySelectorAll('img')).forEach(img => {
            const src = img.src || '';
            if (src && img.naturalWidth >= 60 && img.naturalHeight >= 60) {
                signatures.push(signatureFor('image', src, promptText));
            }
        });
    });
    const mainRoot = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
    Array.from(mainRoot.querySelectorAll('video')).forEach(video => {
        const src = getVideoSrc(video);
        if (!src) return;
        signatures.push(signatureFor('video', src, 'global-create-grid'));
    });
    // Also collect data-video-url at global level
    Array.from(mainRoot.querySelectorAll('[data-testid="generated-video"], [data-video-url], [data-testid*="video" i]')).forEach(div => {
        const dvUrl = div.getAttribute('data-video-url') || '';
        if (!dvUrl) return;
        signatures.push(signatureFor('video', dvUrl, 'global-create-grid'));
    });
    Array.from(mainRoot.querySelectorAll('a[href*=".mp4"], a[href*="fbcdn"], [href*=".mp4"], [href*="fbcdn"]')).forEach(link => {
        const href = link.getAttribute('href') || '';
        if (href) signatures.push(signatureFor('video', href, 'global-create-grid'));
    });
    Array.from(mainRoot.querySelectorAll('img')).forEach(img => {
        const src = img.src || '';
        if (!src || img.naturalWidth < 100 || img.naturalHeight < 100) return;
        signatures.push(signatureFor('image', src, 'global-create-grid'));
    });
    return { signatures: Array.from(new Set(signatures)) };
}

function findCreateMediaForPrompt(prompt, targetType, baselineSignatures = [], selectionMode = 'auto') {
    const baseline = new Set(baselineSignatures || []);
    const clean = (text) => (text || '').replace(/\s+/g, ' ').trim();
    const normalize = (text) => clean(text)
        .toLowerCase()
        .replace(/^\/(video|image)\s+/, '')
        .replace(/^\[\d+\]\s*/, '')
        .replace(/^\d+\s*[.)-]\s*/, '')
        .replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*-\s*\d{1,2}:\d{2}(?::\d{2})?\s*/, '')
        .replace(/^[^:]{1,60}:\s*/, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    const targetPrompt = normalize(prompt);
    const getVideoSrc = (video) => video?.src || video?.currentSrc || video?.querySelector('source')?.src || '';
    const isReadyVideo = (video) => {
        const src = getVideoSrc(video);
        const duration = Number(video?.duration || 0);
        return !!src && video.readyState >= 1 && Number.isFinite(duration) && duration > 0.2;
    };
    const signatureFor = (type, src, promptText) => `${type}|${(src || '').split('#')[0].split('?')[0]}|${clean(promptText).slice(0, 160)}`;
    const promptMatches = (text) => {
        const normalized = normalize(text);
        if (!targetPrompt) return false;
        if (normalized.includes(targetPrompt.slice(0, 80)) || targetPrompt.includes(normalized.slice(0, 80))) return true;
        const targetTokens = targetPrompt.split(' ').filter(t => t.length > 3);
        const textTokens = new Set(normalized.split(' ').filter(t => t.length > 3));
        if (targetTokens.length < 8 || textTokens.size < 8) return false;
        const hits = targetTokens.filter(t => textTokens.has(t)).length;
        return hits >= 8 && hits / Math.min(targetTokens.length, textTokens.size) >= 0.62;
    };
    const sortByGridPosition = (elements) => {
        return elements
            .filter(el => {
                const rect = el.getBoundingClientRect();
                return rect.width >= 60 && rect.height >= 60;
            })
            .sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                const rowDiff = ar.top - br.top;
                if (Math.abs(rowDiff) > 30) return rowDiff;
                return ar.left - br.left;
            });
    };
    const pickBySelection = (elements) => {
        const sorted = sortByGridPosition(elements);
        if (sorted.length === 0) return null;
        const position = parseInt(selectionMode, 10);
        if (Number.isFinite(position) && position >= 1) {
            return sorted[position - 1] || null;
        }
        return sorted[sorted.length - 1];
    };
    const isBaseline = (type, el, promptText) => {
        const src = type === 'video' ? getVideoSrc(el) : (el.src || '');
        if (!src) return true;
        return baseline.has(signatureFor(type, src, promptText));
    };
    const findAnimateButtonForImage = (article, img) => {
        const imageRect = img.getBoundingClientRect();
        const buttons = Array.from(article.querySelectorAll('button, [role="button"]'))
            .filter(btn => /animate/i.test(btn.innerText || btn.getAttribute('aria-label') || ''))
            .sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                const aDist = Math.abs(ar.left - imageRect.left) + Math.abs(ar.top - imageRect.bottom);
                const bDist = Math.abs(br.left - imageRect.left) + Math.abs(br.top - imageRect.bottom);
                return aDist - bDist;
            });
        return buttons[0] || null;
    };
    const hasLoadingSignal = (article) => {
        const text = (article.innerText || '').toLowerCase();
        if (/generating|creating|loading|queued|processing/i.test(text)) return true;
        const busy = article.querySelector('[aria-busy="true"], [role="progressbar"], progress, canvas, svg[aria-label*="loading" i]');
        if (busy) return true;
        return Array.from(article.querySelectorAll('[class], [data-testid], [aria-label]')).some(el => {
            const value = `${el.className || ''} ${el.getAttribute('data-testid') || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
            return value.includes('spinner') || value.includes('loading') || value.includes('progress');
        });
    };
    const findGlobalPromptElement = () => {
        const candidates = Array.from(document.querySelectorAll('span[data-slot="text"], p, div'))
            .filter(el => {
                const text = clean(el.innerText || '');
                if (!text || text.length < 20 || !promptMatches(text)) return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 40 && rect.height > 8 && rect.bottom > 0 && rect.top < window.innerHeight;
            })
            .sort((a, b) => {
                const ar = a.getBoundingClientRect();
                const br = b.getBoundingClientRect();
                return br.left - ar.left || ar.top - br.top;
            });
        return candidates[0] || null;
    };
    const findGlobalMediaForPrompt = () => {
        const promptEl = findGlobalPromptElement();
        if (!promptEl) return { success: false };
        const promptRect = promptEl.getBoundingClientRect();
        const promptText = clean(promptEl.innerText || prompt);
        const mainRoot = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
        const mediaNodes = targetType === 'video'
            ? Array.from(mainRoot.querySelectorAll('video')).filter(isReadyVideo).map(el => ({ type: 'video', el, src: getVideoSrc(el) }))
            : Array.from(mainRoot.querySelectorAll('img')).map(el => ({ type: 'image', el, src: el.src || '' }));
        const usable = mediaNodes
            .filter(item => {
                const rect = item.el.getBoundingClientRect();
                if (!item.src || rect.width < 80 || rect.height < 80) return false;
                if (item.type === 'image' && (item.el.naturalWidth < 100 || item.el.naturalHeight < 100)) return false;
                return rect.left < promptRect.left && rect.bottom > 0 && rect.top < window.innerHeight + 300;
            })
            .map(item => {
                const rect = item.el.getBoundingClientRect();
                const rowDistance = Math.abs((rect.top + rect.height * 0.18) - promptRect.top);
                return { ...item, rect, rowDistance };
            })
            .sort((a, b) => a.rowDistance - b.rowDistance);
        if (!usable.length) return { success: false, articleMatched: true, loading: false };
        const bestRowTop = usable[0].rect.top;
        const rowItems = usable
            .filter(item => Math.abs(item.rect.top - bestRowTop) < Math.max(90, item.rect.height * 0.45))
            .map(item => item.el);
        const selected = pickBySelection(rowItems);
        if (!selected) return { success: false, articleMatched: true, loading: false };
        const src = targetType === 'video' ? getVideoSrc(selected) : (selected.src || '');
        const signature = signatureFor(targetType, src, promptText);
        const globalSignature = signatureFor(targetType, src, 'global-create-grid');
        if (!src || baseline.has(signature) || baseline.has(globalSignature)) {
            return { success: false, articleMatched: true, loading: false, waitingSelected: true, selectedPosition: selectionMode };
        }
        selected.setAttribute('data-autometacopy-seen', 'true');
        return { success: true, articleMatched: true, loading: false, mediaUrl: src, signature, selectedPosition: selectionMode, source: 'global-grid' };
    };

    const articles = Array.from(document.querySelectorAll('article')).reverse();
    for (const article of articles) {
        const articleText = clean(article.innerText || '');
        if (!promptMatches(articleText)) continue;
        const loading = hasLoadingSignal(article);

        const promptEl = Array.from(article.querySelectorAll('span[data-slot="text"], span, p, div'))
            .find(el => promptMatches(el.innerText || ''));
        const promptText = clean(promptEl?.innerText || articleText);

        if (targetType === 'video') {
            const videos = sortByGridPosition(Array.from(article.querySelectorAll('video')).filter(isReadyVideo));
            const selectedVideo = pickBySelection(videos);
            if (selectedVideo) {
                const video = selectedVideo;
                const src = getVideoSrc(video);
                if (!src || loading) return { success: false, articleMatched: true, loading, waitingSelected: true, selectedPosition: selectionMode };
                const signature = signatureFor('video', src, promptText);
                if (baseline.has(signature)) return { success: false, articleMatched: true, loading, waitingSelected: true, selectedPosition: selectionMode };
                video.setAttribute('data-autometacopy-seen', 'true');
                return { success: true, articleMatched: true, loading, mediaUrl: src, signature, selectedPosition: selectionMode };
            }

            const images = sortByGridPosition(Array.from(article.querySelectorAll('img'))
                .filter(img => img.naturalWidth >= 100 && img.naturalHeight >= 100));
            const selectedImage = pickBySelection(images);
            if (selectedImage) {
                if (isBaseline('image', selectedImage, promptText)) {
                    return { success: false, articleMatched: true, loading, waitingSelected: true, selectedPosition: selectionMode };
                }
                const btn = findAnimateButtonForImage(article, selectedImage);
                if (btn && !btn.hasAttribute('data-autometacopy-clicked')) {
                    btn.setAttribute('data-autometacopy-clicked', 'true');
                    btn.click();
                    return { success: false, articleMatched: true, loading: true, animating: true, selectedPosition: selectionMode };
                }
            }
        } else {
            const selectedImage = pickBySelection(Array.from(article.querySelectorAll('img'))
                .filter(img => img.naturalWidth >= 100 && img.naturalHeight >= 100));
            if (selectedImage) {
                const img = selectedImage;
                const src = img.src || '';
                if (!src || img.naturalWidth < 100 || img.naturalHeight < 100 || loading) return { success: false, articleMatched: true, loading, waitingSelected: true, selectedPosition: selectionMode };
                const signature = signatureFor('image', src, promptText);
                if (baseline.has(signature)) return { success: false, articleMatched: true, loading, waitingSelected: true, selectedPosition: selectionMode };
                img.setAttribute('data-autometacopy-seen', 'true');
                return { success: true, articleMatched: true, loading, mediaUrl: src, signature, selectedPosition: selectionMode };
            }
        }
        return { success: false, articleMatched: true, loading, waitingSelected: true, selectedPosition: selectionMode };
    }
    return findGlobalMediaForPrompt();
}

async function injectScript(func, args = []) {
    // Find Meta AI tab by URL (works even if tab is not focused/active)
    const tabs = await chrome.tabs.query({ url: 'https://www.meta.ai/*' });
    const tab = tabs?.[0];
    if (!tab) {
        // Fallback: try active tab
        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!activeTab) return false;
        try {
            const results = await chrome.scripting.executeScript({
                target: { tabId: activeTab.id },
                func: func,
                args: [...args],
                world: 'MAIN'
            });
            return results?.[0]?.result;
        } catch (e) { return false; }
    }
    try {
        const results = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: func,
            args: [...args],
            world: 'MAIN'
        });
        return results?.[0]?.result;
    } catch (e) { return false; }
}
