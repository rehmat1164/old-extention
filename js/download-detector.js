// download-detector.js — Optimized, gallery-free detection engine
import {
    DETECTED_KEY, SESSION_KEY,
    clean, ensureSessionShape,
    getDownloadState, getSelectedPosition,
    normalizeOutput, promptExpectedCount,
    promptOutputType, queueSessionSave, saveSession
} from './download-state.js';
import { startQueuedDownloads } from './download-actions.js';
import {
    reportDetectedSlots, captureFirstFramePreview, getActiveGatePromptIndex, GATE_STATUS
} from './prompt-gate.js';


let realtimeTimer = null;
let observerInstalled = false;
let scanInFlight = false;
let lastScanAt = 0;
let consecutiveIdleScans = 0;
let scheduledScanTimer = null;
let scheduledReason = '';
const _scanContextId = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const CREATE_GALLERY_KEY = 'autoMetaCopy_createGallery';
const MANAGER_EVENTS_KEY = 'autoMetaCopy_managerEvents';
const GALLERY_CAP = 1500;
const THUMB_MAX_WIDTH = 160;
const THUMB_QUALITY = 0.30;
const THUMB_MAX_CHARS = 15000;
const THUMB_BATCH_LIMIT = 8;
const SCAN_LOCK_KEY = 'autoMetaCopy_scanLock';

function cleanMediaSrc(src) {
    return String(src || '').split('?')[0].split('#')[0];
}

function hasUsableThumbnail(item) {
    return !!(item?.thumbnail && String(item.thumbnail).length > 20);
}

function hasLockedThumbnail(item) {
    return item?.type === 'video' && item?.src && item.thumbnailLocked === true && hasUsableThumbnail(item);
}

function shouldCaptureThumbnail(promptRecord, item, settings = {}) {
    return false;
}

function lockThumbnailIfReady(item, lockedAt = Date.now()) {
    if (item?.type === 'video' && item?.src && hasUsableThumbnail(item)) {
        item.thumbnailLocked = true;
        item.thumbnailLockedAt = item.thumbnailLockedAt || lockedAt;
        item.outputLocked = true;
        item.outputLockedAt = item.outputLockedAt || lockedAt;
    }
    return item;
}

function hasLockedOutput(item) {
    if (!item?.src) return false;
    return item.outputLocked === true;
}

function clearDuplicatePromptThumbnails(promptRecord) {
    const seen = new Set();
    let changed = false;
    (promptRecord?.outputs || [])
        .filter(item => item?.type === 'video' && item?.thumbnail && !item.outputLocked)
        .sort((a, b) => Number(a.position || 1) - Number(b.position || 1))
        .forEach(item => {
            const key = String(item.thumbnail || '').slice(0, 600);
            if (!key) return;
            if (seen.has(key)) {
                item.thumbnail = '';
                item.thumbnailLocked = false;
                item.thumbnailLockedAt = null;
                changed = true;
            } else {
                seen.add(key);
            }
        });
    return changed;
}

// Adaptive interval: larger sessions → less frequent scans → less CPU pressure
// TURBO mode added for instant-capture scenarios (1200ms base)
function scanIntervalFor(speed, promptCount) {
    const count = Number(promptCount) || 0;
    const base = speed === 'turbo' ? 1200 : speed === 'realtime' ? 1800 : speed === 'safe' ? 7000 : 3500;
    if (count > 40) return Math.min(base * 2.5, 10000);
    if (count > 25) return Math.min(base * 2, 8000);
    if (count > 10) return Math.min(base * 1.4, 6000);
    return base;
}

function scheduleDetectionScan(reason = 'scheduled', delay = 600) {
    scheduledReason = scheduledReason ? `${scheduledReason},${reason}` : reason;
    if (scheduledScanTimer) clearTimeout(scheduledScanTimer);
    scheduledScanTimer = setTimeout(() => {
        const r = scheduledReason || reason;
        scheduledReason = '';
        scheduledScanTimer = null;
        if (!scanInFlight) runRealtimeDetectionScan(r);
    }, delay);
}

// Pause detection entirely when nothing needs scanning (reduces CPU usage)
// ALSO keeps scanning when 'ready' prompts still have missing thumbnails —
// but ONLY while the session is actively running (prevents flickering after stop).
let thumbnailRetryCount = 0;
const MAX_THUMBNAIL_RETRIES = 15; // Stop trying after 15 failed attempts

function hasActiveWork(session, settings = {}) {
    if (!session?.active) return false;
    if (session.downloadsDone) return false;
    if (session.running === false) return false;
    return (session.prompts || []).some(p => {
        // Standard: prompts still being processed
        if (!['ready', 'downloaded'].includes(p.status) &&
            (p.status === 'submitted' || p.status === 'generating' || p.status === 'detecting' ||
                Number(p.index) <= Number(session.currentIndex))) return true;
        // Missing thumbnails on ready prompts = still has work (keep scanning!)
        // But give up after MAX_THUMBNAIL_RETRIES to prevent infinite loops
        if (thumbnailRetryCount < MAX_THUMBNAIL_RETRIES &&
            p.status === 'ready' && (p.outputs || []).some(o =>
            shouldCaptureThumbnail(p, o, settings))) return true;
        return false;
    });
}

export function initRealtimeDetection() {
    if (realtimeTimer) return;
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local') return;
        if (changes[SESSION_KEY] || changes.autoMetaCopy_detectionPulse) {
            // Fast reaction: pulse = 300ms (DOM change detected), session = 500ms
            scheduleDetectionScan('storage-change', changes.autoMetaCopy_detectionPulse ? 300 : 500);
        }
    });
    refreshDetectionTimer();
}

export async function refreshDetectionTimer() {
    const { session, settings } = await getDownloadState();
    if (realtimeTimer) clearInterval(realtimeTimer);
    const promptCount = session?.prompts?.length || 0;
    const interval = scanIntervalFor(settings.scanSpeed, promptCount);
    realtimeTimer = setInterval(async () => {
        const { session: s, settings: timerSettings } = await getDownloadState();
        // FULL STOP: session done or downloads finished — kill all timers
        if (s?.downloadsDone || (s?.running === false && s?.completedAt)) {
            console.log('[AutoMeta] Session complete — stopping scanner entirely');
            clearInterval(realtimeTimer);
            realtimeTimer = null;
            // ── Batch-flush gallery now that automation stopped ───────────
            // During automation gallery writes were suppressed to keep the
            // page/extension light. Now flush all detected outputs at once.
            try {
                await saveOutputsToGallery(s);
                console.log('[AutoMeta] Gallery flushed after session stop');
            } catch (e) { /* non-critical */ }
            return;
        }
        if (!hasActiveWork(s, timerSettings)) {
            consecutiveIdleScans++;
            if (consecutiveIdleScans > 10) {
                clearInterval(realtimeTimer);
                // Idle-check at 10s but ONLY if session is still active and not done
                realtimeTimer = setInterval(async () => {
                    const { session: idleS } = await getDownloadState();
                    if (!idleS?.active || idleS?.downloadsDone || idleS?.running === false) {
                        console.log('[AutoMeta] Idle-check: session done — stopping scanner');
                        clearInterval(realtimeTimer);
                        realtimeTimer = null;
                        return;
                    }
                    runRealtimeDetectionScan('idle-check');
                }, 10000);
            }
            return;
        }
        consecutiveIdleScans = 0;
        scheduleDetectionScan('interval', 250);
    }, interval);
}

export async function installMutationObserver() {
    if (observerInstalled) return;
    const tabs = await chrome.tabs.query({ url: 'https://www.meta.ai/*' });
    const tab = tabs.find(t => t.url?.includes('/create')) || tabs[0];
    if (!tab?.id) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: 'ISOLATED',
            func: () => {
                if (window.__autoMetaDownloadObserverInstalled) return true;
                window.__autoMetaDownloadObserverInstalled = true;
                let timer = null;
                // Debounce 200ms — ultra-fast capture, catches videos the instant they appear.
                const pulse = () => {
                    clearTimeout(timer);
                    timer = setTimeout(() => {
                        try { chrome.storage.local.set({ autoMetaCopy_detectionPulse: Date.now() }); } catch (e) { }
                    }, 200);
                };
                new MutationObserver(mutations => {
                    if (mutations.some(m => {
                        // Watch for new articles OR media attributes being set
                        if (m.type === 'attributes' && (
                            m.attributeName === 'data-video-url' ||
                            m.attributeName === 'data-video-thumbnail' ||
                            m.attributeName === 'src'
                        )) return true;
                        return Array.from(m.addedNodes || []).some(node => {
                            if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
                            return node.matches?.('article,[data-testid]')
                                || node.querySelector?.('article,[data-testid="generated-video"],[data-testid="generated-image"],[data-video-url],[data-video-thumbnail],video');
                        });
                    })) pulse();
                // Scope: watch <main> only (not entire document).
                // Eliminates mutations from header, sidebar, footer — 80% noise reduction.
                }).observe(document.querySelector('main') || document.documentElement, {
                    childList: true, subtree: true,
                    attributes: true, attributeFilter: ['data-video-url', 'data-video-thumbnail', 'src']
                });
                return true;
            }
        });
        observerInstalled = true;
    } catch (e) {
        observerInstalled = false;
    }
}

