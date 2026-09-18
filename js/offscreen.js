import * as store from './lib/store.js';
import { RunController } from './lib/runner.js';
import { downloadMedia } from './lib/media.js';

async function rpc(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target: 'background', type, ...payload });
  if (!response?.ok) throw new Error(response?.error || 'The extension service worker did not respond.');
  return response.data;
}

const runner = new RunController({
  get: store.get, put: store.put, remove: store.remove,
  getRun: store.getCurrentRun, saveRun: store.putCurrentRun,
  publish: session => rpc('state:publish', { session }), rpc, download: downloadMedia,
});
const ready = runner.init();
let commands = ready;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'engine' || sender.id !== chrome.runtime.id || sender.tab) return;
  const actions = {
    'status:get': () => runner.status(),
    'run:start': () => runner.start(message),
    'run:pause': () => runner.pause(),
    'run:resume': () => runner.resume(),
    'run:stop': () => runner.stop(),
    'run:clear': () => runner.clear(),
    'run:export': () => runner.export(message),
  };
  const command = commands.then(() => {
    if (!actions[message.type]) throw new Error('Unknown local workflow request.');
    return actions[message.type]();
  });
  commands = command.catch(() => {});
  command.then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error.message }));
  return true;
});
