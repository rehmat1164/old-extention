// prompt-gate.js — Unified Brain: controls per-prompt advancement & slot enforcement
// Both core.js and download-detector.js share this module as the single source of truth.
// The gate blocks advancement to the next prompt until the selected slot is confirmed detected.

export const GATE_KEY = 'autoMetaCopy_promptGate';
export const GATE_EVENT_KEY = 'autoMetaCopy_gateEvent';

export const GATE_STATUS = {
    IDLE: 'idle',
    WAITING: 'waiting',       // Submitted, scanning for selected slot
    READY: 'ready',           // ✅ Selected slot detected → advance
    FALLBACK: 'fallback',     // ⚠️ Selected not detected → using another slot
    RETRYING: 'retrying',     // 🔄 Timeout hit → re-submitting prompt
    FAILED: 'failed'          // ❌ Max retries exhausted → skip prompt
};

// ── Storage helpers ─────────────────────────────────────────────────────────────

export async function getGateState() {
    const data = await chrome.storage.local.get({ [GATE_KEY]: null });
    const raw = data[GATE_KEY] || {};
    return {
        activePromptIndex: raw.activePromptIndex ?? -1,
        gates: raw.gates || {}
    };
}

async function saveGateState(state) {
    await chrome.storage.local.set({ [GATE_KEY]: state });
}

async function emitGateEvent(payload) {
    await chrome.storage.local.set({ [GATE_EVENT_KEY]: { ...payload, at: Date.now() } });
}

// ── Gate lifecycle ──────────────────────────────────────────────────────────────

/**
 * Called by core.js immediately after submitting a prompt.
 * Opens the gate for that prompt index, waiting for the selected slot.
 */
export async function openGateForPrompt(promptIndex, selectedSlot, opts = {}) {
    const state = await getGateState();
    state.activePromptIndex = Number(promptIndex);
    state.gates[promptIndex] = {
        status: GATE_STATUS.WAITING,
        selectedSlot: Number(selectedSlot) || 4,
        secondarySlot: Number(opts.secondarySlot) || Number(selectedSlot) || 4,
        retryCount: Math.max(0, Number(opts.retryCount || opts.initialRetryCount || 0)),
        maxRetries: Number(opts.maxRetries ?? 3),
        onFail: opts.onFail || 'skip',              // 'skip' | 'use_other_slot'
        detectedSlots: [],
        attemptStartedAt: Date.now(),
        openedAt: Date.now()
    };
    await saveGateState(state);
    await emitGateEvent({
        promptIndex,
        status: GATE_STATUS.WAITING,
        selectedSlot: Number(selectedSlot) || 4,
        secondarySlot: Number(opts.secondarySlot) || Number(selectedSlot) || 4,
        retryCount: Math.max(0, Number(opts.retryCount || opts.initialRetryCount || 0))
    });
    console.log(`[Gate] ▶ Opened for prompt ${promptIndex + 1}, waiting for slot ${selectedSlot}`);
}

/**
 * Called by download-detector.js each time it detects outputs for a prompt.
 * Merges slots, checks if selected slot is found, opens gate if yes.
 * Returns the evaluation result action: 'ready' | 'fallback' | 'waiting' | 'failed' | 'none'
 */
