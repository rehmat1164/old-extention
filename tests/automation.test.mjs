import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test as nodeTest, before, after } from 'node:test';
import { chromium } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';

const source = Object.fromEntries(await Promise.all(['dom', 'meta', 'vibes', 'content'].map(async name => [name,
  await readFile(new URL(name === 'content' ? '../js/content.js' : `../js/automation/${name}.js`, import.meta.url), 'utf8'),
])));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
let browser;
const test = (name, run) => nodeTest(name, { timeout: 45_000 }, run);

async function waitForOperation(page, id, status) {
  const deadline = Date.now() + 5_000;
  do {
    if (await page.evaluate(async ({ id, status }) => (await MeteAutomation.content.status(id)).status === status, { id, status })) return;
    await delay(20);
  } while (Date.now() < deadline);
  throw new Error(`Operation ${id} did not reach ${status}.`);
}

before(async () => { browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] }); });
after(async () => { await browser?.close(); });

async function pageFor(provider, { content = false } = {}) {
  const page = await browser.newPage();
  const fixture = await readFile(new URL(`fixtures/automation-${provider}.html`, import.meta.url), 'utf8');
  await page.route('**/*', async route => {
    if (route.request().isNavigationRequest()) await route.fulfill({ contentType: 'text/html', body: fixture });
    else if (/\.mp4(?:[?#]|$)/.test(route.request().url())) await route.fulfill({ status: 404, body: '' });
    else await route.fulfill({ contentType: 'image/png', body: png });
  });
  await page.goto(provider === 'meta' ? 'https://www.meta.ai/' : 'https://vibes.ai/projects/fixture-project');
  for (const name of ['dom', 'meta', 'vibes']) await page.addScriptTag({ content: source[name] });
  if (content) await installContent(page);
  return page;
}

async function installContent(page, saved = {}) {
  await page.evaluate(saved => {
    window.localJournal = structuredClone(saved);
    window.checkpoints = [];
    window.chrome = {
      runtime: {
        id: 'fixture-extension',
        onMessage: { addListener(listener) { window.contentListener = listener; } },
        async sendMessage(message) {
          checkpoints.push(structuredClone(message));
          if (message.type === 'operation:checkpoint') await chrome.storage.local.set({ [`operation:content:${message.operationId}`]: message.state });
          return { ok: true, data: true };
        },
      },
      storage: { onChanged: { addListener(listener) { window.storageListener = listener; } }, local: {
        async get(key) { return { [key]: localJournal[key] }; },
        async set(values) {
          const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { oldValue: localJournal[key], newValue }]));
          Object.assign(localJournal, structuredClone(values));
          window.storageListener?.(changes, 'local');
        },
      } },
    };
  }, saved);
  await page.addScriptTag({ content: source.content });
}

async function runVideo(page, index) {
  return page.evaluate(async index => {
    const canvas = document.createElement('canvas'); canvas.width = 720; canvas.height = 1280;
    canvas.getContext('2d').fillRect(0, 0, 720, 1280);
    const dataUrl = canvas.toDataURL('image/png');
    const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), character => character.charCodeAt(0));
    const sha256 = await MeteAutomation.dom.digest(bytes);
    const checkpoints = [];
    const result = await MeteAutomation.vibes.generate({ index, projectUrl: location.href, uploadLabel: `MR_fixture_${String(index).padStart(3, '0')}.png`, image: { name: `${index}.png`, type: 'image/png', dataUrl, sha256 }, prompt: 'Move the camera slowly.', ratio: '1:1', ratioSource: 'image', resolution: '720p', expectedVariants: 4 }, {
      signal: new AbortController().signal, async checkpoint(...args) { checkpoints.push(args); },
    });
    return { result, fixture, checkpoints, badges: [...document.querySelectorAll('[data-mete-run-label]')].map(node => node.textContent) };
  }, index);
}

