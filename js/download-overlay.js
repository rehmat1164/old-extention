import { flattenOutputs, getDownloadState, getPreferredOutput, getResolvedPosition, getSessionCompletionState, promptExpectedCount, promptOutputType, saveDownloadSettings, saveSession, archiveSessionToHistory, getSessionHistory } from './download-state.js';
import { initRealtimeDetection, runRealtimeDetectionScan } from './download-detector.js';
import { downloadItem, startQueuedDownloads, downloadAllAsZip } from './download-actions.js';


const FLOATING_STATE_KEY = 'autoMetaCopy_floatingWindowState';
let root = null, activeTab = 'queue', initialized = false, lastRender = '';
let _isStandaloneTab = false;  // true when running in download-manager.html (new tab)
let floatingState = { visible: false, activeTab: 'queue', minimized: false, maximized: false, lockSizeAfterReopen: false };
const QUEUE_PAGE_SIZE = 8;
const DOWNLOAD_PAGE_SIZE = 24;
const HISTORY_PAGE_SIZE = 20;
let queueWindowStart = 0;
let downloadLimit = DOWNLOAD_PAGE_SIZE;
let historyLimit = HISTORY_PAGE_SIZE;
let renderTimer = null;
let queueManualMode = false;
let queueSessionId = '';
let historyZipRunning = false;
const VALID_TABS = new Set(['queue', 'downloads', 'history']);
const $ = id => root?.querySelector(`#${id}`);
const parentPost = (type, payload = {}) => window.parent?.postMessage({ source: 'autoMetaCopy', type, ...payload }, '*');

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function escapeAttr(value = '') {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function scheduleRender(immediate = false) {
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = setTimeout(() => {
    renderTimer = null;
    render();
  }, immediate ? 0 : 140);
}


function ensureStyles() {
  if (document.getElementById('amStyles')) return;
  const link = document.createElement('link');
  link.id = 'amStyles';
  link.rel = 'stylesheet';
  link.href = chrome.runtime.getURL('js/download-overlay.css') + '?v=' + Date.now();
  document.head.appendChild(link);
}

function markup() {
  return `<section class="win${floatingState.minimized ? ' min' : ''}">
  <header class="hdr" id="amDrag">
    <div class="hdr-left">
      <img src="${chrome.runtime.getURL('auto Meta new logo animation.gif')}" alt="logo" style="width:28px;height:28px;border-radius:8px;object-fit:contain;flex-shrink:0">
      <div>
        <div class="kicker">Mete Run</div>
        <div class="title">Download Manager</div>
      </div>
    </div>
    <span id="amBadge" class="badge">Idle</span>
    <span id="amAspectRatio" style="display:none;font-size:10px;font-weight:800;padding:3px 8px;border-radius:99px;margin-left:4px;background:#F1F5F9;color:#475569;border:1px solid #E2E8F0;"></span>
    <span id="amModeBadge" style="display:none;font-size:10px;font-weight:800;padding:3px 8px;border-radius:99px;margin-left:4px;"></span>
    <div id="amMinBar" class="min-bar" style="display:none">
      <span id="amMinSent" class="min-pill">Sent: <b>0</b></span>
      <span id="amMinDetected" class="min-pill detected">Detected: <b>0/0</b></span>
      <span id="amMinSending" class="min-pill sending" style="display:none"></span>
      <span id="amMinDetecting" class="min-pill detecting" style="display:none"></span>
    </div>
    <div class="hdr-btns">
      <button class="lock-toggle" id="amLockFit" title="No Resize After Reopen" aria-pressed="false">
        <span class="lock-dot"></span>
        <span class="lock-text">Auto fit</span>
      </button>
      <button class="ico" id="amMin" title="Minimize">-</button>
      <button class="ico" id="amMax" title="Maximize">&#9633;</button>
      <button class="ico" id="amClose" title="Close">x</button>
    </div>
  </header>
  <nav class="tabs">
    <button data-tab="queue" class="on">Queue</button>
    <button data-tab="downloads">Downloads</button>
    <button data-tab="history">History</button>
  </nav>
  <div class="stats">
    <div class="stat"><div class="lbl">Total Prompts</div><div class="val" id="sP">0</div></div>
    <div class="stat"><div class="lbl">Detected</div><div class="val" id="sDt">0</div></div>
    <div class="stat"><div class="lbl">Ready To Download</div><div class="val" id="sR">0</div></div>
    <div class="stat"><div class="lbl">Failed</div><div class="val" id="sMi">0</div></div>
  </div>
  <main class="body">
    <div id="vQueue" class="view on">
      <div class="toolbar">
        <button id="bScan">&#8634; Scan</button>
        <details class="download-menu" id="manualDownloadMenu">
          <summary>Download Manually</summary>
          <div class="download-menu-pop">
            <button data-manual-download="selected">Selected slots</button>
            <button data-manual-download="zip">Selected as ZIP</button>
            <div class="menu-sep"></div>
            <button data-manual-download="slot-1">Slot 1</button>
            <button data-manual-download="slot-2">Slot 2</button>
            <button data-manual-download="slot-3">Slot 3</button>
            <button data-manual-download="slot-4">Slot 4</button>
          </div>
        </details>
        <button id="bRetryPrompt" class="btn-ghost">&#8635; Retry Undetected</button>
      </div>
      <span id="zipStatus" class="zip-status"></span>
      <section id="managerActivity" class="manager-activity"></section>
      <section id="nowPanel" class="now-panel"></section>
      <section id="failedPromptsPanel" class="fp-panel" style="display:none">
        <div class="fp-header">
          <span class="fp-title">&#9888;&#65039; Failed Prompts — AI Retry</span>
          <span id="fpCount" class="fp-badge">0</span>
        </div>
        <div id="fpStatus" class="fp-status"></div>
        <div id="fpList" class="fp-list"></div>
      </section>
      <div id="amCloseBanner" style="display:none;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;margin:0 14px 0;border-radius:14px;background:#ECFDF5;border:1.5px solid #A7F3D0;flex-shrink:0">
        <span style="font-size:12px;font-weight:800;color:#065F46">&#10003; All done! Session complete.</span>
        <button id="bCloseSession">Archive &amp; Close Session</button>
      </div>
      <div id="qNav" class="queue-nav-persistent"></div>
      <div id="qGroups" class="groups">
      </div>
    </div>
    <div id="vDownloads" class="view">
      <div id="dlList" class="groups" style="margin-top:8px"></div>
    </div>
    <div id="vHistory" class="view">
      <div id="histList" class="groups" style="margin-top:8px"></div>
    </div>
  </main>

  <div class="rsz r" data-edge="right"></div>
  <div class="rsz b" data-edge="bottom"></div>
  <div class="rsz l" data-edge="left"></div>
  <div class="rsz t" data-edge="top"></div>
  <div class="rsz c br" data-edge="right bottom"></div>
  <div class="rsz c bl" data-edge="left bottom"></div>
  <div class="rsz c tr" data-edge="right top"></div>
  <div class="rsz c tl" data-edge="left top"></div>
  <div id="amPreview" class="preview-modal" hidden>
    <div class="preview-backdrop" data-preview-close></div>
    <div class="preview-panel">
      <button class="preview-close" data-preview-close>×</button>
      <div id="amPreviewMedia" class="preview-media"></div>
      <div id="amPreviewMeta" class="preview-meta"></div>
    </div>
  </div>
</section>`;
}

function mediaCard(item, opts = {}) {
  // ── AUTOMATION RUNNING: zero-weight placeholder only ───────────────────
  // When session is active & running we NEVER inject img/video tags.
  // This prevents the browser from fetching any media URLs during automation.
  if (!item?.src) {
    return '<div class="skel"><div class="skel-inner"></div><span class="skel-icon">&#9654;</span><span class="skel-text">Generating...</span></div>';
  }
  if (opts.lightMode) {
    // Light pill: just a coloured icon — zero network traffic
    const icon = item.type === 'image' ? '&#128247;' : '&#127909;';
    const label = item.type === 'image' ? 'Image' : 'Video';
    return `<div class="light-pill"><span>${icon}</span><span>${label}</span></div>`;
  }
  // DEFERRED MODE: non-selected slots show lightweight placeholder, load on hover
  if (opts.deferred) {
    return '<div class="slot-deferred-placeholder"><div class="vid-play"><div class="vid-play-icon">&#9654;</div></div></div>';
  }
  if (item.type === 'video') {
    const preview = item.thumbnail && item.thumbnail.length > 20 ? item.thumbnail : '';
    let mediaHtml;
    if (preview) {
      mediaHtml = '<img class="preview-img lazy-img" data-lazy-src="' + escapeAttr(preview) + '" src="" loading="lazy" decoding="async" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{className:\'video-thumb-skeleton\'}))">'
    } else {
      mediaHtml = '<video class="thumb-video" data-video-src="' + escapeAttr(item.src) + '" data-video-sig="' + escapeAttr(item.signature || '') + '" muted playsinline preload="metadata" aria-label="Video thumbnail"></video>' +
        '<div class="video-thumb-skeleton video-fallback-bg" aria-label="Thumbnail loading"></div>';
    }
    return '<div class="media-wrap video-placeholder">' +
      mediaHtml +
      '<div class="vid-play"><div class="vid-play-icon">&#9654;</div></div>' +
      '</div>';
  }
  // image
  return '<img class="preview-img lazy-img" data-lazy-src="' + escapeAttr(item.preview || item.src) + '" src="" loading="lazy" decoding="async"' +
    ' onerror="this.parentElement.innerHTML=\'<div class=preview-fail>Preview unavailable</div>\'">';
}

// LAZY LOADING: IntersectionObserver for all data-lazy-src images
let _lazyObserver = null;
function initLazyLoading() {
  if (!root) return;
  // Disconnect previous observer
  if (_lazyObserver) _lazyObserver.disconnect();
  _lazyObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const img = entry.target;
      if (entry.isIntersecting) {
        const lazySrc = img.dataset.lazySrc;
        if (lazySrc && img.src !== lazySrc) {
          img.src = lazySrc;
          img.classList.remove('lazy-placeholder');
          img.classList.add('lazy-loaded');
        }
      } else {
        // Keep loaded thumbnails stable. Clearing src here causes visible flicker
        // when the manager rerenders or the user scrolls back to a prompt.
      }
    });
  }, { root: root.querySelector('.body'), rootMargin: '200px 0px' });
  // Observe all lazy images
  root.querySelectorAll('.lazy-img[data-lazy-src]').forEach(img => _lazyObserver.observe(img));
}

