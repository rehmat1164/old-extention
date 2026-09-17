// background.js — MV3 Service Worker
// Keeps download watchdog alive using alarms even when UI is closed

const SESSION_KEY = 'autoMetaCopy_downloadSession';
const DONE_KEY    = 'autoMetaCopy_downloadedOutputs';
const IN_PROGRESS_KEY = 'autoMetaCopy_downloadingOutputs';
const DOWNLOAD_LOCK_TTL = 5 * 60 * 1000;

async function acquireDownloadSlot(key) {
  const owner = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  const data = await chrome.storage.local.get({ [DONE_KEY]: [], [IN_PROGRESS_KEY]: {} });
  const done = new Set(Array.isArray(data[DONE_KEY]) ? data[DONE_KEY] : []);
  if (done.has(key)) return { ok: false, reason: 'already downloaded' };
  const active = data[IN_PROGRESS_KEY] && typeof data[IN_PROGRESS_KEY] === 'object' ? data[IN_PROGRESS_KEY] : {};
  Object.keys(active).forEach(k => {
    if (!active[k]?.at || now - Number(active[k].at) > DOWNLOAD_LOCK_TTL) delete active[k];
  });
  if (active[key]) return { ok: false, reason: 'download already in progress' };
  active[key] = { owner, at: now };
  await chrome.storage.local.set({ [IN_PROGRESS_KEY]: active });
  const verify = await chrome.storage.local.get({ [IN_PROGRESS_KEY]: {} });
  if (verify[IN_PROGRESS_KEY]?.[key]?.owner !== owner) return { ok: false, reason: 'download lock lost' };
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

function normalizeAutoDownloadMode(mode) {
  if (mode === 'afterAllReadyZip' || mode === 'afterAllComplete-zip') return 'afterAllReadyZip';
  if (mode === 'afterReady' || mode === 'perPromptReady' || mode === 'afterAllComplete' || mode === 'manual') return 'afterReady';
  return 'afterReady';
}

function normalizeSrc(src) {
  return (src || '').split('#')[0].split('?')[0];
}

function downloadedKey(session, item) {
  if (!item) return '';
  return item.signature || `${session?.id || 'session'}|${Number(item.promptIndex)}|${item.type}|${Number(item.position || 1)}|${normalizeSrc(item.src)}`;
}

function promptExpectedCount(prompt) {
  return Number(prompt?.expected) || (prompt?.mode === 'image-to-video' ? 1 : 4);
}

function selectedPositionFor(type, settings, prompt) {
  const custom = settings?.customSelections?.[prompt?.index];
  if (custom && custom !== 'auto') return Number(custom);
  const stored = type === 'image' ? settings.imageGenerationSelect : settings.videoGenerationSelect;
  if (stored && stored !== 'auto') return Number(stored);
  return promptExpectedCount(prompt);
}

function preferredOutputFor(prompt, settings) {
  const outputs = prompt?.outputs || [];
  const type = prompt?.mode === 'prompt-to-image' ? 'image' : 'video';
  const resolved = prompt?.resolvedPosition ? Number(prompt.resolvedPosition) : selectedPositionFor(type, settings, prompt);
  let item = outputs.find(o => Number(o.position) === resolved && o.src);
  if (item) return item;
  const selected = selectedPositionFor(type, settings, prompt);
  item = outputs.find(o => Number(o.position) === selected && o.src);
  if (item) return item;
  const secondary = type === 'video' && settings.secondaryVideoGenerationSelect && settings.secondaryVideoGenerationSelect !== 'auto'
    ? Number(settings.secondaryVideoGenerationSelect)
    : promptExpectedCount(prompt);
  if (Number(secondary) !== Number(selected)) {
    item = outputs.find(o => Number(o.position) === Number(secondary) && o.src);
    if (item) return item;
  }
  return null;
}

function selectedComplete(session, settings) {
  const prompts = session?.prompts || [];
  return prompts.length > 0 && prompts.every(prompt => {
    if (['failed', 'timeout', 'unrecoverable'].includes(prompt.status)) return true;
    return !!preferredOutputFor(prompt, settings);
  });
}

function selectedDownloadsComplete(session, settings) {
  const prompts = session?.prompts || [];
  return prompts.length > 0 && prompts.every(prompt => {
    if (['failed', 'timeout', 'unrecoverable'].includes(prompt.status)) return true;
    const item = preferredOutputFor(prompt, settings);
    return !!(item?.src && item.downloaded);
  });
}

// ── Badge helpers ────────────────────────────────────────────────────────────
function setBadge(text, color) {
  chrome.action.setBadgeText({ text: text || '' });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// ── Sidepanel toggle ─────────────────────────────────────────────────────────
chrome.action.onClicked.addListener((tab) => {
  if (tab.url && tab.url.includes('meta.ai')) {
    chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' })
      .catch(() => {
        // Content script not ready yet — try sidePanel as fallback
        chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId }).catch(() => {});
      });
  } else if (tab.id) {
    chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId }).catch(() => {});
  }
});