test('Meta rich-text composer preserves multiline prompts, submits once, and maps reversed arrivals by labels', async t => {
  const page = await pageFor('meta'); t.after(() => page.close());
  const result = await page.evaluate(async () => {
    const checkpoints = [];
    const payload = { request: 'Image 1:\nA green valley\n\nImage 2:\nA blue lake\n\nGenerate two separate images.', expected: [{ index: 1, marker: 'Image 1' }, { index: 2, marker: 'Image 2' }] };
    const result = await MeteAutomation.meta.generate(payload, { signal: new AbortController().signal, async checkpoint(...value) { checkpoints.push(value); } });
    return { result, fixture, checkpoints };
  });
  assert.equal(result.fixture.submissions, 1);
  assert.equal(result.fixture.request.replace(/\s+/g, ' ').trim(), 'Image 1: A green valley Image 2: A blue lake Generate two separate images.');
  assert.equal(result.result.url, 'https://www.meta.ai/prompt/fixture-chat');
  assert.deepEqual(result.result.images.map(item => [item.index, new URL(item.url).pathname]), [[1, '/output-1.png'], [2, '/output-2.png']]);
  assert.ok(result.checkpoints.some(item => item[0] === 'meta:submitting'));
  assert.equal(result.result.images.some(item => item.url.includes('sidebar')), false);
});

test('rich-text paste updates a controlled editor without joining prompt lines', async t => {
  const page = await pageFor('meta'); t.after(() => page.close());
  const result = await page.evaluate(async () => {
    const editor = document.querySelector('[data-testid="composer-input"]');
    let accepted = '';
    let pastes = 0;
    editor.addEventListener('paste', event => {
      event.preventDefault();
      accepted = event.clipboardData.getData('text/plain');
      pastes++;
      editor.replaceChildren(...accepted.split('\n').map(line => {
        const paragraph = document.createElement('p');
        paragraph.textContent = line || '\u00a0';
        return paragraph;
      }));
    });
    editor.addEventListener('input', event => {
      if (event.inputType === 'insertText' && /\n/.test(event.data || '')) editor.textContent = event.data.replace(/\n/g, '');
    });
    const request = 'Create images in 9:16.\n\nImage 1:\nmake an apple\n\nImage 2:\nmake a lake';
    await MeteAutomation.dom.fillEditor(editor, request, { signal: new AbortController().signal });
    return { accepted, pastes, request, rendered: editor.innerText };
  });
  assert.equal(result.pastes, 1);
  assert.equal(result.accepted, result.request);
  assert.equal(result.rendered.replace(/\s+/g, ' ').trim(), result.request.replace(/\s+/g, ' ').trim());
});

test('rich-text verification still rejects truncated or changed prompt words before submission', async t => {
  const page = await pageFor('meta'); t.after(() => page.close());
  const result = await page.evaluate(async () => {
    const editor = document.querySelector('[data-testid="composer-input"]');
    editor.addEventListener('paste', event => { event.preventDefault(); editor.textContent = 'Image 1: wrong subject'; });
    editor.addEventListener('input', () => { editor.textContent = 'Image 1: wrong subject'; });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    try {
      await MeteAutomation.meta.generate({ request: 'Image 1: make an apple', expected: [{ index: 1, marker: 'Image 1' }] }, {
        signal: controller.signal, async checkpoint() {},
      });
      return { accepted: true, submissions: fixture.submissions };
    } catch { return { accepted: false, submissions: fixture.submissions }; }
    finally { clearTimeout(timer); }
  });
  assert.deepEqual(result, { accepted: false, submissions: 0 });
});

test('Meta fails safely instead of assigning unlabelled batch results by arrival order', async t => {
  const page = await pageFor('meta'); t.after(() => page.close());
  const result = await page.evaluate(async () => {
    fixture.labels = false;
    try {
      await MeteAutomation.meta.generate({ request: 'Image 1: valley\n\nImage 2: lake', expected: [{ index: 1, marker: 'Image 1' }, { index: 2, marker: 'Image 2' }] }, { signal: new AbortController().signal, async checkpoint() {} });
      return { succeeded: true };
    } catch (error) { return { code: error.code, message: error.message, submissions: fixture.submissions }; }
  });
  assert.equal(result.code, 'IMAGE_MAPPING');
  assert.match(result.message, /unique prompt labels/);
  assert.equal(result.submissions, 1);
});

