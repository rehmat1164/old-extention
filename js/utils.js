import { translations } from './config.js';

let currentLang = 'en';
const LOG_STORAGE_KEY = 'autoMetaCopy_activityLog';
const RESUME_STORAGE_KEY = 'autoMetaCopy_resumeState';

export function setGlobalLang(lang) {
    currentLang = lang;
}

export function getCurrentLang() {
    return currentLang;
}

export function i18n(key, replacements = {}) {
    const langDict = translations[currentLang] || translations['en'] || {};
    let translation = langDict[key] || `[${key}]`;
    for (const placeholder in replacements) {
        translation = translation.replace(`{${placeholder}}`, replacements[placeholder]);
    }
    return translation;
}

function cleanLogMessage(message) {
    return String(message)
        .replace(/^\[[^\]]+\]\s*/g, '')
        .replace(/[^\x20-\x7E]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function logBadge(type) {
    return ({ system: 'SYS', success: 'OK', warn: 'WAIT', error: 'ERR', info: 'INFO' })[type] || 'INFO';
}

function normalizeLogType(type, message) {
    const current = ['system', 'success', 'warn', 'error', 'info'].includes(type) ? type : 'info';
    if (current !== 'info' && current !== 'system') return current;
    const text = String(message || '').toLowerCase();
    if (/\b(error|failed|fail|missing|timeout|stuck|denied|blocked)\b/.test(text)) return 'error';
    if (/\b(warn|wait|retry|retrying|paused|partial)\b/.test(text)) return 'warn';
    if (/\b(detected|ready|downloaded|complete|success|saved|moving next)\b/.test(text)) return 'success';
    return current;
}

export function logMessage(message, type = 'info') {
    const logDisplay = document.getElementById('logDisplay');
    if (!logDisplay) return;
    const cleanMessage = cleanLogMessage(message);
    const finalType = normalizeLogType(type, cleanMessage);

    const entry = document.createElement('div');
    entry.className = `log-entry ${finalType}`;

    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    const badgeSpan = document.createElement('span');
    badgeSpan.className = 'log-badge';
    badgeSpan.textContent = logBadge(finalType);

    const msgSpan = document.createElement('span');
    msgSpan.className = 'log-message';
    msgSpan.textContent = cleanMessage;

    entry.appendChild(timeSpan);
    entry.appendChild(badgeSpan);
    entry.appendChild(msgSpan);
    logDisplay.appendChild(entry);
    logDisplay.scrollTop = logDisplay.scrollHeight;

    try {
        if (chrome?.storage?.local) {
            chrome.storage.local.get(LOG_STORAGE_KEY, (data) => {
                const logs = Array.isArray(data[LOG_STORAGE_KEY]) ? data[LOG_STORAGE_KEY] : [];
                logs.push(entry.outerHTML);
                chrome.storage.local.set({ [LOG_STORAGE_KEY]: logs.slice(-250) });
            });
        }
    } catch (e) {
        console.warn('[AutoMeta] Log persistence skipped:', e.message);
    }
}

export async function restoreLogMessages() {
    const logDisplay = document.getElementById('logDisplay');
    if (!logDisplay || !chrome?.storage?.local) return;

    const stateData = await chrome.storage.local.get(RESUME_STORAGE_KEY);
    const resumeState = stateData[RESUME_STORAGE_KEY];
    if (!resumeState?.isRunning) {
        logDisplay.innerHTML = '';
        await chrome.storage.local.remove(LOG_STORAGE_KEY);
        return;
    }

    const data = await chrome.storage.local.get(LOG_STORAGE_KEY);
    const logs = Array.isArray(data[LOG_STORAGE_KEY]) ? data[LOG_STORAGE_KEY] : [];
    if (logs.length > 0) {
        logDisplay.innerHTML = logs.join('');
        logDisplay.scrollTop = logDisplay.scrollHeight;
    }
}

export function updateLiveStatus(message, type = 'info') {
    const liveStatus = document.getElementById('liveStatus');
    if (!liveStatus) return;

    const colorMap = {
        info: 'var(--text-main)',
        success: 'var(--success-color)',
        warn: '#F59E0B',
        error: 'var(--danger-color)'
    };

    liveStatus.textContent = message;
    liveStatus.style.color = colorMap[type] || 'var(--text-main)';
}

export function readFileAsDataURL(file) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => {
            logMessage(i18n('log_file_read_error', { filename: file.name }), 'error');
            resolve(null);
        };
        reader.readAsDataURL(file);
    });
}

export async function interruptibleSleep(ms, stopCheckFn) {
    const checkInterval = 250;
    const endTime = Date.now() + ms;

    while (Date.now() < endTime) {
        if (stopCheckFn && stopCheckFn()) return 'STOPPED';
        const remaining = endTime - Date.now();
        await new Promise(r => setTimeout(r, Math.min(checkInterval, remaining > 0 ? remaining : 0)));
    }
    return 'COMPLETED';
}

export function getRandomWait(minStr, maxStr) {
    const min = parseInt(minStr || '10', 10) || 10;
    const max = parseInt(maxStr || '20', 10) || 20;
    const actualMin = Math.min(min, max);
    const actualMax = Math.max(min, max);
    return Math.max(1000, (Math.floor(Math.random() * (actualMax - actualMin + 1)) + actualMin) * 1000);
}

export function logBilingualError(errorCode, context = {}) {
    const errors = {
        new_chat_failed: {
            en: 'Failed to start new chat',
            ur: 'Naya chat shuru nahi ho saka',
            detail: 'Button not found and keyboard shortcut failed | Button nahi mila aur keyboard shortcut bhi fail'
        },
        button_not_found: {
            en: `Button not found: ${context.button || 'unknown'}`,
            ur: `Button nahi mila: ${context.button || 'unknown'}`,
            detail: 'UI element missing from page | Page par UI element nahi hai'
        },
        upload_failed: {
            en: 'Image upload failed',
            ur: 'Image upload fail ho gaya',
            detail: 'File input not found or upload rejected | File input nahi mila ya upload reject ho gaya'
        },
        generation_timeout: {
            en: 'Generation timed out',
            ur: 'Generation ka time khatam ho gaya',
            detail: 'Media not detected within time limit | Time limit ke andar media detect nahi hua'
        },
        download_failed: {
            en: 'Download failed',
            ur: 'Download fail ho gaya',
            detail: 'Media URL not accessible | Media URL accessible nahi hai'
        }
    };

    const error = errors[errorCode] || {
        en: `Unknown error: ${errorCode}`,
        ur: `Unknown error: ${errorCode}`,
        detail: 'No details available | Koi detail nahi hai'
    };

    logMessage(`ERROR: ${error.en} | ${error.ur}`, 'error');
    logMessage(`Details: ${error.detail}`, 'error');

    if (context.solution) {
        logMessage(`Solution: ${context.solution}`, 'info');
    }
}
