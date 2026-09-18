import test from 'node:test';
import assert from 'node:assert/strict';
import { RunController } from '../js/lib/runner.js';
import { createSession } from '../js/lib/model.js';

const png = marker => new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, marker])], { type: 'image/png' });
const mp4 = new Blob([new Uint8Array([0, 0, 0, 24]), 'ftypisom', new Uint8Array(16)], { type: 'video/mp4' });

function setup(overrides = {}) {
  const stores = { assets: new Map(), handles: new Map(), runs: new Map() };
  const starts = [], downloads = [], commands = [], states = new Map();
  const zip = { chunks: [], closed: false, aborted: false };
  const handle = {
    name: 'chosen.zip', permission: 'granted',
    async queryPermission() { return this.permission; },
    async createWritable() {
      zip.chunks = []; zip.closed = false; zip.aborted = false;
      return {
        async write(value) { if (zip.fail) throw new Error('Disk write failed'); zip.chunks.push(value); },
        async close() { zip.closed = true; },
        async abort() { zip.aborted = true; },
      };
    },
  };
  stores.handles.set('destination', handle);
  const io = {
    get: async (store, key) => stores[store].get(key),
    put: async (store, key, value) => stores[store].set(key, value),
    remove: async (store, key) => stores[store].delete(key),
    getRun: async () => stores.runs.get('current'),
    saveRun: async session => stores.runs.set('current', structuredClone(session)),
    publish: async () => {},
    delay: async () => {},
    download: async ({ url, kind, provider }) => {
      downloads.push({ url, kind, provider });
      return kind === 'image' ? png(url.includes('image2') ? 2 : 1) : mp4;
    },
    rpc: async (type, payload = {}) => {
      commands.push({ type, ...payload });
      if (type === 'operation:clear') return true;
      if (type === 'operation:read') return null;
      const { provider, command } = payload;
      if (type === 'provider:ensure' || type === 'provider:info') return {
        id: provider === 'meta' ? 1 : 2, url: provider === 'meta' ? 'https://www.meta.ai/' : 'https://vibes.ai/projects/test',
      };
      if (command.type === 'ping') return { provider };
      if (command.type === 'operation:cancel') return { status: 'cancelled' };
      if (command.type === 'operation:status') return states.get(command.operationId) || { status: 'missing' };
      if (command.type === 'operation:start') {
        starts.push(command);
        let result;
        if (command.action === 'meta:generate') result = {
          url: 'https://www.meta.ai/prompt/test',
          images: [...command.payload.expected].reverse().map(({ index }) => ({ index, url: `https://media.fbcdn.net/image${index}.png`, sourceKey: `image${index}` })),
        };
        if (command.action === 'vibes:project') result = { url: 'https://vibes.ai/projects/test' };
        if (command.action === 'vibes:generate') result = {
          url: 'https://vibes.ai/projects/test',
          upload: { verified: true, sha256: command.payload.image.sha256, label: command.payload.uploadLabel },
          variants: [4, 2, 1, 3].map(variant => ({ variant, url: `https://media.fbcdn.net/video${command.payload.index}-${variant}.mp4`, sourceKey: `video${command.payload.index}-${variant}` })),
        };
        states.set(command.operationId, { status: 'completed', result });
        return { status: 'running' };
      }
      throw new Error(`Unexpected RPC ${type}`);
    },
    ...overrides,
  };
  const runner = new RunController(io);
  return { runner, io, stores, starts, states, commands, downloads, zip, handle };
}

const imageConfig = { mode: 'image', imagePrompts: 'A tree\n\nA river' };
const pipelineConfig = { mode: 'prompt-video', imagePrompts: 'A tree\n\nA river', videoPrompts: 'Wind\n\nFlowing water', variants: [2, 4], includeImages: true };
const start = async (env, config = imageConfig, extra = {}) => env.runner.start({ config, runId: 'test-run', handleId: 'destination', ...extra });

test('validation and destination cancellation cannot open a provider or start generation', async () => {
  const env = setup();
  await assert.rejects(start(env, { mode: 'prompt-video', imagePrompts: 'one', videoPrompts: 'one\n\ntwo' }), /same count/);
  env.handle.permission = 'denied';
  await assert.rejects(start(env), /ZIP save location/);
  assert.equal(env.commands.length, 0);
  assert.equal(env.runner.session, null);
});