test('Meta ignores user uploads, avatars, unrelated scrollers, badges, and partial marker matches', async t => {
  const page = await pageFor('meta'); t.after(() => page.close());
  const result = await page.evaluate(() => {
    const scope = MeteAutomation.meta.chatScope();
    scope.innerHTML = '<div data-message-author-role="user"><img data-testid="generated-image" alt="Image 1" src="/user.png"></div><article data-message-author-role="assistant"><img alt="Profile picture" src="/avatar.png"><img alt="Meta AI" src="/large-avatar.png" style="width:24px;height:24px"><figure><img data-testid="generated-image" alt="Image 10" src="/generated.png"><span data-mete-run-label>Image 1</span></figure></article>';
    const records = MeteAutomation.meta.imageCandidates(scope);
    return { urls: records.map(item => item.url), matches: MeteAutomation.meta.markerMatches('Image 10, MR_run_0012', [{ index: 1, marker: 'Image 1' }, { index: 2, marker: 'MR_run_001' }]), text: MeteAutomation.dom.text(scope) };
  });
  assert.deepEqual(result.urls.map(url => new URL(url).pathname), ['/generated.png']);
  assert.deepEqual(result.matches, []);
  assert.equal(result.text.includes('Image 1'), false);
});

test('Meta refuses completed images with a different requested aspect ratio', async t => {
  const page = await pageFor('meta'); t.after(() => page.close());
  const code = await page.evaluate(async () => {
    try {
      await MeteAutomation.meta.generate({ request: 'Image 1: valley\n\nImage 2: lake', ratio: '9:16', expected: [{ index: 1, marker: 'Image 1' }, { index: 2, marker: 'Image 2' }] }, {
        signal: new AbortController().signal, async checkpoint() {},
      });
      return 'unexpected-success';
    } catch (error) { return error.code; }
  });
  assert.equal(code, 'IMAGE_RATIO');
});

test('Vibes verifies the current filename, hash, preview, settings, and all four stable video cards', async t => {
  const page = await pageFor('vibes'); t.after(() => page.close());
  const result = await runVideo(page, 1);
  assert.equal(result.fixture.uploads, 1);
  assert.equal(result.fixture.removed, 1);
  assert.equal(result.fixture.submissions, 1);
  assert.deepEqual(result.fixture.uploadedNames, ['MR_fixture_001.png']);
  assert.equal(result.fixture.uploadedType, 'image/png');
  assert.equal(result.fixture.resolution, '720p');
  assert.equal(result.result.upload.verified, true);
  assert.equal(result.result.upload.ratio, '9:16');
  assert.deepEqual(result.fixture.completionOrder, [4, 2, 1, 3]);
  assert.deepEqual(result.result.variants.map(item => [item.variant, new URL(item.url).pathname]), [1, 2, 3, 4].map(index => [index, `/media/video-1-${index}.mp4`]));
  for (const phase of ['vibes:before-upload', 'vibes:uploading', 'vibes:frame-verified', 'vibes:submitting', 'vibes:variants-identified']) assert.ok(result.checkpoints.some(item => item[0] === phase), phase);
  assert.ok(result.badges.includes('Image 1'));
  assert.ok(result.badges.includes('Image 1 · Video 4'));
});

test('Vibes handles a second image in a populated project and labels image/video previews in its picker', async t => {
  const page = await pageFor('vibes'); t.after(() => page.close());
  await runVideo(page, 1);
  const second = await runVideo(page, 2);
  assert.equal(second.fixture.submissions, 2);
  assert.equal(second.fixture.uploads, 2);
  assert.equal(second.fixture.removed, 2);
  assert.deepEqual(second.fixture.uploadedNames, ['MR_fixture_001.png', 'MR_fixture_002.png']);
  assert.equal(second.result.upload.label, 'MR_fixture_002.png');
  assert.deepEqual(second.result.variants.map(item => new URL(item.url).pathname), [1, 2, 3, 4].map(index => `/media/video-2-${index}.mp4`));
  await page.evaluate(() => openFrame());
  await page.waitForFunction(() => [...document.querySelectorAll('#frame-grid [data-mete-run-label]')].some(node => node.textContent === 'Image 2 · Video 4'));
  const badges = await page.locator('#frame-grid [data-mete-run-label]').allTextContents();
  assert.ok(badges.includes('Image 1'));
  assert.ok(badges.includes('Image 2'));
  assert.ok(badges.includes('Image 1 · Video 1'));
});

