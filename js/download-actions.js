// download-actions.js — Gallery-free download queue
import {
    DONE_KEY, SESSION_KEY,
    clean, flattenOutputs, getDownloadState,
    getPreferredOutput, getSessionCompletionState,
    downloadedKey as stateDownloadedKey,
    normalizeOutput, safePathPart, saveSession
} from './download-state.js';

// ─── Timeout guard: prevents queueRunning getting permanently stuck ───────────
let queueRunning = false;
let queueRunningAt = 0;
const IN_PROGRESS_KEY = 'autoMetaCopy_downloadingOutputs';
const MANAGER_EVENTS_KEY_DL = 'autoMetaCopy_managerEvents';
const DOWNLOAD_LOCK_TTL = 5 * 60 * 1000;
const ZIP_PREPARE_LOCK_TTL = 30 * 60 * 1000;

// ─── Speed log helper — pushes events to Active Log in sidepanel ──────────────
async function pushDownloadLog(message, level = 'info', detail = {}) {
    try {
        const data = await chrome.storage.local.get({ [MANAGER_EVENTS_KEY_DL]: [] });
        const events = Array.isArray(data[MANAGER_EVENTS_KEY_DL]) ? data[MANAGER_EVENTS_KEY_DL] : [];
        events.push({
            id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
            at: Date.now(),
            source: 'download-manager',
            level,
            message,
            detail
        });
        await chrome.storage.local.set({ [MANAGER_EVENTS_KEY_DL]: events.slice(-120) });
    } catch (e) { /* non-critical */ }
}

// ─── Format bytes as human-readable size ─────────────────────────────────────
function fmtBytes(bytes) {
    if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
    return bytes + ' B';
}

function fmtSpeed(bytesPerSec) {
    if (bytesPerSec >= 1024 * 1024) return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
    if (bytesPerSec >= 1024) return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
    return bytesPerSec + ' B/s';
}

export function filenameFor(item, folder) {
    const safeFolder = safePathPart(folder || 'meta-videos');
    const ext = item.type === 'video' ? 'mp4' : 'jpg';
    return `${safeFolder}/prompt ${Number(item.promptIndex) + 1} - ${item.type} ${Number(item.position || 1)}.${ext}`;
}

function downloadedKey(item) {
    return stateDownloadedKey(item);
}

async function acquireDownloadSlot(item) {
    const key = downloadedKey(item);
    const owner = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const now = Date.now();
    const data = await chrome.storage.local.get({ [DONE_KEY]: [], [IN_PROGRESS_KEY]: {} });
    const done = new Set(Array.isArray(data[DONE_KEY]) ? data[DONE_KEY] : []);
    if (item.downloaded || done.has(key)) return { ok: false, skipped: true, key, reason: 'already downloaded' };

    const active = data[IN_PROGRESS_KEY] && typeof data[IN_PROGRESS_KEY] === 'object' ? data[IN_PROGRESS_KEY] : {};
    Object.keys(active).forEach(k => {
        if (!active[k]?.at || now - Number(active[k].at) > DOWNLOAD_LOCK_TTL) delete active[k];
    });
    if (active[key]) return { ok: false, skipped: true, key, reason: 'download already in progress' };

    active[key] = { owner, at: now };
    await chrome.storage.local.set({ [IN_PROGRESS_KEY]: active });
    const verify = await chrome.storage.local.get({ [IN_PROGRESS_KEY]: {} });
    if (verify[IN_PROGRESS_KEY]?.[key]?.owner !== owner) return { ok: false, skipped: true, key, reason: 'download lock lost' };
    return { ok: true, key, owner };
}

async function releaseDownloadSlot(lock) {
    if (!lock?.key || !lock.owner) return;
    const data = await chrome.storage.local.get({ [IN_PROGRESS_KEY]: {} });
    const active = data[IN_PROGRESS_KEY] && typeof data[IN_PROGRESS_KEY] === 'object' ? data[IN_PROGRESS_KEY] : {};
    if (active[lock.key]?.owner === lock.owner) {
        delete active[lock.key];
        await chrome.storage.local.set({ [IN_PROGRESS_KEY]: active });
    }
}

