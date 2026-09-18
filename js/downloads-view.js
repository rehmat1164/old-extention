import { downloadInventory } from './lib/downloads.js';
import { MODES } from './lib/model.js';
import { get } from './lib/store.js';

const labels = { archived: 'In last ZIP', local: 'Saved locally', available: 'Available on Vibes', pending: 'Waiting' };
const el = id => document.getElementById(id);
const text = (node, value) => { if (node.textContent !== String(value)) node.textContent = value; };
const bytes = value => value < 1024 ? `${value} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1048576).toFixed(1)} MiB`;
const node = (tag, className, content) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (content != null) element.textContent = content;
  return element;
};

export class DownloadManager {
  constructor(actions) {
    this.actions = actions;
    this.urls = new Map();
    this.pendingUrls = new Map();
    this.epoch = 0;
    this.inventory = downloadInventory(null);
    this.dialog = el('media-preview');
    el('download-variants').addEventListener('change', () => actions.selectVariants(
      [...document.querySelectorAll('input[name="download-variant"]:checked')].map(input => Number(input.value)),
    ));
    el('download-include-images').addEventListener('change', event => actions.includeImages(event.target.checked));
    el('manager-export-button').addEventListener('click', () => actions.save());
    el('manager-save-as').addEventListener('click', () => actions.saveAs());
    el('manager-clear-run').addEventListener('click', () => actions.clear());
    el('manager-run-actions').addEventListener('click', event => {
      const button = event.target.closest('[data-run-command]');
      if (button) actions.run(button.dataset.runCommand);
    });
    for (const id of ['download-search', 'download-filter']) el(id).addEventListener('input', () => this.renderList(true));
    el('download-list').addEventListener('click', event => {
      const button = event.target.closest('[data-preview-file]');
      if (button) this.preview(button.dataset.previewFile).catch(actions.error);
    });
    el('close-media-preview').addEventListener('click', () => this.closePreview());
    this.dialog.addEventListener('cancel', () => this.resetPreview());
    this.dialog.addEventListener('close', () => {
      if (!this.dialog.open) this.resetPreview();
    });
    el('copy-activity').addEventListener('click', () => this.copyLog().catch(actions.error));
    window.addEventListener('pagehide', () => this.release());
  }

  release() {
    this.epoch += 1;
    this.closePreview();
    for (const url of this.urls.values()) URL.revokeObjectURL(url);
    this.urls.clear();
    this.pendingUrls.clear();
  }

  resetPreview() {
    const video = el('media-preview-content').querySelector('video');
    if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    el('media-preview-content').replaceChildren();
    this.previewId = null;
  }

  closePreview() {
    this.resetPreview();
    this.dialog.close();
  }

  async localUrl(assetId) {
    if (this.urls.has(assetId)) return this.urls.get(assetId);
    if (this.pendingUrls.has(assetId)) return this.pendingUrls.get(assetId);
    const epoch = this.epoch;
    const pending = (async () => {
      const record = await get('assets', assetId);
      if (epoch !== this.epoch) return null;
      if (!(record?.blob instanceof Blob)) throw new Error('This local preview is no longer available. The run may have been cleared.');
      const url = URL.createObjectURL(record.blob);
      this.urls.set(assetId, url);
      return url;
    })();
    this.pendingUrls.set(assetId, pending);
    try { return await pending; } finally { if (epoch === this.epoch) this.pendingUrls.delete(assetId); }
  }