test('Vibes never submits when the selected preview is a different image', async t => {
  const page = await pageFor('vibes'); t.after(() => page.close());
  const result = await page.evaluate(async base64 => {
    fixture.mismatchPreview = true;
    const controller = new AbortController();
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    try {
      await MeteAutomation.vibes.generate({ index: 1, projectUrl: location.href, uploadLabel: 'MR_fixture_001.png', image: { name: '1.png', type: 'image/png', dataUrl: `data:image/png;base64,${base64}`, sha256: await MeteAutomation.dom.digest(bytes) }, prompt: 'Animate.', ratio: '9:16', resolution: '720p', expectedVariants: 4 }, {
        signal: controller.signal, async checkpoint(phase) {
          if (phase === 'vibes:uploaded') setTimeout(() => controller.abort(MeteAutomation.dom.error('CANCELLED', 'End of mismatched-preview fixture.')), 200);
        },
      });
    } catch (error) { return { code: error.code, uploads: fixture.uploads, submissions: fixture.submissions, attached: !!MeteAutomation.vibes.startImage() }; }
  }, png.toString('base64'));
  assert.deepEqual(result, { code: 'CANCELLED', uploads: 1, submissions: 0, attached: false });
});

test('Image reconstruction preserves PNG, JPEG and WebP bytes, MIME types, and unique filenames', async t => {
  const page = await pageFor('vibes'); t.after(() => page.close());
  const result = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 8; canvas.height = 8;
    const result = [];
    for (const [type, extension] of [['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]) {
      const dataUrl = canvas.toDataURL(type);
      const bytes = Uint8Array.from(atob(dataUrl.split(',')[1]), character => character.charCodeAt(0));
      const sha256 = await MeteAutomation.dom.digest(bytes);
      const reconstructed = await MeteAutomation.dom.imageFile({ uploadLabel: `MR_file.${extension}`, image: { name: `original.${extension}`, dataUrl, type, sha256 } });
      result.push({ name: reconstructed.file.name, type: reconstructed.file.type, matches: await MeteAutomation.dom.digest(await reconstructed.file.arrayBuffer()) === sha256 });
    }
    return result;
  });
  assert.deepEqual(result, [
    { name: 'MR_file.png', type: 'image/png', matches: true },
    { name: 'MR_file.jpg', type: 'image/jpeg', matches: true },
    { name: 'MR_file.webp', type: 'image/webp', matches: true },
  ]);
});

test('Conflicting image caption identities are rejected, not overridden by alt text', async t => {
  const page = await pageFor('meta'); t.after(() => page.close());
  const result = await page.evaluate(() => {
    const scope = MeteAutomation.meta.chatScope();
    scope.innerHTML = '<article data-message-author-role="assistant"><figure><img data-testid="generated-image" alt="MR_run_001" src="/one.png"><figcaption>MR_run_002</figcaption></figure><figure><img data-testid="generated-image" alt="MR_run_002" src="/two.png"></figure></article>';
    return MeteAutomation.meta.mapImages(MeteAutomation.meta.imageCandidates(scope), [{ index: 1, marker: 'MR_run_001' }, { index: 2, marker: 'MR_run_002' }]);
  });
  assert.match(result.error, /unique prompt labels/);
});