export async function reportDetectedSlots(promptIndex, incomingSlots = []) {
    const state = await getGateState();
    const gate = state.gates[promptIndex];

    // Gate not open for this prompt (e.g. already done)
    if (!gate) return { action: 'none' };

    // Already resolved — skip re-evaluation
    if (gate.status === GATE_STATUS.READY || gate.status === GATE_STATUS.FALLBACK) {
        return { action: 'already_open', status: gate.status, slot: gate.resolvedSlot };
    }

    // Merge incoming slots (deduplication by position)
    const byPosition = new Map((gate.detectedSlots || []).map(s => [s.position, s]));
    (incomingSlots || []).forEach(slot => {
        if (slot?.position && slot?.src) {
            const ex = byPosition.get(slot.position);
            // Always update to latest (newer src is more reliable)
            if (!ex || !ex.src || slot.src !== ex.src) {
                byPosition.set(slot.position, slot);
            }
        }
    });
    gate.detectedSlots = Array.from(byPosition.values());

    // ── Check if SELECTED slot is now detected ──────────────────────────────
    const selectedDetected = gate.detectedSlots.find(
        s => Number(s.position) === Number(gate.selectedSlot)
    );

    if (selectedDetected) {
        gate.status = GATE_STATUS.READY;
        gate.readyAt = Date.now();
        gate.resolvedSlot = selectedDetected;
        state.gates[promptIndex] = gate;
        await saveGateState(state);
        await emitGateEvent({
            promptIndex,
            status: GATE_STATUS.READY,
            slot: selectedDetected,
            retryCount: gate.retryCount
        });
        console.log(`[Gate] ✅ Prompt ${promptIndex + 1} READY — slot ${gate.selectedSlot} detected`);
        return { action: 'ready', slot: selectedDetected, gate };
    }

    const secondaryDetected = gate.secondarySlot && Number(gate.secondarySlot) !== Number(gate.selectedSlot)
        ? gate.detectedSlots.find(s => Number(s.position) === Number(gate.secondarySlot))
        : null;
    if (secondaryDetected) {
        gate.status = GATE_STATUS.FALLBACK;
        gate.readyAt = Date.now();
        gate.resolvedSlot = secondaryDetected;
        gate.resolvedReason = 'secondary_slot_detected';
        state.gates[promptIndex] = gate;
        await saveGateState(state);
        await emitGateEvent({
            promptIndex,
            status: GATE_STATUS.FALLBACK,
            slot: secondaryDetected,
            selectedSlot: gate.selectedSlot,
            secondarySlot: gate.secondarySlot,
            retryCount: gate.retryCount
        });
        console.log(`[Gate] Prompt ${promptIndex + 1} FALLBACK - secondary slot ${gate.secondarySlot} detected`);
        return { action: 'fallback', slot: secondaryDetected, gate };
    }

    // Save updated detected slots (even if not the selected one yet)
    state.gates[promptIndex] = gate;
    await saveGateState(state);
    return { action: 'waiting', gate };
}

/**
 * Called by core.js when a retry timeout occurs (per-attempt).
 * Increments retryCount and decides what to do next.
 * Returns: { action: 'retry' | 'fallback' | 'failed' }
 */
export async function handleGateTimeout(promptIndex) {
    const state = await getGateState();
    const gate = state.gates[promptIndex];
    if (!gate) return { action: 'none' };

    // Already resolved
    if (gate.status === GATE_STATUS.READY || gate.status === GATE_STATUS.FALLBACK) {
        return { action: 'already_done', gate };
    }

    gate.retryCount = (gate.retryCount || 0) + 1;

    if (gate.retryCount <= gate.maxRetries) {
        // Still have retries → retry same prompt
        gate.status = GATE_STATUS.RETRYING;
        gate.attemptStartedAt = Date.now();
        state.gates[promptIndex] = gate;
        await saveGateState(state);
        await emitGateEvent({
            promptIndex,
            status: GATE_STATUS.RETRYING,
            retryCount: gate.retryCount,
            maxRetries: gate.maxRetries
        });
        console.log(`[Gate] 🔄 Prompt ${promptIndex + 1} retry ${gate.retryCount}/${gate.maxRetries}`);
        return { action: 'retry', retryCount: gate.retryCount, gate };
    }

    // Max retries exceeded — apply fallback policy
    const fallback = gate.secondarySlot && Number(gate.secondarySlot) !== Number(gate.selectedSlot)
        ? gate.detectedSlots.find(s => Number(s.position) === Number(gate.secondarySlot))
        : null;
    if (fallback) {
        // Use any detected slot, prefer highest position (usually last generated)
        gate.status = GATE_STATUS.FALLBACK;
        gate.readyAt = Date.now();
        gate.resolvedSlot = fallback;
        gate.resolvedReason = 'secondary_slot_after_retries';
        state.gates[promptIndex] = gate;
        await saveGateState(state);
        await emitGateEvent({
            promptIndex,
            status: GATE_STATUS.FALLBACK,
            slot: fallback,
            selectedSlot: gate.selectedSlot,
            secondarySlot: gate.secondarySlot
        });
        console.log(`[Gate] ⚠️ Prompt ${promptIndex + 1} FALLBACK — slot ${fallback.position} used (selected: ${gate.selectedSlot})`);
        return { action: 'fallback', slot: fallback, gate };
    }

    // Skip prompt
    gate.status = GATE_STATUS.FAILED;
    gate.readyAt = Date.now();
    state.gates[promptIndex] = gate;
    await saveGateState(state);
    await emitGateEvent({
        promptIndex,
        status: GATE_STATUS.FAILED,
        retryCount: gate.retryCount,
        maxRetries: gate.maxRetries
    });
    console.log(`[Gate] ❌ Prompt ${promptIndex + 1} FAILED — max retries (${gate.maxRetries}) reached`);
    return { action: 'failed', gate };
}