// DOM scan — runs inside Meta AI page via chrome.scripting (MAIN world).
// TEXT-BASED 1:1 matching: each article matched to exactly one prompt.
// Uses img.alt (exact) and [data-slot="text"] (fuzzy 0.80). Fixed regex.
export function scanGeneratedOutputs(startedAt, prompts, baselineSignatures = [], currentIndex = -1, mode = '', sessionId = '', thumbnailMode = 'hover', selectedPositions = {}) {

    // ── Helpers (all regex FIXED — no broken /s+/g) ──────────────────────────
    const clean = t => (t || '').replace(/\s+/g, ' ').trim();
    // Simple ASCII normalization — no Unicode property escapes (break on serialization)
    const norm = t => clean(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const hasLockedThumbLocal = item => !!(
        item?.type === 'video' &&
        item?.src &&
        item.thumbnailLocked === true &&
        item.thumbnail &&
        String(item.thumbnail).length > 20
    );
    const shouldExtractThumb = (promptRecord, position) => {
        if (thumbnailMode === 'none') return false;
        if (thumbnailMode === 'all') return true;
        const selected = Number(selectedPositions?.[Number(promptRecord.index)] || 0);
        return selected > 0 && Number(position) === selected;
    };

    // ── O(1) EXACT MATCH hash-map — avoids similarity scoring for identical prompts ──
    const exactMap = new Map();
    (prompts || []).forEach(p => {
        if (!p.prompt) return;
        const key = norm(p.prompt);
        if (key && !exactMap.has(key)) exactMap.set(key, p);
    });

    // ── IDF (Inverse Document Frequency) weight map ───────────────────────────
    // Words that appear in MANY prompts are less discriminating (low weight).
    // Words unique to one prompt carry the real signal (high weight).
    const wordDocFreq = new Map();
    const promptList_idf = prompts || [];
    const totalPrompts = Math.max(1, promptList_idf.length);
    promptList_idf.forEach(p => {
        if (!p.prompt) return;
        const words = new Set(norm(p.prompt).split(' ').filter(w => w.length > 3));
        words.forEach(w => wordDocFreq.set(w, (wordDocFreq.get(w) || 0) + 1));
    });
    // idfWeight(w) = 1.0 if unique to 1 prompt, approaches 0 if in ALL prompts
    const idfWeight = w => {
        const df = wordDocFreq.get(w) || 1;
        // Smooth IDF: log(N/df) / log(N) — normalised 0..1
        return totalPrompts <= 1 ? 1 : Math.log(totalPrompts / df) / Math.log(totalPrompts);
    };

    const similarity = (a, b) => {
        if (!a || !b) return 0;
        const na = norm(a), nb = norm(b);
        if (!na || !nb) return 0;
        if (na === nb) return 1;

        // ── IDF-weighted word overlap (primary score) ─────────────────────────
        const aWords = na.split(' ').filter(w => w.length > 3);
        const bWords = nb.split(' ').filter(w => w.length > 3);
        const aSet = new Set(aWords);
        let weightedIntersect = 0, weightedUnion = 0;
        const allWords = new Set([...aWords, ...bWords]);
        allWords.forEach(w => {
            const wt = Math.max(0.05, idfWeight(w)); // floor 0.05 so common words still count slightly
            if (aSet.has(w) && bWords.includes(w)) weightedIntersect += wt;
            weightedUnion += wt;
        });
        if (weightedUnion === 0) return 0;
        return weightedIntersect / weightedUnion;
    };

    // ── Tail fingerprint: last 60% of a prompt is its most distinctive part ───
    // When multiple prompts share the same opening sentence, the tail is what
    // differentiates them. We compare the tail of the article text against the
    // tail of each prompt to find the best match.
    const promptTail = p => {
        const n = norm(p.prompt || '');
        const start = Math.floor(n.length * 0.4);
        return n.slice(start);
    };
    const tailSimilarity = (articleText, p) => {
        const at = norm(articleText);
        const pt = promptTail(p);
        if (!pt || pt.length < 10) return 0;
        // Check if the article's text contains the distinctive tail words
        const tailWords = pt.split(' ').filter(w => w.length > 4);
        if (!tailWords.length) return 0;
        const atSet = new Set(at.split(' ').filter(w => w.length > 4));
        const tailMatches = tailWords.filter(w => atSet.has(w)).length;
        return tailMatches / tailWords.length;
    };

    const matchPrompt = (text, list) => {
        if (!text || text.length < 4) return null;
        // FAST PATH: O(1) exact match via hash-map
        const normed = norm(text);
        const exact = exactMap.get(normed);
        if (exact) return exact;
        // SLOW PATH: IDF-weighted similarity + tail boost
        let best = null, top = 0;
        for (const p of list) {
            if (!p.prompt) continue;
            const baseScore = similarity(p.prompt, text);
            // Boost score with tail similarity — this separates prompts with same prefix
            const tailBoost = tailSimilarity(text, p) * 0.35;
            const s = Math.min(1, baseScore + tailBoost);
            if (s > top) { top = s; best = p; }
        }
        // Raise threshold slightly: 0.82 reduces false-positive prefix matches
        return top >= 0.82 ? best : null;
    };

    // ── State ─────────────────────────────────────────────────────────────────
    const now          = Date.now();
    const results      = [];
    const seen         = new Set();
    const baselineSet  = new Set(baselineSignatures || []);
    const baselineUrlSet = new Set((baselineSignatures || []).map(sig => {
        const parts = String(sig || '').split('|');
        const maybeUrl = parts.find(part => /^https?:|^blob:/.test(part || '')) || parts[parts.length - 2] || '';
        return maybeUrl.split('?')[0].split('#')[0];
    }).filter(Boolean));
    const promptList   = prompts || [];
    const pendingIdx   = new Set(promptList.map(p => Number(p.index)));
    const sessionMode  = mode || 'prompt-to-video';
    const cleanUrl = (url) => clean(url).split('?')[0].split('#')[0];
    const isUsableUrl = (url, type = 'media') => {
        const u = clean(url);
        if (!u || u.length < 10 || u === 'about:blank' || u.startsWith('data:,')) return false;
        if (type === 'image' && u.startsWith('data:')) return false;
        return /^https?:|^blob:/.test(u);
    };
    const isVisibleMedia = (el, min = 48) => {
        if (!el?.getBoundingClientRect) return true;
        const r = el.getBoundingClientRect();
        return r.width >= min && r.height >= min;
    };
    const readAttrUrl = (el, attr) => clean(el?.getAttribute?.(attr) || '');
    const findVideoUrlInAttributes = (root) => {
        const nodes = [root, ...Array.from(root?.querySelectorAll?.('*') || [])];
        for (const node of nodes) {
            for (const attr of Array.from(node.attributes || [])) {
                const value = clean(attr.value || '');
                if (!isUsableUrl(value, 'video')) continue;
                const name = String(attr.name || '').toLowerCase();
                if (name.includes('video') || /\.(mp4|webm|mov)(\?|#|$)/i.test(value)) return value;
            }
        }
        return '';
    };
    const collectImageMedia = (article) => {
        const found = [];
        const seenUrls = new Set();
        const add = (img) => {
            if (!img || !isVisibleMedia(img)) return;
            const url = clean(img.currentSrc || img.src || img.getAttribute('src') || '');
            if (!isUsableUrl(url, 'image')) return;
            const key = cleanUrl(url);
            if (!key || seenUrls.has(key)) return;
            seenUrls.add(key);
            found.push({ type: 'image', src: url, pos: found.length + 1, el: img });
        };
        Array.from(article.querySelectorAll('img[data-testid="generated-image"]')).forEach(add);
        Array.from(article.querySelectorAll('[data-testid="generated-image"] img, img')).forEach(add);
        found.forEach((item, index) => { item.pos = index + 1; });
        return found;
    };
    const collectVideoMedia = (article) => {
        const cards = [];
        const seenCards = new Set();
        const addCard = (node) => {
            const card = node?.matches?.('[data-testid="generated-video"], [data-video-url], [data-video-thumbnail], video')
                ? node
                : (node?.closest?.('[data-testid="generated-video"], [data-video-url], [data-video-thumbnail]') || node);
            if (!card || seenCards.has(card)) return;
            const hasUrlHint = !!(
                readAttrUrl(card, 'data-video-url') ||
                readAttrUrl(card, 'href') ||
                findVideoUrlInAttributes(card)
            );
            if (!hasUrlHint && !isVisibleMedia(card)) return;
            seenCards.add(card);
            cards.push(card);
        };
        article.querySelectorAll([
            '[data-testid="generated-video"]',
            '[data-testid*="video" i]',
            '[data-video-url]',
            '[data-video-thumbnail]',
            'video',
            'source',
            'a[href*=".mp4"]',
            'a[href*="fbcdn"]',
            '[href*=".mp4"]',
            '[href*="fbcdn"]'
        ].join(',')).forEach(addCard);
        if (findVideoUrlInAttributes(article)) addCard(article);

        const found = [];
        const seenUrls = new Set();
        cards.forEach(card => {
            const video = card.matches?.('video') ? card : card.querySelector?.('video');
            const sources = [
                readAttrUrl(card, 'data-video-url'),
                readAttrUrl(card, 'href'),
                video?.currentSrc || '',
                video?.src || '',
                readAttrUrl(video, 'src'),
                ...Array.from(card.querySelectorAll?.('[data-video-url]') || []).map(el => el.getAttribute('data-video-url') || ''),
                ...Array.from(card.querySelectorAll?.('[href]') || []).map(el => el.getAttribute('href') || ''),
                ...Array.from(card.querySelectorAll?.('source') || []).map(source => source.src || source.getAttribute('src') || ''),
                findVideoUrlInAttributes(card)
            ];
            const url = sources.find(src => isUsableUrl(src, 'video'));
            if (!url) return;
            const key = cleanUrl(url);
            if (!key || seenUrls.has(key)) return;
            seenUrls.add(key);
            found.push({ type: 'video', src: clean(url), pos: found.length + 1, el: card });
        });
        return found;
    };
    const articleMediaStats = (article, promptRecord) => {
        const effectMode = promptRecord.mode || sessionMode;
        const media = effectMode === 'prompt-to-image' ? collectImageMedia(article) : collectVideoMedia(article);
        let total = 0, fresh = 0;
        media.forEach(item => {
            const url = clean(item.src);
            if (!url || url.length < 10 || url.startsWith('data:')) return;
            total++;
            const normalizedUrl = cleanUrl(url);
            const sig = sessionId + '|' + Number(promptRecord.index) + '|' + item.type + '|' + item.pos + '|' + normalizedUrl;
            if (!baselineSet.has(sig) && !baselineUrlSet.has(normalizedUrl)) fresh++;
        });
        return { total, fresh };
    };

    // ── STEP 1: Each article → try to match one pending prompt ───────────────
    // Handles DUPLICATE prompts: when multiple prompts share the same text,
    // each article gets matched to a different prompt index (in DOM order → prompt order).
    const matched = new Map(); // promptIndex → { article, promptRecord, score }
    const consumedPromptIdx = new Set(); // track which prompt indices are already matched

    // Collect all articles with their matched prompt candidates
    const articleCandidates = [];
    const mediaOnlyCandidates = [];
    const mediaCandidates = [];
    Array.from(document.querySelectorAll('article')).forEach((article, articleIndex) => {
        const hasMedia = collectImageMedia(article).length > 0 || collectVideoMedia(article).length > 0;
        if (hasMedia) mediaCandidates.push({ article, articleIndex });
        // Source A: img.alt — Meta AI injects EXACT user prompt here (most reliable for image mode)
        const firstImg  = article.querySelector('img[data-testid="generated-image"]');
        const altText   = firstImg ? clean(firstImg.getAttribute('alt') || '') : '';

        // Source B: [data-slot="text"] textContent (may exist in some layouts)
        const slotEl    = article.querySelector('[data-slot="text"]');
        const slotText  = slotEl ? clean(slotEl.textContent || '') : '';

        // Source C: paragraph or span fallback
        const paraEl    = !slotEl ? article.querySelector('p, span[class*="text"]') : null;
        const paraText  = paraEl ? clean(paraEl.textContent || '') : '';

        // Source D: full article textContent substring check (last resort — always works)
        const fullText  = (!altText && !slotText && !paraText)
            ? clean((article.textContent || '').slice(0, 1000))
            : '';

        // Find ALL prompts that match this article's text (not just the best one)
        const matchedText = altText.length >= 4 ? altText : slotText.length >= 4 ? slotText : paraText.length >= 4 ? paraText : fullText;
        const genericText = /^(i generated|generated|create|download|share|play|9:16|16:9|1:1)\b/i.test(matchedText || '');
        if (hasMedia && (!matchedText || matchedText.length < 4 || genericText)) {
            mediaOnlyCandidates.push({ article, articleIndex });
        }
        if (!matchedText || matchedText.length < 4 || genericText) return;

        let matchingPrompts = [];
        for (const p of promptList) {
            if (!p.prompt) continue;
            const baseScore = similarity(p.prompt, matchedText);
            const tailBoost = tailSimilarity(matchedText, p) * 0.35;
            const s = Math.min(1, baseScore + tailBoost);
            const isRecoveryPrompt = ['failed', 'timeout', 'unrecoverable'].includes(String(p.status || ''));
            const threshold = isRecoveryPrompt ? 0.48 : 0.82;
            if (s >= threshold && pendingIdx.has(Number(p.index))) {
                matchingPrompts.push({ promptRecord: p, score: s });
            }
        }
        if (matchingPrompts.length > 1) {
            matchingPrompts.sort((a, b) => b.score - a.score || Number(a.promptRecord.index) - Number(b.promptRecord.index));
            const topScore = matchingPrompts[0].score;
            matchingPrompts = matchingPrompts.filter(m => m.score >= topScore - 0.03);
        }
        if (matchingPrompts.length > 0) {
            const stats = articleMediaStats(article, matchingPrompts[0].promptRecord);
            articleCandidates.push({ article, articleIndex, matchingPrompts, stats });
        }
    });

    // Sort articles by DOM position ASCENDING (first article = first prompt in sequence).
    // Freshest articles (with more fresh media) still get priority within same DOM position.
    articleCandidates.sort((a, b) => {
        // Articles with MORE fresh media go first (they are new generations)
        if (b.stats.fresh !== a.stats.fresh) return b.stats.fresh - a.stats.fresh;
        // Among equal freshness, earlier DOM position = earlier in sequence
        return a.articleIndex - b.articleIndex;
    });

    // Assign articles to prompts — each prompt index gets at most 1 article
    // Process articles in sorted order, assign to LOWEST matching prompt index first
    // (DOM position order = prompt sequence order)
    for (const candidate of articleCandidates) {
        // Among all prompts matching this article, pick the lowest index not yet consumed
        // Lowest index first = correct sequence (P1 → first article, P2 → second, etc.)
        const available = candidate.matchingPrompts
            .filter(m => !consumedPromptIdx.has(Number(m.promptRecord.index)))
            .sort((a, b) => b.score - a.score || Number(a.promptRecord.index) - Number(b.promptRecord.index));

        if (available.length === 0) continue;
        const best = available[0];
        const promptIdx = Number(best.promptRecord.index);
        const score = (candidate.stats.fresh * 1000) + (candidate.stats.total * 50) + candidate.articleIndex;

        matched.set(promptIdx, { article: candidate.article, promptRecord: best.promptRecord, score });
        consumedPromptIdx.add(promptIdx);
    }

    // Second pass: try to assign remaining unmatched articles to remaining unmatched prompts
    // Uses ascending prompt index to maintain correct sequence
    for (const candidate of articleCandidates) {
        const available = candidate.matchingPrompts
            .filter(m => !consumedPromptIdx.has(Number(m.promptRecord.index)))
            .sort((a, b) => b.score - a.score || Number(a.promptRecord.index) - Number(b.promptRecord.index));

        if (available.length === 0) continue;
        const best = available[0];
        const promptIdx = Number(best.promptRecord.index);
        const score = (candidate.stats.fresh * 1000) + (candidate.stats.total * 50) + candidate.articleIndex;

        matched.set(promptIdx, { article: candidate.article, promptRecord: best.promptRecord, score });
        consumedPromptIdx.add(promptIdx);
    }

    // ── STEP 2: Extract media from each matched article (1 article → 1 prompt) ──
    const matchedArticles = new Set(Array.from(matched.values()).map(item => item.article));
    if (sessionMode === 'image-to-video') {
        const activePrompt = promptList
            .filter(p => pendingIdx.has(Number(p.index))
                && !consumedPromptIdx.has(Number(p.index))
                && ['submitted', 'generating', 'detecting', 'timeout'].includes(String(p.status || ''))
                && Number(p.index) <= Number(currentIndex))
            .sort((a, b) => Number(b.index) - Number(a.index))[0];
        if (activePrompt) {
            const freshCandidate = mediaCandidates
                .filter(candidate => !matchedArticles.has(candidate.article))
                .map(candidate => ({
                    ...candidate,
                    stats: articleMediaStats(candidate.article, activePrompt)
                }))
                .filter(candidate => candidate.stats.fresh > 0)
                .sort((a, b) => b.stats.fresh - a.stats.fresh || a.articleIndex - b.articleIndex)[0];
            if (freshCandidate) {
                const promptIdx = Number(activePrompt.index);
                matched.set(promptIdx, { article: freshCandidate.article, promptRecord: activePrompt, score: 100000 + freshCandidate.articleIndex });
                consumedPromptIdx.add(promptIdx);
                matchedArticles.add(freshCandidate.article);
            }
        }
    }
    const remainingPrompts = promptList
        .filter(p => pendingIdx.has(Number(p.index)) && !consumedPromptIdx.has(Number(p.index)))
        .sort((a, b) => Number(a.index) - Number(b.index));
    mediaOnlyCandidates
        .filter(candidate => !matchedArticles.has(candidate.article))
        .sort((a, b) => a.articleIndex - b.articleIndex)
        .forEach((candidate, i) => {
            const promptRecord = remainingPrompts[i];
            if (!promptRecord) return;
            const promptIdx = Number(promptRecord.index);
            matched.set(promptIdx, { article: candidate.article, promptRecord, score: candidate.articleIndex });
            consumedPromptIdx.add(promptIdx);
        });

    for (const { article, promptRecord } of matched.values()) {
        const pIdx        = Number(promptRecord.index);
        const effectMode  = promptRecord.mode || sessionMode;
        const recoveryPrompt = ['failed', 'timeout', 'unrecoverable'].includes(String(promptRecord.status || ''));

        if (effectMode === 'prompt-to-image') {
            // ── IMAGE mode ──
            collectImageMedia(article)
                .forEach((item, pos) => {
                    const url = clean(item.src || '');
                    if (!url || url.length < 10 || url.startsWith('data:')) return;
                    const normalizedUrl = cleanUrl(url);
                    const sig = sessionId + '|' + pIdx + '|image|' + (pos + 1) + '|' + normalizedUrl;
                    if (seen.has(sig) || (!recoveryPrompt && (baselineSet.has(sig) || baselineUrlSet.has(normalizedUrl)))) return;
                    seen.add(sig);
                    results.push({ type: 'image', src: url, preview: '', position: pos + 1, promptIndex: pIdx, prompt: promptRecord.prompt, signature: sig, detectedAt: now });
                });
        } else {
            // ── VIDEO mode ──
            collectVideoMedia(article)
                .forEach((item, pos) => {
                    const div = item.el;
                    const url = clean(item.src || '');
                    if (!url || url.length < 10) return;
                    const normalizedUrl = cleanUrl(url);
                    const sig = sessionId + '|' + pIdx + '|video|' + (pos + 1) + '|' + normalizedUrl;

                    // ── Thumbnail extraction (shared by new + existing videos) ──
                    // Try multiple sources to guarantee we get one:
                    // 1. data-video-thumbnail (Meta's official attribute)
                    // 2. img tags inside the video card
                    // 3. video poster attribute
                    // 4. img in parent container
                    // 5. background-image CSS
                    const extractThumbnail = () => {
                        const validDataThumb = (u) => {
                            const s = clean(u || '');
                            if (!s || s === 'about:blank' || s.startsWith('data:,')) return '';
                            if (s.startsWith('data:image/') && s.length <= 9000) return s;
                            return '';
                        };
                        const isBlankFrame = (ctx, w, h) => {
                            try {
                                const stepX = Math.max(1, Math.floor(w / 12));
                                const stepY = Math.max(1, Math.floor(h / 12));
                                const data = ctx.getImageData(0, 0, w, h).data;
                                let count = 0, total = 0, bright = 0, variance = 0;
                                for (let y = 0; y < h; y += stepY) {
                                    for (let x = 0; x < w; x += stepX) {
                                        const i = (y * w + x) * 4;
                                        const lum = (data[i] * 0.299) + (data[i + 1] * 0.587) + (data[i + 2] * 0.114);
                                        total += lum;
                                        if (lum > 28) bright++;
                                        count++;
                                    }
                                }
                                const avg = total / Math.max(1, count);
                                for (let y = 0; y < h; y += stepY) {
                                    for (let x = 0; x < w; x += stepX) {
                                        const i = (y * w + x) * 4;
                                        const lum = (data[i] * 0.299) + (data[i + 1] * 0.587) + (data[i + 2] * 0.114);
                                        variance += Math.abs(lum - avg);
                                    }
                                }
                                const spread = variance / Math.max(1, count);
                                return avg < 18 || spread < 5 || (bright / Math.max(1, count) < 0.08 && spread < 8);
                            } catch (e) {
                                return false;
                            }
                        };
                        const compressCanvas = (draw, sourceW, sourceH) => {
                            try {
                                if (!sourceW || !sourceH) return '';
                                const scale = Math.min(1, 96 / sourceW);
                                const w = Math.max(48, Math.round(sourceW * scale));
                                const h = Math.max(48, Math.round(sourceH * scale));
                                const c = document.createElement('canvas');
                                c.width = w;
                                c.height = h;
                                const ctx = c.getContext('2d', { alpha: false });
                                ctx.fillStyle = '#eef2f7';
                                ctx.fillRect(0, 0, w, h);
                                draw(ctx, w, h);
                                if (isBlankFrame(ctx, w, h)) return '';
                                const d = c.toDataURL('image/jpeg', 0.18);
                                return d && d.length >= 400 && d.length <= 9000 ? d : '';
                            } catch (e) {
                                return '';
                            }
                        };
                        const compressImg = (img) => {
                            if (!img || !img.complete || !img.naturalWidth) return '';
                            return compressCanvas((ctx, w, h) => ctx.drawImage(img, 0, 0, w, h), img.naturalWidth, img.naturalHeight);
                        };
                        const canvasVideo = (vid) => {
                            if (!vid || vid.readyState < 2 || !vid.videoWidth || !vid.videoHeight) return '';
                            return compressCanvas((ctx, w, h) => ctx.drawImage(vid, 0, 0, w, h), vid.videoWidth, vid.videoHeight);
                        };

                        const vidEl = div.querySelector('video');

                        const metaThumb = clean(div.getAttribute('data-video-thumbnail') || '');
                        const metaData = validDataThumb(metaThumb);
                        if (metaData) return metaData;
                        if (metaThumb && metaThumb.length > 20 && !metaThumb.startsWith('data:')) return metaThumb;

                        const imgCandidate = Array.from(div.querySelectorAll('img'))
                            .find(img => clean(img.currentSrc || img.src || img.getAttribute('src') || '').length > 20);
                        const imgThumb = compressImg(imgCandidate);
                        if (imgThumb) return imgThumb;
                        const imgUrl = clean(imgCandidate?.currentSrc || imgCandidate?.src || imgCandidate?.getAttribute('src') || '');
                        if (imgUrl && !imgUrl.startsWith('data:')) return imgUrl;

                        const posterData = validDataThumb(vidEl?.poster || vidEl?.getAttribute?.('poster'));
                        if (posterData) return posterData;
                        const posterUrl = clean(vidEl?.poster || vidEl?.getAttribute?.('poster') || '');
                        if (posterUrl && posterUrl.length > 20 && !posterUrl.startsWith('data:')) return posterUrl;

                        const parentImg = Array.from(div.parentElement?.querySelectorAll?.('img') || [])
                            .find(img => clean(img.currentSrc || img.src || img.getAttribute('src') || '').length > 20);
                        const parentThumb = compressImg(parentImg);
                        if (parentThumb) return parentThumb;
                        const parentUrl = clean(parentImg?.currentSrc || parentImg?.src || parentImg?.getAttribute('src') || '');
                        if (parentUrl && !parentUrl.startsWith('data:')) return parentUrl;

                        const videoThumb = canvasVideo(vidEl);
                        return videoThumb || '';
                    };

                    // Already detected → check if thumbnail available now (Meta adds thumbs AFTER video URL)
                    if (seen.has(sig) || (!recoveryPrompt && (baselineSet.has(sig) || baselineUrlSet.has(normalizedUrl)))) {
                        // Only re-emit if this prompt still needs a thumbnail
                        const needsThumb = promptRecord.outputs
                            ? (promptRecord.outputs || []).some(o => Number(o.position) === (pos + 1) && o.src && !hasLockedThumbLocal(o) && shouldExtractThumb(promptRecord, pos + 1))
                            : true;
                        if (needsThumb) {
                            const thumbnail = extractThumbnail();
                            if (thumbnail && thumbnail.length >= 20) {
                                // Emit thumbnail-only update for already-detected video
                                results.push({ type: 'video', src: url, preview: '', thumbnail, thumbnailLocked: true, thumbnailLockedAt: now, position: pos + 1, promptIndex: pIdx, prompt: promptRecord.prompt, signature: sig, detectedAt: now, thumbnailOnly: true });
                            }
                        }
                        return;
                    }
                    seen.add(sig);

                    const thumbnail = shouldExtractThumb(promptRecord, pos + 1) ? extractThumbnail() : '';
                    results.push({ type: 'video', src: url, preview: '', thumbnail, thumbnailLocked: !!thumbnail, thumbnailLockedAt: thumbnail ? now : null, position: pos + 1, promptIndex: pIdx, prompt: promptRecord.prompt, signature: sig, detectedAt: now });
                });
        }
    }

    return results;
}
function mergePromptOutputs(session, promptRecord, incoming) {
    const expectedType = promptOutputType(promptRecord);
    const byPosition = new Map();
    (promptRecord.outputs || []).forEach(item => {
        const n = normalizeOutput(session.id, item, promptRecord);
        if (n.src && n.type === expectedType) byPosition.set(n.position, n);
    });
    (incoming || []).forEach(item => {
        const n = normalizeOutput(session.id, item, promptRecord);
        if (!n.src || n.type !== expectedType) return;
        const ex = byPosition.get(n.position);
        if (hasLockedOutput(ex)) {
            if (cleanMediaSrc(ex.src) !== cleanMediaSrc(n.src)) {
                if (ex.downloaded) return;
                byPosition.set(n.position, {
                    ...n,
                    selected: ex?.selected ?? true,
                    thumbnail: '',
                    preview: '',
                    thumbnailLocked: false,
                    thumbnailLockedAt: null,
                    outputLocked: true,
                    outputLockedAt: Date.now()
                });
                return;
            }
            byPosition.set(n.position, {
                ...ex,
                downloaded: !!(ex.downloaded || n.downloaded),
                downloadedAt: ex.downloadedAt || n.downloadedAt || null,
                filename: ex.filename || n.filename || '',
                queueStatus: ex.queueStatus || n.queueStatus || '',
                thumbnail: '',
                preview: '',
                thumbnailLocked: false,
                thumbnailLockedAt: null,
                outputLocked: true,
                outputLockedAt: ex.outputLockedAt || Date.now()
            });
            return;
        }
        // Preserve existing thumbnail/preview if incoming has empty values
        const sameOutput = ex?.src && cleanMediaSrc(ex.src) === cleanMediaSrc(n.src);
        const merged = sameOutput
            ? { ...ex, ...n, selected: ex?.selected ?? true }
            : { ...n, selected: ex?.selected ?? true, thumbnailLocked: false, thumbnailLockedAt: null };
        if (sameOutput) {
            merged.downloaded = !!(ex.downloaded || n.downloaded);
            merged.downloadedAt = ex.downloadedAt || n.downloadedAt || null;
            merged.filename = ex.filename || n.filename || '';
            merged.queueStatus = ex.queueStatus || n.queueStatus || '';
        }
        if (ex?.thumbnail && ex.thumbnail.length > 20 && (!n.thumbnail || n.thumbnail.length < 20)) {
            merged.thumbnail = ex.thumbnail;
        }
        if (sameOutput && hasLockedThumbnail(ex)) {
            merged.thumbnail = ex.thumbnail;
            merged.thumbnailLocked = true;
            merged.thumbnailLockedAt = ex.thumbnailLockedAt || Date.now();
        }
        if (ex?.preview && ex.preview.length > 20 && (!n.preview || n.preview.length < 20)) {
            merged.preview = ex.preview;
        }
        if (expectedType === 'video') {
            merged.preview = '';
            merged.thumbnail = '';
            merged.thumbnailLocked = false;
            merged.thumbnailLockedAt = null;
            merged.outputLocked = true;
            merged.outputLockedAt = merged.outputLockedAt || Date.now();
        } else if (merged.src) {
            merged.preview = '';
            merged.thumbnail = '';
            merged.outputLocked = true;
            merged.outputLockedAt = merged.outputLockedAt || Date.now();
        }
        byPosition.set(n.position, merged);
    });
    promptRecord.outputs = Array.from(byPosition.values())
        .sort((a, b) => a.position - b.position)
        .slice(0, promptExpectedCount(promptRecord));
    if (promptRecord.outputs.length >= promptExpectedCount(promptRecord)) {
        promptRecord.status = promptRecord.outputs.every(i => i.downloaded) ? 'downloaded' : 'ready';
        promptRecord.detectedAt = promptRecord.detectedAt || Date.now();
    } else if (promptRecord.outputs.length > 0) {
        promptRecord.status = 'generating';
    }
    clearDuplicatePromptThumbnails(promptRecord);
}

function filterDuplicateSessionMedia(session, scanPrompts, scanned) {
    const ownerByUrl = new Map();
    (session?.prompts || []).forEach(prompt => {
        (prompt.outputs || []).forEach(item => {
            if (!item?.src || !item?.type) return;
            const key = `${item.type}|${cleanMediaSrc(item.src)}`;
            if (!ownerByUrl.has(key)) {
                ownerByUrl.set(key, { promptIndex: Number(prompt.index), item });
            }
        });
    });

    const promptOrder = new Map((scanPrompts || [])
        .map((prompt, order) => [Number(prompt.index), order]));

    return (scanned || [])
        .slice()
        .sort((a, b) => {
            const ao = promptOrder.get(Number(a.promptIndex)) ?? Number.MAX_SAFE_INTEGER;
            const bo = promptOrder.get(Number(b.promptIndex)) ?? Number.MAX_SAFE_INTEGER;
            return ao - bo || Number(a.position || 1) - Number(b.position || 1);
        })
        .filter(item => {
            if (!item?.src || !item?.type) return false;
            const promptIndex = Number(item.promptIndex);
            const key = `${item.type}|${cleanMediaSrc(item.src)}`;
            const owner = ownerByUrl.get(key);
            if (owner !== undefined && owner.promptIndex !== promptIndex) {
                const ownerPrompt = (session?.prompts || []).find(p => Number(p.index) === owner.promptIndex);
                if (owner.item?.downloaded) return false;
                if (ownerPrompt) {
                    ownerPrompt.outputs = (ownerPrompt.outputs || []).filter(output =>
                        cleanMediaSrc(output?.src) !== cleanMediaSrc(item.src) || output?.type !== item.type);
                    if (!ownerPrompt.outputs.length && ['ready', 'downloaded'].includes(ownerPrompt.status)) {
                        ownerPrompt.status = 'detecting';
                        ownerPrompt.detectedAt = null;
                        ownerPrompt.downloadedAt = null;
                    }
                }
            }
            ownerByUrl.set(key, { promptIndex, item });
            return true;
        });
}

function pruneDuplicateSessionOutputs(session) {
    if (!session?.prompts?.length) return false;
    const ownerByUrl = new Map();
    let changed = false;
    session.prompts
        .slice()
        .sort((a, b) => Number(a.index) - Number(b.index))
        .forEach(prompt => {
            const kept = [];
            (prompt.outputs || []).forEach(item => {
                if (!item?.src || !item?.type) {
                    kept.push(item);
                    return;
                }
                const key = `${item.type}|${cleanMediaSrc(item.src)}`;
                const owner = ownerByUrl.get(key);
                if (owner !== undefined && owner !== Number(prompt.index)) {
                    changed = true;
                    return;
                }
                ownerByUrl.set(key, Number(prompt.index));
                kept.push(item);
            });

            if (kept.length !== (prompt.outputs || []).length) {
                prompt.outputs = kept;
                if (!kept.some(item => item?.src) && ['ready', 'downloaded'].includes(prompt.status)) {
                    prompt.status = 'detecting';
                    prompt.detectedAt = null;
                    prompt.downloadedAt = null;
                } else if (kept.length < promptExpectedCount(prompt) && prompt.status === 'ready') {
                    prompt.status = 'generating';
                }
            }
        });
    return changed;
}

export async function runRealtimeDetectionScan(reason = 'manual') {
    if (scanInFlight && reason !== 'manual') return null;
    const now = Date.now();
    // Reduced throttle: 400ms for storage-change/pulse, 600ms for interval, 0 for manual
    const minGap = reason === 'manual' ? 0 : reason.includes('storage') ? 400 : 600;
    if (reason !== 'manual' && now - lastScanAt < minGap) return null;

    // ── Cross-context scan lock — prevents duplicate scanners in separate extension pages ──
    if (reason !== 'manual') {
        try {
            const lockData = await chrome.storage.local.get(SCAN_LOCK_KEY);
            const lock = lockData[SCAN_LOCK_KEY];
            if (lock && lock.owner !== _scanContextId && (now - lock.at) < 5000) {
                return null; // Another context is actively scanning
            }
            await chrome.storage.local.set({ [SCAN_LOCK_KEY]: { owner: _scanContextId, at: now } });
        } catch (e) { /* non-critical */ }
    }

    scanInFlight = true;
    lastScanAt = now;
    try {
        const { session, settings } = await getDownloadState();
        if (!session?.active) return null;
        // FULL STOP: don't scan if downloads are already done
        if (session.downloadsDone) return null;

        // Get tab early — needed for BOTH detection scan AND thumbnail capture
        const tabs = await chrome.tabs.query({ url: 'https://www.meta.ai/*' });
        const tab = tabs.find(t => t.url?.includes('/create')) || tabs[0];
        if (!tab?.id) return session;

        // Only scan PENDING prompts — skip ready/downloaded (they are done forever)
        // EXCEPTION: also scan 'ready' prompts if their video outputs are missing thumbnails
        const scanPrompts = session.prompts.filter(p => {
            if (p.status === 'downloaded') return false;
            if (p.status === 'ready') {
                // Re-scan ready prompts ONLY if they have videos without thumbnails
                return (p.outputs || []).some(o => shouldCaptureThumbnail(p, o, settings));
            }
            if (['submitted', 'generating', 'detecting', 'timeout'].includes(p.status)) return true;
            return Number(p.index) <= Number(session.currentIndex);
        });

        let changed = pruneDuplicateSessionOutputs(session);
        let changedFlushed = false;

        if (scanPrompts.length) {
            await installMutationObserver();
            const selectedPositions = {};
            scanPrompts.forEach(prompt => {
                selectedPositions[Number(prompt.index)] = getSelectedPosition(promptOutputType(prompt), settings, prompt);
            });

            const res = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                world: 'MAIN',
                func: scanGeneratedOutputs,
                args: [session.startedAt, scanPrompts, session.baselineSignatures || [], Number(session.currentIndex), session.mode || '', session.id || '', 'none', selectedPositions]
            });
            const scanned = filterDuplicateSessionMedia(session, scanPrompts, res?.[0]?.result || []);

            scanPrompts.forEach(promptRecord => {
                const target = session.prompts.find(p => Number(p.index) === Number(promptRecord.index));
                if (!target) return;
                const before = JSON.stringify(target.outputs);
                mergePromptOutputs(session, target, scanned.filter(i => Number(i.promptIndex) === Number(target.index)));
                if (JSON.stringify(target.outputs) !== before) changed = true;
            });

            // ── GATE REPORTING: Tell the unified brain what we detected ─────────
            // For each prompt that now has outputs, report to prompt-gate.js.
            // The gate decides if the selected slot is found and opens/blocks core.js.
            try {
                const activeIdx = await getActiveGatePromptIndex();
                for (const promptRecord of scanPrompts) {
                    const target = session.prompts.find(p => Number(p.index) === Number(promptRecord.index));
                    if (!target || !target.outputs?.length) continue;

                    // Build detected slots for the output type this prompt expects.
                    // Image mode also uses the gate so core.js does not advance
                    // before the Download Manager has seen the selected image slot.
                    const expectedType = (target.mode || session.mode || '') === 'prompt-to-image' ? 'image' : 'video';

                    const detectedSlots = (target.outputs || [])
                        .filter(o => o.src && o.type === expectedType)
                        .map(o => ({
                            position: Number(o.position),
                            src: o.src,
                            thumbnail: o.thumbnail || '',
                            signature: o.signature || ''
                        }));

                    if (!detectedSlots.length) continue;

                    const gateResult = await reportDetectedSlots(Number(target.index), detectedSlots);

                    // ── First-frame preview on gate-open ─────────────────────────
                    // When the selected slot is confirmed detected (gate = ready),
                    // immediately capture a compressed first-frame preview thumbnail.
                    if (false &&
                        settings.captureFirstFrame !== false &&
                        (gateResult.action === 'ready' || gateResult.action === 'fallback') &&
                        gateResult.slot?.src && !gateResult.slot?.thumbnail) {

                        const resolvedSrc = gateResult.slot.src;
                        console.log(`[Gate→Detector] Capturing first frame for prompt ${Number(target.index) + 1}, slot ${gateResult.slot.position}`);
                        captureFirstFramePreview(resolvedSrc, tab.id).then(thumbnail => {
                            if (!thumbnail) return;
                            // Write thumbnail back into session outputs
                            chrome.storage.local.get(SESSION_KEY).then(d => {
                                const s = ensureSessionShape(d[SESSION_KEY]);
                                if (!s) return;
                                let written = false;
                                s.prompts.forEach(p => {
                                    if (Number(p.index) !== Number(target.index)) return;
                                    (p.outputs || []).forEach(o => {
                                        if (o.src === resolvedSrc || o.signature === gateResult.slot.signature) {
                                            o.thumbnail = thumbnail;
                                            o.thumbnailLocked = true;
                                            o.thumbnailLockedAt = o.thumbnailLockedAt || Date.now();
                                            o.outputLocked = true;
                                            o.outputLockedAt = o.outputLockedAt || Date.now();
                                            written = true;
                                        }
                                    });
                                });
                                if (written) saveSession(s).catch(() => {});
                            }).catch(() => {});
                        }).catch(() => {});
                    }
                }
            } catch (gateErr) {
                console.warn('[Gate→Detector] Gate reporting error:', gateErr.message);
            }

            // Detection timeout: mark prompts as 'timeout' if waiting too long with 0 outputs
            // IMMEDIATE RETRY: emit retryTrigger so core.js can re-submit without waiting
            const newlyTimedOut = [];
            if (settings.retryOnTimeout !== false) {
                const timeoutMs = (Number(settings.detectTimeoutMinutes) || 2) * 60 * 1000;
                session.prompts.forEach(p => {
                    if (['submitted', 'generating', 'detecting'].includes(p.status)
                        && (p.outputs || []).length === 0
                        && p.submittedAt
                        && (now - p.submittedAt) > timeoutMs) {
                        p.status = 'timeout';
                        changed = true;
                        newlyTimedOut.push(Number(p.index));
                        console.log('[AutoMeta] Prompt', p.index + 1, 'timed out — triggering immediate retry');
                    }
                });
            }

            if (changed) {
                if (false && thumbnailRetryCount < MAX_THUMBNAIL_RETRIES) {
                    const thumbUpdated = await captureMissingThumbnails(session, tab.id, settings);
                    if (thumbUpdated) {
                        thumbnailRetryCount = 0;
                    } else {
                        thumbnailRetryCount++;
                    }
                }
                await saveSession(session);
                await publishDetectedOutputs(session);
                const aiRetryActive = session.aiRetryState?.enabled
                    && session.aiRetryState?.phase
                    && session.aiRetryState.phase !== 'done';
                if (!aiRetryActive) {
                    await startQueuedDownloads();
                }
                changedFlushed = true;
            }


            if (newlyTimedOut.length > 0) {
                console.log('[AutoMeta] Timed out prompts marked; per-prompt gate owns retries:', newlyTimedOut.map(i => i + 1).join(', '));
            }
        }

        // ── Capture thumbnails for any video that still has no preview ──────
        // MUST be OUTSIDE scanPrompts block — ready/downloaded prompts still need thumbs.
        // BUT: limit retries to prevent infinite loops when thumbnails can't be found
        if (false && !changed && thumbnailRetryCount < MAX_THUMBNAIL_RETRIES) {
            const thumbUpdated = await captureMissingThumbnails(session, tab.id, settings);
            if (thumbUpdated) {
                thumbnailRetryCount = 0; // Reset on success
                await saveSession(session);
                await publishDetectedOutputs(session);
            } else {
                thumbnailRetryCount++;
                if (thumbnailRetryCount >= MAX_THUMBNAIL_RETRIES) {
                    console.log('[AutoMeta] Thumbnail capture gave up after', MAX_THUMBNAIL_RETRIES, 'attempts');
                }
            }
        }

        if (changed && !changedFlushed) {
            await saveSession(session);
            await publishDetectedOutputs(session);
        }

        return session;
    } finally {
        scanInFlight = false;
    }
}

export async function publishDetectedOutputs(session) {

    const { settings } = await getDownloadState();
    if (!session?.active) return;
    const data = await chrome.storage.local.get(DETECTED_KEY);
    const detected = data[DETECTED_KEY] || {};
    let changed = false;
    session.prompts.forEach(prompt => {
        const type = promptOutputType(prompt);
        const pos = getSelectedPosition(type, settings, prompt);
        const key = prompt.index + ':' + type;
        const selected = (prompt.outputs || []).find(i => Number(i.position) === pos && i.src);
        if (!selected) {
            if (detected[key]) {
                delete detected[key];
                changed = true;
            }
            return;
        }
        const prev = detected[key];
        if (selected.managerPublished) {
            if (!prev || prev.src !== selected.src) {
                detected[key] = { ...selected, detectedAt: selected.managerPublishedAt || selected.detectedAt || Date.now(), sessionStartedAt: session.startedAt || 0 };
                changed = true;
            }
            return;
        }
        if (!prev || prev.src !== selected.src) {
            detected[key] = { ...selected, detectedAt: Date.now(), sessionStartedAt: session.startedAt || 0 };
            selected.managerPublished = true;
            selected.managerPublishedAt = selected.managerPublishedAt || Date.now();
            changed = true;
            pushManagerEvent(`prompt ${Number(prompt.index) + 1} ${type} slot ${pos} detected`, 'success', {
                promptIndex: Number(prompt.index),
                type,
                position: pos
            });
        } else if (!selected.managerPublished) {
            selected.managerPublished = true;
            selected.managerPublishedAt = selected.managerPublishedAt || Date.now();
            changed = true;
        }
    });
    if (changed) {
        await chrome.storage.local.set({ [DETECTED_KEY]: detected });
        queueSessionSave(session);
        // ── Only push to gallery AFTER automation stops ───────────────────
        // Saving media URLs to gallery during active automation causes heavy
        // storage writes and triggers UI re-renders that slow the page.
        // We batch-flush gallery once after session.running becomes false.
        if (!session.running) {
            await saveOutputsToGallery(session);
        }
    }
}

async function pushManagerEvent(message, level = 'info', detail = {}) {
    try {
        const data = await chrome.storage.local.get({ [MANAGER_EVENTS_KEY]: [] });
        const events = Array.isArray(data[MANAGER_EVENTS_KEY]) ? data[MANAGER_EVENTS_KEY] : [];
        events.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, at: Date.now(), source: 'download-manager', level, message, detail });
        await chrome.storage.local.set({ [MANAGER_EVENTS_KEY]: events.slice(-120) });
    } catch (e) {
        console.warn('[AutoMeta DM event] skipped:', e.message);
    }
}