function initVideoThumbnails() {
  initLazyLoading();
  initSafeVideoThumbFallback();
}

// HOVER-TO-REVEAL: For non-selected slots, load thumbnail on first hover
function _initHoverReveal() {
  if (!root) return;
  root.querySelectorAll('.card.slot-deferred').forEach(card => {
    if (card.dataset.hoverBound === '1') return;
    card.dataset.hoverBound = '1';
    card.addEventListener('pointerenter', function _onHover() {
      card.removeEventListener('pointerenter', _onHover);
      const thumb = card.dataset.thumb;
      const placeholder = card.querySelector('.slot-deferred-placeholder');
      if (!placeholder) return;
      if (thumb && thumb.length > 20) {
        // We have a cached thumbnail — render it instantly
        const img = document.createElement('img');
        img.className = 'preview-img lazy-loaded locked-thumb-img';
        img.src = thumb;
        img.loading = 'eager';
        img.decoding = 'async';
        const wrap = document.createElement('div');
        wrap.className = 'media-wrap video-placeholder';
        wrap.appendChild(img);
        const play = document.createElement('div');
        play.className = 'vid-play';
        play.innerHTML = '<div class="vid-play-icon">&#9654;</div>';
        wrap.appendChild(play);
        placeholder.replaceWith(wrap);
        card.classList.remove('slot-deferred');
      } else {
        // No cached thumbnail — try loading video frame
        const videoSrc = card.dataset.previewSrc;
        if (!videoSrc) return;
        const video = document.createElement('video');
        video.className = 'thumb-video';
        video.muted = true;
        video.playsInline = true;
        video.preload = 'metadata';
        video.dataset.videoSrc = videoSrc;
        video.dataset.videoSig = card.dataset.sig || '';
        const wrap = document.createElement('div');
        wrap.className = 'media-wrap video-placeholder';
        wrap.appendChild(video);
        const bg = document.createElement('div');
        bg.className = 'video-thumb-skeleton video-fallback-bg';
        wrap.appendChild(bg);
        const play = document.createElement('div');
        play.className = 'vid-play';
        play.innerHTML = '<div class="vid-play-icon">&#9654;</div>';
        wrap.appendChild(play);
        placeholder.replaceWith(wrap);
        card.classList.remove('slot-deferred');
        // Load the video thumb through existing pipeline
        loadVideoThumb(video, () => {});
      }
    }, { once: true });
  });
}

let _videoThumbObserver = null;
let _videoThumbActive = 0;
const _videoThumbQueue = [];
const VIDEO_THUMB_MAX_ACTIVE = 2;

function initSafeVideoThumbFallback() {
  if (!root) return;
  if (_videoThumbObserver) _videoThumbObserver.disconnect();
  _videoThumbQueue.length = 0;
  _videoThumbActive = 0;

  const pump = () => {
    while (_videoThumbActive < VIDEO_THUMB_MAX_ACTIVE && _videoThumbQueue.length) {
      const video = _videoThumbQueue.shift();
      if (!video?.isConnected || video.dataset.thumbLoaded === '1' || video.dataset.thumbLoading === '1') continue;
      loadVideoThumb(video, pump);
    }
  };

  _videoThumbObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const video = entry.target;
      if (!entry.isIntersecting || video.dataset.thumbLoaded === '1' || video.dataset.thumbQueued === '1') return;
      video.dataset.thumbQueued = '1';
      _videoThumbQueue.push(video);
    });
    pump();
  }, { root: root.querySelector('.body'), rootMargin: '80px 0px', threshold: 0.15 });

  root.querySelectorAll('.thumb-video[data-video-src]').forEach(video => _videoThumbObserver.observe(video));
}