// ── Core.js blocking waiter ─────────────────────────────────────────────────────

/**
 * Called by core.js to block until the gate for a prompt resolves.
 * Handles RETRYING internally by calling the provided retryFn callback.
 *
 * @param {number} promptIndex
 * @param {object} opts
 * @param {number} opts.perAttemptTimeoutMs - How long to wait per attempt before triggering retry (ms)
 * @param {function} opts.retryFn - async () => Promise<bool> — re-submits the prompt. Returns false to abort.
 * @param {function} [opts.shouldStop] - () => bool — abort check
 * @returns {Promise<{ status: string, slot: object|null, retryCount: number }>}
 */
export async function waitForPromptGate(promptIndex, opts = {}) {
    const {
        perAttemptTimeoutMs = 90 * 1000,
        retryFn = null,
        shouldStop = () => false
    } = opts;

    let attemptStart = Date.now();

    return new Promise(resolve => {
        const poll = async () => {
            if (shouldStop()) {
                resolve({ status: GATE_STATUS.FAILED, reason: 'stopped', slot: null, retryCount: 0 });
                return;
            }

            const state = await getGateState();
            const gate = state.gates[promptIndex];

            if (!gate) {
                // Gate not opened yet — wait
                setTimeout(poll, 600);
                return;
            }

            // Resolved states
            if (gate.status === GATE_STATUS.READY || gate.status === GATE_STATUS.FALLBACK) {
                resolve({ status: gate.status, slot: gate.resolvedSlot, retryCount: gate.retryCount, gate });
                return;
            }
            if (gate.status === GATE_STATUS.FAILED) {
                resolve({ status: GATE_STATUS.FAILED, slot: null, retryCount: gate.retryCount, gate });
                return;
            }

            // Check per-attempt timeout
            const elapsed = Date.now() - (gate.attemptStartedAt || attemptStart);
            if (elapsed >= perAttemptTimeoutMs && gate.status !== GATE_STATUS.RETRYING) {
                console.log(`[Gate] ⏱ Prompt ${promptIndex + 1} attempt timed out after ${Math.round(elapsed / 1000)}s`);
                const result = await handleGateTimeout(promptIndex);

                if (result.action === 'retry' && typeof retryFn === 'function') {
                    // Reset attempt timer
                    attemptStart = Date.now();
                    // Update attemptStartedAt in storage (already done by handleGateTimeout)
                    console.log(`[Gate] Calling retryFn for prompt ${promptIndex + 1}...`);
                    const ok = await retryFn(result.retryCount || gate.retryCount);
                    if (!ok || shouldStop()) {
                        resolve({ status: GATE_STATUS.FAILED, reason: 'retry_fn_failed', slot: null, retryCount: gate.retryCount });
                        return;
                    }
                    // After retry, reset gate status to WAITING
                    const freshState = await getGateState();
                    const freshGate = freshState.gates[promptIndex];
                    if (freshGate?.status === GATE_STATUS.READY || freshGate?.status === GATE_STATUS.FALLBACK) {
                        resolve({ status: freshGate.status, slot: freshGate.resolvedSlot, retryCount: freshGate.retryCount, gate: freshGate });
                        return;
                    }
                    if (freshGate) {
                        freshGate.status = GATE_STATUS.WAITING;
                        freshState.gates[promptIndex] = freshGate;
                        await saveGateState(freshState);
                    }
                    setTimeout(poll, 800);
                    return;
                }

                if (result.action === 'fallback') {
                    resolve({ status: GATE_STATUS.FALLBACK, slot: result.slot, retryCount: result.gate?.retryCount, gate: result.gate });
                    return;
                }

                // failed / none / already_done
                resolve({ status: GATE_STATUS.FAILED, slot: null, retryCount: result.gate?.retryCount || 0, gate: result.gate });
                return;
            }

            setTimeout(poll, 700);
        };

        poll();
    });
}

