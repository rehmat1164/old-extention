(() => {
  'use strict';

  const api = globalThis.MeteAutomation ||= {};
  const controls = 'button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="radio"], a';
  const ignored = '[data-mete-run-ui], [data-mete-run-label], nav, aside, [role="navigation"]';
  const providers = { meta: ['meta.ai', 'www.meta.ai'], vibes: ['vibes.ai', 'www.vibes.ai'] };
  const annotations = new WeakMap();

  function error(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function checkAbort(signal) {
    if (signal?.aborted) throw signal.reason || error('CANCELLED', 'The page operation was cancelled.');
  }

  function providerFor(value = location.href) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
      return Object.keys(providers).find(provider => providers[provider].includes(url.hostname)) || null;
    } catch { return null; }
  }

  function allowedUrl(value, provider = providerFor()) {
    try {
      const url = new URL(value);
      if (!providers[provider]) return false;
      if (url.protocol === 'blob:') return providerFor(url.pathname) === provider;
      if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
      return providerFor(url.href) === provider || ['fbcdn.net', 'fbsbx.com'].some(host => url.hostname.endsWith(`.${host}`));
    } catch { return false; }
  }

  function mediaKey(value) {
    if (!value) return '';
    try {
      const url = new URL(value, location.href);
      url.hash = '';
      if (['fbcdn.net', 'fbsbx.com'].some(host => url.hostname.endsWith(`.${host}`))) {
        for (const key of [...url.searchParams.keys()]) {
          if (/^(?:_nc_|oh$|oe$|ccb$|stp$)/.test(key)) url.searchParams.delete(key);
        }
      }
      url.searchParams.sort();
      return url.href;
    } catch { return ''; }
  }

  function text(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.matches?.('[data-mete-run-ui], [data-mete-run-label], script, style')) return '';
    return [...node.childNodes].map(text).join(' ').replace(/\s+/g, ' ').trim();
  }

  function name(node) {
    if (!node) return '';
    const labelledBy = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
      .map(id => text(document.getElementById(id))).join(' ');
    return (node.getAttribute('aria-label') || labelledBy || node.getAttribute('alt') || text(node)).trim();
  }

  function visible(node) {
    if (!node?.isConnected || node.closest?.('[hidden], [aria-hidden="true"], [inert]')) return false;
    const style = getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
  }

  function enabled(node) {
    return visible(node) && !node.disabled && node.getAttribute('aria-disabled') !== 'true';
  }

  function matchesName(value, pattern) {
    return pattern instanceof RegExp ? pattern.test(value) : value.toLowerCase() === String(pattern).toLowerCase();
  }

  function control(root, pattern, { includeDisabled = false } = {}) {
    const candidates = [...root.querySelectorAll(controls)]
      .filter(node => !node.closest(ignored) && (includeDisabled ? visible(node) : enabled(node)) && matchesName(name(node), pattern));
    const leaves = candidates.filter(node => !candidates.some(other => other !== node && node.contains(other)));
    if (leaves.length > 1) throw error('AMBIGUOUS_CONTROL', `More than one visible control matches ${pattern}. Close extra menus or dialogs, then start a new run.`);
    return leaves[0] || null;
  }

  function dialog(pattern) {
    const candidates = [...document.querySelectorAll('[role="dialog"], dialog')].filter(visible)
      .filter(node => matchesName(name(node), pattern) || [...node.querySelectorAll('h1, h2, h3, [role="heading"]')]
        .some(heading => matchesName(text(heading), pattern)));
    return candidates.length === 1 ? candidates[0] : null;
  }

  function busy(root) {
    return [...root.querySelectorAll('[aria-busy="true"], [role="progressbar"], [data-state="loading"], [data-status="generating"], [data-status="pending"]')].some(visible)
      || [...root.querySelectorAll('button, [role="button"]')].some(node => visible(node) && /^(?:Stop(?: generating| generation| response)?|Cancel generation)$/i.test(name(node)));
  }

  function providerFailure(root = document) {
    return [...root.querySelectorAll('[role="alert"], [data-status="failed"], [data-status="error"]')]
      .filter(visible).map(text).find(value => /failed|something went wrong|try again|couldn.t|cannot|can.t|limit reached|not enough|insufficient|blocked|not allowed|sign in|log in/i.test(value)) || '';
  }

  function assertPage(expectedProvider, expectedUrl) {
    if (providerFor() !== expectedProvider || (expectedUrl && (new URL(location.href).origin !== new URL(expectedUrl).origin
      || new URL(location.href).pathname.replace(/\/$/, '') !== new URL(expectedUrl).pathname.replace(/\/$/, '')))) {
      throw error('PAGE_CHANGED', 'The provider page changed during this operation. Nothing was submitted again. Keep the original chat or project open.');
    }
    const failure = providerFailure();
    if (failure) throw error('PROVIDER_ERROR', `The provider reported: ${failure.slice(0, 450)}. Nothing was retried.`);
  }

  function waitFor(check, { signal, timeout = 120_000, interval = 650, stableFor = 0, signature = value => value,
    root = document, message = 'The required page state did not appear.' } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let checking = false;
      let rerun = false;
      let signatureValue;
      let readySince = 0;
      let scheduled;
      let poll;
      let deadline;
      let observer;
      const finish = (failure, value) => {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        clearTimeout(scheduled);
        clearInterval(poll);
        clearTimeout(deadline);
        signal?.removeEventListener('abort', cancel);
        root.removeEventListener?.('load', schedule, true);
        root.removeEventListener?.('loadeddata', schedule, true);
        root.removeEventListener?.('loadedmetadata', schedule, true);
        failure ? reject(failure) : resolve(value);
      };
      const cancel = () => finish(signal.reason || error('CANCELLED', 'The page operation was cancelled.'));
      const tick = async () => {
        if (settled) return;
        if (checking) { rerun = true; return; }
        checking = true;
        try {
          checkAbort(signal);
          const value = await check();
          if (settled) return;
          if (value) {
            const key = signature(value);
            if (!readySince || key !== signatureValue) { readySince = Date.now(); signatureValue = key; }
            if (Date.now() - readySince >= stableFor) finish(null, value);
          } else { readySince = 0; signatureValue = undefined; }
        } catch (failure) { finish(failure); }
        finally {
          checking = false;
          if (rerun && !settled) { rerun = false; schedule(); }
        }
      };
      function schedule() {
        if (settled || scheduled) return;
        scheduled = setTimeout(() => { scheduled = null; void tick(); }, 35);
      }
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener('abort', cancel, { once: true });
      observer = new MutationObserver(schedule);
      observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      root.addEventListener?.('load', schedule, true);
      root.addEventListener?.('loadeddata', schedule, true);
      root.addEventListener?.('loadedmetadata', schedule, true);
      poll = setInterval(() => void tick(), interval);
      deadline = setTimeout(() => finish(error('TIMEOUT', typeof message === 'function' ? message() : message)), timeout);
      void tick();
    });
  }

  function click(node, signal) {
    checkAbort(signal);
    if (!enabled(node)) throw error('CONTROL_NOT_READY', 'The required page control is missing or disabled. No fallback click was attempted.');
    node.click();
  }

  function editorValue(node) {
    return (node?.matches('input, textarea') ? node.value : node?.innerText || node?.textContent || '').replace(/\r\n?/g, '\n').trim();
  }

  function normaliseText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  async function fillEditor(node, value, ctx) {
    checkAbort(ctx.signal);
    if (editorValue(node)) throw error('COMPOSER_NOT_EMPTY', 'The provider composer already contains text. Clear your draft before starting; Mete Run will not overwrite it.');
    node.focus();
    if (node.matches('textarea, input')) {
      const prototype = node.matches('textarea') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
      node.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const selection = getSelection();
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
      // Rich-text editors own paste handling; one multiline insertText can lose line separators.
      const clipboardData = new DataTransfer();
      clipboardData.setData('text/plain', value);
      const handled = !node.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true, composed: true }));
      if (!handled && !editorValue(node)) {
        const lines = value.replace(/\r\n?/g, '\n').split('\n');
        for (let index = 0; index < lines.length; index++) {
          checkAbort(ctx.signal);
          if (index && !document.execCommand('insertLineBreak', false)) {
            throw error('EDITOR_REJECTED', 'The provider editor did not accept a prompt line break. Nothing was submitted.');
          }
          if (lines[index] && !document.execCommand('insertText', false, lines[index])) {
            throw error('EDITOR_REJECTED', 'The provider editor did not accept the prompt. Nothing was submitted.');
          }
        }
      }
    }
    // Paragraphs, BRs and non-breaking spaces may render differently; words and their boundaries must match.
    await waitFor(() => normaliseText(editorValue(node)) === normaliseText(value), {
      signal: ctx.signal, timeout: 10_000, stableFor: 250,
      message: 'The provider editor did not retain the complete prompt. Nothing was submitted.',
    });
  }

  function submit(editor, root, signal) {
    checkAbort(signal);
    const button = control(root, /^(?:Send|Send message|Generate video|Generate images?|Submit)$/i, { includeDisabled: true });
    if (button) { click(button, signal); return; }
    const submitters = [...root.querySelectorAll('button[type="submit"]')].filter(enabled);
    if (submitters.length === 1) { click(submitters[0], signal); return; }
    // Both supplied recordings submit with Enter. Never also click after this.
    editor.focus();
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    editor.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }

  function imageUrl(image) {
    return image?.currentSrc || image?.src || '';
  }

  function imageReady(image, minSize = 32) {
    return visible(image) && image.complete && image.naturalWidth >= minSize && image.naturalHeight >= minSize;
  }

  function labels(node) {
    return ['alt', 'aria-label', 'title', 'data-filename', 'data-label'].map(key => node?.getAttribute(key) || '').filter(Boolean);
  }

  function annotate(image, label, title = label) {
    const parent = image?.parentElement;
    if (!parent || !visible(image)) return;
    let badge = annotations.get(image);
    if (!badge?.isConnected || badge.parentElement !== parent) {
      badge?.remove();
      badge = document.createElement('span');
      badge.setAttribute('data-mete-run-label', '');
      badge.setAttribute('aria-hidden', 'true');
      Object.assign(badge.style, {
        position: 'absolute', left: '6px', top: '6px', zIndex: '5', padding: '3px 6px', borderRadius: '5px',
        font: '600 11px/1.4 system-ui, sans-serif', color: '#fff', background: 'rgba(17,24,39,.9)', pointerEvents: 'none',
      });
      if (getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
      parent.append(badge);
      annotations.set(image, badge);
    }
    const rect = image.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    const left = `${rect.left - parentRect.left + parent.scrollLeft + 6}px`;
    const top = `${rect.top - parentRect.top + parent.scrollTop + 6}px`;
    if (badge.style.left !== left) badge.style.left = left;
    if (badge.style.top !== top) badge.style.top = top;
    if (badge.textContent !== label) badge.textContent = label;
    if (badge.title !== title) badge.title = title;
  }

  function annotation(image) { return annotations.get(image); }

  function sniff(bytes) {
    const ascii = start => String.fromCharCode(...bytes.slice(start, start + 4));
    if (bytes[0] === 0x89 && ascii(1) === 'PNG\r' && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
    if (ascii(0) === 'RIFF' && ascii(8) === 'WEBP') return 'image/webp';
    if (ascii(4) === 'ftyp' && /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(ascii(8))) return 'video/mp4';
    return '';
  }

  async function digest(bytes) {
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  async function imageFile(payload) {
    const image = payload.image;
    const match = /^data:(image\/(?:png|jpeg|webp));base64,([a-zA-Z0-9+/=]+)$/.exec(image?.dataUrl || '');
    if (!match || match[1] !== image.type || match[2].length > 14 * 1024 * 1024 || !/^[a-f0-9]{64}$/i.test(image.sha256 || '')) {
      throw error('INVALID_IMAGE', 'The start-frame payload must contain a PNG, JPG, or WebP image and its SHA-256 fingerprint.');
    }
    const binary = atob(match[2]);
    if (!binary.length || binary.length > 10 * 1024 * 1024) throw error('IMAGE_TOO_LARGE', 'Vibes start frames must be non-empty and no larger than 10 MiB.');
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    if (sniff(bytes) !== image.type) throw error('INVALID_IMAGE', 'The start-frame bytes do not match the declared image type.');
    const sha256 = await digest(bytes);
    if (sha256 !== image.sha256.toLowerCase()) throw error('HASH_MISMATCH', 'The start-frame fingerprint changed during transfer. Nothing was uploaded.');
    if (typeof payload.uploadLabel !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_. -]{0,180}$/.test(payload.uploadLabel)) {
      throw error('INVALID_UPLOAD_LABEL', 'A unique, filesystem-safe upload label is required for every image.');
    }
    const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[image.type];
    const filename = /\.(png|jpe?g|webp)$/i.test(payload.uploadLabel) ? payload.uploadLabel : `${payload.uploadLabel}.${extension}`;
    if (!new RegExp(`\\.${extension === 'jpg' ? 'jpe?g' : extension}$`, 'i').test(filename)) {
      throw error('INVALID_IMAGE_NAME', 'The unique start-frame filename does not match its image type.');
    }
    return { file: new File([bytes], filename, { type: image.type }), sha256, filename };
  }

  async function boundedMedia(url, { signal, limit = 256 * 1024 * 1024 } = {}) {
    if (!allowedUrl(url)) throw error('MEDIA_HOST', 'The media URL is outside the bundled provider allowlist.');
    const response = await fetch(url, { credentials: 'include', redirect: 'error', signal: signal || AbortSignal.timeout(120_000) });
    if (!response.ok || response.type === 'opaque') throw error('MEDIA_RESPONSE', `The provider media request failed (${response.status}). Keep the provider tab open.`);
    const declared = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (declared && !['application/octet-stream', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(declared)) {
      throw error('MEDIA_TYPE', `The provider returned ${declared}, not a supported completed media file.`);
    }
    if (Number(response.headers.get('content-length')) > limit) throw error('MEDIA_SIZE', 'The provider file exceeds the 256 MiB transfer limit.');
    const reader = response.body?.getReader();
    if (!reader) throw error('EMPTY_MEDIA', 'The provider returned no media bytes.');
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        checkAbort(signal);
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) throw error('MEDIA_SIZE', 'The provider file exceeds the 256 MiB transfer limit.');
        chunks.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const blob = new Blob(chunks);
    const type = sniff(new Uint8Array(await blob.slice(0, 48).arrayBuffer()));
    if (!type || (declared && declared !== 'application/octet-stream' && declared !== type)) {
      throw error('MEDIA_TYPE', 'The provider response is not a completed PNG, JPG, WebP, or MP4 file. Thumbnails are not exported as videos.');
    }
    if (type.startsWith('image/') && total > 32 * 1024 * 1024) throw error('MEDIA_SIZE', 'The generated image exceeds the 32 MiB transfer limit.');
    return blob.slice(0, blob.size, type);
  }

  api.dom = Object.freeze({
    controls, ignored, error, checkAbort, providerFor, allowedUrl, mediaKey, text, name, visible, enabled,
    control, dialog, busy, providerFailure, assertPage, waitFor, click, editorValue, normaliseText, fillEditor, submit,
    imageUrl, imageReady, labels, annotate, annotation, sniff, digest, imageFile, boundedMedia,
  });
})();
