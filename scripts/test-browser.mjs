import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');

async function videoFixture(page, width, height) {
  const bytes = await page.evaluate(async ({ width, height }) => {
    // Bundled Chromium lacks H.264. Record actual VP9-in-MP4 without mocking decode properties.
    const mimeType = 'video/mp4;codecs=vp9';
    if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error(`The fixture browser cannot record ${mimeType}.`);
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const paint = canvas.getContext('2d');
    paint.fillStyle = '#526ce8'; paint.fillRect(0, 0, width, height);
    const stream = canvas.captureStream(10);
    const recorder = new MediaRecorder(stream, { mimeType });
    const chunks = [];
    let timer, deadline, url;
    const video = document.createElement('video');
    try {
      const recorded = new Promise((resolve, reject) => {
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.onerror = event => reject(new Error(`MP4 fixture recording failed: ${event.error?.message || 'unknown error'}`));
        recorder.onstop = resolve;
        deadline = setTimeout(() => reject(new Error('MP4 fixture recording timed out.')), 5_000);
      });
      recorder.start();
      let frame = 0;
      timer = setInterval(() => {
        paint.fillStyle = frame++ % 2 ? '#eb9876' : '#526ce8'; paint.fillRect(0, 0, width, height);
      }, 100);
      setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 650);
      await recorded;
      clearInterval(timer); clearTimeout(deadline);
      stream.getTracks().forEach(track => track.stop());
      const blob = new Blob(chunks, { type: 'video/mp4' });
      const decoded = new Promise((resolve, reject) => {
        video.onloadeddata = resolve;
        video.onerror = () => reject(new Error(`MP4 fixture decode failed: ${video.error?.message}`));
        deadline = setTimeout(() => reject(new Error('MP4 fixture decode timed out.')), 5_000);
      });
      video.preload = 'auto'; video.src = url = URL.createObjectURL(blob); video.load();
      await decoded;
      if (video.videoWidth !== width || video.videoHeight !== height || video.readyState < 2
        || !Number.isFinite(video.duration) || video.duration <= 0) throw new Error('MP4 fixture did not decode to its expected dimensions and duration.');
      return [...new Uint8Array(await blob.arrayBuffer())];
    } finally {
      clearInterval(timer); clearTimeout(deadline);
      if (recorder.state === 'recording') recorder.stop();
      stream.getTracks().forEach(track => track.stop());
      video.removeAttribute('src'); video.load();
      if (url) URL.revokeObjectURL(url);
    }
  }, { width, height });
  const result = Buffer.from(bytes);
  assert.equal(result.subarray(4, 8).toString('ascii'), 'ftyp');
  return result;
}

async function savedZip(page, name) {
  const bytes = Buffer.from(await page.evaluate(async name => {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle(name)).getFile();
    return [...new Uint8Array(await file.arrayBuffer())];
  }, name));
  const end = bytes.length - 22;
  assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10);
  let position = bytes.readUInt32LE(end + 16);
  const files = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(bytes.readUInt32LE(position), 0x02014b50);
    assert.equal(bytes.readUInt16LE(position + 10), 0);
    const size = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28);
    const extraLength = bytes.readUInt16LE(position + 30);
    const commentLength = bytes.readUInt16LE(position + 32);
    const local = bytes.readUInt32LE(position + 42);
    assert.equal(bytes.readUInt32LE(local), 0x04034b50);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const path = bytes.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    assert.equal(files.has(path), false);
    files.set(path, bytes.subarray(start, start + size));
    position += 46 + nameLength + extraLength + commentLength;
  }
  assert.equal(position, end);
  const manifestText = files.get('manifest.json').toString('utf8');
  assert.doesNotMatch(manifestText, /blob:|data:image|sourceKey|[?&](?:token|signature)=/);
  return { files, manifest: JSON.parse(manifestText) };
}

async function chooseZip(page, name) {
  await page.evaluate(async name => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle(name, { create: true });
    window.showSaveFilePicker = () => Promise.resolve(handle);
  }, name);
}

async function waitForCompletion(page, zipName) {
  let run;
  try {
    await waitUntil(async () => {
      run = await page.evaluate(async zipName => {
        const terminal = ['complete', 'error', 'export-error', 'stopped'];
        const status = document.querySelector('#run-status-badge')?.dataset.status;
        if (document.querySelector('#run-panel').hidden || !terminal.includes(status)) return false;
        const response = await chrome.runtime.sendMessage({ target: 'background', type: 'status:get' });
        if (!response?.ok) throw new Error(response?.error || 'The extension status request failed.');
        const run = response.data;
        // Re-export may still display the previous ZIP's completed state after the click.
        return run?.zipName === zipName && run.status === status ? run : false;
      }, zipName);
      return !!run;
    }, 60_000);
  } catch (cause) {
    const details = await page.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({ target: 'background', type: 'status:get' });
      const run = response?.data;
      return { status: run?.status, stage: run?.stage, message: run?.message, operation: run?.operation, error: response?.error };
    }).catch(error => ({ error: error.message }));
    throw new Error(`Workflow "${zipName}" did not complete: ${JSON.stringify(details)}`, { cause });
  }
  assert.equal(run.status, 'complete', run.message);
  return run;
}