async function markOutputDownloaded(targetItem, filename) {
    const { session } = await getDownloadState();
    if (!session) return;
    session.prompts = session.prompts.map(prompt => {
        if (Number(prompt.index) !== Number(targetItem.promptIndex)) return prompt;
        const outputs = (prompt.outputs || []).map(item => {
            const n = normalizeOutput(session.id, item, prompt);
            if ((n.signature && n.signature === targetItem.signature) || n.src === targetItem.src) {
                return { ...n, downloaded: true, downloadedAt: Date.now(), queueStatus: 'downloaded', filename };
            }
            return n;
        });
        const allDone = outputs.length > 0 && outputs.every(i => i.downloaded);
        return { ...prompt, outputs, status: allDone ? 'downloaded' : prompt.status, downloadedAt: allDone ? Date.now() : prompt.downloadedAt };
    });
    await saveSession(session);

    const data = await chrome.storage.local.get(DONE_KEY);
    const downloaded = new Set(Array.isArray(data[DONE_KEY]) ? data[DONE_KEY] : []);
    downloaded.add(downloadedKey(targetItem));
    await chrome.storage.local.set({ [DONE_KEY]: Array.from(downloaded) });
}

export async function downloadItem(item, folder) {
    if (!item?.src) return { success: false, error: 'missing src' };
    const downloadLock = await acquireDownloadSlot(item);
    if (!downloadLock.ok) {
        console.log('[Runflow AutoDownload] Skipping:', downloadLock.reason, '|', item.src.slice(0, 60));
        return { success: true, skipped: true, reason: downloadLock.reason };
    }
    const filename = filenameFor(item, folder);
    const shortName = filename.split('/').pop().slice(0, 40);
    console.log('[Runflow AutoDownload] Attempting:', filename.slice(0, 70), '|', item.src.slice(0, 60));

    // ── Log download start to Active Log ──────────────────────────────────────
    const promptNum = Number(item.promptIndex ?? 0) + 1;
    const slotNum = Number(item.position || 1);
    await pushDownloadLog(
        `⬇ Downloading P${promptNum} slot ${slotNum} — ${shortName}`,
        'info',
        { promptIndex: item.promptIndex, position: slotNum }
    );

    const startAt = Date.now();

    // ── Method 1: Direct chrome.downloads API ──────────────────────────────────
    let result = await new Promise(resolve => {
        try {
            chrome.downloads.download(
                { url: item.src, filename, conflictAction: 'uniquify' },
                (downloadId) => {
                    if (chrome.runtime.lastError) {
                        resolve({ success: false, error: chrome.runtime.lastError.message });
                    } else if (downloadId === undefined || downloadId === null) {
                        resolve({ success: false, error: 'downloadId undefined' });
                    } else {
                        console.log('[Runflow AutoDownload] ✅ Direct download id:', downloadId);
                        resolve({ success: true, downloadId });
                    }
                }
            );
        } catch (e) {
            resolve({ success: false, error: 'api_unavailable' });
        }
    });

    // ── Method 2: Via background service worker (fallback for content scripts) ──
    if (!result.success) {
        console.log('[Runflow AutoDownload] Direct failed (' + result.error + '), trying sendMessage');
        try {
            const msg = await chrome.runtime.sendMessage({ type: 'downloadFile', url: item.src, filename });
            if (msg?.success) {
                result = msg;
                console.log('[Runflow AutoDownload] ✅ sendMessage download ok');
            } else {
                console.warn('[Runflow AutoDownload] sendMessage returned failure:', msg?.error);
            }
        } catch (e) {
            console.warn('[Runflow AutoDownload] sendMessage threw:', e.message);
        }
    }

    // ── Speed tracking via chrome.downloads.onChanged ────────────────────────
    // Watches the download in real-time and logs speed + size when it completes.
    if (result?.success && result.downloadId != null) {
        const dlId = result.downloadId;
        await new Promise(resolve => {
            let lastBytes = 0;
            let lastAt = Date.now();
            let speedSamples = [];
            let logTimer = null;
            let pollTimer = null;
            let settled = false;

            const cleanup = () => {
                if (settled) return;
                settled = true;
                try { chrome.downloads.onChanged.removeListener(onChanged); } catch (e) {}
                if (logTimer) clearInterval(logTimer);
                if (pollTimer) clearInterval(pollTimer);
                resolve();
            };

            const finishComplete = () => {
                const elapsed = (Date.now() - startAt) / 1000;
                const avgSpeed = speedSamples.length > 0
                    ? speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length
                    : (lastBytes > 0 ? lastBytes / Math.max(0.5, elapsed) : 0);
                const sizeStr = lastBytes > 0 ? ` (${fmtBytes(lastBytes)})` : '';
                const speedStr = avgSpeed > 100 ? ` @ ${fmtSpeed(avgSpeed)}` : '';
                const timeStr = elapsed > 0.5 ? ` in ${elapsed.toFixed(1)}s` : '';
                pushDownloadLog(
                    `âœ… P${promptNum} slot ${slotNum} downloaded${sizeStr}${timeStr}${speedStr}`,
                    'success',
                    { promptIndex: item.promptIndex, position: slotNum, bytes: lastBytes, speedBps: Math.round(avgSpeed), elapsedSec: elapsed }
                ).catch(() => {});
                cleanup();
            };

            const finishInterrupted = () => {
                pushDownloadLog(
                    `âŒ P${promptNum} slot ${slotNum} download interrupted`,
                    'error',
                    { promptIndex: item.promptIndex, position: slotNum }
                ).catch(() => {});
                cleanup();
            };

            const onChanged = (delta) => {
                if (delta.id !== dlId) return;

                // Track speed from bytesReceived increments
                if (delta.bytesReceived != null) {
                    const now = Date.now();
                    const dt = (now - lastAt) / 1000; // seconds
                    const db = delta.bytesReceived.current - lastBytes;
                    if (dt > 0.2 && db > 0) {
                        speedSamples.push(db / dt);
                        if (speedSamples.length > 5) speedSamples.shift();
                        lastBytes = delta.bytesReceived.current;
                        lastAt = now;
                    }
                }

                // Download finished (state changed to complete or interrupted)
                if (delta.state) {
                    const newState = delta.state.current;
                    if (newState === 'complete') {
                        const elapsed = (Date.now() - startAt) / 1000;
                        const avgSpeed = speedSamples.length > 0
                            ? speedSamples.reduce((a, b) => a + b, 0) / speedSamples.length
                            : (lastBytes > 0 ? lastBytes / Math.max(0.5, elapsed) : 0);
                        const sizeStr = lastBytes > 0 ? ` (${fmtBytes(lastBytes)})` : '';
                        const speedStr = avgSpeed > 100 ? ` @ ${fmtSpeed(avgSpeed)}` : '';
                        const timeStr = elapsed > 0.5 ? ` in ${elapsed.toFixed(1)}s` : '';
                        pushDownloadLog(
                            `✅ P${promptNum} slot ${slotNum} downloaded${sizeStr}${timeStr}${speedStr}`,
                            'success',
                            { promptIndex: item.promptIndex, position: slotNum, bytes: lastBytes, speedBps: Math.round(avgSpeed), elapsedSec: elapsed }
                        ).catch(() => {});
                        cleanup();
                    } else if (newState === 'interrupted') {
                        pushDownloadLog(
                            `❌ P${promptNum} slot ${slotNum} download interrupted`,
                            'error',
                            { promptIndex: item.promptIndex, position: slotNum }
                        ).catch(() => {});
                        cleanup();
                    }
                }
            };

            const pollDownloadState = () => {
                try {
                    chrome.downloads.search({ id: dlId }, items => {
                        const dl = items?.[0];
                        if (!dl || settled) return;
                        if (Number(dl.bytesReceived) > lastBytes) lastBytes = Number(dl.bytesReceived);
                        if (dl.state === 'complete') finishComplete();
                        else if (dl.state === 'interrupted') finishInterrupted();
                    });
                } catch (e) {
                    cleanup();
                }
            };

            try {
                chrome.downloads.onChanged.addListener(onChanged);
                pollDownloadState();
                pollTimer = setInterval(pollDownloadState, 700);
                // Safety timeout: don't wait more than 10 min for a single download
                setTimeout(() => cleanup(), 10 * 60 * 1000);
            } catch (e) {
                resolve();
            }
        });
    }

    if (result?.success) {
        try {
            await markOutputDownloaded(item, filename);
        } catch (e) {
            await releaseDownloadSlot(downloadLock);
            throw e;
        }
        console.log('[Runflow AutoDownload] ✅ Marked downloaded:', filename.slice(0, 60));
    } else {
        const errMsg = result?.error || 'all_methods_failed';
        console.error('[Runflow AutoDownload] ❌ ALL methods failed for:', filename.slice(0, 60), '|', errMsg);
        await pushDownloadLog(
            `❌ P${promptNum} slot ${slotNum} failed — ${errMsg}`,
            'error',
            { promptIndex: item.promptIndex, position: slotNum, error: errMsg }
        );
    }
    await releaseDownloadSlot(downloadLock);
    return result || { success: false, error: 'all_methods_failed' };
}

