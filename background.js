import { PROVIDERS, providerForUrl } from './js/lib/policy.js';

let creatingOffscreen;
let operationQueue = Promise.resolve();
const engineUrl = chrome.runtime.getURL('offscreen.html');
const panelUrl = chrome.runtime.getURL('sidepanel.html');
const operationTypes = new Set(['ping', 'operation:start', 'operation:status', 'operation:cancel', 'media:read']);

function updateOperations(work) {
  const pending = operationQueue.then(work);
  operationQueue = pending.catch(() => {});
  return pending;
}

async function ensureEngine() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [engineUrl] });
    if (!contexts.length) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html', reasons: ['BLOBS'],
        justification: 'Keep local image/video Blobs and stream the user-selected ZIP while the side panel is closed.',
      });
    }
  })();
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}

async function providerTab(tabId, provider) {
  if (!Number.isInteger(tabId)) throw new Error('The generation tab is missing.');
  const tab = await chrome.tabs.get(tabId);
  if (!providerForUrl(tab.url) || (provider && providerForUrl(tab.url) !== provider)) {
    throw new Error('The generation tab left Meta AI or Vibes AI. Reopen its original page before continuing.');
  }
  return tab;
}

async function focusProvider({ provider, tabId }) {
  if (!PROVIDERS[provider]) throw new Error('Choose Meta AI or Vibes AI.');
  let tab;
  if (Number.isInteger(tabId)) {
    try { tab = await providerTab(tabId, provider); } catch { /* Find an existing provider tab instead. */ }
  }
  if (!tab) tab = (await chrome.tabs.query({})).find(candidate => providerForUrl(candidate.url) === provider);
  if (!tab) return chrome.tabs.create({ url: PROVIDERS[provider].home, active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return chrome.tabs.update(tab.id, { active: true });
}

async function handleEngine(message) {
  switch (message.type) {
    case 'state:publish':
      await chrome.storage.local.set({ session: message.session });
      return true;
    case 'provider:ensure': {
      if (!PROVIDERS[message.provider]) throw new Error('Unsupported generation provider.');
      if (message.tabId != null) return providerTab(message.tabId, message.provider);
      return chrome.tabs.create({ url: PROVIDERS[message.provider].home, active: true });
    }
    case 'provider:info':
      return providerTab(message.tabId, message.provider);
    case 'provider:send': {
      const { tabId, provider, command } = message;
      await providerTab(tabId, provider);
      if (!command || !operationTypes.has(command.type)) throw new Error('Unsupported provider command.');
      if (['operation:start', 'operation:status'].includes(command.type)) {
        await updateOperations(async () => {
          const key = `operation-owner:${command.operationId}`;
          const owner = (await chrome.storage.session.get(key))[key];
          if (owner != null && owner !== tabId) throw new Error('This operation belongs to a different tab.');
          await chrome.storage.session.set({ [key]: tabId });
        });
      }
      const response = await chrome.tabs.sendMessage(tabId, { ...command, target: 'content' });
      if (!response?.ok) throw new Error(response?.error || 'The page automation did not respond. Refresh the provider page and try again.');
      return response.data;
    }
    case 'operation:read':
      return (await chrome.storage.session.get(`operation:${message.operationId}`))[`operation:${message.operationId}`] || null;
    case 'operation:clear': {
      return updateOperations(async () => {
        const state = await chrome.storage.session.get(null);
        const keys = Object.keys(state).filter(key => key.startsWith('operation:') || key.startsWith('operation-owner:'));
        await chrome.storage.session.remove(keys);
        const local = await chrome.storage.local.get(null);
        await chrome.storage.local.remove(Object.keys(local).filter(key => key.startsWith('operation:content:')));
        return true;
      });
    }
    default:
      throw new Error('Unknown local worker request.');
  }
}

async function handlePanel(message) {
  if (message.type === 'tab:focus') return focusProvider(message);
  if (!['status:get', 'run:start', 'run:pause', 'run:resume', 'run:stop', 'run:clear', 'run:export'].includes(message.type)) {
    throw new Error('Unknown panel request.');
  }
  await ensureEngine();
  const response = await chrome.runtime.sendMessage({ ...message, target: 'engine' });
  if (!response?.ok) throw new Error(response?.error || 'The local worker did not respond. Reopen the side panel.');
  return response.data;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'background' || sender.id !== chrome.runtime.id) return;
  const reply = promise => {
    Promise.resolve(promise).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message }));
  };
  if (sender.tab && providerForUrl(sender.url)) {
    if (message.type === 'panel:open') {
      // Invoke immediately so the click's user gesture reaches Chrome's native panel API.
      reply(chrome.sidePanel.open({ windowId: sender.tab.windowId }));
      return true;
    }
    if (message.type === 'operation:checkpoint') {
      reply(updateOperations(async () => {
        const owner = (await chrome.storage.session.get(`operation-owner:${message.operationId}`))[`operation-owner:${message.operationId}`];
        if (owner !== sender.tab.id) throw new Error('This operation belongs to a different tab.');
        if (message.state?.id !== message.operationId) throw new Error('The checkpoint does not match its operation.');
        // Clear and checkpoint writes share one queue so a late cancelled step cannot recreate deleted data.
        await chrome.storage.local.set({ [`operation:content:${message.operationId}`]: message.state });
        await chrome.storage.session.set({ [`operation:${message.operationId}`]: message.state });
        return true;
      }));
      return true;
    }
    return;
  }
  if (sender.url === engineUrl) reply(handleEngine(message));
  else if (sender.url?.split('?')[0] === panelUrl) reply(handlePanel(message));
  else return;
  return true;
});

async function configurePanel() {
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}

chrome.runtime.onInstalled.addListener(() => {
  configurePanel().catch(console.error);
  chrome.storage.local.remove(['nvidiaApiKey', 'geminiApiKey']).catch(console.error);
});
chrome.runtime.onStartup.addListener(() => configurePanel().catch(console.error));
configurePanel().catch(console.error);
