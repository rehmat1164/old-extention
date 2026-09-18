import { createSession, MODES, batchImagePrompt, assetFilename, exportPlan, runManifest, MAX_IMAGE_BYTES } from './model.js';
import { publicStatus, vibesProjectUrl, validateVariants } from './policy.js';
import { assetBlob, mediaType, sha256, dataUrl } from './media.js';
import { writeZip } from './zip.js';

class Paused extends Error {}
class Stopped extends Error {}

export class RunController {
  constructor(io) {
    this.io = io;
    this.session = null;
    this.task = null;
    this.starting = false;
    this.pauseRequested = false;
    this.stopRequested = false;
    this.delay = io.delay || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  async init() {
    this.session = await this.io.getRun() || null;
    if (this.session && ['running', 'pausing', 'exporting', 'stopping'].includes(this.session.status)) {
      this.session.status = 'paused';
      this.session.message = 'Chrome or the local worker restarted. Resume checks the existing operation; it will not submit it again.';
      await this.save();
    }
    return this.status();
  }

  status() { return publicStatus(this.session); }

  async save(message) {
    if (!this.session) return;
    this.session.updatedAt = new Date().toISOString();
    if (message && message !== this.session.message) {
      this.session.message = message;
      this.session.log.push({ at: this.session.updatedAt, message });
      this.session.log = this.session.log.slice(-100);
    }
    await this.io.saveRun(this.session);
    await this.io.publish(this.status());
  }

  async start({ config, uploads = [], handleId, zipName, runId }) {
    if (this.starting || this.task) throw new Error('A run is already active.');
    if (this.session) throw new Error('Clear the previous run before generating another batch.');
    this.starting = true;
    try {
      const session = createSession(config, uploads, runId);
      const handle = await this.io.get('handles', handleId);
      if (!handle || typeof handle.createWritable !== 'function' || await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
        throw new Error('Choose and allow a ZIP save location before generation starts.');
      }
      if (session.mode === MODES.IMAGE_VIDEO) {
        for (const job of session.jobs) {
          const blob = assetBlob(await this.io.get('assets', job.image.assetId));
          const type = await mediaType(blob, 'image');
          if (blob.size > MAX_IMAGE_BYTES || blob.size !== job.image.size || type !== job.image.type) {
            throw new Error(`Source image ${job.index} does not match its saved file or exceeds 10 MB. Upload it again.`);
          }
          job.image.sha256 = await sha256(blob);
        }
      }
      session.handleId = handleId;
      session.handleIds = [handleId];
      session.zipName = zipName || handle.name || session.zipName;
      session.status = 'running';
      session.operation = null;
      this.session = session;
      this.pauseRequested = false;
      this.stopRequested = false;
      await this.save('ZIP destination confirmed. Starting the selected workflow.');
      this.launch(() => this.generate());
      return this.status();
    } finally { this.starting = false; }
  }

  launch(work) {
    this.task = work().catch(async error => {
      if (error instanceof Stopped || this.stopRequested) {
        this.session.status = 'stopped';
        await this.save('Stopped locally. A request already submitted on the provider may still finish there; it will not be submitted again.');
      } else if (error instanceof Paused) {
        this.session.status = 'paused';
        await this.save('Paused safely between items. Your saved images and videos are kept locally.');
      } else {
        this.session.status = this.session.stage === 'export' ? 'export-error' : 'error';
        await this.save(error.message || 'The current step failed. No automatic generation retry was made.');
      }
    }).catch(error => {
      console.error('Could not persist the local run state:', error);
    }).finally(() => { this.task = null; });
  }

  checkStopped() {
    if (this.stopRequested) throw new Stopped();
  }

  async boundary() {
    this.checkStopped();
    if (this.pauseRequested) throw new Paused();
  }

  async pause() {
    if (!this.task || this.session.status === 'exporting') throw new Error('There is no generation step to pause.');
    this.pauseRequested = true;
    this.session.status = 'pausing';
    await this.save('Pausing after the current submitted item is collected. No next item will be submitted.');
    return this.status();
  }

  async resume() {
    if (this.task || this.starting) throw new Error('The current step is still settling.');
    if (!this.session || !['paused', 'error', 'export-error'].includes(this.session.status)) throw new Error('There is no paused run to resume.');
    this.pauseRequested = false;
    this.stopRequested = false;
    this.session.status = 'running';
    await this.save('Continuing saved progress without resubmitting completed work.');
    this.launch(() => this.generate());
    return this.status();
  }

  async stop() {
    if (!this.session || !this.task) throw new Error('There is no active run to stop.');
    this.stopRequested = true;
    this.session.status = 'stopping';
    await this.save('Stopping local automation. Already-submitted provider requests are not cancelled.');
    const op = this.session.operation;
    if (op) this.send(op.provider, op.tabId, { type: 'operation:cancel', operationId: op.id }).catch(() => {});
    return this.status();
  }

  async clear() {
    if (this.task || this.starting) throw new Error('Stop the current run and let it settle before clearing.');
    if (this.session) {
      for (const job of this.session.jobs) {
        if (job.image?.assetId && this.session.mode !== MODES.IMAGE_VIDEO) await this.io.remove('assets', job.image.assetId);
        for (const candidate of job.variants) if (candidate.assetId) await this.io.remove('assets', candidate.assetId);
      }
      for (const handleId of new Set([...(this.session.handleIds || []), this.session.handleId].filter(Boolean))) {
        await this.io.remove('handles', handleId);
      }
    }
    await this.io.remove('runs', 'current');
    await this.io.rpc('operation:clear');
    this.session = null;
    await this.io.publish(null);
    return null;
  }

  async send(provider, tabId, command) {
    return this.io.rpc('provider:send', { provider, tabId, command });
  }

  async tab(provider) {
    const existing = this.session[provider]?.tabId;
    const tab = await this.io.rpc('provider:ensure', { provider, tabId: existing });
    if (provider === 'vibes' && this.session.vibes?.projectReady) this.assertProject(tab.url);
    this.session[provider] = { ...this.session[provider], tabId: tab.id, url: tab.url };
    await this.save();
    const deadline = Date.now() + 90_000;
    let lastError;
    do {
      this.checkStopped();
      try {
        const state = await this.send(provider, tab.id, { type: 'ping' });
        if (state?.provider === provider) return tab.id;
      } catch (error) { lastError = error; }
      await this.delay(750);
    } while (Date.now() < deadline);
    throw new Error(`The ${provider === 'meta' ? 'Meta AI' : 'Vibes AI'} tab is not ready. Sign in and refresh it, then Resume. ${lastError?.message || ''}`);
  }

  async operate(provider, action, payload, index = null) {
    this.checkStopped();
    const tabId = this.session[provider].tabId;
    let op = this.session.operation;
    if (op && (op.action !== action || op.index !== index || op.tabId !== tabId)) {
      throw new Error('A previous page operation is unresolved. Inspect its provider tab before clearing this run.');
    }
    if (!op) {
      op = { id: `${this.session.id}:${action}:${index ?? 'batch'}`, action, provider, tabId, index };
      this.session.operation = op;
      await this.save();
      // Persist the operation identity before submitting: a restart must never send it twice.
      await this.send(provider, tabId, { type: 'operation:start', operationId: op.id, action, payload });
    }
    const deadline = Date.now() + 80 * 60_000;
    let unreachableSince;
    while (Date.now() < deadline) {
      this.checkStopped();
      let state;
      try {
        state = await this.send(provider, tabId, { type: 'operation:status', operationId: op.id });
        unreachableSince = null;
      } catch {
        unreachableSince ||= Date.now();
        state = { status: 'missing' };
      }
      if (state?.status === 'missing') {
        const checkpoint = await this.io.rpc('operation:read', { operationId: op.id });
        if (checkpoint?.status === 'completed') state = checkpoint;
        if (state.status === 'missing' && (!unreachableSince || Date.now() - unreachableSince > 30_000)) {
          throw new Error('The provider page reloaded or lost the current operation. To avoid duplicate generation, it was not resubmitted. Check the page; clear this run only when you are ready to start a new one.');
        }
      }
      if (state?.message) await this.save(state.message);
      if (state?.status === 'completed') return state.result;
      if (['failed', 'cancelled'].includes(state?.status)) throw new Error(state.error || state.message || 'The page could not complete this step. Nothing was resubmitted.');
      await this.delay(1000);
    }
    throw new Error('This step is still taking too long. Check the provider tab, then Resume to keep observing the same request. No duplicate was submitted.');
  }

  async finishOperation() {
    this.session.operation = null;
    await this.save();
  }

  async saveAsset(blob, { kind, index, variant }) {
    this.checkStopped();
    const id = `${this.session.id}:${kind}:${index}:${variant || 1}`;
    const metadata = {
      assetId: id, type: blob.type, size: blob.size, sha256: await sha256(blob),
      name: kind === 'image' ? assetFilename(this.session.id, index, blob.type) : `video_${index}_${variant}.mp4`,
    };
    await this.io.put('assets', id, { ...metadata, blob, runId: this.session.id });
    return metadata;
  }

  async fetchAsset(source, kind, provider) {
    return this.io.download({
      url: source.url, kind, provider, checkCancelled: () => this.checkStopped(),
      readChunk: payload => this.send(provider, this.session[provider].tabId, { type: 'media:read', ...payload }),
    });
  }

  async generateImages() {
    if (this.session.jobs.every(job => job.image?.assetId)) return;
    await this.boundary();
    this.session.stage = 'images';
    await this.save('Opening a new Meta AI chat for the numbered image prompts.');
    await this.tab('meta');
    if (!this.session.meta.images) {
      const result = await this.operate('meta', 'meta:generate', {
        request: batchImagePrompt(this.session.jobs.map(job => job.imagePrompt), this.session.settings.ratio),
        ratio: this.session.settings.ratio,
        expected: this.session.jobs.map(job => ({ index: job.index, marker: `Image ${job.index}` })),
      });
      const images = result?.images;
      if (!Array.isArray(images) || images.length !== this.session.jobs.length
        || new Set(images.map(image => image.index)).size !== images.length
        || images.some(image => !this.session.jobs.some(job => job.index === image.index) || !image.url)
        || new Set(images.map(image => image.sourceKey || image.url)).size !== images.length) {
        throw new Error('Meta AI results could not be paired one-to-one with the numbered prompts. No order was guessed.');
      }
      this.session.meta = { ...this.session.meta, url: result.url, images };
      await this.finishOperation();
    }
    for (const job of this.session.jobs) {
      this.checkStopped();
      if (job.image?.assetId) continue;
      const source = this.session.meta.images.find(image => image.index === job.index);
      job.image = { ...await this.saveAsset(await this.fetchAsset(source, 'image', 'meta'), { kind: 'image', index: job.index }), sourceKey: source.sourceKey };
      job.status = this.session.mode === MODES.IMAGE ? 'complete' : 'image-ready';
      await this.save(`Image ${job.index} of ${this.session.jobs.length} saved locally with its prompt number.`);
    }
  }

  async collectSelected(job) {
    for (const variant of this.session.settings.variants) {
      this.checkStopped();
      const candidate = job.variants.find(item => item.variant === variant);
      if (!candidate) throw new Error(`Image ${job.index} is missing video variant ${variant}.`);
      if (candidate.assetId) continue;
      const asset = await this.saveAsset(await this.fetchAsset(candidate, 'video', 'vibes'), { kind: 'video', index: job.index, variant });
      Object.assign(candidate, asset);
      await this.save(`Saved video ${job.index}, variant ${variant}. Only selected candidates are saved locally.`);
    }
  }

  async generateVideos() {
    await this.boundary();
    this.session.stage = 'videos';
    await this.tab('vibes');
    if (!this.session.vibes.projectReady) {
      await this.save('Creating a separate Vibes AI project for this run.');
      const result = await this.operate('vibes', 'vibes:project', {});
      if (!vibesProjectUrl(result?.url)) throw new Error('Vibes did not return a verified project for this run. No image was uploaded.');
      const tab = await this.io.rpc('provider:info', { provider: 'vibes', tabId: this.session.vibes.tabId });
      if (vibesProjectUrl(tab.url) !== vibesProjectUrl(result.url)) throw new Error('The Vibes tab left the newly created project. No image was uploaded.');
      this.session.vibes = { ...this.session.vibes, url: result.url, projectReady: true };
      await this.finishOperation();
    }
    for (const job of this.session.jobs) {
      if (job.status === 'complete') continue;
      await this.boundary();
      const tab = await this.io.rpc('provider:info', { provider: 'vibes', tabId: this.session.vibes.tabId });
      this.assertProject(tab.url);
      if (!job.variants.length) {
        const blob = assetBlob(await this.io.get('assets', job.image.assetId));
        if (blob.size > MAX_IMAGE_BYTES) throw new Error(`Image ${job.index} is larger than Vibes AI's 10 MB upload limit.`);
        const name = assetFilename(this.session.id, job.index, blob.type);
        job.status = 'generating';
        await this.save(`Image ${job.index}/${this.session.jobs.length}: verifying the upload and generating four video candidates.`);
        const result = await this.operate('vibes', 'vibes:generate', {
          index: job.index, uploadLabel: name,
          image: { name, type: blob.type, dataUrl: await dataUrl(blob), sha256: job.image.sha256 },
          prompt: job.videoPrompt, ratio: this.session.settings.ratio,
          projectUrl: this.session.vibes.url,
          ratioSource: 'image',
          resolution: this.session.settings.resolution, expectedVariants: 4,
        }, job.index);
        const variants = result?.variants;
        this.assertProject(result?.url);
        if (!result?.upload?.verified || result.upload.sha256 !== job.image.sha256
          || !Array.isArray(variants) || variants.length !== 4
          || [1, 2, 3, 4].some(variant => variants.filter(item => item.variant === variant && item.url).length !== 1)
          || new Set(variants.map(item => item.sourceKey || item.url)).size !== 4) {
          throw new Error(`The start-frame or four video identities for image ${job.index} are ambiguous. The next image was not uploaded.`);
        }
        job.upload = result.upload;
        job.variants = variants;
        this.session.vibes.url = result.url;
        await this.finishOperation();
      }
      await this.collectSelected(job);
      job.status = 'complete';
      await this.save(`Image ${job.index}/${this.session.jobs.length} finished. Its selected videos are saved locally.`);
    }
  }

  async generate() {
    if (this.session.generationComplete) return this.exportZip();
    if (this.session.mode !== MODES.IMAGE_VIDEO) await this.generateImages();
    if (this.session.mode !== MODES.IMAGE) await this.generateVideos();
    await this.boundary();
    this.session.generationComplete = true;
    if (this.session.settings.autoSave === false) {
      this.session.status = 'ready-to-export';
      this.session.stage = 'export';
      await this.save('All requested media is saved locally. Automatic ZIP saving is off; open Download Manager and Save ZIP when ready.');
      return;
    }
    await this.save('All requested media is saved locally. Preparing your ZIP.');
    await this.exportZip();
  }

  assertProject(url) {
    const expected = vibesProjectUrl(this.session.vibes?.url);
    if (!expected || vibesProjectUrl(url) !== expected) {
      throw new Error('The Vibes tab left this run’s dedicated project. Return to the original project before resuming; no image was uploaded to another project.');
    }
  }

  async export({ variants, includeImages, handleId, zipName } = {}) {
    if (this.task || this.starting) throw new Error('Wait for the current step to finish before exporting.');
    if (!this.session?.generationComplete) throw new Error('Finish generation before exporting the complete batch.');
    if (includeImages !== undefined && typeof includeImages !== 'boolean') throw new Error('Choose whether to include images in the ZIP.');
    if (variants && this.session.mode !== MODES.IMAGE) this.session.settings.variants = validateVariants(variants);
    if (includeImages !== undefined) this.session.settings.includeImages = includeImages;
    if (handleId) {
      this.session.handleIds = [...new Set([...(this.session.handleIds || []), this.session.handleId, handleId].filter(Boolean))];
      this.session.handleId = handleId;
    }
    if (zipName) this.session.zipName = zipName;
    this.pauseRequested = false;
    this.stopRequested = false;
    this.session.status = 'exporting';
    await this.save();
    this.launch(() => this.exportZip());
    return this.status();
  }

  async exportZip() {
    this.session.stage = 'export';
    this.session.status = 'exporting';
    this.session.zipProgress = null;
    await this.save('Writing your selected files to the ZIP location chosen before generation.');
    if (this.session.mode !== MODES.IMAGE) for (const job of this.session.jobs) await this.collectSelected(job);
    const handle = await this.io.get('handles', this.session.handleId);
    if (!handle || await handle.queryPermission({ mode: 'readwrite' }) !== 'granted') {
      throw new Error('ZIP write permission was lost. Your media is safe locally. Choose a ZIP location again to export; generation will not repeat.');
    }
    const entries = [];
    const files = exportPlan(this.session);
    for (const file of files) {
      entries.push({ name: file.path, blob: assetBlob(await this.io.get('assets', file.assetId)) });
    }
    entries.push({ name: 'manifest.json', blob: new Blob([JSON.stringify(runManifest(this.session), null, 2)], { type: 'application/json' }) });
    this.checkStopped();
    const writable = await handle.createWritable();
    let lastProgress = 0;
    const result = await writeZip(entries, {
      write: chunk => { this.checkStopped(); return writable.write(chunk); },
      close: () => { this.checkStopped(); return writable.close(); },
      abort: reason => writable.abort(reason),
    }, async progress => {
      this.checkStopped();
      this.session.zipProgress = progress;
      if (Date.now() - lastProgress >= 500 || progress.progress === 1) {
        lastProgress = Date.now();
        await this.save();
      }
    });
    this.session.status = 'complete';
    this.session.exportedAt = new Date().toISOString();
    this.session.lastExport = { at: this.session.exportedAt, name: this.session.zipName, bytes: result.bytesWritten, files };
    await this.save(`Saved ${this.session.zipName}. Prompt numbers, image names, and video variants are recorded in manifest.json.`);
  }
}