export function selectedOutputsFromSession(session, settings) {
    if (!session) return [];
    const selected = [];
    session.prompts.forEach(prompt => {
        const item = getPreferredOutput(prompt, settings);
        if (item) selected.push(item);
    });
    return selected;
}

export async function downloadSelectedOutputs() {
    const { session, settings, downloaded } = await getDownloadState();
    const items = selectedOutputsFromSession(session, settings);
    for (const item of items) {
        if (downloaded.has(downloadedKey(item)) || item.downloaded) continue;
        await downloadItem(item, settings.downloadFolder || session.folder);
    }
}

async function markZipItemsDownloaded(items = [], filename = '') {
    const { session } = await getDownloadState();
    if (!session || !Array.isArray(items) || !items.length) return;
    const keys = new Set(items.map(downloadedKey));
    session.prompts = (session.prompts || []).map(prompt => {
        const outputs = (prompt.outputs || []).map(item => {
            const n = normalizeOutput(session.id, item, prompt);
            if (keys.has(downloadedKey(n))) {
                return { ...n, downloaded: true, downloadedAt: Date.now(), queueStatus: 'downloaded', filename };
            }
            return n;
        });
        const selectedDone = outputs.some(item => item.downloaded);
        return { ...prompt, outputs, status: selectedDone ? 'downloaded' : prompt.status, downloadedAt: selectedDone ? Date.now() : prompt.downloadedAt };
    });
    await saveSession(session);

    const data = await chrome.storage.local.get(DONE_KEY);
    const downloaded = new Set(Array.isArray(data[DONE_KEY]) ? data[DONE_KEY] : []);
    items.forEach(item => downloaded.add(downloadedKey(item)));
    await chrome.storage.local.set({ [DONE_KEY]: Array.from(downloaded) });
}