// ── First-frame preview capture ─────────────────────────────────────────────────

/**
 * Captures the first frame of a video from the Meta AI tab.
 * Injects into MAIN world of the tab so it can access the live video element.
 * Returns a compressed JPEG data URL (≤12KB) or empty string on failure.
 */
export async function captureFirstFramePreview(videoUrl, tabId) {
    if (!tabId || !videoUrl) return '';
    try {
        const res = await chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: (src) => {
                return new Promise(resolve => {
                    const video = document.createElement('video');
                    video.muted = true;
                    video.playsInline = true;
                    video.preload = 'metadata';
                    video.crossOrigin = 'anonymous';

                    let done = false;
                    const finish = (result) => {
                        if (done) return;
                        done = true;
                        clearTimeout(timer);
                        try { video.pause(); video.src = ''; video.load(); } catch (e) { }
                        resolve(result);
                    };

                    const captureFrame = () => {
                        try {
                            const targetW = 160, targetH = 90;
                            const canvas = document.createElement('canvas');
                            canvas.width = targetW;
                            canvas.height = targetH;
                            const ctx = canvas.getContext('2d', { alpha: false });
                            ctx.fillStyle = '#111827';
                            ctx.fillRect(0, 0, targetW, targetH);

                            if (video.videoWidth && video.videoHeight) {
                                // Maintain aspect ratio
                                const scale = Math.min(targetW / video.videoWidth, targetH / video.videoHeight);
                                const w = Math.round(video.videoWidth * scale);
                                const h = Math.round(video.videoHeight * scale);
                                const x = Math.round((targetW - w) / 2);
                                const y = Math.round((targetH - h) / 2);
                                ctx.drawImage(video, x, y, w, h);
                            }

                            const data = canvas.toDataURL('image/jpeg', 0.22);
                            finish(data && data.length > 500 && data.length < 14000 ? data : '');
                        } catch (e) {
                            finish('');
                        }
                    };

                    // Timer = 8s hard limit per video
                    const timer = setTimeout(() => finish(''), 8000);

                    video.addEventListener('loadeddata', () => {
                        try {
                            const dur = isFinite(video.duration) ? video.duration : 0;
                            const seekTo = dur > 1.5 ? 0.6 : dur > 0.4 ? 0.2 : 0;
                            if (seekTo > 0) {
                                video.currentTime = seekTo;
                            } else {
                                captureFrame();
                            }
                        } catch (e) { captureFrame(); }
                    }, { once: true });

                    video.addEventListener('seeked', () => captureFrame(), { once: true });

                    video.addEventListener('error', () => finish(''), { once: true });

                    video.src = src;
                    try { video.load(); } catch (e) { finish(''); }
                });
            },
            args: [videoUrl]
        });
        return res?.[0]?.result || '';
    } catch (e) {
        console.warn('[Gate] captureFirstFramePreview failed:', e.message);
        return '';
    }
}

// ── Utilities ───────────────────────────────────────────────────────────────────

/** Returns the currently active prompt index according to the gate */
export async function getActiveGatePromptIndex() {
    const state = await getGateState();
    return state.activePromptIndex ?? -1;
}

/** Returns full gate info for a prompt index */
export async function getPromptGateInfo(promptIndex) {
    const state = await getGateState();
    return state.gates[promptIndex] || null;
}

/** Clears all gate state — call on session end/reset */
export async function clearAllGates() {
    await chrome.storage.local.remove([GATE_KEY, GATE_EVENT_KEY]);
    console.log('[Gate] All gates cleared.');
}

/** Mark a gate as complete externally (e.g., if already downloaded) */
export async function markGateComplete(promptIndex, slot) {
    const state = await getGateState();
    if (!state.gates[promptIndex]) return;
    state.gates[promptIndex].status = GATE_STATUS.READY;
    state.gates[promptIndex].resolvedSlot = slot;
    state.gates[promptIndex].readyAt = state.gates[promptIndex].readyAt || Date.now();
    await saveGateState(state);
}