async function saveOutputsToGallery(session) {
    const outputs = [];
    (session?.prompts || []).forEach(prompt => {
        (prompt.outputs || []).forEach(item => {
            if (!item?.src) return;
            outputs.push({
                type: item.type,
                src: item.src,
                preview: '',
                thumbnail: '',
                prompt: item.prompt || prompt.prompt || '',
                promptIndex: Number(item.promptIndex ?? prompt.index ?? 0),
                position: Number(item.position || 1),
                sessionId: session.id,
                detectedAt: item.detectedAt || Date.now(),
                downloadedAt: item.downloadedAt || null,
                downloaded: !!item.downloaded,
                source: 'download-manager',
                signature: item.signature || `${session.id}|${item.type}|${item.position}|${item.src}`,
                hash: item.signature || `${session.id}|${item.type}|${item.position}|${cleanMediaSrc(item.src)}`
            });
        });
    });
    if (!outputs.length) return;
    const data = await chrome.storage.local.get({ [CREATE_GALLERY_KEY]: { items: [] } });
    const gallery = data[CREATE_GALLERY_KEY] || { items: [] };
    const map = new Map();
    [...(gallery.items || []), ...outputs].forEach(item => {
        const leanItem = {
            ...item,
            preview: '',
            thumbnail: '',
            thumbnailLocked: false,
            thumbnailLockedAt: null
        };
        const key = item.signature || `${item.type}|${(item.src || '').split('?')[0]}|${(item.prompt || '').slice(0, 160)}`;
        map.set(key, { ...map.get(key), ...leanItem });
    });
    const items = Array.from(map.values()).sort((a, b) => (b.detectedAt || b.savedAt || 0) - (a.detectedAt || a.savedAt || 0)).slice(0, GALLERY_CAP);
    await chrome.storage.local.set({
        [CREATE_GALLERY_KEY]: {
            ...gallery,
            scannedAt: gallery.scannedAt || Date.now(),
            setupComplete: gallery.setupComplete !== false,
            items
        }
    });
}