  render({ session, mode, variants, includeImages, locked, actionPending, isExtension }) {
    if (session?.id !== this.session?.id) {
      this.release();
      this.listKey = null;
      el('activity-notice').textContent = '';
    }
    this.session = session;
    this.inventory = downloadInventory(session, { variants, includeImages });
    const inventory = this.inventory;
    text(el('downloads-count'), inventory.cached);
    text(el('downloads-selected'), inventory.selected);
    text(el('downloads-ready'), inventory.ready);
    text(el('downloads-size'), bytes(inventory.bytes));
    el('download-video-selection').hidden = mode === MODES.IMAGE;
    text(el('download-selection-summary'), `Variants ${variants.join(', ') || 'none'} · ${includeImages ? 'Images + videos' : 'Videos only'}`);
    document.querySelectorAll('input[name="download-variant"]').forEach(input => {
      input.checked = variants.includes(Number(input.value));
      input.disabled = locked;
    });
    el('download-include-images').checked = includeImages;
    el('download-include-images').disabled = locked;
    const canExport = Boolean(isExtension && session?.generationComplete && !locked && (mode === MODES.IMAGE || variants.length));
    el('manager-export-button').disabled = !canExport;
    el('manager-save-as').disabled = !canExport;
    el('manager-clear-run').disabled = !isExtension || !session || actionPending
      || ['running', 'waiting', 'pausing', 'stopping', 'exporting'].includes(session.status);
    const last = session?.lastExport;
    const currentFiles = inventory.files.filter(file => file.selected);
    const matchesExport = last && last.files.length === currentFiles.length && currentFiles.every(file => file.state === 'archived');
    const status = !session ? 'Not started' : session.status === 'exporting' ? 'Writing ZIP'
      : session.status === 'complete' ? matchesExport ? 'Saved' : 'Selection changed'
        : session.status === 'ready-to-export' ? 'Ready to save'
          : /error/.test(session.status) ? 'Needs attention'
            : session.status === 'stopped' ? 'Stopped' : session.status === 'paused' ? 'Paused' : 'Working';
    text(el('archive-state'), status);
    text(el('archive-name'), session?.zipName || 'Choose a save location when you Generate.');
    const detail = !session ? 'Nothing is downloaded from other chats or projects.'
      : !currentFiles.length ? 'Select at least one video variant before saving.'
        : session.status === 'exporting' ? session.zipProgress?.name ? `Writing ${session.zipProgress.name}…` : 'Collecting selected files and preparing the archive…'
          : session.status === 'complete' && !matchesExport ? 'Your selection differs from the last ZIP. Save again to apply it without regenerating.'
            : `${inventory.ready} of ${inventory.selected} selected files saved locally. ${session.generationComplete ? 'You can export without generating again.' : 'Generation is still being tracked.'}`;
    text(el('archive-detail'), detail);
    const showMessage = session && session.status !== 'complete' && session.status !== 'exporting';
    el('manager-message').hidden = !showMessage;
    el('manager-message').dataset.error = /error/.test(session?.status || '');
    if (showMessage) text(el('manager-message'), session.message);
    const controls = el('manager-run-actions');
    const commands = ['running', 'waiting'].includes(session?.status) ? [['Pause after item', 'run:pause'], ['Stop', 'run:stop']]
      : ['pausing', 'exporting'].includes(session?.status) ? [['Stop', 'run:stop']]
        : !session?.generationComplete && ['paused', 'error'].includes(session?.status) ? [['Resume', 'run:resume']] : [];
    const commandKey = JSON.stringify([session?.id, commands, actionPending, isExtension]);
    if (commandKey !== this.commandKey) {
      this.commandKey = commandKey;
      controls.replaceChildren();
      for (const [label, command] of commands) {
        const button = node('button', 'run-control-button', label);
        button.type = 'button'; button.dataset.runCommand = command; button.disabled = actionPending || !isExtension;
        controls.append(button);
      }
    }
    const progress = el('archive-progress');
    progress.value = session?.status === 'exporting' ? Math.min(session.zipProgress?.progress || 0, .99)
      : inventory.selected ? inventory.ready / inventory.selected : 0;
    progress.setAttribute('aria-label', session?.status === 'exporting' ? 'ZIP write progress' : 'Selected media ready');
    el('last-export').hidden = !last;
    if (last) text(el('last-export'), `Last saved: ${last.name} · ${bytes(last.bytes)} · ${last.files.length} media files`);
    this.renderList();
    this.renderLog();
  }

