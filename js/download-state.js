// download-state.js — Lean state module (Gallery removed)
export const SESSION_KEY = 'autoMetaCopy_downloadSession';
export const DONE_KEY = 'autoMetaCopy_downloadedOutputs';
export const DETECTED_KEY = 'autoMetaCopy_detectedOutputs';
export const HISTORY_KEY = 'autoMetaCopy_sessionHistory';
export const REFRESH_FLAG_KEY = 'autoMetaCopy_intentionalRefresh';
export const FINAL_REFRESH_FLAG_KEY = 'autoMetaCopy_finalRefreshFlag'; // Set when extension triggers final page refresh after completion
export const GATE_KEY = 'autoMetaCopy_promptGate';             // Unified brain gate state
export const GATE_EVENT_KEY = 'autoMetaCopy_gateEvent';         // Real-time gate event channel
const MAX_HISTORY = 30;

function stripPreviewPayload(item = {}) {
    const { preview, thumbnail, ...rest } = item || {};
    return {
        ...rest,
        preview: '',
        thumbnail: '',
        thumbnailLocked: false,
        thumbnailLockedAt: null
    };
}

function stripSessionPreviewPayload(session = {}) {
    return {
        ...session,
        prompts: (session.prompts || []).map(prompt => ({
            ...prompt,
            outputs: (prompt.outputs || []).map(stripPreviewPayload)
        }))
    };
}

export async function archiveSessionToHistory(session) {
    if (!session?.id || !session?.prompts?.length) return;
    const leanSession = stripSessionPreviewPayload(session);
    const data = await chrome.storage.local.get({ [HISTORY_KEY]: [] });
    const history = (data[HISTORY_KEY] || []).filter(h => h.id !== leanSession.id);
    history.unshift({
        id: leanSession.id,
        startedAt: leanSession.startedAt || 0,
        endedAt: Date.now(),
        folder: leanSession.folder || leanSession.downloadFolder || 'meta-videos',
        settings: {
            ...(leanSession.settings || {}),
            downloadFolder: leanSession.folder || leanSession.downloadFolder || leanSession.settings?.downloadFolder || 'meta-videos',
            imageGenerationSelect: leanSession.imageSelect || leanSession.settings?.imageGenerationSelect || 'auto',
            videoGenerationSelect: leanSession.videoSelect || leanSession.settings?.videoGenerationSelect || 'auto',
            secondaryVideoGenerationSelect: leanSession.secondaryVideoSelect || leanSession.settings?.secondaryVideoGenerationSelect || 'auto',
            autoDownloadMode: leanSession.autoDownloadMode || leanSession.settings?.autoDownloadMode || 'afterReady',
            customSelections: leanSession.customSelections || leanSession.settings?.customSelections || {}
        },
        aiRetryState: leanSession.aiRetryState || null,
        prompts: leanSession.prompts || [],
        stats: {
            total: leanSession.prompts?.length || 0,
            detected: (leanSession.prompts || []).reduce((s, p) => s + (p.outputs?.length || 0), 0),
            downloaded: (leanSession.prompts || []).reduce((s, p) => s + (p.outputs || []).filter(o => o.downloaded).length, 0)
        }
    });
    await chrome.storage.local.set({ [HISTORY_KEY]: history.slice(0, MAX_HISTORY) });
}

export async function getSessionHistory() {
    const data = await chrome.storage.local.get({ [HISTORY_KEY]: [] });
    return data[HISTORY_KEY] || [];
}