// ── captureMissingThumbnails ─────────────────────────────────────────────────
// Runs in MAIN world to find video frames for items that still have no preview.
// Works independently of baseline signatures (covers ready/downloaded prompts).
export async function captureMissingThumbnails(session, tabId, settings = {}) {
    if (!session?.prompts?.length) return false;
    return false;
    // ── Skip ALL thumbnail capture while automation is actively running ───
    // Loading video frames from the page during generation adds CPU load
    // and can interfere with the page's own rendering pipeline.
    // Thumbnails are captured from first-frame by prompt-gate.js immediately
    // after each slot is detected, so this function only runs post-session.
    if (session.running === true) {
        return false;
    }
    // Collect items that need a preview. Keep prompt + slot metadata so the
    // page script can fall back to prompt/position matching when Meta swaps URLs.
    const needsThumb = [];
    let lockedExisting = false;
    session.prompts.forEach(prompt => {
        if (clearDuplicatePromptThumbnails(prompt)) lockedExisting = true;
        (prompt.outputs || []).forEach(item => {
            if (item.type === 'video' && item.src && hasUsableThumbnail(item) && !item.thumbnailLocked) {
                lockThumbnailIfReady(item);
                item.preview = '';
                lockedExisting = true;
                return;
            }
            if (shouldCaptureThumbnail(prompt, item, settings)) {
                needsThumb.push({
                    src: item.src,
                    signature: item.signature || '',
                    prompt: item.prompt || prompt.prompt || '',
                    promptIndex: Number(item.promptIndex ?? prompt.index ?? 0),
                    position: Number(item.position || 1),
                    detectedAt: Number(item.detectedAt || prompt.detectedAt || 0),
                    refreshExisting: false
                });
            }
        });
    });
    needsThumb.sort((a, b) => (b.detectedAt || 0) - (a.detectedAt || 0));
    needsThumb.splice(THUMB_BATCH_LIMIT);
    if (!needsThumb.length) return lockedExisting;

    console.log('[Runflow Thumbnail] Capturing previews for', needsThumb.length, 'videos');

    let resolvedTabId = tabId;
    if (!resolvedTabId) {
        const tabs = await chrome.tabs.query({ url: 'https://www.meta.ai/*' });
        const tab = (tabs || []).find(t => t.url?.includes('/create')) || tabs?.[0];
        resolvedTabId = tab?.id;
    }
    if (!resolvedTabId) { console.warn('[Runflow Thumbnail] No Meta AI tab found'); return false; }

    let res;
    try {
        res = await chrome.scripting.executeScript({
            target: { tabId: resolvedTabId },
            world: 'MAIN',
            func: (targets, thumbConfig) => {
                const maxW = Number(thumbConfig?.maxW) || 120;
                const quality = Number(thumbConfig?.quality) || 0.25;
                const maxChars = Number(thumbConfig?.maxChars) || 12000;
                const cleanUrl = (u) => String(u || '').split('?')[0].split('#')[0];
                const cleanText = (t) => String(t || '').replace(/\s+/g, ' ').trim();
                const norm = (t) => cleanText(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
                const similarity = (a, b) => {
                    const na = norm(a), nb = norm(b);
                    if (!na || !nb) return 0;
                    if (na === nb) return 1;
                    const shorter = na.length < nb.length ? na : nb;
                    const longer = na.length < nb.length ? nb : na;
                    if (longer.includes(shorter.slice(0, Math.min(70, shorter.length)))) return 0.92;
                    const aw = new Set(na.split(' ').filter(w => w.length > 3));
                    const bw = nb.split(' ').filter(w => w.length > 3);
                    if (!aw.size || !bw.length) return 0;
                    return bw.filter(w => aw.has(w)).length / Math.max(aw.size, bw.length);
                };
                const targetList = Array.isArray(targets) ? targets : [];
                const wanted = new Set(targetList.map(t => cleanUrl(t?.src || t)).filter(Boolean));
                const out = {};

                const validPreview = (u) => {
                    const s = String(u || '');
                    if (s.length < 20) return '';
                    if (s === 'about:blank' || s.startsWith('data:,')) return '';
                    if (s.startsWith('data:image/')) return s.length <= maxChars ? s : '';
                    return s;
                };

                const validTinyData = (u) => {
                    const s = String(u || '');
                    if (!s || s === 'about:blank' || s.startsWith('data:,')) return '';
                    return s.startsWith('data:image/') && s.length <= maxChars ? s : '';
                };

                const bgUrl = (el) => {
                    if (!el) return '';
                    const style = el.style?.backgroundImage || getComputedStyle(el).backgroundImage || '';
                    const m = style.match(/url\(["']?([^"')]+)["']?\)/);
                    return validPreview(m?.[1] || '');
                };

                const getVideoKeys = (div) => {
                    const keys = new Set();
                    const add = (u) => {
                        const c = cleanUrl(u);
                        if (c) keys.add(c);
                    };
                    add(div.getAttribute('data-video-url'));
                    const vid = div.querySelector('video');
                    if (vid) {
                        add(vid.currentSrc);
                        add(vid.src);
                        add(vid.getAttribute('src'));
                    }
                    div.querySelectorAll('source').forEach(source => {
                        add(source.src);
                        add(source.getAttribute('src'));
                    });
                    return Array.from(keys);
                };

                const collectVideoCards = (root = document) => {
                    const cards = [];
                    const seen = new Set();
                    root.querySelectorAll('[data-testid="generated-video"], video').forEach(node => {
                        const div = node.matches?.('[data-testid="generated-video"]')
                            ? node
                            : (node.closest?.('[data-testid="generated-video"]') || node);
                        if (!div || seen.has(div)) return;
                        seen.add(div);
                        cards.push(div);
                    });
                    return cards;
                };

                const visualPreview = (el) => {
                    if (!el) return '';
                    if (el.tagName === 'IMG') {
                        const compressed = compressImgUrl(el);
                        if (compressed) return compressed;
                        return validPreview(el.currentSrc || el.src || el.getAttribute('src')) || '';
                    }
                    if (el.tagName === 'VIDEO') {
                        return validTinyData(el.poster || el.getAttribute('poster')) || validPreview(el.poster || el.getAttribute('poster')) || canvasThumb(el) || '';
                    }
                    const img = Array.from(el.querySelectorAll?.('img') || [])
                        .find(i => i.complete && i.naturalWidth > 40 && i.naturalHeight > 40 && validPreview(i.currentSrc || i.src));
                    if (img) {
                        const compressed = compressImgUrl(img);
                        if (compressed) return compressed;
                        return validPreview(img.currentSrc || img.src || img.getAttribute('src')) || '';
                    }
                    const video = el.querySelector?.('video');
                    if (video) return validTinyData(video.poster || video.getAttribute('poster')) || validPreview(video.poster || video.getAttribute('poster')) || canvasThumb(video) || '';
                    return bgUrl(el);
                };

                const collectVisualTiles = (root = document) => {
                    const tiles = [];
                    const seen = new Set();
                    const add = (el) => {
                        if (!el || seen.has(el)) return;
                        const r = el.getBoundingClientRect?.();
                        if (!r || r.width < 80 || r.height < 80) return;
                        const preview = visualPreview(el);
                        if (!preview) return;
                        seen.add(el);
                        tiles.push({ el, preview, top: r.top, left: r.left });
                    };
                    root.querySelectorAll('img, video, [style*="background-image"], [data-testid="generated-video"], [data-testid="generated-image"]').forEach(node => {
                        const card = node.closest?.('[data-testid="generated-video"], [data-testid="generated-image"]') || node;
                        add(card);
                    });
                    const unique = [];
                    const previewSeen = new Set();
                    tiles.sort((a, b) => a.top - b.top || a.left - b.left).forEach(tile => {
                        const key = String(tile.preview || '').slice(0, 600);
                        if (!key || previewSeen.has(key)) return;
                        previewSeen.add(key);
                        unique.push(tile);
                    });
                    return unique;
                };

                const isBlankFrame = (ctx, w, h) => {
                    try {
                        const stepX = Math.max(1, Math.floor(w / 12));
                        const stepY = Math.max(1, Math.floor(h / 12));
                        const data = ctx.getImageData(0, 0, w, h).data;
                        let count = 0, total = 0, bright = 0, variance = 0;
                        for (let y = 0; y < h; y += stepY) {
                            for (let x = 0; x < w; x += stepX) {
                                const i = (y * w + x) * 4;
                                const lum = (data[i] * 0.299) + (data[i + 1] * 0.587) + (data[i + 2] * 0.114);
                                total += lum;
                                if (lum > 28) bright++;
                                count++;
                            }
                        }
                        const avg = total / Math.max(1, count);
                        for (let y = 0; y < h; y += stepY) {
                            for (let x = 0; x < w; x += stepX) {
                                const i = (y * w + x) * 4;
                                const lum = (data[i] * 0.299) + (data[i + 1] * 0.587) + (data[i + 2] * 0.114);
                                variance += Math.abs(lum - avg);
                            }
                        }
                        const spread = variance / Math.max(1, count);
                        return avg < 18 || spread < 5 || (bright / Math.max(1, count) < 0.08 && spread < 8);
                    } catch (e) {
                        return false;
                    }
                };

                // COMPRESSED: 160px max, JPEG 0.35 quality, 15KB cap
                const canvasThumb = (vid) => {
                    try {
                        if (!vid || vid.readyState < 2 || !vid.videoWidth || !vid.videoHeight) return '';
                        const scale = Math.min(1, maxW / vid.videoWidth);
                        const w = Math.max(48, Math.round(vid.videoWidth * scale));
                        const h = Math.max(48, Math.round(vid.videoHeight * scale));
                        const c = document.createElement('canvas');
                        c.width = w;
                        c.height = h;
                        const ctx = c.getContext('2d', { alpha: false });
                        ctx.drawImage(vid, 0, 0, w, h);
                        if (isBlankFrame(ctx, w, h)) return '';
                        const d = c.toDataURL('image/jpeg', quality);
                        // 15KB cap — reject oversized thumbnails
                        if (!d || d.length < 500 || d.length > maxChars) return '';
                        return d;
                    } catch (e) {
                        return '';
                    }
                };

                // Compress CDN URL images via canvas for smaller storage footprint
                const compressImgUrl = (imgEl) => {
                    try {
                        if (!imgEl || !imgEl.complete || !imgEl.naturalWidth) return '';
                        const scale = Math.min(1, maxW / imgEl.naturalWidth);
                        const w = Math.max(48, Math.round(imgEl.naturalWidth * scale));
                        const h = Math.max(48, Math.round(imgEl.naturalHeight * scale));
                        const c = document.createElement('canvas');
                        c.width = w;
                        c.height = h;
                        const ctx = c.getContext('2d', { alpha: false });
                        ctx.drawImage(imgEl, 0, 0, w, h);
                        if (isBlankFrame(ctx, w, h)) return '';
                        const d = c.toDataURL('image/jpeg', quality);
                        if (!d || d.length < 500 || d.length > maxChars) return '';
                        return d;
                    } catch (e) {
                        return '';
                    }
                };

                const getPreview = (div) => {
                    // PRIORITY 1: data-video-thumbnail — Meta's official thumbnail CDN URL
                    // This is the MOST reliable source, always use it when available
                    const vid = div.querySelector('video');
                    const metaThumb = validPreview(div.getAttribute?.('data-video-thumbnail'));
                    const metaData = validTinyData(metaThumb);
                    if (metaData) return metaData;
                    if (metaThumb) {
                        const metaImg = Array.from(div.querySelectorAll('img'))
                            .find(i => [i.currentSrc, i.src, i.getAttribute('src')].some(src => String(src || '') === metaThumb));
                        const compressed = compressImgUrl(metaImg);
                        if (compressed) return compressed;
                        return metaThumb;
                    }

                    // PRIORITY 2: img tags inside card (may be the thumbnail rendered as <img>)
                    const imgEl = Array.from(div.querySelectorAll('img'))
                        .find(i => i.complete && i.naturalWidth > 40 && validPreview(i.currentSrc || i.src));
                    if (imgEl) {
                        const compressed = compressImgUrl(imgEl);
                        if (compressed) return compressed;
                        return validPreview(imgEl.currentSrc || imgEl.src || imgEl.getAttribute('src')) || '';
                    }

                    // PRIORITY 3: video poster attribute
                    const poster = validTinyData(vid?.poster || vid?.getAttribute?.('poster'));
                    if (poster) return poster;
                    const posterUrl = validPreview(vid?.poster || vid?.getAttribute?.('poster'));
                    if (posterUrl && !posterUrl.startsWith('data:')) return posterUrl;

                    // PRIORITY 5: background-image CSS
                    const bg = Array.from(div.querySelectorAll('[style*="background-image"]'))
                        .map(bgUrl)
                        .map(validTinyData)
                        .find(Boolean) || validTinyData(bgUrl(div));
                    if (bg) return bg;

                    const vidThumb = canvasThumb(vid);
                    return vidThumb || '';
                };

                collectVideoCards(document).forEach(div => {
                    const keys = getVideoKeys(div);
                    if (!keys.length) return;
                    if (wanted.size && !keys.some(k => wanted.has(k))) return;
                    const preview = getPreview(div);
                    if (!preview) return;
                    keys.forEach(k => { if (!wanted.size || wanted.has(k)) out[k] = preview; });
                });

                // Fallback: same prompt + slot position. This fixes cases where Meta
                // renders the thumbnail/card but the stored video URL is a different
                // blob/currentSrc than data-video-url.
                const articles = Array.from(document.querySelectorAll('article')).map((article, articleIndex) => ({
                    article,
                    articleIndex,
                    text: cleanText((article.textContent || '').slice(0, 1600)),
                    videos: collectVideoCards(article),
                    tiles: collectVisualTiles(article)
                })).filter(a => a.videos.length || a.tiles.length);

                targetList.forEach(target => {
                    const key = cleanUrl(target?.src || target);
                    if (!key || out[key]) return;
                    const pos = Math.max(1, Number(target?.position || 1));
                    let best = null;
                    articles.forEach(candidate => {
                        if (Math.max(candidate.videos.length, candidate.tiles.length) < pos) return;
                        const score = similarity(target?.prompt || '', candidate.text);
                        if (!best || score > best.score || (score === best.score && candidate.articleIndex > best.articleIndex)) {
                            best = { ...candidate, score };
                        }
                    });
                    if (!best || (best.score < 0.58 && articles.length > 1)) return;
                    const preview = getPreview(best.videos[pos - 1]) || best.tiles[pos - 1]?.preview || '';
                    if (preview) out[key] = preview;
                });

                return out;
            },
            args: [needsThumb, { maxW: THUMB_MAX_WIDTH, quality: THUMB_QUALITY, maxChars: THUMB_MAX_CHARS }]
        });
    } catch (e) {
        console.warn('[Runflow Thumbnail] executeScript failed:', e.message);
        return false;
    }

    const previews = res?.[0]?.result || {};
    const found = Object.keys(previews).length;
    if (!found) {
        console.log('[Runflow Thumbnail] No DOM thumbnails found on page yet');
        return false;
    }
    console.log('[Runflow Thumbnail] Found', found, 'previews on page');

    let updated = false;
    session.prompts.forEach(prompt => {
        (prompt.outputs || []).forEach(item => {
            if (item.type !== 'video' || !item.src) return;
            const cleanSrc = item.src.split('?')[0].split('#')[0];
            const p = previews[cleanSrc];
            if (p && (p !== item.thumbnail || !item.thumbnailLocked)) {
                item.thumbnail = p;
                item.preview = '';
                item.thumbnailLocked = true;
                item.thumbnailLockedAt = item.thumbnailLockedAt || Date.now();
                item.outputLocked = true;
                item.outputLockedAt = item.outputLockedAt || item.thumbnailLockedAt || Date.now();
                updated = true;
            }
        });
    });
    if (updated) console.log('[Runflow Thumbnail] Updated previews in session');
    return updated;
}

export { getSessionCompletionState } from './download-state.js';