test('Vibes refuses changed hashes and leaves the provider untouched', async t => {
  const page = await pageFor('vibes'); t.after(() => page.close());
  const result = await page.evaluate(async dataUrl => {
    try {
      await MeteAutomation.vibes.generate({ index: 1, projectUrl: location.href, uploadLabel: 'MR_fixture_001.png', image: { name: '1.png', type: 'image/png', dataUrl, sha256: '0'.repeat(64) }, prompt: 'Animate.', ratio: '9:16', resolution: '720p', expectedVariants: 4 }, { signal: new AbortController().signal, async checkpoint() {} });
    } catch (error) { return { code: error.code, uploads: fixture.uploads, submissions: fixture.submissions, removed: fixture.removed }; }
  }, `data:image/png;base64,${png.toString('base64')}`);
  assert.deepEqual(result, { code: 'HASH_MISMATCH', uploads: 0, submissions: 0, removed: 0 });
});

test('Vibes rejects mixed groups, missing variants, and reordered unlabelled candidates', async t => {
  const page = await pageFor('vibes'); t.after(() => page.close());
  const result = await page.evaluate(() => {
    const records = [1, 2, 3, 4].map(index => ({ card: document.createElement('div'), key: `node:${index}`, stableKey: `asset:${index}`, groupKey: 'batch', variant: null }));
    const capture = action => { try { action(); return 'accepted'; } catch (error) { return error.code; } };
    const group = MeteAutomation.vibes.freezeGroup(records);
    return {
      reordered: capture(() => MeteAutomation.vibes.reconcileGroup(group, [records[1], records[0], records[2], records[3]])),
      missing: capture(() => MeteAutomation.vibes.freezeGroup(records.slice(0, 3))),
      mixed: capture(() => MeteAutomation.vibes.freezeGroup(records.map((record, index) => ({ ...record, groupKey: index === 3 ? 'different' : 'batch' })))),
      labelled: MeteAutomation.vibes.freezeGroup(records.map((record, index) => ({ ...record, variant: 4 - index }))).records.map(record => record.variant),
    };
  });
  assert.deepEqual(result, { reordered: 'VARIANT_ORDER', missing: 'VARIANT_COUNT', mixed: 'MIXED_GROUP', labelled: [4, 3, 2, 1] });
});

test('Video URL collection does not reinterpret CDN thumbnails, posters, or image links as MP4', async t => {
  const page = await pageFor('vibes'); t.after(() => page.close());
  const result = await page.evaluate(() => {
    const card = document.createElement('div');
    card.innerHTML = '<img src="https://scontent.example.fbcdn.net/thumbnail.jpg"><a href="https://scontent.example.fbcdn.net/photo.jpg">Download</a><video poster="https://scontent.example.fbcdn.net/poster.jpg"></video>';
    const first = MeteAutomation.vibes.videoSources(card);
    card.querySelector('video').src = 'https://video.example.fbcdn.net/file.mp4';
    return { first, second: MeteAutomation.vibes.videoSources(card) };
  });
  assert.deepEqual(result.first, []);
  assert.deepEqual(result.second, ['https://video.example.fbcdn.net/file.mp4']);
});

test('Waits react to DOM readiness and cancellation instead of fixed generation sleeps', async t => {
  const page = await pageFor('meta'); t.after(() => page.close());
  const result = await page.evaluate(async () => {
    const controller = new AbortController();
    const pending = MeteAutomation.dom.waitFor(() => false, { signal: controller.signal, timeout: 10_000 }).catch(error => error.code);
    controller.abort(MeteAutomation.dom.error('CANCELLED', 'Stopped.'));
    const ready = MeteAutomation.dom.waitFor(() => document.querySelector('#ready'), { interval: 5_000, timeout: 1_000 });
    const node = document.createElement('div'); node.id = 'ready'; document.body.append(node);
    return { cancelled: await pending, found: (await ready).id };
  });
  assert.deepEqual(result, { cancelled: 'CANCELLED', found: 'ready' });
});

