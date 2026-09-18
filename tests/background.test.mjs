import assert from 'node:assert/strict';
import test from 'node:test';

let revision = 0;

async function setup() {
  const local = {}, session = {};
  const storage = data => ({
    async get(key) { return structuredClone(key == null ? data : { [key]: data[key] }); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  let listener;
  globalThis.chrome = {
    runtime: {
      id: 'fixture-extension', getURL: path => `chrome-extension://fixture-extension/${path}`,
      onMessage: { addListener(value) { listener = value; } },
      onInstalled: { addListener() {} }, onStartup: { addListener() {} },
    },
    storage: { local: storage(local), session: storage(session) },
    sidePanel: { async setPanelBehavior() {} },
    tabs: {
      async get(id) { return { id, url: 'https://www.meta.ai/' }; },
      async sendMessage() { return { ok: true, data: { status: 'running' } }; },
    },
  };
  await import(`../background.js?fixture=${++revision}`);
  const send = (message, sender) => new Promise(resolve => {
    listener({ target: 'background', ...message }, { id: chrome.runtime.id, ...sender }, resolve);
  });
  const engine = message => send(message, { url: chrome.runtime.getURL('offscreen.html') });
  const checkpoint = (id, state = {}, tabId = 1) => send({ type: 'operation:checkpoint', operationId: id, state: { id, status: 'running', ...state } },
    { tab: { id: tabId }, url: 'https://www.meta.ai/' });
  const register = (id, tabId = 1) => engine({ type: 'provider:send', tabId, provider: 'meta',
    command: { type: 'operation:start', operationId: id, action: 'meta:generate', payload: {} } });
  return { local, session, engine, checkpoint, register, localStorage: chrome.storage.local };
}

test('only the owning provider tab can persist its operation journal', async () => {
  const env = await setup();
  assert.equal((await env.checkpoint('unknown')).ok, false);
  assert.equal((await env.register('owned')).ok, true);
  assert.equal((await env.register('owned', 2)).ok, false);
  assert.equal((await env.checkpoint('owned', {}, 2)).ok, false);
  assert.equal((await env.checkpoint('owned', { id: 'another' })).ok, false);
  assert.deepEqual(env.local, {});
  assert.equal((await env.checkpoint('owned')).ok, true);
  assert.equal(env.local['operation:content:owned'].status, 'running');
  assert.equal(env.session['operation:owned'].status, 'running');
});

test('Clear waits for in-flight checkpoint writes and rejects later cancelled-operation writes before local persistence', async () => {
  const env = await setup();
  await env.register('clear-race');
  let entered, release;
  const writing = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const set = env.localStorage.set;
  env.localStorage.set = async values => { entered(); await blocked; return set(values); };
  const checkpoint = env.checkpoint('clear-race');
  await writing;
  const clearing = env.engine({ type: 'operation:clear' });
  release();
  assert.equal((await checkpoint).ok, true);
  assert.equal((await clearing).ok, true);
  assert.deepEqual(env.local, {});
  assert.deepEqual(env.session, {});
  assert.equal((await env.checkpoint('clear-race', { status: 'cancelled' })).ok, false);
  assert.deepEqual(env.local, {});
  assert.deepEqual(env.session, {});
  assert.equal((await env.register('new-run')).ok, true);
  assert.equal((await env.checkpoint('new-run', { status: 'completed' })).ok, true);
});