// ── Download watchdog via storage listener ───────────────────────────────────
// When UI (overlay/sidepanel) is closed, background ensures downloads continue.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  if (!changes[SESSION_KEY]) return;

  const session = changes[SESSION_KEY].newValue;
  const localSettings = await chrome.storage.local.get({
    autoDownload: session?.settings?.autoDownload ?? session?.autoDownload ?? true,
    autoDownloadMode: session?.settings?.autoDownloadMode ?? session?.autoDownloadMode ?? 'afterReady',
    downloadFolder: session?.settings?.downloadFolder ?? session?.folder ?? 'meta-videos',
    imageGenerationSelect: session?.settings?.imageGenerationSelect ?? session?.imageSelect ?? 'auto',
    videoGenerationSelect: session?.settings?.videoGenerationSelect ?? session?.videoSelect ?? 'auto',
    secondaryVideoGenerationSelect: session?.settings?.secondaryVideoGenerationSelect ?? session?.secondaryVideoSelect ?? 'auto',
    customSelections: session?.settings?.customSelections ?? session?.customSelections ?? {}
  });
  const settings = { ...localSettings, ...(session || {}), ...(session?.settings || {}) };
  settings.autoDownloadMode = normalizeAutoDownloadMode(settings.autoDownloadMode);
  const autoDownloadEnabled = settings.autoDownload !== false && settings.autoDownload !== 'false';
  if (!session?.active || !autoDownloadEnabled) {
    setBadge('');
    return;
  }
  if (session.downloadStartRequested !== true) {
    setBadge('');
    return;
  }

  // Get already-downloaded keys
  const doneData = await chrome.storage.local.get(DONE_KEY);
  const doneSet  = new Set(Array.isArray(doneData[DONE_KEY]) ? doneData[DONE_KEY] : []);

  // Find selected outputs that are ready but not yet downloaded
  const pending = [];
  (session.prompts || []).forEach(prompt => {
    if (!['ready','downloaded'].includes(prompt.status)) return;
    const item = preferredOutputFor(prompt, settings);
    if (item?.downloaded) return;
    const key     = item ? downloadedKey(session, item) : null;
    if (item && key && !doneSet.has(key)) pending.push({ item, key });
  });

  if (!pending.length) {
    // All done
    const anyActive = (session.prompts || []).some(p => !['ready','downloaded','failed','timeout','unrecoverable'].includes(p.status));
    setBadge(anyActive ? '⏳' : '✓', anyActive ? '#F59E0B' : '#10B981');
    return;
  }

  setBadge(`${pending.length}`, '#4361EE');

  // ZIP mode waits for all selected outputs; individual mode streams as each is ready.
  const mode = settings.autoDownloadMode;
  const allSelectedReady = selectedComplete(session, settings);

  if (mode === 'afterAllReadyZip' && !allSelectedReady) {
    return; // wait for all selected outputs to finish
  }

  // ZIP mode needs an extension page to build a Blob. Record a visible
  // session flag instead of silently waiting in the background.
  if (mode === 'afterAllReadyZip') {
    setBadge('ZIP', '#7C3AED');
    if (!session.zipNeedsManager) {
      await chrome.storage.local.set({
        [SESSION_KEY]: {
          ...session,
          zipNeedsManager: true,
          zipStatus: 'Open Download Manager to build ZIP.'
        }
      });
    }
    return;
  }

  const lockData = await chrome.storage.local.get('autoMetaCopy_downloadLock');
  const lock = lockData['autoMetaCopy_downloadLock'];
  if (lock && (Date.now() - lock.at) < 30000) {
    return;
  }
  await chrome.storage.local.set({ autoMetaCopy_downloadLock: { at: Date.now(), owner: 'background' } });

  // Trigger each pending download via chrome.downloads directly
  for (const { item, key } of pending) {
    const itemLock = await acquireDownloadSlot(key);
    if (!itemLock.ok) continue;
    const folder = settings.downloadFolder || session.folder || 'meta-videos';
    const safeFolder = folder.replace(/[<>:"/\\|?*]+/g, '_').trim();
    const ext  = item.type === 'video' ? 'mp4' : 'jpg';
    const filename = `${safeFolder}/prompt ${Number(item.promptIndex) + 1} - ${item.type} ${Number(item.position || 1)}.${ext}`;

    chrome.downloads.download({ url: item.src, filename, conflictAction: 'uniquify' }, (downloadId) => {
      if (!chrome.runtime.lastError && downloadId !== undefined) {
        // Mark as downloaded in storage
        chrome.storage.local.get([DONE_KEY, SESSION_KEY], (data) => {
          const done = new Set(Array.isArray(data[DONE_KEY]) ? data[DONE_KEY] : []);
          done.add(key);
          const updates = { [DONE_KEY]: Array.from(done) };

          // Also update session.prompts[x].outputs[y].downloaded = true
          const sess = data[SESSION_KEY];
          if (sess?.prompts) {
            sess.prompts = sess.prompts.map(p => {
              if (Number(p.index) !== Number(item.promptIndex)) return p;
              const outputs = (p.outputs || []).map(o => {
                const oKey = downloadedKey(sess, o);
                if (oKey === key) return { ...o, downloaded: true, downloadedAt: Date.now(), filename };
                return o;
              });
              const allDone = outputs.length > 0 && outputs.every(o => o.downloaded);
              return { ...p, outputs, status: allDone ? 'downloaded' : p.status };
            });

            // ── Signal core.js when ALL session downloads complete ──────────────
            const allPromptsSubmitted = sess.allPromptsSubmitted;
            const allSessionDone = allPromptsSubmitted && selectedDownloadsComplete(sess, settings);
            if (allSessionDone && !sess.downloadsDone) {
              sess.downloadsDone = true;
              setBadge('✓', '#10B981');
              console.log('[AutoMeta BG] downloadsDone=true — all downloads complete');
            }

            updates[SESSION_KEY] = sess;
          }
          chrome.storage.local.set(updates, () => { releaseDownloadSlot(itemLock); });
        });
      } else {
        releaseDownloadSlot(itemLock);
      }
    });

    // Small delay between downloads to avoid browser rate limiting
    await new Promise(r => setTimeout(r, 600));
  }
  chrome.storage.local.remove('autoMetaCopy_downloadLock');
});