function captureTinyVideoFrame(video) {
  try {
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return '';
    const maxW = 160;
    const scale = Math.min(1, maxW / video.videoWidth);
    const w = Math.max(48, Math.round(video.videoWidth * scale));
    const h = Math.max(48, Math.round(video.videoHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.drawImage(video, 0, 0, w, h);
    const data = canvas.toDataURL('image/jpeg', 0.30);
    return data && data.length > 500 && data.length < 15000 ? data : '';
  } catch (e) {
    return '';
  }
}

async function lockVideoThumbInSession(video, thumbnail) {
  if (!thumbnail) return false;
  const sig = video.dataset.videoSig || '';
  const src = video.dataset.videoSrc || '';
  const { session } = await getDownloadState();
  if (!session?.prompts?.length) return false;
  let updated = false;
  session.prompts.forEach(prompt => {
    (prompt.outputs || []).forEach(item => {
      if (item.type !== 'video' || !item.src) return;
      if ((sig && item.signature === sig) || item.src === src) {
        item.thumbnail = thumbnail;
        item.preview = '';
        item.thumbnailLocked = true;
        item.thumbnailLockedAt = item.thumbnailLockedAt || Date.now();
        item.outputLocked = true;
        item.outputLockedAt = item.outputLockedAt || item.thumbnailLockedAt;
        updated = true;
      }
    });
  });
  if (updated) {
    await saveSession(session);
    // DON'T force full re-render here — the storage.onChanged listener will
    // trigger a render naturally. Forcing it here creates a render cascade
    // that destroys DOM elements (nav buttons, loaded images) mid-update.
  }
  return updated;
}

function replaceVideoWithThumb(video, thumbnail) {
  if (!thumbnail || !video?.parentElement) return;
  const img = document.createElement('img');
  img.className = 'preview-img lazy-loaded locked-thumb-img';
  img.src = thumbnail;
  img.decoding = 'async';
  video.replaceWith(img);
  const bg = img.parentElement?.querySelector('.video-fallback-bg');
  if (bg) bg.style.display = 'none';
}

function loadVideoThumb(video, done) {
  const src = video.dataset.videoSrc;
  if (!src) return done?.();
  _videoThumbActive++;
  video.dataset.thumbLoading = '1';
  let finished = false;

  const finish = (ok = false) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    _videoThumbActive = Math.max(0, _videoThumbActive - 1);
    delete video.dataset.thumbLoading;
    if (ok) {
      video.dataset.thumbLoaded = '1';
      video.classList.add('thumb-ready');
      const bg = video.parentElement?.querySelector('.video-fallback-bg');
      if (bg) bg.style.display = 'none';
    } else {
      try {
        video.pause();
        video.removeAttribute('src');
        video.load();
      } catch (e) { }
    }
    done?.();
  };

  const reveal = async () => {
    try { video.pause(); } catch (e) { }
    const thumbnail = captureTinyVideoFrame(video);
    if (thumbnail) {
      replaceVideoWithThumb(video, thumbnail);
      lockVideoThumbInSession(video, thumbnail).catch(() => {});
    } else {
      video.classList.add('thumb-ready');
      const bg = video.parentElement?.querySelector('.video-fallback-bg');
      if (bg) bg.style.display = 'none';
    }
    finish(true);
  };
  const seekFrame = () => {
    if (video.dataset.seekStarted === '1') return;
    video.dataset.seekStarted = '1';
    try {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      const t = duration > 1.2 ? 0.6 : duration > 0.35 ? 0.2 : 0;
      if (t > 0 && Math.abs((video.currentTime || 0) - t) > 0.05) {
        video.currentTime = t;
        return;
      }
    } catch (e) { }
    reveal();
  };

  const timer = setTimeout(() => reveal(), 2200);
  video.addEventListener('loadedmetadata', seekFrame, { once: true });
  video.addEventListener('loadeddata', seekFrame, { once: true });
  video.addEventListener('seeked', reveal, { once: true });
  video.addEventListener('canplay', seekFrame, { once: true });
  video.addEventListener('error', () => finish(false), { once: true });
  video.src = src;
  try { video.load(); } catch (e) { }
}

let _histHash = '';
async function renderHistory() {
  const histEl = document.getElementById('histList');
  if (!histEl) return;
  const history = await getSessionHistory();
  const visibleHistory = history.slice(0, historyLimit);

  const hh = visibleHistory.map(h => (h.id || '') + (h.stats?.downloaded || 0) + (h.prompts?.length || 0)).join('|') + `|limit:${historyLimit}`;
  if (_histHash === hh && histEl.children.length > 0) return;
  _histHash = hh;
  histEl.innerHTML = '';

  if (!history.length) {
    histEl.innerHTML = '<div class="empty">No session history yet.<br>Sessions saved here after completion.</div>';
    return;
  }

  const fmtDate = ts => {
    if (!ts) return 'Unknown';
    const d = new Date(ts), today = new Date();
    const isToday = d.toDateString() === today.toDateString();
    const yest = new Date(today); yest.setDate(today.getDate() - 1);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (isToday) return `Today · ${time}`;
    if (d.toDateString() === yest.toDateString()) return `Yesterday · ${time}`;
    return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} · ${time}`;
  };

  visibleHistory.forEach((h, hi) => {
    const prompts = h.prompts || [];
    const totalVids = prompts.reduce((s, p) => s + (p.outputs || []).filter(o => o.src).length, 0);
    const totalDl = prompts.reduce((s, p) => s + (p.outputs || []).filter(o => o.downloaded).length, 0);

    const sessionEl = document.createElement('div');
    sessionEl.className = 'h-session';
    sessionEl.id = `hs-${hi}`;

    // ── Session header ──────────────────────────────────────────────────────
    const sessionHd = document.createElement('div');
    sessionHd.className = 'h-session-hd';
    sessionHd.innerHTML = `
      <div style="flex:1;min-width:0">
        <div class="h-session-title">Session — ${fmtDate(h.startedAt)}</div>
        <div class="h-session-meta">${prompts.length} prompts · ${totalVids} outputs · ${totalDl} downloaded</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="chip ready" style="font-size:10px">${totalDl} dl</span>
        <span style="color:var(--muted);font-size:14px" class="h-arrow">▼</span>
      </div>`;

    const sessionBody = document.createElement('div');
    sessionBody.className = 'h-session-body';
    sessionBody.style.display = 'none';
    sessionBody.style.borderTop = '1px solid var(--line2)';

    // ── Bulk slot download buttons ────────────────────────────────────────
    const slotBtns = document.createElement('div');
    slotBtns.className = 'h-session-slots';
    const zipBtn = document.createElement('button');
    zipBtn.textContent = `ZIP Session (${totalVids})`;
    zipBtn.dataset.histZip = hi;
    zipBtn.disabled = totalVids === 0;
    slotBtns.appendChild(zipBtn);
    const zipSlotSelect = document.createElement('select');
    zipSlotSelect.dataset.histZipSlotSelect = hi;
    zipSlotSelect.style.cssText = 'height:28px;border:1px solid var(--line);border-radius:8px;background:#fff;color:var(--fg);font-size:11px;font-weight:700;padding:0 8px';
    [1, 2, 3, 4].forEach(slot => {
      const count = prompts.reduce((s, p) =>
        s + (p.outputs || []).filter(o => Number(o.position) === slot && o.src).length, 0);
      const opt = document.createElement('option');
      opt.value = String(slot);
      opt.textContent = `ZIP Slot ${slot} (${count})`;
      opt.disabled = count === 0;
      zipSlotSelect.appendChild(opt);
    });
    slotBtns.appendChild(zipSlotSelect);
    const zipSlotBtn = document.createElement('button');
    zipSlotBtn.textContent = 'Download ZIP Slot';
    zipSlotBtn.dataset.histZipSlotBtn = hi;
    zipSlotBtn.disabled = totalVids === 0;
    slotBtns.appendChild(zipSlotBtn);
    [1, 2, 3, 4].forEach(slot => {
      const count = prompts.reduce((s, p) =>
        s + (p.outputs || []).filter(o => Number(o.position) === slot && o.src).length, 0);
      if (!count) return;
      const btn = document.createElement('button');
      btn.textContent = `⬇ Slot ${slot} (${count})`;
      btn.dataset.histDl = slot;
      btn.dataset.histIdx = hi;
      slotBtns.appendChild(btn);
    });
    sessionBody.appendChild(slotBtns);

    // ── Prompts list (text only, no media) ────────────────────────────────
    prompts.forEach((p, pi) => {
      const outputs = p.outputs || [];
      const detected = outputs.filter(o => o.src).length;
      const downloaded = outputs.filter(o => o.downloaded).length;

      const promptEl = document.createElement('div');
      promptEl.className = 'h-prompt';
      promptEl.style.cssText = 'border-bottom:1px solid var(--line2);padding:8px 14px';

      // Prompt header row
      const hd = document.createElement('div');
      hd.className = 'h-prompt-hd';
      hd.style.cssText = 'display:flex;align-items:center;gap:8px;flex-wrap:wrap';
      hd.innerHTML = `
        <strong style="font-size:11px;color:var(--fg);flex-shrink:0">P${pi + 1}</strong>
        <span style="flex:1;font-size:11px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml((p.prompt || '').slice(0, 100))}</span>
        <span class="chip ${downloaded >= detected && detected > 0 ? 'downloaded' : detected > 0 ? 'ready' : 'queued'}" style="font-size:10px;flex-shrink:0">${detected > 0 ? `${downloaded}/${detected} dl` : 'No output'}</span>`;

      // Slot status pills (text only)
      const slotRow = document.createElement('div');
      slotRow.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-top:6px';
      [1, 2, 3, 4].forEach(pos => {
        const item = outputs.find(o => Number(o.position) === pos);
        const pill = document.createElement('span');
        pill.className = `dl-slot ${item?.downloaded ? 'dl-slot-done' : item?.src ? 'dl-slot-ready' : 'dl-slot-pending'}`;
        pill.style.cursor = item?.src ? 'pointer' : 'default';
        pill.title = `Slot ${pos}`;
        pill.textContent = `${pos}: ${item?.downloaded ? '✓ Done' : item?.src ? 'Ready' : '–'}`;
        if (item?.signature) pill.dataset.histSlotDl = item.signature;
        if (item?.src) pill.dataset.histSlotSrc = item.src;
        pill.dataset.histSlotIdx = hi;
        pill.dataset.histPromptIdx = pi;
        slotRow.appendChild(pill);
      });

      // Download buttons row
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px;margin-top:6px';
      const dlAllBtn = document.createElement('button');
      dlAllBtn.textContent = '⬇ All';
      dlAllBtn.style.fontSize = '10px';
      dlAllBtn.dataset.histPromptDlAll = hi;
      dlAllBtn.dataset.histPromptIdx = pi;
      btns.appendChild(dlAllBtn);

      promptEl.appendChild(hd);
      promptEl.appendChild(slotRow);
      promptEl.appendChild(btns);
      sessionBody.appendChild(promptEl);
    });

    const arrow = sessionHd.querySelector('.h-arrow');
    sessionHd.addEventListener('click', () => {
      const isOpen = sessionBody.style.display !== 'none';
      sessionBody.style.display = isOpen ? 'none' : 'block';
      if (arrow) arrow.textContent = isOpen ? '▼' : '▲';
    });

    sessionEl.appendChild(sessionHd);
    sessionEl.appendChild(sessionBody);
    histEl.appendChild(sessionEl);
  });

  if (history.length > visibleHistory.length) {
    const more = document.createElement('button');
    more.className = 'load-more';
    more.dataset.loadMore = 'history';
    more.textContent = `Load ${Math.min(HISTORY_PAGE_SIZE, history.length - visibleHistory.length)} more sessions`;
    histEl.appendChild(more);
  }
}


function renderCard(prompt, settings, sessionRunning = false) {
  const exp = promptExpectedCount(prompt);
  const selPos = getResolvedPosition('video', settings, prompt);
  const hasAny = prompt.outputs?.length > 0;
  const allReady = (prompt.outputs?.length || 0) >= exp;
  const statusLabel = prompt.status === 'downloaded' ? 'downloaded'
    : prompt.status === 'timeout' ? 'timeout'
      : allReady ? 'ready'
        : hasAny ? 'generating'
          : prompt.status || 'queued';
  const slots = Array.from({ length: exp }, (_, i) => {
    const pos = i + 1;
    const item = (prompt.outputs || []).find(o => Number(o.position) === pos);
    const sel = pos === selPos;
    // During automation: no img/video at all — only a lightweight icon pill
    const showPreview = !!item?.src;
    const cardMedia = mediaCard(item, { lightMode: !showPreview });
    return `<div class="card${sel ? ' sel' : ''}" data-sig="${escapeAttr(item?.signature || '')}" data-prompt-idx="${prompt.index}" data-slot-pos="${pos}">
  <span class="slot-num">${pos}</span>
  <span class="sel-check">&#10003;</span>
  ${cardMedia}
  <div class="card-btns">
    <button data-sel="${prompt.index}" data-slot="${pos}">${sel ? '&#10003; Selected' : 'Select'}</button>
    ${item ? `<button data-dlsig="${escapeAttr(item.signature)}">${item.downloaded ? '&#10003;' : '&#11015;'}</button>` : ''}
  </div></div>`;
  });
  return `<div class="grp" data-grp-idx="${prompt.index}">
  <div class="grp-hd">
    <div><strong>Prompt ${Number(prompt.index) + 1}</strong><p>${escapeHtml((prompt.prompt || '').slice(0, 120))}${(prompt.prompt || '').length > 120 ? '\u2026' : ''}</p></div>
    <span class="chip ${escapeAttr(statusLabel)}">${escapeHtml(statusLabel)}</span>
  </div>
  <div class="grid">${slots.join('')}</div></div>`;
}

function slotLabel(value) {
  if (value === undefined || value === null || value === '') return '-';
  return String(value) === 'auto' ? 'Auto - Last' : `Slot ${value}`;
}

function renderNowPanel(session, settings, comp) {
  const el = document.getElementById('nowPanel');
  if (!el) return;
  if (!session?.active || !session?.prompts?.length) {
    el.innerHTML = `<div class="now-empty">Start automation to see the current prompt, selected slots, retries, and download progress here.</div>`;
    return;
  }
  const prompts = session.prompts || [];
  const currentIndex = Math.max(0, Math.min(Number(session.currentIndex || 0), prompts.length - 1));
  const prompt = prompts[currentIndex] || prompts.find(p => !['downloaded', 'ready', 'failed'].includes(p.status)) || prompts[0];
  const outputType = promptOutputType(prompt);
  const primary = outputType === 'image' ? settings.imageGenerationSelect : settings.videoGenerationSelect;
  const secondary = outputType === 'video' ? settings.secondaryVideoGenerationSelect : '-';
  const resolved = prompt.resolvedPosition || getResolvedPosition(outputType, settings, prompt);
  const retryCount = Number(prompt.retryCount || prompt.attempts || 0);
  const maxRetries = Number(settings.maxPerPromptRetries ?? 3);
  const detected = (prompt.outputs || []).filter(o => o.src).length;
  const status = prompt.status || (session.running === false ? 'idle' : 'running');
  const promptText = escapeHtml(prompt.prompt || 'No prompt text captured yet.');
  el.innerHTML = `
    <div class="now-head">
      <div>
        <div class="now-kicker">Now Running</div>
        <strong>Prompt ${Number(prompt.index ?? currentIndex) + 1} / ${prompts.length}</strong>
      </div>
      <span class="chip ${escapeAttr(status)}">${escapeHtml(status)}</span>
    </div>
    <p class="now-prompt">${promptText}</p>
    <div class="now-pills">
      <span><b>Primary</b>${escapeHtml(slotLabel(primary))}</span>
      <span><b>Fallback</b>${escapeHtml(slotLabel(secondary))}</span>
      <span><b>Resolved</b>${escapeHtml(slotLabel(resolved))}</span>
      <span><b>Retry</b>${retryCount}/${maxRetries}</span>
      <span><b>Detected</b>${detected}/${promptExpectedCount(prompt)}</span>
    </div>`;
}

function renderFailedPromptsPanel(session, settings) {
  const panel = document.getElementById('failedPromptsPanel');
  const fpList = document.getElementById('fpList');
  const fpCount = document.getElementById('fpCount');
  const fpStatus = document.getElementById('fpStatus');
  if (!panel) return;

  // Read AI retry state from session (populated by core.js)
  const aiRetry = session?.aiRetryState;
  const enabled = aiRetry?.enabled === true;
  const failedPrompts = aiRetry?.failedPrompts || [];
  const hasCurrentSessionPrompts = !!session?.id && Array.isArray(session.prompts) && session.prompts.length > 0;

  if (!hasCurrentSessionPrompts || !enabled || failedPrompts.length === 0) {
    panel.style.display = 'none';
    return;
  }

  panel.style.display = 'block';
  if (fpCount) fpCount.textContent = failedPrompts.length;

  // Status line
  if (fpStatus) {
    const phase = aiRetry?.phase || 'waiting';
    const phaseLabels = {
      waiting: 'Waiting for automation to complete...',
      sending: 'Sending failed prompts to NVIDIA Qwen AI...',
      retrying: 'Retrying AI-edited prompts...',
      round2: 'Round 2: sending still-failed prompts to NVIDIA Qwen...',
      retrying2: 'Round 2 retry in progress...',
      done: 'AI retry complete.'
    };
    fpStatus.textContent = phaseLabels[phase] || phase;
    fpStatus.className = `fp-status ${phase === 'done' ? 'done' : phase.startsWith('retry') ? 'retrying' : 'pending'}`;
  }

  // Prompt cards
  if (fpList) {
    const statusLabels = {
      queued: 'Queued',
      sending: 'Sending to AI',
      edited: 'AI Edited',
      retrying: 'Retrying',
      success: 'Success ✓',
      failed2: 'Round 2 Fail',
      unrecoverable: 'Unrecoverable'
    };
    const statusClasses = {
      queued: 'fp-queued', sending: 'fp-sending', edited: 'fp-edited',
      retrying: 'fp-retrying', success: 'fp-success',
      failed2: 'fp-failed2', unrecoverable: 'fp-failed2'
    };
    fpList.innerHTML = failedPrompts.map(fp => {
      const promptNum = Number(fp.index ?? 0) + 1;
      const promptPreview = escapeHtml((fp.editedPrompt || fp.prompt || '').slice(0, 90));
      const hasEdit = !!fp.editedPrompt && fp.editedPrompt !== fp.prompt;
      const statusKey = fp.status || 'queued';
      const statusLabel = statusLabels[statusKey] || statusKey;
      const statusCls = statusClasses[statusKey] || 'fp-queued';
      const roundBadge = fp.round > 1 ? `<span class="fp-round">R${fp.round}</span>` : '';
      return `<div class="fp-card" data-fp-status="${escapeAttr(statusKey)}">
        <div class="fp-card-header">
          <span class="fp-num">Prompt ${promptNum}</span>
          ${roundBadge}
          <span class="fp-chip ${statusCls}">${escapeHtml(statusLabel)}</span>
        </div>
        <p class="fp-prompt">${hasEdit ? '✏️ ' : ''}${promptPreview}</p>
      </div>`;
    }).join('');
  }
}

function renderManagerActivity(session, settings, comp) {
  const el = document.getElementById('managerActivity');
  if (!el) return;
  if (!session?.active || !session?.prompts?.length) {
    el.innerHTML = `
      <div class="activity-line idle">
        <span class="activity-emoji">💤</span>
        <span class="activity-text">Waiting for prompts. Start automation from the side panel.</span>
      </div>`;
    return;
  }
  const prompts = session.prompts || [];
  const currentIndex = Math.max(0, Math.min(Number(session.currentIndex || 0), prompts.length - 1));
  const current = prompts[currentIndex] || prompts[0];
  const rows = [];
  const preferred = getPreferredOutput(current, settings);
  if (session.zipNeedsManager) {
    rows.push({ cls: 'warn', icon: 'ZIP', text: session.zipStatus || 'Open Download Manager to build ZIP.' });
  }
  if (preferred?.src) {
    rows.push({ cls: 'ok', icon: '✅', text: `Prompt ${Number(current.index ?? currentIndex) + 1} detected - slot ${preferred.position || current.resolvedPosition || 'auto'} ready.` });
  } else if (current.status === 'failed') {
    rows.push({ cls: 'err', icon: '💀', text: `Prompt ${Number(current.index ?? currentIndex) + 1} failed after retries.` });
  } else if (session.running !== false) {
    rows.push({ cls: 'searching', icon: '🔎', text: `Searching prompt ${Number(current.index ?? currentIndex) + 1}` });
  } else {
    rows.push({ cls: 'idle', icon: '🧭', text: 'Session is idle. No selected video is ready yet.' });
  }
  if (comp.selectedOutputs > 0) rows.push({ cls: 'ok', icon: '⬇️', text: `${comp.selectedOutputs} selected output(s) ready to download.` });
  if (comp.missingOutputs > 0) rows.push({ cls: 'warn', icon: '⚠️', text: `${comp.missingOutputs} prompt(s) still missing selected output.` });
  el.innerHTML = rows.slice(0, 3).map(row => `
    <div class="activity-line ${row.cls}">
      <span class="activity-emoji">${row.icon}</span>
      <span class="activity-text">${escapeHtml(row.text)}</span>
      ${row.cls === 'searching' ? '<span class="activity-dots"><i></i><i></i><i></i></span>' : ''}
    </div>`).join('');
}

function renderManagerActivityCompact(session, settings, comp) {
  const el = document.getElementById('managerActivity');
  if (!el) return;
  if (!session?.active || !session?.prompts?.length) {
    el.innerHTML = `
      <div class="activity-line idle">
        <span class="activity-emoji">&#128164;</span>
        <span class="activity-text">Waiting for prompts. Start automation from the side panel.</span>
      </div>`;
    return;
  }
  const prompts = session.prompts || [];
  const currentIndex = Math.max(0, Math.min(Number(session.currentIndex || 0), prompts.length - 1));
  const current = prompts[currentIndex] || prompts[0];
  const rows = [];
  const preferred = getPreferredOutput(current, settings);
  if (preferred?.src) {
    rows.push({ cls: 'ok', icon: '&#9989;', text: `Prompt ${Number(current.index ?? currentIndex) + 1} detected - slot ${preferred.position || current.resolvedPosition || 'auto'} ready.` });
  } else if (current.status === 'failed') {
    rows.push({ cls: 'err', icon: '&#128128;', text: `Prompt ${Number(current.index ?? currentIndex) + 1} failed after retries.` });
  } else if (session.running !== false) {
    rows.push({ cls: 'searching', icon: '&#128269;', text: `Searching prompt ${Number(current.index ?? currentIndex) + 1}` });
  } else {
    rows.push({ cls: 'idle', icon: '&#129517;', text: 'Session is idle. No selected video is ready yet.' });
  }
  const ready = Number(comp.readyPrompts ?? comp.selectedOutputs ?? 0);
  const failed = Number(comp.failedPrompts || 0);
  const missing = Number(comp.missingSelectedPrompts ?? comp.missingOutputs ?? 0);
  if (ready > 0 || failed > 0 || missing > 0) {
    const cls = failed > 0 ? 'err' : ready > 0 ? 'ok' : 'warn';
    const icon = failed > 0 ? '&#128128;' : ready > 0 ? '&#11015;' : '&#9888;';
    rows.push({ cls, icon, text: `Ready ${ready}/${comp.totalPrompts} - Failed ${failed} - Missing ${missing}` });
  }
  el.innerHTML = rows.slice(0, 2).map(row => `
    <div class="activity-line ${row.cls}">
      <span class="activity-emoji">${row.icon}</span>
      <span class="activity-text">${escapeHtml(row.text)}</span>
      ${row.cls === 'searching' ? '<span class="activity-dots"><i></i><i></i><i></i></span>' : ''}
    </div>`).join('');
}

function selectedVideos(session, settings) {
  return (session?.prompts || [])
    .map(prompt => getPreferredOutput(prompt, settings))
    .filter(item => item?.src && item.type === 'video');
}

function slotVideos(session, slot) {
  return (session?.prompts || [])
    .flatMap(prompt => (prompt.outputs || []).filter(item => item?.src && item.type === 'video' && Number(item.position) === Number(slot)));
}

function setManagerStatus(message, type = 'info') {
  const el = document.getElementById('zipStatus');
  if (!el) return;
  el.textContent = message;
  el.className = `zip-status ${type}`;
}

async function downloadItemsManually(items, session, settings) {
  if (!items.length) {
    setManagerStatus('No video detected yet.', 'error');
    return;
  }
  setManagerStatus(`Downloading ${items.length} video(s)...`, 'info');
  for (const item of items) {
    await downloadItem(item, settings.downloadFolder || session?.folder);
    await new Promise(resolve => setTimeout(resolve, 450));
  }
  setManagerStatus(`Downloaded ${items.length} video(s).`, 'success');
  lastRender = '';
  scheduleRender(true);
}


function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }

function queueSlice(session) {
  const prompts = session?.prompts || [];
  if (prompts.length <= QUEUE_PAGE_SIZE) {
    queueManualMode = false;
    queueWindowStart = 0;
    return { prompts, start: 0, end: prompts.length };
  }
  const current = Math.max(0, Number(session.currentIndex || 0));
  const maxStart = Math.max(0, prompts.length - QUEUE_PAGE_SIZE);
  queueWindowStart = Math.max(0, Math.min(queueWindowStart, maxStart));
  if (!queueManualMode && (current < queueWindowStart || current >= queueWindowStart + QUEUE_PAGE_SIZE)) {
    queueWindowStart = Math.max(0, Math.min(current - 2, prompts.length - QUEUE_PAGE_SIZE));
  }
  return { prompts: prompts.slice(queueWindowStart, queueWindowStart + QUEUE_PAGE_SIZE), start: queueWindowStart, end: Math.min(prompts.length, queueWindowStart + QUEUE_PAGE_SIZE) };
}

function openPreview(item) {
  if (!item?.src) return;
  const modal = document.getElementById('amPreview');
  const media = document.getElementById('amPreviewMedia');
  const meta = document.getElementById('amPreviewMeta');
  if (!modal || !media || !meta) return;
  media.innerHTML = item.type === 'image'
    ? `<img src="${escapeAttr(item.src)}" alt="">`
    : `<video src="${escapeAttr(item.src)}" controls autoplay muted playsinline preload="metadata"></video>`;
  meta.textContent = item.prompt || '';
  modal.hidden = false;
}

function closePreview() {
  const modal = document.getElementById('amPreview');
  const media = document.getElementById('amPreviewMedia');
  if (!modal || !media) return;
  media.querySelectorAll('video').forEach(v => {
    v.pause();
    v.removeAttribute('src');
    v.load();
  });
  media.innerHTML = '';
  modal.hidden = true;
}

async function render() {
  if (!root) return;
  const { session, settings } = await getDownloadState();
  if ((session?.id || '') !== queueSessionId) {
    queueSessionId = session?.id || '';
    queueManualMode = false;
    queueWindowStart = 0;
  }
  const comp = getSessionCompletionState(session, settings);
  const promptDigest = session?.prompts?.map(p => {
    const selectedPos = getResolvedPosition(promptOutputType(p), settings, p);
    return `${p.status}:${p.outputs?.length || 0}:${(p.outputs || []).map(o => {
      const thumbnailAffectsQueue = settings.thumbnailMode === 'all' || Number(o.position) === Number(selectedPos);
      return `${o.position}-${o.downloaded ? 1 : 0}-${o.src || ''}-${o.preview ? 1 : 0}-${thumbnailAffectsQueue && o.thumbnail ? 1 : 0}`;
    }).join(',')}`;
  }).join('|');
  const hash = `${session?.id}|${activeTab}|${floatingState.minimized}|${floatingState.lockSizeAfterReopen ? 1 : 0}|${session?.running}|${queueWindowStart}|${queueManualMode ? 1 : 0}|${downloadLimit}|${historyLimit}|${JSON.stringify(comp)}|${promptDigest}`;
  if (hash === lastRender) return;
  lastRender = hash;
  const win = root.querySelector('.win');
  if (win) {
    win.classList.toggle('min', !!floatingState.minimized);
    win.classList.toggle('portrait-mode', session?.aspectRatio === '9:16');
  }
  const badge = document.getElementById('amBadge');
  const isLive = session?.active && session?.running !== false;
  const isCompleted = session?.active && session?.running === false && session?.completedAt;
  if (badge) { badge.textContent = isCompleted ? 'Complete' : isLive ? 'Detecting...' : 'Idle'; badge.className = `badge${isLive ? ' active' : ''}`; }
  const modeBadge = document.getElementById('amModeBadge');
  const ratioBadge = document.getElementById('amAspectRatio');
  if (session?.active) {
    if (modeBadge) {
      const m = session.mode || 'prompt-to-video';
      const modeLabel = m === 'prompt-to-image' ? '[IMG] Image' : m === 'image-to-video' ? '[I>V] Img->Vid' : '[VID] Video';
      const modeColor = m === 'prompt-to-image' ? '#2D7FF9' : m === 'image-to-video' ? '#0891B2' : '#155EEF';
      modeBadge.textContent = modeLabel; modeBadge.style.display = 'inline-block';
      modeBadge.style.background = modeColor + '18'; modeBadge.style.color = modeColor;
      modeBadge.style.border = `1px solid ${modeColor}40`;
    }
    if (ratioBadge && session.aspectRatio) {
      ratioBadge.textContent = session.aspectRatio;
      ratioBadge.style.display = 'inline-block';
    }
  }
  else {
    if (modeBadge) modeBadge.style.display = 'none';
    if (ratioBadge) ratioBadge.style.display = 'none';
  }
  const hasData = session?.active && comp.totalPrompts > 0;
  setText('sP', hasData ? comp.totalPrompts : 0);
  setText('sDt', hasData ? `${comp.detectedPrompts || 0}/${comp.totalPrompts}` : '0/0');
  setText('sR', hasData ? (comp.readyPrompts ?? comp.selectedOutputs) : 0);
  setText('sMi', hasData ? (comp.failedPrompts || 0) : 0);
  renderManagerActivityCompact(session, settings, comp);
  renderNowPanel(session, settings, comp);
  renderFailedPromptsPanel(session, settings);
  // ── Minimized stats bar ────────────────────────────────────────────────────
  const minBar = document.getElementById('amMinBar');
  if (minBar) {
    if (floatingState.minimized && session?.active && comp.totalPrompts > 0) {
      minBar.style.display = 'flex';
      const sentEl = document.getElementById('amMinSent');
      const detectedEl = document.getElementById('amMinDetected');
      const sendingEl = document.getElementById('amMinSending');
      const detectingEl = document.getElementById('amMinDetecting');
      const currentIndex = Math.max(0, Math.min(Number(session.currentIndex || 0), (session.prompts || []).length - 1));
      const currentPrompt = (session.prompts || [])[currentIndex];
      const currentPromptNum = currentPrompt ? Number(currentPrompt.index ?? currentIndex) + 1 : currentIndex + 1;
      const sendingPromptText = currentPrompt?.prompt ? currentPrompt.prompt.slice(0, 42) + (currentPrompt.prompt.length > 42 ? '…' : '') : '';
      // Find the prompt currently being detected (latest with detecting/generating status)
      const detectingPrompt = [...(session.prompts || [])].reverse().find(p => ['detecting', 'generating', 'submitted'].includes(p.status));
      const detectingNum = detectingPrompt ? Number(detectingPrompt.index ?? 0) + 1 : null;
      const detectingText = detectingPrompt?.prompt ? detectingPrompt.prompt.slice(0, 42) + (detectingPrompt.prompt.length > 42 ? '…' : '') : '';
      if (sentEl) sentEl.innerHTML = `Sent: <b>${currentPromptNum}/${comp.totalPrompts}</b>`;
      if (detectedEl) detectedEl.innerHTML = `Detected: <b>${comp.detectedPrompts || 0}/${comp.totalPrompts}</b>`;
      if (sendingEl) {
        sendingEl.style.display = sendingPromptText ? 'inline-flex' : 'none';
        sendingEl.innerHTML = sendingPromptText ? `&#128228; P${currentPromptNum}: <span title="${escapeAttr(currentPrompt?.prompt || '')}">${escapeHtml(sendingPromptText)}</span>` : '';
      }
      if (detectingEl) {
        detectingEl.style.display = detectingNum ? 'inline-flex' : 'none';
        detectingEl.innerHTML = detectingNum ? `&#128269; P${detectingNum}: <span title="${escapeAttr(detectingPrompt?.prompt || '')}">${escapeHtml(detectingText)}</span>` : '';
      }
    } else {
      minBar.style.display = 'none';
    }
  }
  const lockBtn = document.getElementById('amLockFit');
  if (lockBtn) {
    lockBtn.classList.toggle('on', !!floatingState.lockSizeAfterReopen);
    lockBtn.setAttribute('aria-pressed', floatingState.lockSizeAfterReopen ? 'true' : 'false');
    lockBtn.title = floatingState.lockSizeAfterReopen ? 'Size locked after reopen' : 'Auto-fit after reopen';
    const txt = lockBtn.querySelector('.lock-text');
    if (txt) txt.textContent = floatingState.lockSizeAfterReopen ? 'Locked' : 'Auto fit';
  }
  const qEl = document.getElementById('qGroups');
  const qNav = document.getElementById('qNav');
  if (qEl) {
    if (!session?.active || !session?.prompts?.length) {
      qEl.innerHTML = `<div class="empty"><strong>&#128248; No tasks yet</strong>Start automation in the side panel to begin detecting media.</div>`;
      if (qNav) qNav.innerHTML = '';
    } else {
      const slice = queueSlice(session);
      // PERSISTENT NAV: render outside qGroups so innerHTML rebuild doesn't destroy buttons
      if (qNav) {
        if (session.prompts.length > QUEUE_PAGE_SIZE) {
          qNav.innerHTML = `<div class="window-nav"><button data-window="prev" ${slice.start <= 0 ? 'disabled' : ''}>Previous</button><span>Showing ${slice.start + 1}-${slice.end} of ${session.prompts.length}</span><button data-window="next" ${slice.end >= session.prompts.length ? 'disabled' : ''}>Next</button></div>`;
        } else {
          qNav.innerHTML = '';
        }
      }
      const isSessionRunning = !!(session?.active && session?.running !== false);
      qEl.innerHTML = slice.prompts.map(p => renderCard(p, settings, isSessionRunning)).join('');
      initVideoThumbnails();
    }
  }
  const dlEl = document.getElementById('dlList');
  if (dlEl) {
    if (!session?.active || !session?.prompts?.length) {
      dlEl.innerHTML = '<div class="empty">No download data yet.</div>';
    } else {
      const prompts = session.prompts.slice(0, downloadLimit);
      dlEl.innerHTML = prompts.map(prompt => {
        const exp = promptExpectedCount(prompt);
        const resolvedPos = getResolvedPosition(promptOutputType(prompt), settings, prompt);
        const selectedItem = (prompt.outputs || []).find(o => Number(o.position) === Number(resolvedPos));
        const selectedStatus = selectedItem?.downloaded ? 'Downloaded'
          : selectedItem?.src ? 'Ready'
            : prompt.status === 'failed' ? 'Failed'
              : 'Missing';
        const slots = Array.from({ length: exp }, (_, i) => {
          const pos = i + 1; const item = (prompt.outputs || []).find(o => Number(o.position) === pos);
          const statusCls = item?.downloaded ? 'dl-slot-done' : item?.src ? 'dl-slot-ready' : 'dl-slot-pending';
          const label = item?.downloaded ? '&#10003; Done' : item?.src ? 'Ready' : Number(pos) === Number(resolvedPos) ? 'Selected missing' : 'Pending';
          return `<span class="dl-slot ${statusCls}" ${item?.signature ? `data-dlsig="${item.signature}"` : ''} title="Slot ${pos}">${pos}: ${label}</span>`;
        }).join('');
        const allDone = (prompt.outputs || []).filter(o => o.downloaded).length;
        const sc = selectedStatus === 'Downloaded' ? 'chip downloaded' : selectedStatus === 'Ready' ? 'chip ready' : selectedStatus === 'Failed' ? 'chip failed' : 'chip queued';
        return `<div class="grp compact-download" style="padding:10px 12px">
  <div class="grp-hd" style="margin-bottom:8px">
    <div><strong>Prompt ${Number(prompt.index) + 1}</strong><p>${escapeHtml((prompt.prompt || '').slice(0, 100))}</p></div>
    <span class="${sc}">${escapeHtml(selectedStatus)} - Slot ${escapeHtml(slotLabel(resolvedPos).replace('Slot ', ''))}</span>
  </div><div class="download-meta">Downloaded ${allDone}/${exp} - Primary ${escapeHtml(slotLabel(settings.videoGenerationSelect))} - Secondary ${escapeHtml(slotLabel(settings.secondaryVideoGenerationSelect))}</div><div style="display:flex;gap:6px;flex-wrap:wrap">${slots}</div></div>`;
      }).join('') + (session.prompts.length > prompts.length ? `<button class="load-more" data-load-more="downloads">Load ${Math.min(DOWNLOAD_PAGE_SIZE, session.prompts.length - prompts.length)} more prompts</button>` : '');
    }
  }
  const closeBanner = document.getElementById('amCloseBanner');
  if (closeBanner) closeBanner.style.display = isCompleted ? 'flex' : 'none';
  if (activeTab === 'history') await renderHistory();
}