export async function downloadAllReadyOutputs() {
    const { session, settings, downloaded } = await getDownloadState();
    const items = flattenOutputs(session);
    for (const item of items) {
        if (downloaded.has(downloadedKey(item)) || item.downloaded) continue;
        await downloadItem(item, settings.downloadFolder || session.folder);
    }
}

export async function startQueuedDownloads() {
    // ── SYNC guard (before any await!) — prevents concurrent double triggers ──
    if (queueRunning && (Date.now() - queueRunningAt) < 60000) {
        console.log('[Runflow AutoDownload] Queue busy, skipping');
        return;
    }

    // ── CROSS-CONTEXT lock via storage — prevents sidepanel + floating manager
    //    from both triggering downloads simultaneously (they're separate JS contexts)
    const lockData = await chrome.storage.local.get('autoMetaCopy_downloadLock');
    const lock = lockData['autoMetaCopy_downloadLock'];
    if (lock && (Date.now() - lock.at) < 30000) {
        console.log('[Runflow AutoDownload] Cross-context lock active, skipping');
        return;
    }
    await chrome.storage.local.set({ autoMetaCopy_downloadLock: { at: Date.now() } });

    // Lock immediately (synchronous — before first await)
    queueRunning = true;
    queueRunningAt = Date.now();

    try {
        const state = await getDownloadState();
        const session = state.session;
        const downloaded = state.downloaded;
        const settings = { ...state.settings, ...(session || {}), ...(session?.settings || {}) };
        settings.autoDownloadMode = settings.autoDownloadMode === 'afterAllReadyZip' ? 'afterAllReadyZip' : 'afterReady';
        const mode = settings.autoDownloadMode;
        console.log('[Runflow AutoDownload] startQueuedDownloads → active:', session?.active,
            '| autoDownload:', settings.autoDownload, '| mode:', mode,
            '| prompts:', session?.prompts?.length);

        if (!session?.active) { console.log('[Runflow AutoDownload] ⛔ session not active'); return; }
        if (session.downloadsDone) { console.log('[Runflow AutoDownload] ⛔ downloads already done'); return; }
        if (!settings.autoDownload) { console.log('[Runflow AutoDownload] ⛔ autoDownload OFF'); return; }
        if (session.downloadStartRequested !== true) {
            console.log('[Runflow AutoDownload] waiting for main extension download signal');
            return;
        }
        if (mode === 'afterAllReadyZip') {
            const zipStartedAt = Number(session.zipDownloadStartedAt || session.zipPreparingAt || 0);
            if (session.zipPreparing && zipStartedAt && (Date.now() - zipStartedAt) < ZIP_PREPARE_LOCK_TTL) {
                console.log('[Runflow AutoDownload] ZIP already preparing for this session');
                return;
            }
            if (session.zipDownloadStartedAt && (Date.now() - Number(session.zipDownloadStartedAt)) < ZIP_PREPARE_LOCK_TTL) {
                console.log('[Runflow AutoDownload] ZIP already started for this session');
                return;
            }
        }
        const completion = getSessionCompletionState(session, settings);
        const selectedReady = completion.selectedComplete || completion.complete;
        console.log('[Runflow AutoDownload] completion → selectedComplete:', completion.selectedComplete,
            '| complete:', completion.complete, '| detected:', completion.detectedOutputs,
            '| missing:', completion.missingOutputs);

        // ZIP mode waits for all selected prompt outputs; individual mode streams as each is ready.
        if (mode === 'afterAllReadyZip' && !selectedReady) {
            console.log('[Runflow AutoDownload] ⛔ afterAllReadyZip mode but not ready yet');
            return;
        }

        // ── ZIP mode: bundle all selected items into one ZIP ─────────────────────
        if (mode === 'afterAllReadyZip') {
            console.log('[Runflow AutoDownload] 📦 ZIP mode — bundling all selected items');
            const zipItems = selectedOutputsFromSession(session, settings).filter(item => item?.src);
            const zipStartedAt = Date.now();
            await saveSession({
                ...session,
                zipPreparing: true,
                zipPreparingAt: zipStartedAt,
                zipDownloadStartedAt: zipStartedAt,
                zipItemCount: zipItems.length,
                zipNeedsManager: false,
                zipStatus: 'Building ZIP...',
                running: false
            });
            const res = await downloadAllAsZip(session, settings, msg => {
                console.log('[Runflow AutoDownload ZIP]', msg);
            }, {
                filenamePrefix: 'selected-videos'
            });
            if (res.success) {
                console.log('[Runflow AutoDownload] ✅ ZIP download started —', res.count, 'files');
            } else {
                console.error('[Runflow AutoDownload] ❌ ZIP failed:', res.error);
            }
            // Signal to core.js that downloads are done
            const freshZip = (await getDownloadState()).session;
            if ((res.success || res.partial) && freshZip) {
                await markZipItemsDownloaded(zipItems, res.filename || 'videos.zip');
                const afterMark = (await getDownloadState()).session || freshZip;
                await saveSession({ ...afterMark, zipPreparing: false, zipNeedsManager: false, zipStatus: 'ZIP download started.', downloadsDone: true, completedAt: Date.now(), running: false });
            } else {
                const failedZip = (await getDownloadState()).session || session;
                await saveSession({ ...failedZip, zipPreparing: false, zipNeedsManager: false, zipStatus: 'ZIP failed.', zipDownloadStartedAt: 0, zipPreparingAt: 0, zipError: res.error || 'ZIP failed' });
            }
            return;
        }

        // ── Individual download mode (afterAllComplete / perPromptReady) ──────────
        const items = selectedOutputsFromSession(session, settings)
            .filter(item => item?.src && !item.downloaded && !downloaded.has(downloadedKey(item)))
            .sort((a, b) => {
                if (Number(a.promptIndex) !== Number(b.promptIndex)) return Number(a.promptIndex) - Number(b.promptIndex);
                return Number(a.position) - Number(b.position);
            });

        console.log('[Runflow AutoDownload] Items to download:', items.length,
            '→', items.map(i => 'P' + (i.promptIndex + 1) + ':pos' + i.position).join(', '));

        if (!items.length) {
            console.log('[Runflow AutoDownload] ⛔ No pending items (all done or none selected)');
            // If isReady, it means everything was already downloaded — signal done
            if (selectedReady) {
                const nowSession = (await getDownloadState()).session;
                if (nowSession && !nowSession.downloadsDone) {
                    await saveSession({ ...nowSession, downloadsDone: true, completedAt: Date.now(), running: false });
                    console.log('[Runflow AutoDownload] ✅ All already done — downloadsDone flag set');
                }
            }
            return;
        }

        // ── Concurrent download queue — respects user's concurrentDownloads setting ──
        // Default: 1 (sequential). User can set 2-4 in settings for faster batch downloads.
        const concurrency = Math.max(1, Math.min(4, Number(settings.concurrentDownloads) || 1));
        const folder = settings.downloadFolder || session.folder;
        console.log(`[Runflow AutoDownload] Starting ${items.length} downloads, concurrency=${concurrency}`);

        if (concurrency === 1) {
            // Sequential mode (original behaviour, safest)
            for (const item of items) {
                await downloadItem(item, folder);
                await new Promise(r => setTimeout(r, 400));
            }
        } else {
            // Concurrent mode: process items in batches of `concurrency`
            for (let i = 0; i < items.length; i += concurrency) {
                const batch = items.slice(i, i + concurrency);
                console.log(`[Runflow AutoDownload] Batch ${Math.floor(i / concurrency) + 1}: downloading`,
                    batch.map(x => 'P' + (x.promptIndex + 1) + ':pos' + x.position).join(', '));
                await Promise.allSettled(batch.map(item => downloadItem(item, folder)));
                // Small gap between batches to avoid overloading
                if (i + concurrency < items.length) await new Promise(r => setTimeout(r, 300));
            }
        }

        console.log('[Runflow AutoDownload] ✅ Queue complete! (' + items.length + ' items, concurrency=' + concurrency + ')');

        // Signal to core.js that downloads are done
        const freshData = await getDownloadState();
        const freshSession = freshData.session;
        const freshCompletion = getSessionCompletionState(freshSession, freshData.settings);
        if (freshSession && (freshCompletion.selectedComplete || freshCompletion.complete)) {
            await saveSession({ ...freshSession, downloadsDone: true, completedAt: Date.now(), running: false });
            console.log('[Runflow AutoDownload] ✅ downloadsDone flag set on session');
        }

    } finally {
        queueRunning = false;
        // Clear cross-context lock
        chrome.storage.local.remove('autoMetaCopy_downloadLock');
    }
}