test('Content acknowledges immediately, deduplicates IDs, checkpoints, and cancels only its active operation', async t => {
  const page = await pageFor('meta'); t.after(() => page.close());
  await page.evaluate(() => {
    window.starts = 0;
    MeteAutomation.meta = { async generate(payload, ctx) {
      starts++;
      await ctx.checkpoint('waiting', 'Waiting without resubmission.');
      return MeteAutomation.dom.waitFor(() => false, { signal: ctx.signal, timeout: 60_000 });
    } };
  });
  await installContent(page);
  const response = await page.evaluate(() => {
    const message = { target: 'content', type: 'operation:start', operationId: 'run:meta:batch', action: 'meta:generate', payload: {} };
    let response;
    const keepAlive = contentListener(message, { id: chrome.runtime.id }, value => { response = value; });
    const duplicate = MeteAutomation.content.start(message);
    let busy;
    try { MeteAutomation.content.start({ ...message, operationId: 'other' }); } catch (error) { busy = error.code; }
    return { response, duplicate, busy, keepAlive };
  });
  assert.equal(response.keepAlive, false);
  assert.equal(response.response.data.status, 'running');
  assert.equal(response.duplicate.id, 'run:meta:batch');
  assert.equal(response.busy, 'TAB_BUSY');
  await page.waitForFunction(() => starts === 1 && checkpoints.some(item => item.state?.phase === 'waiting'));
  const state = await page.evaluate(async () => {
    await MeteAutomation.content.cancel('run:meta:batch');
    const retry = MeteAutomation.content.start({ operationId: 'run:meta:batch', action: 'meta:generate' });
    return { retry, starts, checkpoints: checkpoints.map(item => item.state?.phase), iframes: document.querySelectorAll('iframe').length, openers: document.querySelectorAll('[data-mete-run-ui]').length };
  });
  assert.equal(state.retry.status, 'cancelled');
  assert.equal(state.starts, 1);
  assert.equal(state.iframes, 0);
  assert.equal(state.openers, 1);
  assert.ok(state.checkpoints.includes('starting'));
  assert.ok(state.checkpoints.includes('cancelled'));
});

test('Content restores an interrupted journal safely without re-submitting its operation ID', async t => {
  const page = await pageFor('meta'); t.after(() => page.close());
  await page.evaluate(() => { window.starts = 0; MeteAutomation.meta = { async generate() { starts++; return {}; } }; });
  await installContent(page, { 'operation:content:interrupted': { id: 'interrupted', action: 'meta:generate', provider: 'meta', status: 'running', phase: 'meta:generating', message: 'Generating.' } });
  const result = await page.evaluate(async () => {
    const status = await MeteAutomation.content.status('interrupted');
    const retry = MeteAutomation.content.start({ operationId: 'interrupted', action: 'meta:generate' });
    const missing = await MeteAutomation.content.status('unknown');
    return { status, retry, starts, missing };
  });
  assert.equal(result.status.errorCode, 'INTERRUPTED');
  assert.equal(result.status.status, 'failed');
  assert.equal(result.retry.status, 'failed');
  assert.equal(result.starts, 0);
  assert.equal(result.missing.status, 'missing');
});

test('Completed operations are exposed only after checkpoint acknowledgement and remain idempotent', async t => {
  const page = await pageFor('meta'); t.after(() => page.close());
  await page.evaluate(() => {
    window.starts = 0;
    MeteAutomation.meta = { async generate(payload) { starts++; return { token: payload.token }; } };
  });
  await installContent(page);
  await page.evaluate(() => {
    chrome.runtime.sendMessage = async message => {
      checkpoints.push(structuredClone(message));
      if (message.state?.status === 'completed') await new Promise(resolve => { window.finishCheckpoint = resolve; });
      return { ok: true };
    };
    MeteAutomation.content.start({ operationId: 'completed-once', action: 'meta:generate', payload: { token: 'original' } });
  });
  await page.waitForFunction(() => !!window.finishCheckpoint);
  const saving = await page.evaluate(() => MeteAutomation.content.status('completed-once'));
  assert.equal(saving.status, 'running');
  assert.equal(saving.phase, 'saving');
  assert.equal(saving.result, undefined);
  await page.evaluate(() => finishCheckpoint());
  await waitForOperation(page, 'completed-once', 'completed');
  const completed = await page.evaluate(() => ({
    state: MeteAutomation.content.start({ operationId: 'completed-once', action: 'meta:generate', payload: { token: 'replacement' } }), starts,
  }));
  assert.equal(completed.starts, 1);
  assert.deepEqual(completed.state.result, { token: 'original' });
});