function setTab(tab) {
  activeTab = VALID_TABS.has(tab) ? tab : 'queue';
  root.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('on', b.dataset.tab === activeTab));
  root.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === `v${activeTab[0].toUpperCase()}${activeTab.slice(1)}`));
  lastRender = '';
  scheduleRender(true);
}

function bindEvents() {
  let childPointerActive = false;
  const pointerPayload = e => ({
    clientX: e.clientX,
    clientY: e.clientY,
    screenX: e.screenX,
    screenY: e.screenY
  });

  root.addEventListener('pointerdown', e => {
    const edge = e.target.closest('[data-edge]');
    if (edge) {
      childPointerActive = true;
      e.target.setPointerCapture?.(e.pointerId);
      parentPost('FLOATING_POINTER_START', { action: 'resize', edge: edge.dataset.edge, ...pointerPayload(e) });
      e.preventDefault();
      return;
    }
    if (e.target.closest('#amDrag') && !e.target.closest('button')) {
      childPointerActive = true;
      e.target.setPointerCapture?.(e.pointerId);
      parentPost('FLOATING_POINTER_START', { action: 'drag', ...pointerPayload(e) });
      e.preventDefault();
    }
  });

  root.addEventListener('pointermove', e => {
    if (!childPointerActive) return;
    parentPost('FLOATING_POINTER_MOVE', pointerPayload(e));
  });

  function endChildPointer(e) {
    if (!childPointerActive) return;
    childPointerActive = false;
    parentPost('FLOATING_POINTER_END', pointerPayload(e));
  }

  root.addEventListener('pointerup', endChildPointer);
  root.addEventListener('pointercancel', endChildPointer);

  // Scroll handler — ensures wheel events scroll inside the overlay
  root.addEventListener('wheel', e => {
    const scrollTarget = e.target.closest('.groups') || root.querySelector('.view.on .groups');
    if (scrollTarget) {
      scrollTarget.scrollTop += e.deltaY;
      e.preventDefault();
      e.stopPropagation();
    }
  }, { passive: false });

  root.addEventListener('click', async e => {
    if (e.target.closest('#amClose')) parentPost('FLOATING_CLOSE');
    if (e.target.closest('#amMin')) parentPost('FLOATING_MINIMIZE');
    if (e.target.closest('#amMax')) parentPost('FLOATING_MAXIMIZE');
    if (e.target.closest('#amLockFit')) {
      parentPost('FLOATING_LOCK_SIZE', { lockSizeAfterReopen: !floatingState.lockSizeAfterReopen });
      return;
    }
    if (e.target.closest('[data-preview-close]')) { closePreview(); return; }
    const tb = e.target.closest('[data-tab]'); if (tb) setTab(tb.dataset.tab);
    const moreBtn = e.target.closest('[data-load-more]');
    if (moreBtn) {
      if (moreBtn.dataset.loadMore === 'history') historyLimit += HISTORY_PAGE_SIZE;
      if (moreBtn.dataset.loadMore === 'downloads') downloadLimit += DOWNLOAD_PAGE_SIZE;
      lastRender = ''; await render(); return;
    }
    const winBtn = e.target.closest('[data-window]');
    if (winBtn) {
      const { session } = await getDownloadState();
      const maxStart = Math.max(0, (session?.prompts?.length || 0) - QUEUE_PAGE_SIZE);
      queueManualMode = true;
      queueWindowStart += winBtn.dataset.window === 'next' ? QUEUE_PAGE_SIZE : -QUEUE_PAGE_SIZE;
      queueWindowStart = Math.max(0, Math.min(queueWindowStart, maxStart));
      lastRender = ''; await render(); return;
    }
    const selBtn = e.target.closest('[data-sel]');
    if (selBtn) {
      const { settings } = await getDownloadState();
      const cs = { ...(settings.customSelections || {}), [selBtn.dataset.sel]: selBtn.dataset.slot };
      await saveDownloadSettings({ customSelections: cs, selectionMode: 'custom' });
      lastRender = ''; await render(); return;
    }
    const dlBtn = e.target.closest('[data-dlsig]');
    if (dlBtn) {
      const { session, settings } = await getDownloadState();
      const item = flattenOutputs(session).find(o => o.signature === dlBtn.dataset.dlsig);
      if (item) await downloadItem(item, settings.downloadFolder || session?.folder);
      lastRender = ''; await render(); return;
    }
    const histSlotBtn = e.target.closest('[data-hist-slot-dl]');
    if (histSlotBtn) {
      const histIdx = Number(histSlotBtn.dataset.histSlotIdx);
      const promptIdx = Number(histSlotBtn.dataset.histPromptIdx);
      const history = await getSessionHistory();
      const h = history[histIdx];
      const prompt = (h?.prompts || [])[promptIdx];
      const item = (prompt?.outputs || []).find(o => o.signature === histSlotBtn.dataset.histSlotDl || o.src === histSlotBtn.dataset.histSlotSrc);
      if (item?.src) {
        const { settings } = await getDownloadState();
        await downloadItem(item, h.folder || settings.downloadFolder);
      }
      lastRender = ''; await renderHistory(); return;
    }
    if (e.target.closest('#bScan')) { await runRealtimeDetectionScan('manual'); lastRender = ''; await render(); }
    if (e.target.closest('#bRetryPrompt')) { parentPost('RETRY_UNDETECTED_PROMPT'); }
    const manualBtn = e.target.closest('[data-manual-download]');
    if (manualBtn) {
      const action = manualBtn.dataset.manualDownload;
      root.querySelector('#manualDownloadMenu')?.removeAttribute('open');
      const { session, settings } = await getDownloadState();
      if (!session?.active && !session?.prompts?.length) {
        setManagerStatus('No video detected yet.', 'error');
        return;
      }
      if (action === 'selected') {
        await downloadItemsManually(selectedVideos(session, settings), session, settings);
        return;
      }
      if (action === 'zip') {
        const videos = selectedVideos(session, settings);
        if (!videos.length) {
          setManagerStatus('No video detected yet.', 'error');
          return;
        }
        setManagerStatus('Preparing ZIP...', 'info');
        const res = await downloadAllAsZip(session, settings, msg => setManagerStatus(String(msg).replace(/[^\x20-\x7E]/g, ''), 'info'));
        setManagerStatus(res.success ? `ZIP ready - ${res.count} files` : (res.error || 'ZIP failed'), res.success ? 'success' : 'error');
        return;
      }
      if (action.startsWith('slot-')) {
        await downloadItemsManually(slotVideos(session, Number(action.slice(5))), session, settings);
      }
      return;
    }
    if (e.target.closest('#bReset')) {
      const width = Math.round(Math.min(1120, Math.max(300, window.innerWidth * 0.82)));
      const height = Math.round(Math.min(760, Math.max(260, window.innerHeight * 0.78)));
      const st = { visible: true, activeTab: 'queue', minimized: false, maximized: false, x: 60, y: 60, width, height };
      await chrome.storage.local.set({ [FLOATING_STATE_KEY]: st });
      parentPost('OPEN_FLOATING_MANAGER', { tab: 'queue' });
    }
    if (e.target.closest('#bClearSession')) {
      await chrome.storage.local.remove(['autoMetaCopy_downloadSession', 'autoMetaCopy_downloadedOutputs', 'autoMetaCopy_detectedOutputs']);
      lastRender = ''; await render();
    }
    if (e.target.closest('#bCloseSession')) {
      const { session } = await getDownloadState();
      if (session) await archiveSessionToHistory(session);
      await chrome.storage.local.remove(['autoMetaCopy_downloadSession', 'autoMetaCopy_downloadedOutputs', 'autoMetaCopy_detectedOutputs']);
      lastRender = ''; await render();
    }
    const histZipBtn = e.target.closest('[data-hist-zip]');
    if (histZipBtn) {
      if (historyZipRunning) {
        setManagerStatus('ZIP already preparing...', 'info');
        return;
      }
      historyZipRunning = true;
      const idx = Number(histZipBtn.dataset.histZip);
      try {
        const history = await getSessionHistory();
        const h = history[idx];
        if (!h) return;
        const { settings } = await getDownloadState();
        const zipSettings = {
          ...settings,
          ...(h.settings || {}),
          downloadFolder: h.folder || h.settings?.downloadFolder || settings.downloadFolder
        };
        setManagerStatus('Preparing history ZIP...', 'info');
        const allItems = flattenOutputs(h).filter(item => item.src);
        const res = await downloadAllAsZip(h, zipSettings, msg => setManagerStatus(String(msg).replace(/[^\x20-\x7E]/g, ''), 'info'), {
          items: allItems,
          includeFailureReport: false,
          filenamePrefix: 'session-videos'
        });
        setManagerStatus(res.success ? `History ZIP ready - ${res.count} files` : (res.error || 'History ZIP failed'), res.success ? 'success' : 'error');
      } finally {
        historyZipRunning = false;
      }
      return;
    }
    const histZipSlotBtn = e.target.closest('[data-hist-zip-slot-btn]');
    if (histZipSlotBtn) {
      if (historyZipRunning) {
        setManagerStatus('ZIP already preparing...', 'info');
        return;
      }
      historyZipRunning = true;
      const idx = Number(histZipSlotBtn.dataset.histZipSlotBtn);
      try {
        const history = await getSessionHistory();
        const h = history[idx];
        if (!h) return;
        const slotSelect = root.querySelector(`[data-hist-zip-slot-select="${idx}"]`);
        const slot = Math.max(1, Math.min(4, Number(slotSelect?.value) || 1));
        const items = flattenOutputs(h).filter(item => Number(item.position) === slot && item.src);
        if (!items.length) {
          setManagerStatus(`No videos found in history slot ${slot}.`, 'error');
          return;
        }
        const { settings } = await getDownloadState();
        const zipSettings = {
          ...settings,
          ...(h.settings || {}),
          downloadFolder: h.folder || h.settings?.downloadFolder || settings.downloadFolder
        };
        setManagerStatus(`Preparing history ZIP for slot ${slot} (${items.length} files)...`, 'info');
        const res = await downloadAllAsZip(h, zipSettings, msg => setManagerStatus(String(msg).replace(/[^\x20-\x7E]/g, ''), 'info'), {
          items,
          includeFailureReport: false,
          filenamePrefix: `slot-${slot}-videos`
        });
        setManagerStatus(res.success ? `Slot ${slot} ZIP ready - ${res.count} files` : (res.error || `Slot ${slot} ZIP failed`), res.success ? 'success' : 'error');
      } finally {
        historyZipRunning = false;
      }
      return;
    }
    // History bulk download by slot
    const histDlBtn = e.target.closest('[data-hist-dl]');
    if (histDlBtn) {
      const slot = Number(histDlBtn.dataset.histDl);
      const idx = Number(histDlBtn.dataset.histIdx);
      const history = await getSessionHistory();
      const h = history[idx];
      if (!h) return;
      const { settings } = await getDownloadState();
      for (const prompt of (h.prompts || [])) {
        const item = (prompt.outputs || []).find(o => Number(o.position) === slot && o.src);
        if (item && !item.downloaded) {
          await downloadItem(item, h.folder || settings.downloadFolder);
          await new Promise(r => setTimeout(r, 600));
        }
      }
      lastRender = ''; await renderHistory();
    }
    // History per-prompt download all
    const histPromptDlBtn = e.target.closest('[data-hist-prompt-dl-all]');
    if (histPromptDlBtn) {
      const histIdx = Number(histPromptDlBtn.dataset.histPromptDlAll);
      const promptIdx = Number(histPromptDlBtn.dataset.histPromptIdx);
      const history = await getSessionHistory();
      const h = history[histIdx];
      if (!h) return;
      const { settings } = await getDownloadState();
      const prompt = (h.prompts || [])[promptIdx];
      if (!prompt) return;
      for (const item of (prompt.outputs || [])) {
        if (item.src && !item.downloaded) {
          await downloadItem(item, h.folder || settings.downloadFolder);
          await new Promise(r => setTimeout(r, 600));
        }
      }
      lastRender = ''; await renderHistory();
    }
    // History per-prompt download SELECTED (only .sel cards)
    const histPromptDlSelBtn = e.target.closest('[data-hist-prompt-dl-sel]');
    if (histPromptDlSelBtn) {
      const histIdx = Number(histPromptDlSelBtn.dataset.histPromptDlSel);
      const promptIdx = Number(histPromptDlSelBtn.dataset.histPromptIdx);
      const history = await getSessionHistory();
      const h = history[histIdx];
      if (!h) return;
      const { settings } = await getDownloadState();
      const prompt = (h.prompts || [])[promptIdx];
      if (!prompt) return;
      // Find selected video cards in this prompt's accordion
      const promptEl = document.getElementById(`hp-${histIdx}-${promptIdx}`);
      const selCards = promptEl ? Array.from(promptEl.querySelectorAll('.h-vid-card.sel')) : [];
      if (!selCards.length) {
        // Nothing selected - show visual hint
        histPromptDlSelBtn.textContent = '!! Select videos first!';
        setTimeout(() => { histPromptDlSelBtn.textContent = '&#11015; Download Selected'; }, 2000);
        return;
      }
      const selSigs = new Set(selCards.map(c => c.dataset.histVidSig).filter(Boolean));
      for (const item of (prompt.outputs || [])) {
        if (item.src && selSigs.has(item.signature || '')) {
          await downloadItem(item, h.folder || settings.downloadFolder);
          await new Promise(r => setTimeout(r, 600));
        }
      }
      lastRender = ''; await renderHistory();
    }
    // History individual video card click (toggle selected)
    const histVidCard = e.target.closest('[data-hist-vid-sig]');
    if (histVidCard) {
      histVidCard.classList.toggle('sel');
    }
  });

  window.addEventListener('message', e => {
    const msg = e.data || {};
    if (msg.source !== 'autoMetaCopy' || msg.type !== 'FLOATING_STATE') return;
    floatingState = { ...floatingState, ...msg.state };
    if (msg.state?.activeTab) setTab(msg.state.activeTab);
    root.querySelector('.win')?.classList.toggle('min', !!floatingState.minimized);
    lastRender = ''; scheduleRender();
  });
}