test('one image per prompt is exported in prompt order, not completion order', async () => {
  const env = setup();
  await start(env);
  await env.runner.task;
  assert.equal(env.runner.session.status, 'complete');
  assert.equal(env.zip.closed, true);
  assert.equal(env.starts.length, 1);
  assert.deepEqual(env.downloads.map(item => item.url), ['https://media.fbcdn.net/image1.png', 'https://media.fbcdn.net/image2.png']);
  const text = new TextDecoder().decode(await new Blob(env.zip.chunks).arrayBuffer());
  assert.match(text, /images\/image_001.png/);
  assert.match(text, /images\/image_002.png/);
  assert.doesNotMatch(text, /videos\//);
  assert.match(text, /manifest.json/);
  assert.doesNotMatch(text, /media.fbcdn.net/);
});

test('pipeline verifies each upload hash, observes four variants and fetches selected variants only', async () => {
  const env = setup();
  await start(env, pipelineConfig);
  await env.runner.task;
  assert.equal(env.runner.session.status, 'complete');
  assert.deepEqual(env.starts.map(item => item.action), ['meta:generate', 'vibes:project', 'vibes:generate', 'vibes:generate']);
  assert.deepEqual(env.downloads.filter(item => item.kind === 'video').map(item => item.url), [
    'https://media.fbcdn.net/video1-2.mp4', 'https://media.fbcdn.net/video1-4.mp4',
    'https://media.fbcdn.net/video2-2.mp4', 'https://media.fbcdn.net/video2-4.mp4',
  ]);
  for (const job of env.runner.session.jobs) assert.equal(job.upload.sha256, job.image.sha256);
  const text = new TextDecoder().decode(await new Blob(env.zip.chunks).arrayBuffer());
  assert.match(text, /images\/image_002.png/);
  assert.match(text, /videos\/video_002_variant_4.mp4/);
  assert.doesNotMatch(text, /videos\/video_001_variant_1.mp4/);
});

test('uploaded files pair with video prompts in natural filename order', async () => {
  const env = setup();
  const uploads = ['image10.png', 'image2.png'].map((name, index) => {
    const blob = png(index);
    const asset = { assetId: name, name, size: blob.size, type: blob.type };
    env.stores.assets.set(name, { blob });
    return asset;
  });
  await start(env, { mode: 'image-video', videoPrompts: 'Second image moves\n\nTenth image moves', variants: [1] }, { uploads });
  await env.runner.task;
  assert.equal(env.runner.session.status, 'complete');
  assert.deepEqual(env.runner.session.jobs.map(job => [job.originalName, job.videoPrompt]), [
    ['image2.png', 'Second image moves'], ['image10.png', 'Tenth image moves'],
  ]);
  assert.equal(env.starts.some(item => item.action === 'meta:generate'), false);
});

test('duplicate start requests cannot create a second run', async () => {
  const env = setup();
  const first = start(env);
  await assert.rejects(start(env), /already active/);
  await first;
  await env.runner.task;
  assert.equal(env.starts.filter(item => item.action === 'meta:generate').length, 1);
});

test('missing or ambiguous result identities stop before any video action', async () => {
  const env = setup();
  const rpc = env.io.rpc;
  env.io.rpc = async (type, payload) => {
    const result = await rpc(type, payload);
    if (payload?.command?.type === 'operation:status') {
      result.result.images[1].index = result.result.images[0].index;
    }
    return result;
  };
  await start(env, pipelineConfig);
  await env.runner.task;
  assert.equal(env.runner.session.status, 'error');
  assert.match(env.runner.session.message, /one-to-one/);
  assert.equal(env.downloads.length, 0);
  assert.equal(env.starts.length, 1);
  assert.equal(env.zip.closed, false);
});

test('a failed upload verification prevents saving videos or submitting the next image', async () => {
  const env = setup();
  const rpc = env.io.rpc;
  env.io.rpc = async (type, payload) => {
    const result = await rpc(type, payload);
    if (payload?.command?.type === 'operation:status' && result.result?.upload) result.result.upload.sha256 = 'wrong-image';
    return result;
  };
  await start(env, pipelineConfig);
  await env.runner.task;
  assert.equal(env.runner.session.status, 'error');
  assert.match(env.runner.session.message, /start-frame/);
  assert.equal(env.downloads.filter(item => item.kind === 'video').length, 0);
  assert.equal(env.starts.filter(item => item.action === 'vibes:generate').length, 1);
});

test('lost page operations are never automatically submitted again on Resume', async () => {
  const env = setup();
  const rpc = env.io.rpc;
  env.io.rpc = async (type, payload) => payload?.command?.type === 'operation:status' ? { status: 'missing' } : rpc(type, payload);
  await start(env);
  await env.runner.task;
  assert.equal(env.runner.session.status, 'error');
  assert.match(env.runner.session.message, /not resubmitted/);
  await env.runner.resume();
  await env.runner.task;
  assert.equal(env.starts.length, 1);
  assert.equal(env.zip.closed, false);
});

test('worker restart pauses a saved operation and can recover a completed checkpoint without re-submission', async () => {
  const env = setup();
  const session = createSession(imageConfig, [], 'test-run');
  session.status = 'running'; session.handleId = 'destination';
  session.meta = { tabId: 1, url: 'https://www.meta.ai/prompt/test' };
  session.operation = { id: 'old-op', provider: 'meta', tabId: 1, action: 'meta:generate', index: null };
  env.stores.runs.set('current', session);
  const rpc = env.io.rpc;
  env.io.rpc = async (type, payload) => type === 'operation:read' ? {
    status: 'completed', result: { url: session.meta.url, images: [1, 2].map(index => ({ index, url: `https://media.fbcdn.net/image${index}.png` })) },
  } : rpc(type, payload);
  await env.runner.init();
  assert.equal(env.runner.session.status, 'paused');
  await env.runner.resume();
  await env.runner.task;
  assert.equal(env.runner.session.status, 'complete');
  assert.equal(env.starts.length, 0);
});

test('Pause collects the submitted item and prevents the next stage until Resume', async () => {
  const env = setup();
  const rpc = env.io.rpc;
  let unblock, observing;
  const observed = new Promise(resolve => { observing = resolve; });
  const block = new Promise(resolve => { unblock = resolve; });
  let blocked = false;
  env.io.rpc = async (type, payload) => {
    if (payload?.command?.type === 'operation:status' && !blocked) {
      blocked = true; observing(); await block;
    }
    return rpc(type, payload);
  };
  await start(env, pipelineConfig);
  await observed;
  await env.runner.pause();
  unblock();
  await env.runner.task;
  assert.equal(env.runner.session.status, 'paused');
  assert.equal(env.starts.length, 1);
  assert.equal(env.downloads.length, 2);
  await env.runner.resume();
  await env.runner.task;
  assert.equal(env.runner.session.status, 'complete');
  assert.equal(env.starts.filter(item => item.action === 'meta:generate').length, 1);
});

test('export failure is not reported as completion and retry never regenerates media', async () => {
  const env = setup();
  env.zip.fail = true;
  await start(env);
  await env.runner.task;
  assert.equal(env.runner.session.status, 'export-error');
  assert.equal(env.runner.session.exportedAt, undefined);
  assert.equal(env.zip.aborted, true);
  env.zip.fail = false;
  await env.runner.export();
  await env.runner.task;
  assert.equal(env.runner.session.status, 'complete');
  assert.equal(env.starts.length, 1);
  assert.equal(env.downloads.length, 2);
});

test('changing exported variants downloads only the newly selected candidates without generation', async () => {
  const env = setup();
  await start(env, pipelineConfig);
  await env.runner.task;
  const starts = env.starts.length;
  const downloadCount = env.downloads.length;
  await env.runner.export({ variants: [3] });
  await env.runner.task;
  assert.equal(env.runner.session.status, 'complete');
  assert.equal(env.starts.length, starts);
  assert.deepEqual(env.downloads.slice(downloadCount).map(item => item.url), ['https://media.fbcdn.net/video1-3.mp4', 'https://media.fbcdn.net/video2-3.mp4']);
  await assert.rejects(env.runner.export({ variants: [3, 3] }), /unique/);
});

test('manual ZIP review keeps complete media local until explicitly saved, including after worker restart', async () => {
  const env = setup();
  await start(env, { ...pipelineConfig, autoSave: false });
  await env.runner.task;
  assert.equal(env.runner.session.status, 'ready-to-export');
  assert.equal(env.runner.session.generationComplete, true);
  assert.equal(env.zip.closed, false);
  assert.equal(env.zip.chunks.length, 0);
  assert.equal(env.runner.session.lastExport, undefined);
  const requests = env.starts.length;
  const restored = new RunController(env.io);
  await restored.init();
  assert.equal(restored.session.status, 'ready-to-export');
  assert.equal(restored.task, null);
  await restored.export({ includeImages: false, variants: [2, 4] });
  await restored.task;
  assert.equal(restored.session.status, 'complete');
  assert.equal(env.starts.length, requests);
  assert.equal(env.zip.closed, true);
  assert.equal(restored.session.lastExport.files.length, 4);
  assert.ok(restored.session.lastExport.files.every(file => file.path.startsWith('videos/')));
  assert.equal(restored.session.lastExport.bytes, new Blob(env.zip.chunks).size);
  assert.equal(restored.session.zipProgress.progress, 1);
});

test('changing ZIP contents never regenerates and a failed rewrite retains the last successful export record', async () => {
  const env = setup();
  await start(env, pipelineConfig);
  await env.runner.task;
  const previous = structuredClone(env.runner.session.lastExport);
  const requests = env.starts.length;
  const downloads = env.downloads.length;
  await assert.rejects(env.runner.export({ includeImages: 'no', variants: [1] }), /include images/);
  assert.deepEqual(env.runner.session.settings.variants, [2, 4]);
  env.zip.fail = true;
  await env.runner.export({ includeImages: false });
  await env.runner.task;
  assert.equal(env.runner.session.status, 'export-error');
  assert.deepEqual(env.runner.session.lastExport, previous);
  assert.equal(env.runner.session.exportedAt, previous.at);
  env.zip.fail = false;
  await env.runner.export();
  await env.runner.task;
  assert.equal(env.runner.session.lastExport.files.length, 4);
  assert.equal(env.starts.length, requests);
  assert.equal(env.downloads.length, downloads);
});

test('Stop cancels local observation and never exports or resubmits a stopped item', async () => {
  const env = setup();
  const rpc = env.io.rpc;
  let unblock, observed;
  const block = new Promise(resolve => { unblock = resolve; });
  const observing = new Promise(resolve => { observed = resolve; });
  env.io.rpc = async (type, payload) => {
    if (payload?.command?.type === 'operation:status') { observed(); await block; }
    return rpc(type, payload);
  };
  await start(env);
  await observing;
  await env.runner.stop();
  unblock();
  await env.runner.task;
  assert.equal(env.runner.session.status, 'stopped');
  assert.equal(env.starts.length, 1);
  assert.equal(env.zip.closed, false);
  assert.equal(env.downloads.length, 0);
  assert.ok(env.commands.some(item => item.command?.type === 'operation:cancel'));
  await assert.rejects(env.runner.resume(), /no paused run/);
});

test('a slow provider operation remains observable beyond the old 35-minute cutoff', async t => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const env = setup({ delay: async () => { now += 40 * 60_000; } });
  const rpc = env.io.rpc;
  let waiting = true;
  env.io.rpc = async (type, payload) => {
    if (payload?.command?.type === 'operation:status' && waiting) { waiting = false; return { status: 'running' }; }
    return rpc(type, payload);
  };
  await start(env);
  await env.runner.task;
  assert.equal(env.runner.session.status, 'complete');
  assert.equal(env.starts.length, 1);
});