  renderList(force = false) {
    const filter = el('download-filter').value;
    const search = el('download-search').value.trim().toLowerCase();
    const key = JSON.stringify([this.session?.id, this.inventory.groups, filter, search]);
    if (!force && key === this.listKey) return;
    this.listKey = key;
    const list = el('download-list');
    list.replaceChildren();
    for (const group of this.inventory.groups) {
      const matchesGroup = `${group.index} ${group.prompt} ${group.originalName || ''}`.toLowerCase().includes(search);
      const files = group.files.filter(file => (filter === 'all' || filter === 'selected' && file.selected || filter === file.kind)
        && (matchesGroup || `${file.label} ${file.path || ''}`.toLowerCase().includes(search)));
      if (!files.length) continue;
      const card = node('section', 'download-group');
      card.dataset.imageIndex = group.index;
      const heading = node('header', 'download-group-heading');
      const thumb = node('span', 'download-thumb', group.index);
      thumb.setAttribute('aria-hidden', 'true');
      const source = group.files.find(file => file.kind === 'image');
      if (source.assetId) this.localUrl(source.assetId).then(url => {
        if (!url || !thumb.isConnected) return;
        const image = node('img');
        image.alt = ''; image.src = url;
        image.addEventListener('error', () => { thumb.textContent = group.index; }, { once: true });
        thumb.replaceChildren(image);
      }).catch(() => {});
      const copy = node('div');
      copy.append(node('h3', '', `Image ${group.index}`), node('p', '', group.originalName || group.prompt));
      if (group.verified) copy.append(node('p', 'verified-note', 'Start frame verified · videos matched'));
      heading.append(thumb, copy);
      card.append(heading);
      for (const file of files) {
        const row = node('div', 'download-file');
        row.dataset.selected = file.selected;
        row.dataset.fileKey = file.key;
        const info = node('div');
        const path = file.path || (file.selected ? 'Numbered filename assigned when ready' : file.kind === 'image' ? 'Source image · not included in ZIP' : 'Not selected for this ZIP');
        info.append(node('strong', '', file.label), node('span', 'file-path', path));
        const badge = node('span', 'file-state', `${labels[file.state]}${file.assetId ? ` · ${bytes(file.size)}` : ''}`);
        badge.dataset.state = file.state;
        info.append(badge);
        const preview = node('button', 'download-preview', file.kind === 'video' ? 'Play' : 'View');
        preview.type = 'button';
        preview.disabled = !file.assetId;
        preview.dataset.previewFile = file.key;
        preview.setAttribute('aria-label', `Preview ${file.label}`);
        row.append(info, preview);
        card.append(row);
      }
      list.append(card);
    }
    if (!list.children.length) {
      const empty = node('div', 'download-empty');
      empty.append(node('strong', '', this.session ? 'No matching outputs' : 'Your outputs will appear here'),
        node('p', '', this.session ? 'Try another filter or filename.' : 'Start a run in Generate. See each image and video, review local files, and save an organised ZIP.'));
      list.append(empty);
    }
  }

  async preview(key) {
    const file = this.inventory.files.find(item => item.key === key);
    if (!file?.assetId) return;
    this.previewId = file.assetId;
    const url = await this.localUrl(file.assetId);
    if (!url || this.previewId !== file.assetId) return;
    text(el('media-preview-title'), file.label);
    const media = node(file.kind === 'video' ? 'video' : 'img');
    if (file.kind === 'video') { media.controls = true; media.preload = 'metadata'; }
    else media.alt = file.label;
    media.src = url;
    media.addEventListener('error', () => {
      text(el('media-preview-detail'), 'Chrome could not decode this cached preview. The file has not been replaced or fetched again.');
    }, { once: true });
    el('media-preview-content').replaceChildren(media);
    text(el('media-preview-detail'), `${file.path || file.label} · ${bytes(file.size)} · Local file${file.sha256 ? ` · SHA-256 ${file.sha256.slice(0, 12)}…` : ''}`);
    if (!this.dialog.open) this.dialog.showModal();
  }

  renderLog() {
    const log = this.session?.log || [];
    const key = JSON.stringify(log);
    text(el('activity-count'), `${log.length} events`);
    el('copy-activity').disabled = !log.length;
    if (this.logKey === key) return;
    this.logKey = key;
    const list = el('activity-list');
    list.replaceChildren();
    for (const event of [...log].reverse()) {
      const item = node('li');
      const date = new Date(event.at);
      const time = node('time', '', Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour12: false }) : '—');
      if (Number.isFinite(date.getTime())) time.dateTime = date.toISOString();
      item.append(time, node('span', '', event.message));
      list.append(item);
    }
    if (!log.length) list.append(node('li', '', 'No run events yet.'));
  }

  async copyLog() {
    if (!this.session || !navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable in this browser.');
    const lines = [`Mete Run local · ${this.session.mode} · ${this.session.status}`,
      ...(this.session.log || []).map(event => `${event.at}  ${event.message}`)];
    await navigator.clipboard.writeText(lines.join('\n'));
    text(el('activity-notice'), 'Copied locally. Review filenames and messages before sharing.');
  }
}