test('An unavailable operation journal prevents action side effects', async t => {
  const page = await pageFor('meta'); t.after(() => page.close());
  await page.evaluate(() => { window.starts = 0; MeteAutomation.meta = { async generate() { starts++; return {}; } }; });
  await installContent(page);
  await page.evaluate(() => {
    chrome.storage.local.set = async () => { throw new Error('Local journal unavailable.'); };
    MeteAutomation.content.start({ operationId: 'cannot-checkpoint', action: 'meta:generate' });
  });
  await waitForOperation(page, 'cannot-checkpoint', 'failed');
  const result = await page.evaluate(async () => ({ starts, state: await MeteAutomation.content.status('cannot-checkpoint') }));
  assert.equal(result.starts, 0);
  assert.match(result.state.error, /journal unavailable/);
});

test('The native-panel opener sends only on a user click and rejects foreign extension messages', async t => {
  const page = await pageFor('meta', { content: true }); t.after(() => page.close());
  const before = await page.evaluate(() => {
    let replied = false;
    contentListener({ target: 'content', type: 'operation:start', operationId: 'foreign', action: 'meta:generate' }, { id: 'another-extension' }, () => { replied = true; });
    return { replied, messages: checkpoints.length };
  });
  assert.deepEqual(before, { replied: false, messages: 0 });
  await page.locator('[data-mete-run-ui]').click();
  assert.deepEqual(await page.evaluate(() => checkpoints.map(message => [message.target, message.type])), [['background', 'panel:open']]);
});

test('the website open-button setting applies to current and newly opened provider tabs', async t => {
  const page = await pageFor('meta'); t.after(() => page.close());
  await installContent(page, { showLauncher: false });
  await page.waitForFunction(() => document.querySelector('[data-mete-run-ui]').style.display === 'none');
  assert.equal(await page.locator('[data-mete-run-ui]').isVisible(), false);
  await page.evaluate(() => chrome.storage.local.set({ showLauncher: true }));
  assert.equal(await page.locator('[data-mete-run-ui]').isVisible(), true);
  await page.evaluate(() => chrome.storage.local.set({ showLauncher: false }));
  assert.equal(await page.locator('[data-mete-run-ui]').isVisible(), false);
  assert.equal(await page.evaluate(() => checkpoints.length), 0);
});

test('Vibes creates one project and recovers its saved navigation checkpoint without a second click', async t => {
  const page = await pageFor('vibes'); t.after(() => page.close());
  const result = await page.evaluate(async () => {
    history.replaceState({}, '', '/');
    window.creates = 0;
    const button = document.createElement('button'); button.textContent = 'Create new';
    button.onclick = () => { creates++; history.pushState({}, '', '/projects/created-project'); };
    document.querySelector('main').append(button);
    const phases = [];
    const project = await MeteAutomation.vibes.project({}, { signal: new AbortController().signal, async checkpoint(phase) { phases.push(phase); } });
    return { project, phases, creates };
  });
  assert.equal(result.creates, 1);
  assert.deepEqual(result.phases, ['vibes:project-opening', 'vibes:project-opened']);
  assert.equal(result.project.url, 'https://vibes.ai/projects/created-project');
  await installContent(page, { 'operation:content:project-navigation': { id: 'project-navigation', action: 'vibes:project', provider: 'vibes', status: 'running', phase: 'vibes:project-opened', checkpoint: { projectUrl: result.project.url } } });
  const recovered = await page.evaluate(() => MeteAutomation.content.status('project-navigation'));
  assert.equal(recovered.status, 'completed');
  assert.equal(recovered.result.url, 'https://vibes.ai/projects/created-project');
  assert.equal(await page.evaluate(() => creates), 1);
});