export const DOWNLOAD_DEFAULTS = {
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
    concurrentDownloads: 1,          // 1-4 parallel downloads at once
    preserveSessionAfterRefresh: true,
    // Auto-refresh after each prompt
    autoRefreshAfterPrompt: false,
    autoRefreshDelay: 20,           // seconds, minimum 10
    // Detection timeout → retry queue
    detectTimeoutMinutes: 2,        // minutes before marking prompt as timed-out
    retryOnTimeout: true,
    maxRetryAttempts: 3,
    retryRecentGraceSec: 60,
    retryOldPromptWindow: 6,
    retryPartialPrompts: true,
    aiRetryAttemptRetryEnabled: false,
    aiRetryAttemptRetries: 1,
    thumbnailMode: 'hover',
    // ── Unified Brain Gate Settings ─────────────────────────────────────────────
    // What to do when the SELECTED slot is not detected after maxPerPromptRetries:
    //   'retry'         — re-submit same prompt up to maxPerPromptRetries times, then skip
    //   'use_other_slot'— after retries, download whichever slot WAS detected
    slotNotDetectedBehavior: 'retry',
    // Max times to re-submit the SAME prompt before giving up (per-prompt, not global)
    maxPerPromptRetries: 3,
    // Min/max seconds to wait per attempt for the selected slot before retrying
    perAttemptMinTimeoutSec: 60,
    perAttemptTimeoutSec: 60,
    // Whether to capture a compressed first-frame thumbnail immediately on detection
    captureFirstFrame: false
};

export function normalizeAutoDownloadMode(mode) {
    if (mode === 'afterAllReadyZip' || mode === 'afterAllComplete-zip') return 'afterAllReadyZip';
    if (mode === 'afterReady' || mode === 'perPromptReady' || mode === 'afterAllComplete' || mode === 'manual') return 'afterReady';
    return DOWNLOAD_DEFAULTS.autoDownloadMode;
}

export function clean(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
}

export function normalizeSrc(src) {
    return (src || '').split('#')[0].split('?')[0];
}