test('project navigation between video jobs blocks uploads and cannot overwrite the pinned project on Resume', async () => {
  const env = setup();
  const rpc = env.io.rpc;
  let navigate = true;
  env.io.rpc = async (type, payload) => {
    if (navigate && payload?.provider === 'vibes' && ['provider:info', 'provider:ensure'].includes(type)
      && env.runner.session.jobs[0].status === 'complete') return { id: 2, url: 'https://vibes.ai/projects/unrelated' };
    return rpc(type, payload);
  };
  await start(env, pipelineConfig);
  await env.runner.task;
  assert.equal(env.runner.session.status, 'error');
  assert.match(env.runner.session.message, /dedicated project/);
  assert.equal(env.runner.session.vibes.url, 'https://vibes.ai/projects/test');
  assert.equal(env.starts.filter(command => command.action === 'vibes:generate').length, 1);
  await env.runner.resume();
  await env.runner.task;
  assert.equal(env.runner.session.status, 'error');
  assert.equal(env.runner.session.vibes.url, 'https://vibes.ai/projects/test');
  navigate = false;
  await env.runner.resume();
  await env.runner.task;
  assert.equal(env.runner.session.status, 'complete');
  assert.deepEqual(env.starts.filter(command => command.action === 'vibes:generate').map(command => command.payload.projectUrl),
    ['https://vibes.ai/projects/test', 'https://vibes.ai/projects/test']);
});