test('Vibes refuses an unrelated or missing pinned project before touching its composer', async t => {
  const page = await pageFor('vibes'); t.after(() => page.close());
  const result = await page.evaluate(async () => {
    const codes = [];
    for (const projectUrl of [undefined, 'https://vibes.ai/projects/other', 'https://www.vibes.ai/projects/fixture-project']) {
      try { await MeteAutomation.vibes.generate({ projectUrl }, { signal: new AbortController().signal, async checkpoint() {} }); }
      catch (error) { codes.push(error.code); }
    }
    try { await MeteAutomation.vibes.project({}, { signal: new AbortController().signal, async checkpoint() {} }); }
    catch (error) { codes.push(error.code); }
    return { codes, uploads: fixture.uploads, submissions: fixture.submissions, removed: fixture.removed };
  });
  assert.deepEqual(result, { codes: ['PROJECT_REQUIRED', 'PAGE_CHANGED', 'PAGE_CHANGED', 'VIBES_HOME_REQUIRED'], uploads: 0, submissions: 0, removed: 0 });
});

test('project recovery requires its persisted exact identity rather than an opening checkpoint or another project', async t => {
  const page = await pageFor('vibes'); t.after(() => page.close());
  await installContent(page, {
    'operation:content:opening': { id: 'opening', action: 'vibes:project', status: 'running', phase: 'vibes:project-opening' },
    'operation:content:other': { id: 'other', action: 'vibes:project', status: 'running', phase: 'vibes:project-opened', checkpoint: { projectUrl: 'https://vibes.ai/projects/other' } },
  });
  const result = await page.evaluate(async () => Promise.all(['opening', 'other'].map(async id => (await MeteAutomation.content.status(id)).errorCode)));
  assert.deepEqual(result, ['INTERRUPTED', 'INTERRUPTED']);
  assert.equal(await page.evaluate(() => fixture.submissions), 0);
});

test('content operation timeout covers sequential upload and generation phase budgets', async t => {
  const page = await pageFor('vibes'); t.after(() => page.close());
  await page.evaluate(() => {
    window.deadlines = [];
    const original = window.setTimeout.bind(window);
    window.setTimeout = (callback, timeout, ...args) => { deadlines.push(timeout); return original(callback, timeout, ...args); };
    MeteAutomation.vibes = { async generate() { return {}; } };
  });
  await installContent(page);
  await page.evaluate(() => MeteAutomation.content.start({ operationId: 'long-video', action: 'vibes:generate' }));
  await waitForOperation(page, 'long-video', 'completed');
  assert.ok((await page.evaluate(() => deadlines)).some(timeout => timeout >= 65 * 60_000 && timeout < 80 * 60_000));
});

test('Content validates media hosts and chunk bounds, sniffs bytes, and serves provider blob chunks', async t => {
  const page = await pageFor('meta', { content: true }); t.after(() => page.close());
  const result = await page.evaluate(async base64 => {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
    const first = await MeteAutomation.content.readMedia({ url, offset: 0, length: 16 });
    const second = await MeteAutomation.content.readMedia({ url, offset: 16, length: 1024 });
    const capture = async action => { try { await action(); return 'accepted'; } catch (error) { return error.code; } };
    const outside = await capture(() => MeteAutomation.content.readMedia({ url: 'https://vibes.ai.example.org/x.png' }));
    const range = await capture(() => MeteAutomation.content.readMedia({ url, offset: 0, length: 1024 * 1024 + 1 }));
    const html = URL.createObjectURL(new Blob(['<html>Login required</html>'], { type: 'text/html' }));
    const invalid = await capture(() => MeteAutomation.content.readMedia({ url: html }));
    return { first, second, outside, range, invalid, keys: [MeteAutomation.dom.mediaKey('https://www.meta.ai/image?id=1'), MeteAutomation.dom.mediaKey('https://www.meta.ai/image?id=2')] };
  }, png.toString('base64'));
  assert.equal(result.first.total, png.length);
  assert.equal(result.first.type, 'image/png');
  assert.deepEqual(Buffer.concat([Buffer.from(result.first.base64, 'base64'), Buffer.from(result.second.base64, 'base64')]), png);
  assert.equal(result.outside, 'MEDIA_HOST');
  assert.equal(result.range, 'MEDIA_RANGE');
  assert.equal(result.invalid, 'MEDIA_TYPE');
  assert.notEqual(result.keys[0], result.keys[1]);
});
