(() => {
  'use strict';

  const api = globalThis.MeteAutomation;
  if (!api?.dom || api.content) return;
  const D = api.dom;
  const provider = D.providerFor();
  if (!provider || window.top !== window) return;
  const operations = new Map();
  const mediaCache = new Map();
  const journalKey = id => `operation:content:${id}`;
  let activeId = null;

  function snapshot(record) {
    const state = structuredClone(record.state);
    if (record.finalizing && state.status === 'completed') {
      state.status = 'running';
      state.phase = 'saving';
      state.message = 'Saving the verified provider results locally.';
      delete state.result;
    }
    return state;
  }

  async function persist(record) {
    const state = structuredClone(record.state);
    record.writes = (record.writes || Promise.resolve()).catch(() => {}).then(async () => {
      const response = await chrome.runtime.sendMessage({ target: 'background', type: 'operation:checkpoint', operationId: state.id, state });
      if (!response?.ok) throw D.error('CHECKPOINT_FAILED', response?.error || 'The extension could not save this operation safely. Nothing was resubmitted.');
    });
    return record.writes;
  }

  async function restore(id) {
    const saved = (await chrome.storage.local.get(journalKey(id)))[journalKey(id)];
    if (!saved) return null;
    if (saved.status !== 'running') return saved;
    const project = saved.checkpoint?.projectUrl;
    if (saved.action === 'vibes:project' && saved.phase === 'vibes:project-opened' && provider === 'vibes' && project
      && D.providerFor(project) === 'vibes' && /^\/projects\/[^/]+\/?$/.test(new URL(project).pathname)
      && new URL(project).origin === location.origin && new URL(project).pathname.replace(/\/$/, '') === location.pathname.replace(/\/$/, '')) {
      return { ...saved, status: 'completed', phase: 'completed', message: 'The verified Vibes project is open.', result: { url: project }, updatedAt: Date.now() };
    }
    return {
      ...saved, status: 'failed', phase: 'interrupted', updatedAt: Date.now(),
      message: 'The provider tab reloaded or navigated away. This operation was not resubmitted.',
      error: 'The provider tab lost its live operation after a reload or navigation. Inspect the original chat/project. Clear the run only when you are ready to start a new request; Mete Run will never repeat this operation ID.',
      errorCode: 'INTERRUPTED',
    };
  }

  function actionFor(action) {
    return {
      'meta:generate': provider === 'meta' && api.meta?.generate,
      'vibes:project': provider === 'vibes' && api.vibes?.project,
      'vibes:generate': provider === 'vibes' && api.vibes?.generate,
    }[action];
  }

  function validId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\u0000-\u001f]/.test(id);
  }

  async function execute(record, action, payload) {
    // Upload, preview selection and playback have sequential deadlines, not one shared 30-minute budget.
    const timer = setTimeout(() => record.controller.abort(D.error('TIMEOUT', 'This operation exceeded 75 minutes. Check the provider page. Nothing was retried.')), 75 * 60_000);
    try {
      const saved = await restore(record.state.id);
      if (saved) {
        record.state = saved;
        await persist(record);
        return;
      }
      D.checkAbort(record.controller.signal);
      await persist(record);
      const ctx = {
        operationId: record.state.id, signal: record.controller.signal,
        checkpoint: async (phase, message, details = {}) => {
          D.checkAbort(record.controller.signal);
          record.state = { ...record.state, phase, message, checkpoint: { ...record.state.checkpoint, ...details }, updatedAt: Date.now() };
          await persist(record);
          D.checkAbort(record.controller.signal);
        },
      };
      const result = await action(payload || {}, ctx);
      D.checkAbort(record.controller.signal);
      record.finalizing = true;
      record.state = { ...record.state, status: 'completed', phase: 'completed', message: 'Provider step completed and verified.', result, updatedAt: Date.now() };
      await persist(record);
    } catch (failure) {
      const cancelled = record.controller.signal.aborted && record.controller.signal.reason?.code === 'CANCELLED';
      record.state = {
        ...record.state, status: cancelled ? 'cancelled' : 'failed', phase: cancelled ? 'cancelled' : 'failed',
        message: failure.message || 'The page operation failed. Nothing was retried.',
        error: failure.message || 'The page operation failed.', errorCode: failure.code || 'AUTOMATION_FAILED', updatedAt: Date.now(),
      };
      await persist(record).catch(() => {});
    } finally {
      record.finalizing = false;
      clearTimeout(timer);
      if (activeId === record.state.id) activeId = null;
    }
  }

  function start(message) {
    const { operationId, action, payload } = message;
    if (!validId(operationId)) throw D.error('INVALID_OPERATION', 'A unique operation ID is required.');
    const existing = operations.get(operationId);
    if (existing) return snapshot(existing);
    if (activeId) throw D.error('TAB_BUSY', 'This provider tab is already running another operation. Wait for it or cancel it first.');
    const handler = actionFor(action);
    if (typeof handler !== 'function') throw D.error('UNSUPPORTED_ACTION', `The ${provider} tab cannot perform this action.`);
    const record = {
      controller: new AbortController(),
      state: { id: operationId, action, provider, url: location.href, status: 'running', phase: 'starting', message: 'Starting the provider step; checking its saved operation identity.', startedAt: Date.now(), updatedAt: Date.now() },
    };
    activeId = operationId;
    operations.set(operationId, record);
    // Acknowledge before hydration or work; MV3 messages never span generation waits.
    queueMicrotask(() => void execute(record, handler, payload));
    return snapshot(record);
  }

  async function status(operationId) {
    if (!validId(operationId)) throw D.error('INVALID_OPERATION', 'A valid operation ID is required.');
    const existing = operations.get(operationId);
    if (existing) return snapshot(existing);
    const saved = await restore(operationId);
    if (!saved) return { id: operationId, status: 'missing', phase: 'missing', message: 'This tab has no saved operation with that ID. Nothing was started.' };
    const record = { state: saved, controller: new AbortController() };
    operations.set(operationId, record);
    await persist(record);
    return snapshot(record);
  }

  async function cancel(operationId) {
    const record = operations.get(operationId);
    if (!record || record.state.status !== 'running') return status(operationId);
    const failure = D.error('CANCELLED', 'Mete Run stopped observing this operation. A request already accepted by the provider may still finish there; it will not be submitted again.');
    record.controller.abort(failure);
    record.state = { ...record.state, status: 'cancelled', phase: 'cancelled', message: failure.message, error: failure.message, errorCode: failure.code, updatedAt: Date.now() };
    await persist(record);
    return snapshot(record);
  }

  async function readMedia({ url, offset = 0, length = 1024 * 1024 }) {
    if (!D.allowedUrl(url, provider)) throw D.error('MEDIA_HOST', 'This media address is outside the bundled provider allowlist.');
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024) {
      throw D.error('MEDIA_RANGE', 'Media reads require a non-negative offset and a chunk of at most 1 MiB.');
    }
    const now = Date.now();
    for (const [key, entry] of mediaCache) if (entry.expiresAt < now) mediaCache.delete(key);
    if (!mediaCache.has(url)) {
      if (offset !== 0) throw D.error('MEDIA_EXPIRED', 'This media transfer expired. Its bytes were not fetched again in the middle of a file.');
      if (mediaCache.size >= 2) throw D.error('MEDIA_BUSY', 'Two media transfers are already active in this tab. Finish one before starting another.');
      const entry = { expiresAt: now + 5 * 60_000 };
      entry.promise = D.boundedMedia(url).catch(failure => { mediaCache.delete(url); throw failure; });
      mediaCache.set(url, entry);
    }
    const entry = mediaCache.get(url);
    entry.expiresAt = now + 5 * 60_000;
    const blob = await entry.promise;
    if (offset >= blob.size) throw D.error('MEDIA_RANGE', 'The media offset is past the end of this file.');
    const bytes = new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer());
    let binary = '';
    for (let position = 0; position < bytes.length; position += 32768) binary += String.fromCharCode(...bytes.subarray(position, position + 32768));
    const result = { offset, total: blob.size, base64: btoa(binary), type: blob.type };
    if (offset + bytes.length === blob.size) mediaCache.delete(url);
    return result;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target !== 'content' || sender.id !== chrome.runtime.id) return;
    const respond = data => sendResponse({ ok: true, data });
    const fail = failure => sendResponse({ ok: false, error: failure.message || String(failure) });
    try {
      if (message.type === 'ping') { respond({ provider, url: location.href }); return false; }
      if (message.type === 'operation:start') { respond(start(message)); return false; }
      const pending = message.type === 'operation:status' ? status(message.operationId)
        : message.type === 'operation:cancel' ? cancel(message.operationId)
          : message.type === 'media:read' ? readMedia(message) : Promise.reject(D.error('UNSUPPORTED_MESSAGE', 'Unknown content operation.'));
      Promise.resolve(pending).then(respond, fail);
      return true;
    } catch (failure) { fail(failure); return false; }
  });

  const host = document.createElement('div');
  host.setAttribute('data-mete-run-ui', '');
  Object.assign(host.style, { position: 'fixed', right: '14px', bottom: '14px', zIndex: '2147483646' });
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = ':host{all:initial}button{font:600 12px/1.4 system-ui,sans-serif;color:#fff;background:#1b4cd4;border:1px solid #86a6ff80;border-radius:99px;padding:10px 14px;box-shadow:0 3px 16px #0003;cursor:pointer}button:hover{background:#1743b9}button:focus-visible{outline:3px solid #a4bfff;outline-offset:3px}p{max-width:210px;margin:6px 0 0;padding:8px;border-radius:8px;background:#172337;color:white;font:12px/1.5 system-ui,sans-serif}';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Open Mete Run';
  button.title = 'Open Chrome’s native Mete Run side panel';
  const notice = document.createElement('p');
  notice.hidden = true;
  button.addEventListener('click', () => {
    chrome.runtime.sendMessage({ target: 'background', type: 'panel:open' }).then(response => {
      if (!response?.ok) throw new Error(response?.error);
      notice.hidden = true;
    }).catch(() => {
      notice.textContent = 'Click Mete Run in Chrome’s toolbar to open its side panel.';
      notice.hidden = false;
    });
  });
  shadow.append(style, button, notice);
  document.documentElement.append(host);
  const showLauncher = value => { host.hidden = value === false; host.style.display = host.hidden ? 'none' : ''; };
  chrome.storage.local.get('showLauncher').then(settings => showLauncher(settings.showLauncher)).catch(() => {});
  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === 'local' && changes.showLauncher) showLauncher(changes.showLauncher.newValue);
  });
  api.content = Object.freeze({ start, status, cancel, readMedia });
})();