export function safePathPart(text) {
    return clean(text).replace(/[<>:"|?*\x00-\x1F]/g, '').slice(0, 80) || 'output';
}

export function promptOutputType(promptRecord) {
    return promptRecord?.mode === 'prompt-to-image' ? 'image' : 'video';
}

export function promptExpectedCount(promptRecord) {
    return Number(promptRecord?.expected) || (promptRecord?.mode === 'image-to-video' ? 1 : 4);
}

export function outputSignature(sessionId, item) {
    return `${sessionId || 'session'}|${Number(item.promptIndex)}|${item.type}|${Number(item.position || 1)}|${normalizeSrc(item.src)}`;
}

export function downloadedKey(item, sessionId = '') {
    if (!item) return '';
    return item.signature || outputSignature(sessionId, item);
}

export function normalizeOutput(sessionId, item, promptRecord = {}) {
    const normalized = {
        ...item,
        preview: '',
        thumbnail: '',
        promptIndex: Number.isInteger(Number(item.promptIndex)) ? Number(item.promptIndex) : Number(promptRecord.index || 0),
        position: Number(item.position || 1),
        prompt: item.prompt || promptRecord.prompt || '',
        detectedAt: item.detectedAt || Date.now(),
        downloaded: !!item.downloaded,
        selected: item.selected !== false,
        thumbnailLocked: false,
        thumbnailLockedAt: null,
        outputLocked: !!item.outputLocked,
        outputLockedAt: item.outputLockedAt || null,
        managerPublished: !!item.managerPublished,
        managerPublishedAt: item.managerPublishedAt || null
    };
    normalized.signature = item.signature || outputSignature(sessionId, normalized);
    return normalized;
}

export function ensureSessionShape(rawSession) {
    if (!rawSession) return null;
    const session = {
        ...DOWNLOAD_DEFAULTS,
        ...rawSession,
        baselineSignatures: Array.isArray(rawSession.baselineSignatures) ? rawSession.baselineSignatures : [],
        prompts: Array.isArray(rawSession.prompts) ? rawSession.prompts : []
    };
    session.prompts = session.prompts.map((prompt, index) => {
        const shaped = {
            index: Number.isInteger(Number(prompt.index)) ? Number(prompt.index) : index,
            prompt: prompt.prompt || prompt.text || '',
            mode: prompt.mode || session.mode || 'prompt-to-video',
            expected: promptExpectedCount({ ...prompt, mode: prompt.mode || session.mode }),
            status: prompt.status || 'queued',
            submittedAt: prompt.submittedAt || null,
            detectedAt: prompt.detectedAt || null,
            downloadedAt: prompt.downloadedAt || null,
            retryCount: Number(prompt.retryCount || 0),
            retryReason: prompt.retryReason || '',
            lastRetryAt: prompt.lastRetryAt || null,
            selectedPosition: prompt.selectedPosition || null,
            secondaryPosition: prompt.secondaryPosition || null,
            resolvedPosition: prompt.resolvedPosition || null,
            resolvedReason: prompt.resolvedReason || '',
            outputs: []
        };
        shaped.outputs = Array.isArray(prompt.outputs)
            ? prompt.outputs.map(item => normalizeOutput(session.id, item, shaped)).filter(item => item.src && item.type)
            : [];
        return shaped;
    });
    return session;
}

export function flattenOutputs(session) {
    const shaped = ensureSessionShape(session);
    if (!shaped) return [];
    return shaped.prompts.flatMap(prompt => prompt.outputs.map(item => normalizeOutput(shaped.id, item, prompt)))
        .sort((a, b) => a.promptIndex - b.promptIndex || a.position - b.position);
}

export async function getDownloadState() {
    const data = await chrome.storage.local.get({
        ...DOWNLOAD_DEFAULTS,
        [SESSION_KEY]: null,
        [DONE_KEY]: []
    });
    const session = ensureSessionShape(data[SESSION_KEY]);
    // Build settings from ALL DOWNLOAD_DEFAULTS keys dynamically
    // (previously hardcoded subset caused autoRefreshAfterPrompt etc. to be undefined)
    const settings = {};
    Object.keys(DOWNLOAD_DEFAULTS).forEach(key => {
        settings[key] = data[key] !== undefined ? data[key] : DOWNLOAD_DEFAULTS[key];
    });
    settings.autoDownloadMode = normalizeAutoDownloadMode(settings.autoDownloadMode);
    // Force boolean for critical boolean fields (handles both string and boolean storage)
    settings.autoDownload = data.autoDownload !== false && data.autoDownload !== 'false';
    settings.autoArchiveSession = data.autoArchiveSession === true || data.autoArchiveSession === 'true';
    settings.preserveSessionAfterRefresh = data.preserveSessionAfterRefresh !== false && data.preserveSessionAfterRefresh !== 'false';
    settings.autoRefreshAfterPrompt = data.autoRefreshAfterPrompt === true || data.autoRefreshAfterPrompt === 'true';
    settings.retryOnTimeout = data.retryOnTimeout !== false && data.retryOnTimeout !== 'false';
    settings.retryPartialPrompts = data.retryPartialPrompts !== false && data.retryPartialPrompts !== 'false';
    settings.maxRetryAttempts = Number(data.maxRetryAttempts ?? DOWNLOAD_DEFAULTS.maxRetryAttempts) || DOWNLOAD_DEFAULTS.maxRetryAttempts;
    settings.autoRefreshDelay = Math.max(10, Math.min(120, Number(data.autoRefreshDelay ?? DOWNLOAD_DEFAULTS.autoRefreshDelay) || DOWNLOAD_DEFAULTS.autoRefreshDelay));
    settings.retryRecentGraceSec = Number(data.retryRecentGraceSec ?? DOWNLOAD_DEFAULTS.retryRecentGraceSec) || DOWNLOAD_DEFAULTS.retryRecentGraceSec;
    settings.retryOldPromptWindow = Number(data.retryOldPromptWindow ?? DOWNLOAD_DEFAULTS.retryOldPromptWindow) || DOWNLOAD_DEFAULTS.retryOldPromptWindow;
    settings.concurrentDownloads = Math.max(1, Math.min(4, Number(data.concurrentDownloads ?? DOWNLOAD_DEFAULTS.concurrentDownloads) || 1));
    // Fix: 0 is falsy in JS, so `|| default` would override 0. Use nullish-safe pattern.
    const rawPerPrompt = data.maxPerPromptRetries;
    settings.maxPerPromptRetries = (rawPerPrompt !== undefined && rawPerPrompt !== null && rawPerPrompt !== '')
        ? Math.max(0, Number(rawPerPrompt))
        : DOWNLOAD_DEFAULTS.maxPerPromptRetries;
    settings.slotNotDetectedBehavior = ['retry', 'use_other_slot'].includes(data.slotNotDetectedBehavior) ? data.slotNotDetectedBehavior : DOWNLOAD_DEFAULTS.slotNotDetectedBehavior;
    settings.perAttemptMinTimeoutSec = Math.max(10, Number(data.perAttemptMinTimeoutSec ?? DOWNLOAD_DEFAULTS.perAttemptMinTimeoutSec) || DOWNLOAD_DEFAULTS.perAttemptMinTimeoutSec);
    settings.perAttemptTimeoutSec    = Math.max(settings.perAttemptMinTimeoutSec, Number(data.perAttemptTimeoutSec ?? DOWNLOAD_DEFAULTS.perAttemptTimeoutSec) || DOWNLOAD_DEFAULTS.perAttemptTimeoutSec);
    if (settings.perAttemptMinTimeoutSec > settings.perAttemptTimeoutSec) {
        settings.perAttemptMinTimeoutSec = settings.perAttemptTimeoutSec;
    }
    settings.captureFirstFrame = data.captureFirstFrame === true || data.captureFirstFrame === 'true';
    return {
        session,
        downloaded: new Set(Array.isArray(data[DONE_KEY]) ? data[DONE_KEY] : []),
        settings
    };
}


export async function saveDownloadSettings(settings = {}) {
    const allowed = {};
    Object.keys(DOWNLOAD_DEFAULTS).forEach(key => {
        if (settings[key] !== undefined) allowed[key] = settings[key];
    });
    if (allowed.autoDownloadMode !== undefined) {
        allowed.autoDownloadMode = normalizeAutoDownloadMode(allowed.autoDownloadMode);
    }
    if (allowed.autoRefreshDelay !== undefined) {
        allowed.autoRefreshDelay = Math.max(10, Math.min(120, Number(allowed.autoRefreshDelay) || DOWNLOAD_DEFAULTS.autoRefreshDelay));
    }
    if (allowed.perAttemptTimeoutSec !== undefined) {
        allowed.perAttemptTimeoutSec = Math.max(10, Math.min(300, Number(allowed.perAttemptTimeoutSec) || DOWNLOAD_DEFAULTS.perAttemptTimeoutSec));
    }
    if (allowed.perAttemptMinTimeoutSec !== undefined) {
        allowed.perAttemptMinTimeoutSec = Math.max(10, Math.min(300, Number(allowed.perAttemptMinTimeoutSec) || DOWNLOAD_DEFAULTS.perAttemptMinTimeoutSec));
    }
    if (allowed.perAttemptMinTimeoutSec !== undefined && allowed.perAttemptTimeoutSec !== undefined && allowed.perAttemptMinTimeoutSec > allowed.perAttemptTimeoutSec) {
        allowed.perAttemptTimeoutSec = allowed.perAttemptMinTimeoutSec;
    }
    await chrome.storage.local.set(allowed);
}

// Debounced session save — avoids thrashing storage on rapid updates
let _saveTimer = null;
let _pendingSession = null;
export function queueSessionSave(session) {
    _pendingSession = session;
    if (_saveTimer) return;
    _saveTimer = setTimeout(async () => {
        _saveTimer = null;
        if (_pendingSession) {
            await chrome.storage.local.set({ [SESSION_KEY]: ensureSessionShape(_pendingSession) });
            _pendingSession = null;
        }
    }, 800);
}

export async function saveSession(session) {
    await chrome.storage.local.set({ [SESSION_KEY]: ensureSessionShape(session) });
}

export function getSelectedPosition(type, settings, promptRecord) {
    const custom = settings?.customSelections?.[promptRecord?.index];
    if (custom && custom !== 'auto') return Number(custom);
    const stored = type === 'image' ? settings.imageGenerationSelect : settings.videoGenerationSelect;
    if (stored && stored !== 'auto') return Number(stored);
    return promptExpectedCount(promptRecord);
}

export function getSecondaryPosition(type, settings, promptRecord) {
    if (type !== 'video') return getSelectedPosition(type, settings, promptRecord);
    const stored = settings.secondaryVideoGenerationSelect;
    if (stored && stored !== 'auto') return Number(stored);
    return promptExpectedCount(promptRecord);
}

export function getResolvedPosition(type, settings, promptRecord) {
    if (promptRecord?.resolvedPosition) return Number(promptRecord.resolvedPosition);
    return getSelectedPosition(type, settings, promptRecord);
}

export function getPreferredOutput(promptRecord, settings) {
    const type = promptOutputType(promptRecord);
    const outputs = promptRecord?.outputs || [];
    const resolvedPosition = getResolvedPosition(type, settings, promptRecord);
    let item = outputs.find(o => Number(o.position) === Number(resolvedPosition) && o.src);
    if (item) return item;
    const primaryPosition = getSelectedPosition(type, settings, promptRecord);
    item = outputs.find(o => Number(o.position) === Number(primaryPosition) && o.src);
    if (item) return item;
    const secondaryPosition = getSecondaryPosition(type, settings, promptRecord);
    if (Number(secondaryPosition) !== Number(primaryPosition)) {
        item = outputs.find(o => Number(o.position) === Number(secondaryPosition) && o.src);
        if (item) return item;
    }
    return null;
}

export function getSessionCompletionState(session, settings = DOWNLOAD_DEFAULTS) {
    const shaped = ensureSessionShape(session);
    if (!shaped) {
        return {
            complete: false,
            selectedComplete: false,
            totalPrompts: 0,
            detectedPrompts: 0,
            readyPrompts: 0,
            failedPrompts: 0,
            missingSelectedPrompts: 0,
            detectedOutputs: 0,
            selectedOutputs: 0,
            missingOutputs: 0,
            slotMissingOutputs: 0,
            downloadedOutputs: 0,
            missing: []
        };
    }
    let detectedOutputs = 0;
    let selectedOutputs = 0;
    let downloadedOutputs = 0;
    let detectedPrompts = 0;
    let readyPrompts = 0;
    let failedPrompts = 0;
    let missingSelectedPrompts = 0;
    const missing = [];
    shaped.prompts.forEach(prompt => {
        const expected = promptExpectedCount(prompt);
        const type = promptOutputType(prompt);
        const selectedPosition = getResolvedPosition(type, settings, prompt);
        const outputs = prompt.outputs || [];
        detectedOutputs += outputs.filter(item => item.src).length;
        downloadedOutputs += outputs.filter(item => item.downloaded).length;
        if (outputs.some(item => item.src)) detectedPrompts++;
        const selected = outputs.find(item => Number(item.position) === selectedPosition && item.src) || getPreferredOutput(prompt, settings);
        if (selected) {
            selectedOutputs++;
            readyPrompts++;
        } else if (['failed', 'timeout', 'unrecoverable'].includes(prompt.status)) {
            failedPrompts++;
        } else {
            missingSelectedPrompts++;
        }
        for (let position = 1; position <= expected; position++) {
            if (!outputs.some(item => Number(item.position) === position && item.src)) {
                missing.push({ promptIndex: prompt.index, position, type });
            }
        }
    });
    // selectedComplete: true when the 1 selected slot per prompt is ready
    // Used by auto-download to trigger even if non-selected slots are missing
    const selectedComplete = shaped.prompts.length > 0 && shaped.prompts.every(p => {
        if (['failed', 'timeout', 'unrecoverable'].includes(p.status)) return true;
        return !!getPreferredOutput(p, settings);
    });
    return {
        complete: missing.length === 0,
        selectedComplete,
        totalPrompts: shaped.prompts.length,
        detectedPrompts,
        readyPrompts,
        failedPrompts,
        missingSelectedPrompts,
        detectedOutputs,
        selectedOutputs,
        downloadedOutputs,
        missingOutputs: missingSelectedPrompts,
        slotMissingOutputs: missing.length,
        missing
    };
}