async function clearRun(page) {
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#clear-run-button').click();
  await page.waitForFunction(() => document.querySelector('#run-panel').hidden);
}

async function selectVariants(page, variants) {
  for (const checkbox of await page.locator('input[name="variant"]').all()) {
    if (await checkbox.isChecked() !== variants.includes(Number(await checkbox.inputValue()))) await checkbox.locator('..').click();
  }
}

async function waitUntil(check, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  throw new Error('The asynchronous browser assertion did not become true.');
}

// Extension-created tabs can navigate before Playwright attaches its routes.
const blockedConnections = new Set();
const offlineProxy = createServer((request, response) => { response.writeHead(502); response.end(); });
offlineProxy.on('connect', (request, socket) => {
  blockedConnections.add(request.url);
  socket.end('HTTP/1.1 502 Offline fixture proxy\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});
await new Promise(resolve => offlineProxy.listen(0, '127.0.0.1', resolve));
const profile = await mkdtemp(join(tmpdir(), 'mete-run-browser-'));
const extensionPath = resolve(process.env.EXTENSION_PATH || 'dist/mete-run-local');
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 420, height: 940 },
  proxy: { server: `http://127.0.0.1:${offlineProxy.address().port}` },
  args: ['--no-sandbox', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
});
const errors = [], network = [];
const fixtureStarts = [];
const fixtureDocuments = new Map();
let fixturesEnabled = false;
const report = text => console.log(`PASS ${text}`);
let page;
try {
  context.on('page', current => {
    current.on('pageerror', error => errors.push(error.message));
    if (!fixturesEnabled) return;
    const prepare = (async () => {
      await current.waitForLoadState('domcontentloaded');
      const session = await context.newCDPSession(current);
      const { frameTree } = await session.send('Page.getFrameTree');
      await session.detach();
      const url = frameTree.frame.unreachableUrl || current.url();
      if (!['https://www.meta.ai/', 'https://vibes.ai/'].includes(url)) return;
      const initial = await current.evaluate(() => ({ url: location.href, fixture: !!globalThis.fixture }));
      const setup = { requestedUrl: url, initialUrl: initial.url, unreachableUrl: frameTree.frame.unreachableUrl, restaged: false, ready: false };
      fixtureDocuments.set(current, setup);
      // Re-stage only an unserved first document, before any provider operation can run.
      if (!initial.fixture) {
        assert.equal(frameTree.frame.unreachableUrl, url, 'Refusing to reload a served provider document with a missing fixture.');
        setup.restaged = true;
        await current.goto(url);
      }
      assert.equal(await current.evaluate(() => globalThis.meteFixtureOptions?.realMedia), true);
      assert.equal(await current.evaluate(() => !!globalThis.fixture), true);
      setup.ready = true;
    })();
    fixtureStarts.push(prepare);
    prepare.catch(error => errors.push(`Provider fixture setup: ${error.message}`));
  });
  await context.addInitScript(() => { window.meteFixtureOptions = { realMedia: true }; });
  await context.route(/^https?:/, async route => {
    network.push(route.request().url());
    await route.abort();
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  const id = new URL(worker.url()).host;
  page = await context.newPage();
  const panelUrl = `chrome-extension://${id}/sidepanel.html`;
  await page.goto(panelUrl);
  await page.waitForFunction(() => document.querySelector('#connection-state-text')?.textContent === 'Local ready');
  const options = await worker.evaluate(() => chrome.sidePanel.getOptions({}));
  assert.equal(options.path, 'sidepanel.html');
  await waitUntil(() => worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }))
    .some(context => context.documentUrl === chrome.runtime.getURL('offscreen.html'))));
  const contexts = await worker.evaluate(() => chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }));
  assert.equal(contexts.length, 1);
  assert.ok(contexts[0].documentUrl.endsWith('/offscreen.html'));
  assert.equal(await page.locator('#preview-banner').isVisible(), false);
  report('unpacked MV3 extension, native panel configuration, background and offscreen worker load');

  assert.deepEqual(await page.locator('#mode-select option').allTextContents(), ['Image', 'Image → Video', 'Prompt → Image → Video']);
  assert.equal(await page.locator('#image-prompts').getAttribute('placeholder'), 'Enter prompts (1 image per prompt, separated by blank lines).');
  assert.equal(await page.locator('#generate-button').isDisabled(), true);
  await page.locator('#image-prompts').fill('A red apple\n\nA mountain lake');
  assert.match(await page.locator('#image-mode-count').innerText(), /2 prompts/);
  assert.equal(await page.locator('#video-options').isVisible(), false);
  assert.equal(await page.locator('#generate-button').isEnabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  report('exactly three modes, exact image placeholder, blank-line counts and narrow sidebar layout');

  await page.evaluate(() => {
    window.pickerCalls = 0;
    window.showSaveFilePicker = () => {
      window.pickerCalls += 1;
      window.pickerHadGesture = navigator.userActivation.isActive;
      return Promise.reject(new DOMException('Test user cancelled', 'AbortError'));
    };
  });
  await page.locator('#generate-button').click();
  await page.waitForFunction(() => window.pickerCalls === 1 && !document.querySelector('#generate-button').disabled);
  assert.equal(await page.evaluate(() => window.pickerHadGesture), true);
  assert.equal((await page.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'status:get' }))).data, null);
  assert.equal(network.length, 0);
  report('ZIP picker is invoked in the click gesture; cancelling does not start generation or open provider tabs');

  await page.locator('#mode-select').selectOption('prompt-video');
  await page.locator('#pipeline-image-prompts').fill('First image\n\nSecond image');
  await page.locator('#video-prompt-tab').click();
  await page.locator('#pipeline-video-prompts').fill('Only one video prompt');
  assert.equal(await page.locator('#generate-button').isDisabled(), true);
  await page.locator('#pipeline-video-prompts').fill('First video\n\nSecond video');
  assert.equal(await page.locator('#generate-button').isEnabled(), true);
  for (const checkbox of await page.locator('input[name="variant"]').all()) {
    if (await checkbox.isChecked()) await checkbox.locator('..').click();
  }
  assert.equal(await page.locator('#generate-button').isDisabled(), true);
  await page.locator('input[name="variant"][value="2"]').locator('..').click();
  await page.locator('input[name="variant"][value="4"]').locator('..').click();
  assert.equal(await page.locator('#generate-button').isEnabled(), true);
  await page.locator('input[name="zip-contents"][value="images-videos"]').locator('..').click();
  assert.match(await page.locator('#output-summary').innerText(), /images\//);
  assert.match(await page.locator('#output-summary').innerText(), /videos\//);
  report('paired prompt tabs, count mismatch blocking, variant validation and ZIP content choices');

  assert.equal(await page.locator('.workspace-nav [role="tab"]').count(), 3);
  let scrollingViews = 0;
  for (const viewport of [{ width: 360, height: 600 }, { width: 420, height: 940 }]) {
    await page.setViewportSize(viewport);
    for (const view of ['generate', 'downloads', 'settings']) {
      await page.locator(`#workspace-${view}`).click();
      assert.equal(await page.locator(`#${view}-view`).isVisible(), true);
      assert.equal(await page.locator('.workspace-nav [aria-selected="true"]').count(), 1);
      const before = await page.locator('#generate-button').boundingBox();
      const scroll = await page.evaluate(() => {
        const area = document.querySelector('.scroll-area');
        area.scrollTop = area.scrollHeight;
        return area.scrollTop;
      });
      if (scroll > 0) scrollingViews++;
      const after = await page.locator('#generate-button').boundingBox();
      assert.deepEqual(after, before, 'Generate must not move when a workspace section scrolls.');
      assert.ok(after.y >= 0 && after.y + after.height <= viewport.height);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
  }
  assert.ok(scrollingViews >= 3, 'Sticky assertions must exercise real overflowing content.');
  await page.locator('#workspace-settings').click();
  await page.locator('#auto-save-setting').uncheck();
  await page.locator('#launcher-setting').uncheck();
  await waitUntil(() => page.evaluate(async () => {
    const draft = await (await import('./js/lib/store.js')).get('drafts', 'ui');
    return draft?.config?.autoSave === false && (await chrome.storage.local.get('showLauncher')).showLauncher === false;
  }));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#connection-state-text').textContent === 'Local ready');
  await page.locator('#workspace-settings').click();
  assert.equal(await page.locator('#auto-save-setting').isChecked(), false);
  assert.equal(await page.locator('#launcher-setting').isChecked(), false);
  await page.locator('#reset-settings').click();
  assert.equal(await page.locator('#auto-save-setting').isChecked(), true);
  assert.equal(await page.locator('#pipeline-image-prompts').inputValue(), 'First image\n\nSecond image');
  await page.locator('#launcher-setting').check();
  await page.locator('#workspace-generate').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.locator('#workspace-downloads').getAttribute('aria-selected'), 'true');
  assert.match(await page.locator('#download-list').innerText(), /Your outputs will appear here/);
  await page.locator('#workspace-generate').click();
  report('Downloads and Settings remain accessible; Generate stays fixed during real scrolling at 360×600 and 420×940; local preferences survive reload');

  const imageBytes = async color => Buffer.from(await page.evaluate(color => {
    const canvas = document.createElement('canvas');
    canvas.width = 720; canvas.height = 1280;
    const paint = canvas.getContext('2d');
    paint.fillStyle = color; paint.fillRect(0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/png').split(',')[1];
  }, color), 'base64');
  const sourceBytes = await imageBytes('#536ce8');
  const secondSourceBytes = await imageBytes('#eb9876');
  await page.locator('#mode-select').selectOption('image-video');
  await page.locator('#image-upload').setInputFiles([
    { name: 'image10.png', mimeType: 'image/png', buffer: secondSourceBytes },
    { name: 'image2.png', mimeType: 'image/png', buffer: sourceBytes },
  ]);
  await page.waitForFunction(() => document.querySelector('#upload-count')?.textContent === '2 images' && document.querySelector('#upload-hash-status').hidden);
  const uploadText = await page.locator('#upload-list').innerText();
  assert.ok(uploadText.indexOf('image2.png') < uploadText.indexOf('image10.png'));
  await page.locator('#upload-video-prompts').fill('Image two moves\n\nImage ten moves');
  assert.equal(await page.locator('#generate-button').isEnabled(), true);
  await page.locator('#image-upload').setInputFiles([{ name: 'image2.png', mimeType: 'image/png', buffer: sourceBytes }]);
  await page.waitForFunction(() => document.querySelector('#alert-region').textContent.toLowerCase().includes('already selected'));
  assert.equal(await page.locator('#upload-count').innerText(), '2 images');
  await waitUntil(() => page.evaluate(async () => {
    const { get } = await import('./js/lib/store.js');
    const draft = await get('drafts', 'ui');
    return draft?.uploads?.length === 2 && draft.config.videoPrompts === 'Image two moves\n\nImage ten moves';
  }));
  assert.equal(await page.evaluate(async () => (await (await import('./js/lib/store.js')).get('drafts', 'ui'))?.uploads?.length), 2);
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#upload-count')?.textContent === '2 images');
  assert.equal(await page.locator('#mode-select').inputValue(), 'image-video');
  assert.equal(await page.locator('#upload-video-prompts').inputValue(), 'Image two moves\n\nImage ten moves');
  report('PNG uploads, natural numbered order, duplicate protection and real IndexedDB draft/Blob reload');

  await worker.evaluate(() => chrome.offscreen.closeDocument());
  await page.evaluate(async () => {
    const { put, putCurrentRun } = await import('./js/lib/store.js');
    const { createSession } = await import('./js/lib/model.js');
    const { sha256 } = await import('./js/lib/media.js');
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 768;
    canvas.getContext('2d').fillRect(0, 0, 512, 768);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('browser-test.zip', { create: true });
    await put('handles', 'browser-handle', handle);
    const session = createSession({ mode: 'image', imagePrompts: 'Saved browser fixture' }, [], 'browser-fixture');
    const image = { assetId: 'browser-image', type: blob.type, size: blob.size, sha256: await sha256(blob) };
    await put('assets', image.assetId, { ...image, blob });
    session.jobs[0].image = image; session.jobs[0].status = 'complete';
    session.status = 'export-error'; session.stage = 'export'; session.generationComplete = true;
    session.handleId = 'browser-handle'; session.zipName = 'browser-test.zip';
    session.message = 'Fixture: media exists locally; retry the ZIP export.';
    await putCurrentRun(session);
  });
  await page.reload();
  await page.waitForFunction(() => document.querySelector('#run-status-badge')?.dataset.status === 'export-error');
  assert.equal(await page.locator('#mode-select').isDisabled(), true);
  assert.equal(await page.locator('#image-prompts').isDisabled(), true);
  assert.equal(await page.locator('#export-zip-button').isVisible(), true);
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('browser-test.zip', { create: true });
    window.showSaveFilePicker = () => Promise.resolve(handle);
  });
  await page.locator('#export-zip-button').click();
  await page.waitForFunction(() => document.querySelector('#run-status-badge')?.dataset.status === 'complete');
  const archive = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const file = await (await root.getFileHandle('browser-test.zip')).getFile();
    const bytes = new Uint8Array(await file.arrayBuffer());
    return { signature: [...bytes.slice(0, 4)], text: new TextDecoder().decode(bytes), size: file.size };
  });
  assert.deepEqual(archive.signature, [80, 75, 3, 4]);
  assert.match(archive.text, /images\/image_001.png/);
  assert.match(archive.text, /manifest.json/);
  assert.ok(archive.size > 1000);
  assert.equal(network.length, 0);
  report('real persisted FileSystemFileHandle and Blobs round-trip through offscreen ZIP export; complete only after close');

  page.once('dialog', dialog => dialog.accept());
  await page.locator('#clear-run-button').click();
  await page.waitForFunction(() => document.querySelector('#run-panel').hidden);
  const assetMissing = await page.evaluate(async () => {
    const { get } = await import('./js/lib/store.js');
    return (await get('assets', 'browser-image')) === undefined;
  });
  assert.equal(assetMissing, true);
  const metaFixture = await readFile('tests/fixtures/automation-meta.html', 'utf8');
  const vibesFixture = await readFile('tests/fixtures/automation-vibes.html', 'utf8');
  const videos = {
    portrait: await videoFixture(page, 720, 1280),
    square: await videoFixture(page, 720, 720),
  };
  report('real portrait and square VP9 MP4 fixtures recorded locally and preflighted with native decoding');
  await context.unrouteAll({ behavior: 'wait' });
  const unexpected = [];
  await context.route(/^https?:/, async route => {
    const url = new URL(route.request().url());
    if (!['https://www.meta.ai', 'https://vibes.ai'].includes(url.origin)) {
      unexpected.push(route.request().url()); return route.abort();
    }
    if (route.request().isNavigationRequest()) return route.fulfill({ contentType: 'text/html', body: url.hostname === 'vibes.ai' ? vibesFixture : metaFixture });
    if (url.pathname.endsWith('.mp4')) {
      assert.ok(videos[url.searchParams.get('shape')]);
      return route.fulfill({ contentType: 'video/mp4', body: videos[url.searchParams.get('shape')] });
    }
    if (url.pathname.endsWith('.png')) return route.fulfill({ contentType: 'image/png', body: sourceBytes });
    unexpected.push(route.request().url());
    return route.abort();
  });
  fixturesEnabled = true;
  await page.locator('#ratio-select').selectOption('1:1');
  await page.locator('#image-prompts').fill('Blue local fixture\n\nPeach local fixture');
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const handle = await root.getFileHandle('full-image-workflow.zip', { create: true });
    window.showSaveFilePicker = () => Promise.resolve(handle);
  });
  await page.locator('#generate-button').click();
  await page.waitForFunction(() => !document.querySelector('#run-panel').hidden && ['complete', 'error', 'export-error'].includes(document.querySelector('#run-status-badge')?.dataset.status), null, { timeout: 25_000 });
  assert.equal(await page.locator('#run-status-badge').getAttribute('data-status'), 'complete', await page.locator('#run-message').innerText());
  const generated = await page.evaluate(() => chrome.runtime.sendMessage({ target: 'background', type: 'status:get' }));
  assert.equal(generated.data.jobs.length, 2);
  assert.notEqual(generated.data.jobs[0].image.sha256, generated.data.jobs[1].image.sha256);
  const metaPage = context.pages().find(candidate => candidate.url().startsWith('https://www.meta.ai/prompt/'));
  assert.ok(metaPage);
  assert.equal(await metaPage.evaluate(() => fixture.submissions), 1);
  const imageZip = await savedZip(page, 'full-image-workflow.zip');
  assert.deepEqual([...imageZip.files.keys()], ['images/image_001.png', 'images/image_002.png', 'manifest.json']);
  for (const job of imageZip.manifest.jobs) assert.equal(fingerprint(imageZip.files.get(job.image.filename)), job.image.sha256);
  assert.deepEqual(unexpected, []);
  report('full image workflow: real content-script messaging, one submission, labelled out-of-order arrivals, page Blob transfer and automatic ZIP export');

  await clearRun(page);
  await page.locator('#mode-select').selectOption('image-video');
  assert.equal(await page.locator('#upload-count').innerText(), '2 images');
  await page.locator('#upload-video-prompts').fill('Image two moves\n\nImage ten moves');
  await page.locator('#resolution-select').selectOption('720p');
  await selectVariants(page, [2, 4]);
  await page.locator('input[name="zip-contents"][value="images-videos"]').locator('..').click();
  await chooseZip(page, 'full-upload-workflow.zip');
  await page.locator('#generate-button').click();
  const uploaded = await waitForCompletion(page, 'full-upload-workflow.zip');
  const vibesPage = [...context.pages()].reverse().find(candidate => candidate.url().startsWith('https://vibes.ai/projects/'));
  assert.ok(vibesPage);
  const uploads = await vibesPage.evaluate(() => ({
    submissions: fixture.submissions, uploads: fixture.uploads, names: fixture.uploadedNames, hashes: fixture.uploadedHashes,
    prompts: fixture.promptHistory, frames: fixture.startFrames, completionOrder: fixture.completionOrder,
    decoded: [...document.querySelectorAll('#grid video')].map(video => [video.videoWidth, video.videoHeight, video.readyState]),
    nativeDecode: Object.getOwnPropertyDescriptor(HTMLVideoElement.prototype, 'videoWidth').get.toString().includes('[native code]'),
  }));
  assert.equal(uploads.nativeDecode, true);
  assert.equal(uploads.submissions, 2);
  assert.equal(uploads.uploads, 2);
  assert.deepEqual(uploads.hashes, [fingerprint(sourceBytes), fingerprint(secondSourceBytes)]);
  assert.deepEqual(uploads.prompts, ['Image two moves', 'Image ten moves']);
  assert.deepEqual(uploads.names, uploaded.jobs.map(job => job.upload.filename));
  assert.deepEqual(uploads.frames.map(frame => frame.name), uploads.names);
  assert.ok(uploads.frames.every(frame => frame.width === 720 && frame.height === 1280));
  assert.equal(uploads.decoded.length, 8);
  assert.ok(uploads.decoded.every(([width, height, ready]) => width === 720 && height === 1280 && ready >= 2));
  assert.notDeepEqual(uploads.completionOrder.slice(0, 4), [1, 2, 3, 4]);
  assert.deepEqual(uploaded.jobs.map(job => job.originalName), ['image2.png', 'image10.png']);
  for (const [index, job] of uploaded.jobs.entries()) {
    assert.equal(job.upload.verified, true);
    assert.equal(job.upload.sha256, uploads.hashes[index]);
    assert.deepEqual(job.variants.map(variant => variant.variant), [1, 2, 3, 4]);
    assert.deepEqual(job.variants.filter(variant => variant.assetId).map(variant => variant.variant), [2, 4]);
  }
  const uploadZip = await savedZip(page, 'full-upload-workflow.zip');
  assert.deepEqual([...uploadZip.files.keys()], ['images/image_001.png', 'images/image_002.png',
    'videos/video_001_variant_2.mp4', 'videos/video_001_variant_4.mp4', 'videos/video_002_variant_2.mp4', 'videos/video_002_variant_4.mp4', 'manifest.json']);
  for (const [name, bytes] of uploadZip.files) {
    if (name.endsWith('.mp4')) assert.equal(fingerprint(bytes), fingerprint(videos.portrait));
  }
  assert.deepEqual(uploadZip.manifest.jobs.map(job => job.image.sha256), uploads.hashes);
  report('full Image → Video workflow: two distinct verified uploads, prompt-order mapping, eight genuinely decoded MP4s, only variants 2 + 4 saved and zipped');

  await page.locator('#workspace-downloads').click();
  assert.equal(await page.locator('#downloads-selected').innerText(), '6');
  assert.equal(await page.locator('#downloads-ready').innerText(), '6');
  assert.equal(await page.locator('#downloads-count').innerText(), '6');
  assert.equal(await page.locator('#archive-state').innerText(), 'Saved');
  assert.equal(await page.locator('.download-group').count(), 2);
  assert.equal(await page.locator('.download-file').count(), 10);
  assert.equal(await page.locator('[data-preview-file="1:video:1"]').isDisabled(), true);
  await page.locator('[data-preview-file="1:image:1"]').click();
  await page.waitForFunction(() => {
    const image = document.querySelector('#media-preview-content img');
    return image?.complete && image.naturalWidth === 720;
  });
  assert.match(await page.locator('#media-preview-content img').getAttribute('src'), /^blob:chrome-extension:/);
  await page.locator('#close-media-preview').click();
  await page.locator('[data-preview-file="1:video:2"]').click();
  await page.locator('#media-preview-content video').evaluate(video => video.play());
  await page.waitForFunction(() => document.querySelector('#media-preview-content video')?.readyState >= 2);
  assert.equal(await page.locator('#media-preview-content video').evaluate(video => video.videoHeight), 1280);
  assert.match(await page.locator('#media-preview-content video').getAttribute('src'), /^blob:chrome-extension:/);
  await page.locator('#close-media-preview').click();
  assert.equal(await page.locator('#media-preview-content').innerHTML(), '');
  await page.locator('[data-preview-file="2:image:1"]').click();
  await page.waitForFunction(() => document.querySelector('#media-preview-content img')?.naturalWidth === 720);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#media-preview-content').innerHTML(), '');
  await page.locator('#download-filter').selectOption('image');
  assert.equal(await page.locator('.download-file').count(), 2);
  await page.locator('#download-search').fill('image10');
  assert.equal(await page.locator('.download-group').count(), 1);
  assert.equal(await page.locator('.download-group').getAttribute('data-image-index'), '2');
  await page.locator('#download-search').fill('');
  await page.locator('#download-filter').selectOption('all');
  await page.locator('#download-video-selection > summary').click();
  await page.locator('#download-include-images').uncheck();
  assert.equal(await page.locator('#downloads-selected').innerText(), '4');
  assert.equal(await page.locator('#archive-state').innerText(), 'Selection changed');
  await page.locator('#download-include-images').check();
  await page.locator('.activity-panel summary').click();
  assert.ok(await page.locator('#activity-list li').count() > 1);
  await page.locator('#copy-activity').click();
  await page.waitForFunction(() => document.querySelector('#activity-notice').textContent.includes('Copied locally'));
  await page.locator('#workspace-generate').click();
  report('Download Manager verifies cache/ZIP counts, filters numbered files, previews real local PNG/MP4 bytes, tracks changed selection, and copies diagnostic events');

  await selectVariants(page, [1]);
  await chooseZip(page, 'changed-variant-workflow.zip');
  await page.locator('#export-zip-button').click();
  const reexported = await waitForCompletion(page, 'changed-variant-workflow.zip');
  assert.equal(await vibesPage.evaluate(() => fixture.submissions), 2);
  assert.equal(await vibesPage.evaluate(() => fixture.uploads), 2);
  assert.deepEqual(reexported.settings.variants, [1]);
  const changedZip = await savedZip(page, 'changed-variant-workflow.zip');
  assert.deepEqual([...changedZip.files.keys()], ['images/image_001.png', 'images/image_002.png', 'videos/video_001.mp4', 'videos/video_002.mp4', 'manifest.json']);
  assert.deepEqual(changedZip.manifest.settings.variants, [1]);
  report('changing the selected variant exports the existing candidate without uploading or generating again');

  await page.locator('#workspace-downloads').click();
  await page.locator('#download-include-images').uncheck();
  await chooseZip(page, 'manager-videos-only.zip');
  await page.locator('#manager-save-as').click();
  await waitForCompletion(page, 'manager-videos-only.zip');
  const managerZip = await savedZip(page, 'manager-videos-only.zip');
  assert.deepEqual([...managerZip.files.keys()], ['videos/video_001.mp4', 'videos/video_002.mp4', 'manifest.json']);
  assert.equal(managerZip.manifest.settings.includeImages, false);
  assert.equal(await vibesPage.evaluate(() => fixture.submissions), 2);
  assert.equal(await page.locator('#archive-state').innerText(), 'Saved');
  await page.locator('#workspace-generate').click();
  report('Download Manager Save ZIP as applies changed contents without any extra provider submission');

  await clearRun(page);
  await page.locator('#mode-select').selectOption('prompt-video');
  await page.locator('#image-prompt-tab').click();
  await page.locator('#pipeline-image-prompts').fill('A blue square\n\nA peach square');
  await page.locator('#video-prompt-tab').click();
  await page.locator('#pipeline-video-prompts').fill('Blue moves first\n\nPeach moves second');
  await page.locator('#pipeline-ratio-select').selectOption('1:1');
  await page.locator('#resolution-select').selectOption('720p');
  await selectVariants(page, [3]);
  await page.locator('input[name="zip-contents"][value="videos"]').locator('..').click();
  await chooseZip(page, 'full-pipeline-workflow.zip');
  await page.locator('#generate-button').click();
  await page.locator('#workspace-downloads').click();
  await page.locator('[data-run-command="run:pause"]').click();
  await page.waitForFunction(() => document.querySelector('#run-status-badge')?.dataset.status === 'paused', null, { timeout: 30_000 });
  assert.match(await page.locator('#manager-message').innerText(), /Paused safely/);
  assert.equal(await page.locator('#manager-export-button').isDisabled(), true);
  await page.locator('[data-run-command="run:resume"]').click();
  const pipeline = await waitForCompletion(page, 'full-pipeline-workflow.zip');
  const pipelineMeta = [...context.pages()].reverse().find(candidate => candidate.url().startsWith('https://www.meta.ai/prompt/'));
  const pipelineVibes = [...context.pages()].reverse().find(candidate => candidate.url().startsWith('https://vibes.ai/projects/'));
  assert.equal(await pipelineMeta.evaluate(() => fixture.submissions), 1);
  const pipelineUploads = await pipelineVibes.evaluate(() => ({ hashes: fixture.uploadedHashes, prompts: fixture.promptHistory, submissions: fixture.submissions }));
  assert.equal(pipelineUploads.submissions, 2);
  assert.deepEqual(pipelineUploads.prompts, ['Blue moves first', 'Peach moves second']);
  assert.deepEqual(pipelineUploads.hashes, pipeline.jobs.map(job => job.image.sha256));
  assert.notEqual(pipelineUploads.hashes[0], pipelineUploads.hashes[1]);
  assert.ok(pipeline.jobs.every(job => job.upload.verified && job.upload.ratio === '1:1'));
  assert.ok(pipeline.jobs.every(job => job.variants.filter(variant => variant.assetId).map(variant => variant.variant).join() === '3'));
  const pipelineZip = await savedZip(page, 'full-pipeline-workflow.zip');
  assert.deepEqual([...pipelineZip.files.keys()], ['videos/video_001.mp4', 'videos/video_002.mp4', 'manifest.json']);
  for (const [name, bytes] of pipelineZip.files) {
    if (name.endsWith('.mp4')) assert.equal(fingerprint(bytes), fingerprint(videos.square));
  }
  assert.deepEqual(pipelineZip.manifest.jobs.map(job => job.image.filename), [null, null]);
  assert.deepEqual(pipelineZip.manifest.jobs.map(job => job.videoPrompt), pipelineUploads.prompts);
  assert.deepEqual(unexpected, []);
  await page.locator('#workspace-generate').click();
  report('full Prompt → Image → Video workflow: Download Manager Pause/Resume, one Meta batch, exact image bytes uploaded in order, selected-only videos ZIP with complete mapping');

  await clearRun(page);
  await page.locator('#workspace-settings').click();
  await page.locator('#auto-save-setting').uncheck();
  await page.locator('#workspace-generate').click();
  await page.locator('#mode-select').selectOption('image');
  await page.locator('#image-prompts').fill('Manual blue square\n\nManual peach square');
  await page.locator('#ratio-select').selectOption('1:1');
  await chooseZip(page, 'manual-review.zip');
  await page.locator('#generate-button').click();
  await page.waitForFunction(() => document.querySelector('#run-status-badge')?.dataset.status === 'ready-to-export', null, { timeout: 30_000 });
  assert.equal(await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('manual-review.zip')).getFile()).size), 0);
  await page.locator('#workspace-downloads').click();
  assert.equal(await page.locator('#archive-state').innerText(), 'Ready to save');
  await page.evaluate(() => { window.showSaveFilePicker = () => { throw new Error('Saving to the chosen destination must not invoke another picker.'); }; });
  await page.locator('#manager-export-button').click();
  await waitForCompletion(page, 'manual-review.zip');
  const manualZip = await savedZip(page, 'manual-review.zip');
  assert.deepEqual([...manualZip.files.keys()], ['images/image_001.png', 'images/image_002.png', 'manifest.json']);
  await page.locator('#workspace-generate').click();
  await clearRun(page);
  await page.locator('#workspace-settings').click();
  page.once('dialog', dialog => dialog.accept());
  await page.locator('#clear-draft-images').click();
  await page.waitForFunction(() => document.querySelector('#settings-notice').textContent.includes('draft images cleared'));
  assert.equal(await page.locator('#upload-count').innerText(), '0 images');
  report('automatic saving can be disabled for local review; Save ZIP reuses the preselected handle; Settings clears draft images separately');

  await Promise.all(fixtureStarts);
  const journal = await worker.evaluate(() => chrome.storage.local.get(null));
  assert.equal(Object.keys(journal).some(key => key.startsWith('operation:content:')), false);
  assert.deepEqual(errors, []);
  report('clearing releases generated media and operation journals; no uncaught extension UI errors');
  console.log('Browser extension checks passed. Provider pages/media were local fixtures; live login verification remains a local user test.');
} catch (error) {
  console.error('Connections denied by the offline proxy:', [...blockedConnections]);
  console.error('Provider fixture setup:', JSON.stringify([...fixtureDocuments.values()], null, 2));
  if (page && !page.isClosed()) {
    console.error('Uncaught page errors:', errors);
    console.error('Browser failure details:', JSON.stringify(await page.evaluate(async () => {
      const { get, entries } = await import('./js/lib/store.js');
      const draft = await get('drafts', 'ui');
      const assets = await entries('assets');
      return {
        mode: document.querySelector('#mode-select')?.value,
        count: document.querySelector('#upload-count')?.textContent,
        alert: document.querySelector('#alert-region')?.textContent,
        run: document.querySelector('#run-message')?.textContent,
        savedRun: await get('runs', 'current'),
        operations: await chrome.storage.local.get(null),
        draft,
        assets: assets.map(({ key, value }) => ({ key, size: value?.blob?.size, type: value?.blob?.type })),
      };
    }).catch(() => 'Page unavailable'), null, 2));
  }
  for (const providerPage of context.pages().filter(candidate => fixtureDocuments.has(candidate) || /^https:\/\/(?:www\.meta|vibes)\.ai\//.test(candidate.url()))) {
    console.error('Provider fixture failure details:', JSON.stringify(await providerPage.evaluate(() => ({
      url: location.href,
      title: document.title,
      contentType: document.contentType,
      readyState: document.readyState,
      fixture: globalThis.fixture,
      realMedia: globalThis.meteFixtureOptions?.realMedia,
      codecs: Object.fromEntries(['avc1.42E01E', 'vp09.00.10.08'].map(codec => [codec, document.createElement('video').canPlayType(`video/mp4;codecs=${codec}`)])),
      dialogs: [...document.querySelectorAll('[role="dialog"]')].map(node => ({ name: node.getAttribute('aria-label'), text: node.innerText })),
      controls: [...document.querySelectorAll('button, textarea, input')].map(node => ({
        tag: node.tagName, name: node.getAttribute('aria-label') || node.textContent, value: node.value,
        disabled: node.disabled, hiddenAncestor: !!node.closest('[hidden], [aria-hidden="true"], [inert]'),
        visible: !!node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden',
      })),
      media: [...document.querySelectorAll('img, video')].map(node => ({
        tag: node.tagName, name: node.getAttribute('alt'), src: node.currentSrc || node.src,
        width: node.naturalWidth ?? node.videoWidth, height: node.naturalHeight ?? node.videoHeight,
        complete: node.complete, readyState: node.readyState, duration: node.duration, error: node.error?.message, errorCode: node.error?.code,
        parent: node.parentElement?.outerHTML.slice(0, 1500),
      })),
    })).catch(error => ({ url: providerPage.url(), error: error.message })), null, 2));
  }
  throw error;
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
  await new Promise(resolve => offlineProxy.close(resolve));
}