// ── ZIP Builder (pure JS, STORE method — no compression, no external libs) ────
function buildZipCrc32(buf) {
    if (!buildZipCrc32._t) {
        buildZipCrc32._t = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            buildZipCrc32._t[i] = c;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = buildZipCrc32._t[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildZipBlob(files) {
    // files: [{name: string, data: Uint8Array}]
    const parts = [], cdirs = [];
    let offset = 0;
    for (const { name, data } of files) {
        const nb = new TextEncoder().encode(name);
        const crc = buildZipCrc32(data);
        const sz = data.length;
        // Local file header (30 + name)
        const lh = new Uint8Array(30 + nb.length);
        const dv = new DataView(lh.buffer);
        dv.setUint32(0, 0x04034b50, true); // sig
        dv.setUint16(4, 20, true);         // version
        dv.setUint32(14, crc, true);       // crc32
        dv.setUint32(18, sz, true);        // compressed
        dv.setUint32(22, sz, true);        // uncompressed
        dv.setUint16(26, nb.length, true); // name len
        lh.set(nb, 30);
        // Central dir (46 + name)
        const cd = new Uint8Array(46 + nb.length);
        const cv = new DataView(cd.buffer);
        cv.setUint32(0, 0x02014b50, true);
        cv.setUint16(4, 20, true); cv.setUint16(6, 20, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, sz, true); cv.setUint32(24, sz, true);
        cv.setUint16(28, nb.length, true);
        cv.setUint32(42, offset, true);
        cd.set(nb, 46);
        parts.push(lh, data); cdirs.push(cd);
        offset += lh.length + data.length;
    }
    const cdSz = cdirs.reduce((s, c) => s + c.length, 0);
    const eocdr = new Uint8Array(22);
    const ev = new DataView(eocdr.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true);
    ev.setUint32(12, cdSz, true); ev.setUint32(16, offset, true);
    return new Blob([...parts, ...cdirs, eocdr], { type: 'application/zip' });
}

function failedPromptsReport(session, settings) {
    const failed = (session?.prompts || []).filter(prompt => !getPreferredOutput(prompt, settings));
    if (!failed.length) return '';
    const lines = [
        'Mete Run failed prompts report',
        `Session: ${session?.id || 'unknown'}`,
        `Generated: ${new Date().toISOString()}`,
        '',
        'The prompts below did not have a downloadable selected or secondary output.',
        ''
    ];
    failed.forEach(prompt => {
        const type = prompt.mode === 'prompt-to-image' ? 'image' : 'video';
        const primarySlot = prompt.selectedPosition || (type === 'image' ? settings.imageGenerationSelect : settings.videoGenerationSelect) || 'auto';
        const secondarySlot = type === 'video' ? (prompt.secondaryPosition || settings.secondaryVideoGenerationSelect || 'auto') : '-';
        lines.push(`Prompt #${Number(prompt.index) + 1}`);
        lines.push(`Primary slot: ${primarySlot}`);
        lines.push(`Secondary slot: ${secondarySlot}`);
        lines.push(`Status: ${prompt.status || 'unknown'}`);
        lines.push(`Retry count: ${Number(prompt.retryCount || 0)}`);
        if (prompt.retryReason || prompt.resolvedReason) lines.push(`Reason: ${prompt.retryReason || prompt.resolvedReason}`);
        if (prompt.originalPrompt && prompt.originalPrompt !== prompt.prompt) {
            lines.push(`Original prompt: ${clean(prompt.originalPrompt || '')}`);
            lines.push(`AI edited prompt: ${clean(prompt.aiEditedPrompt || prompt.prompt || '')}`);
        } else {
            lines.push(`Prompt: ${clean(prompt.prompt || '')}`);
        }
        lines.push('');
    });
    return lines.join('\n');
}

export async function downloadAllAsZip(session, settings, onProgress, options = {}) {
    const items = (Array.isArray(options.items)
        ? options.items
        : selectedOutputsFromSession(session, settings)).filter(i => i.src);
    const failureReport = options.includeFailureReport === false ? '' : failedPromptsReport(session, settings);
    if (!items.length && !failureReport) return { success: false, error: 'No items selected' };

    onProgress?.(`Fetching 0 / ${items.length}...`);
    const files = [];
    const failedFetches = [];
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        onProgress?.(`Fetching ${i + 1} / ${items.length}...`);
        try {
            const resp = await fetch(item.src);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const buf = await resp.arrayBuffer();
            const fullName = filenameFor(item, settings.downloadFolder || session.folder || 'downloads');
            files.push({ name: fullName, data: new Uint8Array(buf) });
        } catch (e) {
            console.warn('[ZIP] Fetch failed:', item.src.slice(0, 60), e.message);
            failedFetches.push({
                name: filenameFor(item, settings.downloadFolder || session.folder || 'downloads'),
                error: e.message,
                src: item.src
            });
        }
    }
    if (failedFetches.length) {
        const lines = [
            'Mete Run ZIP fetch failures',
            `Session: ${session?.id || 'unknown'}`,
            `Generated: ${new Date().toISOString()}`,
            '',
            'The files below could not be fetched from their direct media URLs.',
            ''
        ];
        failedFetches.forEach((item, index) => {
            lines.push(`${index + 1}. ${item.name}`);
            lines.push(`Error: ${item.error || 'unknown'}`);
            lines.push(`URL: ${item.src || ''}`);
            lines.push('');
        });
        files.push({
            name: `${safePathPart(settings.downloadFolder || session.folder || 'downloads')}/zip-fetch-failures.txt`,
            data: new TextEncoder().encode(lines.join('\n'))
        });
    }
    if (failureReport) {
        files.push({
            name: `${safePathPart(settings.downloadFolder || session.folder || 'downloads')}/failed-prompts.txt`,
            data: new TextEncoder().encode(failureReport)
        });
    }
    if (!files.length) return { success: false, error: 'All fetches failed' };

    onProgress?.(`Building ZIP (${files.length} files)...`);
    const blob = buildZipBlob(files);

    // ── Proper filename: videos-YYYY-MM-DD.zip ───────────────────────────────
    const now = new Date();
    const dateStr = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
    const prefix = safePathPart(options.filenamePrefix || 'videos');
    const zipFilename = `${prefix}-${dateStr}.zip`;

    // ── Anchor-click download (chrome.downloads + blob URL ignores filename)
    // Anchor <a download="name"> is the ONLY reliable way to set filename for blobs.
    return new Promise(resolve => {
        let blobUrl = '';
        const payload = {
            success: failedFetches.length === 0,
            partial: failedFetches.length > 0,
            count: files.length,
            failed: failedFetches.length,
            filename: zipFilename,
            error: failedFetches.length ? `${failedFetches.length} file(s) failed to fetch` : ''
        };
        const finish = (result) => {
            if (blobUrl) setTimeout(() => URL.revokeObjectURL(blobUrl), 5 * 60 * 1000);
            resolve(result);
        };
        const anchorFallback = (fallbackError = null) => {
            try {
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = zipFilename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                onProgress?.(`ZIP downloading: ${zipFilename} (${files.length} files)`);
                finish(payload);
            } catch (e) {
                finish({ success: false, error: fallbackError?.message || e.message });
            }
        };
        try {
            blobUrl = URL.createObjectURL(blob);
            if (globalThis.chrome?.downloads?.download) {
                globalThis.chrome.downloads.download(
                    { url: blobUrl, filename: zipFilename, conflictAction: 'uniquify', saveAs: false },
                    (downloadId) => {
                        if (!globalThis.chrome.runtime.lastError && downloadId !== undefined && downloadId !== null) {
                            onProgress?.(`ZIP downloading: ${zipFilename} (${files.length} files)`);
                            finish({ ...payload, downloadId });
                            return;
                        }
                        anchorFallback(globalThis.chrome.runtime.lastError || null);
                    }
                );
                return;
            }
            anchorFallback();
        } catch (e) {
            finish({ success: false, error: e.message });
        }
    });
}