export function initDownloadManagerOverlay() {
  if (initialized) return;
  initialized = true;
  ensureStyles();

  // Detect if running in standalone download-manager.html tab (not floating iframe)
  _isStandaloneTab = window.location.pathname.includes('download-manager.html');

  root = document.getElementById('autoMetaFloatingRoot');
  if (!root) { root = document.createElement('div'); root.id = 'autoMetaFloatingRoot'; document.body.appendChild(root); }
  root.innerHTML = markup();
  bindEvents();

  // Start detection from any manager surface when a session is active.
  chrome.storage.local.get('autoMetaCopy_downloadSession', data => {
    if (data.autoMetaCopy_downloadSession?.active) initRealtimeDetection();
  });
  chrome.storage.local.get({ [FLOATING_STATE_KEY]: floatingState }, data => {
    floatingState = { ...floatingState, ...data[FLOATING_STATE_KEY] };
    activeTab = VALID_TABS.has(floatingState.activeTab) ? floatingState.activeTab : 'queue';
    setTab(activeTab);
    render();
  });
  let _storageRenderTimer = null;
  function scheduleStorageRender() {
    if (_storageRenderTimer) return;
    _storageRenderTimer = setTimeout(() => {
      _storageRenderTimer = null;
      lastRender = '';
      scheduleRender();
    }, _isStandaloneTab ? 800 : 500);  // Standalone tab updates less aggressively
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[FLOATING_STATE_KEY]) floatingState = { ...floatingState, ...changes[FLOATING_STATE_KEY].newValue };
    if (changes.autoMetaCopy_downloadSession) {
      const newSession = changes.autoMetaCopy_downloadSession.newValue;
      const oldSession = changes.autoMetaCopy_downloadSession.oldValue;
      // Only floating manager starts detection — standalone tab just watches
      if (newSession?.active && !oldSession?.active) initRealtimeDetection();
      scheduleStorageRender();
    }
    if (changes.autoMetaCopy_downloadedOutputs || changes[FLOATING_STATE_KEY]) {
      scheduleStorageRender();
    }
    const settingKeys = [
      'downloadFolder', 'autoDownload', 'autoDownloadMode', 'imageGenerationSelect', 'videoGenerationSelect', 'secondaryVideoGenerationSelect',
      'scanSpeed', 'thumbnailMode', 'preserveSessionAfterRefresh', 'autoRefreshAfterPrompt',
      'autoRefreshDelay', 'detectTimeoutMinutes', 'retryOnTimeout', 'maxRetryAttempts',
      'retryRecentGraceSec', 'retryOldPromptWindow', 'retryPartialPrompts',
      'maxPerPromptRetries', 'perAttemptTimeoutSec',
      'captureFirstFrame', 'startFrom', 'imageUploadDelay', 'generationWait',
      'refreshAfterAllDone', 'postDownloadWait', 'language'
    ];
    if (settingKeys.some(key => changes[key])) {
      scheduleStorageRender();
    }
    // ── Gate events: re-render immediately when prompt status changes ──────
    if (changes.autoMetaCopy_gateEvent) {
      const ev = changes.autoMetaCopy_gateEvent.newValue;
      if (ev) {
        const idx = ev.promptIndex;
        const status = ev.status;
        // Log gate event to UI status area (if visible)
        const statusMap = {
          ready: `✅ Prompt ${idx + 1}: slot detected — advancing`,
          fallback: `⚠️ Prompt ${idx + 1}: fallback slot ${ev.slot?.position} used`,
          retrying: `🔄 Prompt ${idx + 1}: retry ${ev.retryCount}/${ev.maxRetries}`,
          failed: `❌ Prompt ${idx + 1}: max retries reached — skipping`
        };
        if (statusMap[status]) console.log('[Gate→UI]', statusMap[status]);
        scheduleStorageRender(); // Re-render to update prompt status badges
      }
    }
  });
}

export function openDownloadManagerOverlay(tab = 'queue') {
  parentPost('OPEN_FLOATING_MANAGER', { tab: VALID_TABS.has(tab) ? tab : 'queue' });
  // Only scan if session is active
  chrome.storage.local.get('autoMetaCopy_downloadSession', data => {
    if (data.autoMetaCopy_downloadSession?.active) runRealtimeDetectionScan('overlay-open');
  });
}
export function closeDownloadManagerOverlay() { parentPost('FLOATING_CLOSE'); }
export async function refreshDownloadManagerState() { lastRender = ''; await render(); }
export { runRealtimeDetectionScan, startQueuedDownloads, getSessionCompletionState };