// ── Message listener ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'openDownloadsSettings') {
    chrome.tabs.create({ url: 'chrome://settings/downloads' });
    sendResponse({ success: true });
    return false;
  }

  if (request.type === 'openFolderPicker') {
    chrome.tabs.create({ url: chrome.runtime.getURL('folder-picker.html') }, (tab) => {
      if (chrome.runtime.lastError) sendResponse({ success: false, error: chrome.runtime.lastError.message });
      else sendResponse({ success: true, tabId: tab.id });
    });
    return true;
  }

  if (request.type === 'openDownloadManager') {
    chrome.tabs.create({ url: chrome.runtime.getURL('download-manager.html') }, (tab) => {
      if (chrome.runtime.lastError) sendResponse({ success: false, error: chrome.runtime.lastError.message });
      else sendResponse({ success: true, tabId: tab.id });
    });
    return true;
  }

  if (request.type === 'openSidePanelPopup') {
    if (sender.tab?.id) {
      chrome.sidePanel.open({ tabId: sender.tab.id, windowId: sender.tab.windowId })
        .then(() => sendResponse({ success: true }))
        .catch((error) => sendResponse({ success: false, error: error?.message || 'Unable to open side panel' }));
    } else {
      sendResponse({ success: false, error: 'Tab ID missing' });
      return false;
    }
    return true;
  }

  if (request.type === 'downloadFile') {
    if (!request.url) { sendResponse({ success: false, error: 'missing url' }); return false; }
    chrome.downloads.download({ url: request.url, filename: request.filename || 'download.mp4', conflictAction: 'uniquify' }, (downloadId) => {
      if (chrome.runtime.lastError) sendResponse({ success: false, error: chrome.runtime.lastError.message });
      else sendResponse({ success: true, downloadId });
    });
    return true;
  }

  if (request.type === 'clearBadge') {
    setBadge('');
    sendResponse({ success: true });
    return false;
  }

  sendResponse({ success: false, error: `Unhandled message type: ${request.type || 'unknown'}` });
  return false;
});