test('an unidentified project creation is not recovered from whichever project happens to be open', async () => {
  const env = setup();
  const rpc = env.io.rpc;
  env.io.rpc = async (type, payload) => payload?.command?.type === 'operation:status'
    && env.runner.session.operation?.action === 'vibes:project' ? { status: 'missing' } : rpc(type, payload);
  await start(env, pipelineConfig);
  await env.runner.task;
  assert.equal(env.runner.session.status, 'error');
  assert.equal(env.starts.filter(command => command.action === 'vibes:generate').length, 0);
  await env.runner.resume();
  await env.runner.task;
  assert.equal(env.starts.filter(command => command.action === 'vibes:project').length, 1);
  assert.equal(env.zip.closed, false);
});

test('re-export then Clear removes every run-owned ZIP handle, not just the last destination', async () => {
  const env = setup();
  await start(env, pipelineConfig);
  await env.runner.task;
  env.stores.handles.set('second-destination', env.handle);
  env.stores.handles.set('third-destination', env.handle);
  await env.runner.export({ handleId: 'second-destination', variants: [3] });
  await env.runner.task;
  await env.runner.export({ handleId: 'third-destination' });
  await env.runner.task;
  assert.equal(env.runner.session.status, 'complete');
  await env.runner.clear();
  assert.equal(env.stores.handles.size, 0);
  assert.equal(env.stores.assets.size, 0);
});
