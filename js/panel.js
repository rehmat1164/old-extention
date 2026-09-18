import {
  DEFAULT_SETTINGS,
  MODE_OPTIONS,
  MODES,
  RATIOS,
  RESOLUTIONS,
  parsePrompts,
  sortImages,
  validateConfig,
} from './lib/model.js';
import { get as getLocal, put as putLocal, remove as removeLocal } from './lib/store.js';
import { call, isExtension } from './bridge.js';
import { DownloadManager } from './downloads-view.js';

const DRAFT_KEY = 'ui';
const STATUS_STORAGE_KEY = 'session';
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MODE_LABELS = Object.freeze({
  [MODES.IMAGE]: 'Image',
  [MODES.IMAGE_VIDEO]: 'Image → Video',
  [MODES.PROMPT_VIDEO]: 'Prompt → Image → Video',
});
const STATUS_LABELS = Object.freeze({
  ready: 'Ready',
  running: 'Running',
  waiting: 'Waiting',
  paused: 'Paused',
  pausing: 'Pausing',
  attention: 'Needs attention',
  interrupted: 'Interrupted',
  stopping: 'Stopping',
  stopped: 'Stopped',
  exporting: 'Exporting ZIP',
  complete: 'ZIP complete',
  'ready-to-export': 'Ready to save ZIP',
  error: 'Needs attention',
  'export-error': 'Export needs attention',
});
const STAGE_LABELS = Object.freeze({
  setup: 'Preparing your local run',
  images: 'Generating and saving images',
  videos: 'Generating videos one image at a time',
  export: 'Writing the local ZIP archive',
});

function requiredElement(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Mete Run panel is missing #${id}.`);
  return element;
}

const elements = {
  modeSelect: requiredElement('mode-select'),
  modeDescription: requiredElement('mode-description'),
  modeStatus: requiredElement('mode-status'),
  imageModeFields: requiredElement('image-mode-fields'),
  pipelineModeFields: requiredElement('pipeline-mode-fields'),
  uploadModeFields: requiredElement('upload-mode-fields'),
  imagePrompts: requiredElement('image-prompts'),
  pipelineImagePrompts: requiredElement('pipeline-image-prompts'),
  pipelineVideoPrompts: requiredElement('pipeline-video-prompts'),
  uploadVideoPrompts: requiredElement('upload-video-prompts'),
  ratioSelect: requiredElement('ratio-select'),
  pipelineRatioSelect: requiredElement('pipeline-ratio-select'),
  resolutionSelect: requiredElement('resolution-select'),
  imageModeCount: requiredElement('image-mode-count'),
  pipelineImageCount: requiredElement('pipeline-image-count'),
  pipelineVideoCount: requiredElement('pipeline-video-count'),
  pipelinePairCount: requiredElement('pipeline-pair-count'),
  pipelinePairStatus: requiredElement('pipeline-pair-status'),
  imagePromptTab: requiredElement('image-prompt-tab'),
  videoPromptTab: requiredElement('video-prompt-tab'),
  imagePromptPanel: requiredElement('image-prompt-panel'),
  videoPromptPanel: requiredElement('video-prompt-panel'),
  imageUpload: requiredElement('image-upload'),
  uploadDropZone: requiredElement('upload-drop-zone'),
  uploadList: requiredElement('upload-list'),
  uploadCount: requiredElement('upload-count'),
  uploadVideoCount: requiredElement('upload-video-count'),
  uploadPairStatus: requiredElement('upload-pair-status'),
  uploadHashStatus: requiredElement('upload-hash-status'),
  videoOptions: requiredElement('video-options'),
  variantOptions: requiredElement('variant-options'),
  zipContents: requiredElement('zip-contents'),
  outputSummary: requiredElement('output-summary'),
  validationSummary: requiredElement('validation-summary'),
  previewBanner: requiredElement('preview-banner'),
  connectionState: requiredElement('connection-state'),
  connectionStateText: requiredElement('connection-state-text'),
  runPanel: requiredElement('run-panel'),
  runStatusLabel: requiredElement('run-status-label'),
  runStatusBadge: requiredElement('run-status-badge'),
  runMessage: requiredElement('run-message'),
  runZipName: requiredElement('run-zip-name'),
  runStage: requiredElement('run-stage'),
  runProgress: requiredElement('run-progress'),
  jobProgressList: requiredElement('job-progress-list'),
  focusMetaButton: requiredElement('focus-meta-button'),
  focusVibesButton: requiredElement('focus-vibes-button'),
  runRecoveryActions: requiredElement('run-recovery-actions'),
  stopExplanation: requiredElement('stop-explanation'),
  completedRunActions: requiredElement('completed-run-actions'),
  exportZipButton: requiredElement('export-zip-button'),
  newRunButton: requiredElement('new-run-button'),
  clearRunButton: requiredElement('clear-run-button'),
  alertRegion: requiredElement('alert-region'),
  actionHint: requiredElement('action-hint'),
  generateButton: requiredElement('generate-button'),
  generateLabel: requiredElement('generate-label'),
  autoSaveSetting: requiredElement('auto-save-setting'),
  launcherSetting: requiredElement('launcher-setting'),
  resetSettings: requiredElement('reset-settings'),
  clearDraftImages: requiredElement('clear-draft-images'),
  settingsNotice: requiredElement('settings-notice'),
  settingsOutputSummary: requiredElement('settings-output-summary'),
};

const state = {
  config: cloneDefaults(),
  uploads: [],
  activePromptTab: 'image',
  session: null,
  engineAlive: true,
  hashingCount: 0,
  pendingNames: new Set(),
  uploadQueue: Promise.resolve(),
  starting: false,
  actionPending: false,
  startAttempted: false,
  draftTimer: null,
  uploadRenderKey: null,
  view: 'generate',
  scrollPositions: {},
  showLauncher: true,
};

const manager = new DownloadManager({
  selectVariants: variants => setVariants(variants),
  includeImages: include => setIncludeImages(include),
  save: () => saveSelectedZip(),
  saveAs: () => exportZipAgain(),
  clear: () => performRunAction('run:clear'),
  run: type => performRunAction(type),
  error: error => showAlert(error),
});

function cloneDefaults() {
  return {
    mode: DEFAULT_SETTINGS.mode,
    ratio: DEFAULT_SETTINGS.ratio,
    resolution: DEFAULT_SETTINGS.resolution,
    variants: [...DEFAULT_SETTINGS.variants],
    includeImages: DEFAULT_SETTINGS.includeImages,
    autoSave: DEFAULT_SETTINGS.autoSave,
    imagePrompts: DEFAULT_SETTINGS.imagePrompts,
    videoPrompts: DEFAULT_SETTINGS.videoPrompts,
  };
}

function isKnownMode(value) {
  return Object.values(MODES).includes(value);
}

function normaliseConfig(value) {
  const source = value && typeof value === 'object' ? value : {};
  const variants = Array.isArray(source.variants)
    ? [...new Set(source.variants.filter(item => Number.isInteger(item) && item >= 1 && item <= 4))]
    : [...DEFAULT_SETTINGS.variants];

  return {
    mode: isKnownMode(source.mode) ? source.mode : DEFAULT_SETTINGS.mode,
    ratio: RATIOS.includes(source.ratio) ? source.ratio : DEFAULT_SETTINGS.ratio,
    resolution: RESOLUTIONS.includes(source.resolution) ? source.resolution : DEFAULT_SETTINGS.resolution,
    variants,
    includeImages: source.includeImages === true,
    autoSave: source.autoSave !== false,
    imagePrompts: typeof source.imagePrompts === 'string' ? source.imagePrompts : DEFAULT_SETTINGS.imagePrompts,
    videoPrompts: typeof source.videoPrompts === 'string' ? source.videoPrompts : DEFAULT_SETTINGS.videoPrompts,
  };
}

function serialiseConfig() {
  return {
    ...state.config,
    variants: [...state.config.variants].sort((left, right) => left - right),
  };
}

function publicUpload(upload) {
  return {
    assetId: upload.assetId,
    name: upload.name,
    type: upload.type,
    size: upload.size,
    sha256: upload.sha256,
  };
}

function serialiseUploads() {
  return state.uploads.map(publicUpload);
}

function setText(element, text) {
  const value = String(text ?? '');
  if (element.textContent !== value) element.textContent = value;
}

function setValue(element, value) {
  if (element.value !== value) element.value = value;
}

function pluralise(count, noun) {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function countPrompts(value) {
  return parsePrompts(value).length;
}

function currentCounts() {
  return {
    image: countPrompts(state.config.imagePrompts),
    video: countPrompts(state.config.videoPrompts),
    uploads: state.uploads.length,
  };
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 1024) return `${Math.max(0, Number(value) || 0)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

function titleCase(value) {
  return String(value || 'pending')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, character => character.toUpperCase());
}

function currentValidation() {
  const base = validateConfig(serialiseConfig(), serialiseUploads());
  if (state.hashingCount === 0) return base;
  return {
    ...base,
    valid: false,
    errors: [...base.errors, `Wait for ${pluralise(state.hashingCount, 'image')} to finish local hashing.`],
  };
}

function immediatePairIssue(counts) {
  if (state.config.mode === MODES.PROMPT_VIDEO) {
    return (counts.image > 0 || counts.video > 0) && (counts.image !== counts.video || counts.image === 0);
  }
  if (state.config.mode === MODES.IMAGE_VIDEO) {
    return (counts.uploads > 0 || counts.video > 0) && (counts.uploads !== counts.video || counts.uploads === 0);
  }
  return false;
}

function modeOption(mode) {
  return MODE_OPTIONS.find(option => option.value === mode) || MODE_OPTIONS[0];
}

function populateModeOptions() {
  elements.modeSelect.replaceChildren(...MODE_OPTIONS.map(option => {
    const item = document.createElement('option');
    item.value = option.value;
    item.textContent = MODE_LABELS[option.value] || option.label;
    return item;
  }));
}

function selectPromptTab(name, shouldFocus = false) {
  const imageSelected = name !== 'video';
  state.activePromptTab = imageSelected ? 'image' : 'video';
  elements.imagePromptTab.setAttribute('aria-selected', String(imageSelected));
  elements.imagePromptTab.tabIndex = imageSelected ? 0 : -1;
  elements.videoPromptTab.setAttribute('aria-selected', String(!imageSelected));
  elements.videoPromptTab.tabIndex = imageSelected ? -1 : 0;
  elements.imagePromptPanel.hidden = !imageSelected;
  elements.videoPromptPanel.hidden = imageSelected;
  if (shouldFocus) (imageSelected ? elements.imagePromptTab : elements.videoPromptTab).focus();
}

function setPairStatus(element, message, tone) {
  setText(element, message);
  element.dataset.tone = tone;
}

function renderCounts(counts) {
  setText(elements.imageModeCount, pluralise(counts.image, 'prompt'));
  setText(elements.pipelineImageCount, String(counts.image));
  setText(elements.pipelineVideoCount, String(counts.video));
  setText(elements.uploadCount, pluralise(counts.uploads, 'image'));
  setText(elements.uploadVideoCount, pluralise(counts.video, 'prompt'));

  if (counts.image > 0 && counts.image === counts.video) {
    setText(elements.pipelinePairCount, pluralise(counts.image, 'pair'));
    setPairStatus(elements.pipelinePairStatus, `${pluralise(counts.image, 'prompt pair')} ready to run in order.`, 'success');
  } else if (counts.image === 0 && counts.video === 0) {
    setText(elements.pipelinePairCount, '0 pairs');
    setPairStatus(elements.pipelinePairStatus, 'Add one image prompt and one video prompt for each item.', 'neutral');
  } else {
    setText(elements.pipelinePairCount, 'Counts differ');
    setPairStatus(elements.pipelinePairStatus, `${pluralise(counts.image, 'image prompt')} · ${pluralise(counts.video, 'video prompt')} — counts must match.`, 'error');
  }

  if (counts.uploads > 0 && counts.uploads === counts.video) {
    setPairStatus(elements.uploadPairStatus, `${pluralise(counts.uploads, 'image')} matched to ${pluralise(counts.video, 'video prompt')} in filename order.`, 'success');
  } else if (counts.uploads === 0 && counts.video === 0) {
    setPairStatus(elements.uploadPairStatus, 'Upload images, then add one video prompt for each image.', 'neutral');
  } else {
    setPairStatus(elements.uploadPairStatus, `${pluralise(counts.uploads, 'image')} · ${pluralise(counts.video, 'video prompt')} — counts must match.`, 'error');
  }

  if (state.hashingCount > 0) {
    setText(elements.uploadHashStatus, `Hashing ${pluralise(state.hashingCount, 'image')} locally before it can run.`);
    elements.uploadHashStatus.hidden = false;
  } else {
    elements.uploadHashStatus.hidden = true;
    setText(elements.uploadHashStatus, '');
  }
}

function createSvg(path) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  const shape = document.createElementNS(namespace, 'path');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

function createUploadRow(upload, index) {
  const row = document.createElement('div');
  row.className = 'upload-row';

  if (upload.previewUrl) {
    const image = document.createElement('img');
    image.className = 'upload-thumb';
    image.src = upload.previewUrl;
    image.alt = '';
    row.append(image);
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'upload-thumb-placeholder';
    placeholder.setAttribute('aria-hidden', 'true');
    placeholder.textContent = 'IMG';
    row.append(placeholder);
  }

  const copy = document.createElement('div');
  copy.className = 'upload-copy';
  const label = document.createElement('strong');
  label.textContent = `Image ${index + 1} · ${upload.name}`;
  const meta = document.createElement('span');
  meta.textContent = `${formatBytes(upload.size)} · stored locally`;
  copy.append(label, meta);

  const remove = document.createElement('button');
  remove.className = 'icon-button';
  remove.type = 'button';
  remove.dataset.removeAsset = upload.assetId;
  remove.setAttribute('aria-label', `Remove Image ${index + 1}, ${upload.name}`);
  remove.title = 'Remove image';
  remove.append(createSvg('M6 6l12 12M18 6 6 18'));

  row.append(copy, remove);
  return row;
}

function renderUploads() {
  const key = [
    state.hashingCount,
    ...state.uploads.map(upload => `${upload.assetId}:${upload.name}:${upload.previewUrl || ''}`),
  ].join('|');
  if (key === state.uploadRenderKey) return;
  state.uploadRenderKey = key;
  elements.uploadList.replaceChildren();

  if (!state.uploads.length && !state.hashingCount) {
    const empty = document.createElement('p');
    empty.className = 'upload-empty';
    empty.textContent = 'No source images selected yet.';
    elements.uploadList.append(empty);
    return;
  }

  state.uploads.forEach((upload, index) => elements.uploadList.append(createUploadRow(upload, index)));
  if (state.hashingCount) {
    const pending = document.createElement('p');
    pending.className = 'upload-processing';
    pending.textContent = `Preparing ${pluralise(state.hashingCount, 'image')} locally…`;
    elements.uploadList.append(pending);
  }
}

function appendSummaryText(text) {
  elements.outputSummary.append(document.createTextNode(text));
}

function appendSummaryFolder(name) {
  const folder = document.createElement('strong');
  folder.textContent = name;
  elements.outputSummary.append(folder);
}

function renderOutputSummary(counts) {
  elements.outputSummary.replaceChildren();
  const mode = state.config.mode;
  const variants = state.config.variants.length;

  if (mode === MODES.IMAGE) {
    appendSummaryText('A local ZIP will contain ');
    appendSummaryFolder('images/');
    appendSummaryText(` with ${pluralise(counts.image, 'numbered image')}.`);
    return;
  }

  const sourceCount = mode === MODES.IMAGE_VIDEO ? counts.uploads : counts.image;
  appendSummaryText('A local ZIP will contain ');
  if (state.config.includeImages) {
    appendSummaryFolder('images/');
    appendSummaryText(' and ');
  }
  appendSummaryFolder('videos/');
  appendSummaryText(` with ${pluralise(sourceCount, 'numbered item')} × ${pluralise(variants, 'selected variant')}.`);
}

function renderValidation(validation, counts) {
  const missingVariants = state.config.mode !== MODES.IMAGE && state.config.variants.length === 0;
  const show = state.startAttempted || immediatePairIssue(counts) || state.hashingCount > 0 || missingVariants;
  elements.validationSummary.hidden = !show;
  elements.validationSummary.replaceChildren();
  if (show && validation.errors.length) {
    const list = document.createElement('ul');
    validation.errors.forEach(error => {
      const item = document.createElement('li');
      item.textContent = error;
      list.append(item);
    });
    elements.validationSummary.append(list);
  } else if (show && state.hashingCount > 0) {
    elements.validationSummary.textContent = 'Source files are still being hashed locally.';
  } else {
    elements.validationSummary.hidden = true;
  }

  const pipelineInvalid = state.startAttempted && state.config.mode === MODES.PROMPT_VIDEO
    && (counts.image === 0 || counts.video === 0 || counts.image !== counts.video);
  const uploadInvalid = state.startAttempted && state.config.mode === MODES.IMAGE_VIDEO
    && (counts.uploads === 0 || counts.video === 0 || counts.uploads !== counts.video);
  const imageInvalid = state.startAttempted && state.config.mode === MODES.IMAGE && counts.image === 0;
  elements.imagePrompts.setAttribute('aria-invalid', String(imageInvalid));
  elements.pipelineImagePrompts.setAttribute('aria-invalid', String(pipelineInvalid));
  elements.pipelineVideoPrompts.setAttribute('aria-invalid', String(pipelineInvalid));
  elements.uploadVideoPrompts.setAttribute('aria-invalid', String(uploadInvalid));
}

function statusPacket(value) {
  if (value && typeof value === 'object' && Object.hasOwn(value, 'session')) {
    return { session: value.session || null, alive: value.alive !== false };
  }
  return { session: value || null, alive: true };
}

function setSessionFromResponse(value, hydrate = false) {
  const packet = statusPacket(value);
  const changed = packet.session?.id !== state.session?.id;
  state.session = packet.session;
  state.engineAlive = packet.alive;
  if (state.session && (changed || hydrate)) {
    state.config = normaliseConfig({
      mode: state.session.mode,
      ...state.session.settings,
      imagePrompts: state.session.jobs.map(job => job.imagePrompt || '').filter(Boolean).join('\n\n'),
      videoPrompts: state.session.jobs.map(job => job.videoPrompt || '').filter(Boolean).join('\n\n'),
    });
  }
}

function statusName(status) {
  return STATUS_LABELS[status] || titleCase(status || 'ready');
}

function stageName(stage) {
  return STAGE_LABELS[stage] || (stage ? titleCase(stage) : 'Preparing your local run');
}

function jobDescription(job) {
  if (job.originalName) return job.originalName;
  if (job.imagePrompt) return job.imagePrompt.replace(/\s+/g, ' ').slice(0, 72);
  return 'Waiting for the next local step';
}

function renderJobs(session) {
  elements.jobProgressList.replaceChildren();
  const jobs = Array.isArray(session.jobs) ? session.jobs : [];
  jobs.forEach((job, listIndex) => {
    const item = document.createElement('li');
    item.className = 'job-progress-item';
    const copy = document.createElement('div');
    copy.className = 'job-progress-copy';
    const title = document.createElement('strong');
    title.textContent = `Image ${job.index || listIndex + 1}`;
    const detail = document.createElement('span');
    detail.textContent = jobDescription(job);
    copy.append(title, detail);
    const status = document.createElement('span');
    status.className = 'job-state';
    status.dataset.state = job.status || 'pending';
    status.textContent = titleCase(job.status || 'pending');
    item.append(copy, status);
    elements.jobProgressList.append(item);
  });
}

function runIsActive(session) {
  return ['running', 'waiting'].includes(session?.status);
}

function sessionCanResume(session) {
  if (!session || session.unsafeCheckpoint === true || session.resumeSafe === false) return false;
  return !session.generationComplete && ['paused', 'error'].includes(session.status);
}

function recoveryButton(label, type, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `run-control-button ${className}`.trim();
  button.dataset.runAction = type;
  button.textContent = label;
  button.disabled = state.actionPending;
  return button;
}

function renderRunControls(session) {
  elements.runRecoveryActions.replaceChildren();
  elements.stopExplanation.hidden = true;
  elements.completedRunActions.hidden = true;

  if (!session) return;
  if (runIsActive(session)) {
    elements.runRecoveryActions.append(
      recoveryButton('Pause after this item', 'run:pause'),
      recoveryButton('Stop', 'run:stop', 'stop-control'),
    );
    elements.stopExplanation.hidden = false;
    return;
  }
  if (['pausing', 'exporting'].includes(session.status)) {
    elements.runRecoveryActions.append(recoveryButton('Stop', 'run:stop', 'stop-control'));
    elements.stopExplanation.hidden = false;
    return;
  }

  if (sessionCanResume(session)) {
    elements.runRecoveryActions.append(recoveryButton('Resume', 'run:resume'));
  } else if (session.status === 'stopped') {
    const message = document.createElement('p');
    message.className = 'recovery-note';
    message.textContent = 'This stopped run will not submit further requests. Clear it when you are ready to start a new run.';
    elements.runRecoveryActions.append(message);
  }

  if (session.generationComplete && ['complete', 'ready-to-export', 'export-error', 'paused', 'error'].includes(session.status)) {
    elements.completedRunActions.hidden = false;
    elements.exportZipButton.disabled = state.actionPending || (session.mode !== MODES.IMAGE && state.config.variants.length === 0);
    elements.newRunButton.disabled = state.actionPending;
    elements.clearRunButton.disabled = state.actionPending;
  } else if (!['running', 'waiting', 'pausing', 'stopping', 'exporting'].includes(session.status)) {
    elements.runRecoveryActions.append(recoveryButton('Clear cached run', 'run:clear', 'quiet-control'));
  }
}

function renderSession() {
  const session = state.session;
  elements.runPanel.hidden = !session;
  if (!session) return;

  const status = session.status || 'ready';
  const jobs = Array.isArray(session.jobs) ? session.jobs : [];
  const complete = jobs.filter(job => ['complete', 'done'].includes(job.status)).length;
  setText(elements.runStatusLabel, statusName(status));
  setText(elements.runStatusBadge, statusName(status));
  elements.runStatusBadge.dataset.status = status;
  setText(elements.runMessage, session.message || 'Your workflow is kept locally and will continue if this sidebar is closed.');
  const completedZipName = status === 'complete' && typeof session.zipName === 'string' && session.zipName.trim()
    ? session.zipName.trim()
    : '';
  elements.runZipName.hidden = !completedZipName;
  setText(elements.runZipName, completedZipName ? `ZIP ready: ${completedZipName}` : '');
  setText(elements.runStage, stageName(session.stage));
  setText(elements.runProgress, jobs.length
    ? `${pluralise(complete, 'item')} complete of ${pluralise(jobs.length, 'item')}.`
    : 'Preparing the first item.');
  renderJobs(session);

  const metaTabId = session.meta?.tabId;
  const vibesTabId = session.vibes?.tabId;
  elements.focusMetaButton.hidden = !Number.isInteger(metaTabId);
  elements.focusVibesButton.hidden = !Number.isInteger(vibesTabId);
  elements.focusMetaButton.dataset.tabId = Number.isInteger(metaTabId) ? String(metaTabId) : '';
  elements.focusVibesButton.dataset.tabId = Number.isInteger(vibesTabId) ? String(vibesTabId) : '';
  renderRunControls(session);
}

function renderConnection() {
  if (!isExtension) {
    elements.previewBanner.hidden = false;
    elements.connectionState.dataset.state = 'offline';
    setText(elements.connectionStateText, 'Preview');
    return;
  }

  elements.previewBanner.hidden = true;
  if (state.initialising) {
    elements.connectionState.dataset.state = 'busy';
    setText(elements.connectionStateText, 'Loading local data');
  } else if (!state.engineAlive) {
    elements.connectionState.dataset.state = 'offline';
    setText(elements.connectionStateText, 'Check local run');
  } else if (state.session && runIsActive(state.session)) {
    elements.connectionState.dataset.state = 'busy';
    setText(elements.connectionStateText, 'Run active');
  } else {
    elements.connectionState.dataset.state = 'ready';
    setText(elements.connectionStateText, 'Local ready');
  }
}

function renderAction(validation) {
  const mode = state.config.mode;
  const label = mode === MODES.IMAGE ? 'Generate images' : 'Generate videos';
  setText(elements.generateLabel, label);

  let hint;
  if (state.initialising) {
    hint = 'Loading your saved local workspace…';
  } else if (state.session) {
    hint = 'Track files and save ZIPs in Downloads. Clear this run before a new batch.';
  } else if (state.starting) {
    hint = 'ZIP destination is being confirmed before automation starts.';
  } else if (state.hashingCount) {
    hint = 'Finish local source-image hashing before generating.';
  } else if (!validation.valid) {
    hint = validation.errors[0] || 'Complete the required fields to continue.';
  } else if (!isExtension) {
    hint = 'Preview only — install the ZIP in Chrome to generate.';
  } else {
    hint = 'Choose a ZIP location, then start the local workflow.';
  }
  setText(elements.actionHint, hint);
  elements.generateButton.disabled = setupIsLocked() || state.hashingCount > 0 || !validation.valid;
}

function syncInputs() {
  const { config } = state;
  setValue(elements.modeSelect, config.mode);
  setValue(elements.imagePrompts, config.imagePrompts);
  setValue(elements.pipelineImagePrompts, config.imagePrompts);
  setValue(elements.pipelineVideoPrompts, config.videoPrompts);
  setValue(elements.uploadVideoPrompts, config.videoPrompts);
  setValue(elements.ratioSelect, config.ratio);
  setValue(elements.pipelineRatioSelect, config.ratio);
  setValue(elements.resolutionSelect, config.resolution);

  elements.variantOptions.querySelectorAll('input[name="variant"]').forEach(input => {
    input.checked = config.variants.includes(Number(input.value));
  });
  const selectedZip = config.includeImages ? 'images-videos' : 'videos';
  elements.zipContents.querySelectorAll('input[name="zip-contents"]').forEach(input => {
    input.checked = input.value === selectedZip;
  });
}

function renderMode() {
  const mode = state.config.mode;
  const option = modeOption(mode);
  setText(elements.modeDescription, option.description);
  setText(elements.modeStatus, `${MODE_LABELS[mode] || option.label} active`);
  elements.imageModeFields.hidden = mode !== MODES.IMAGE;
  elements.pipelineModeFields.hidden = mode !== MODES.PROMPT_VIDEO;
  elements.uploadModeFields.hidden = mode !== MODES.IMAGE_VIDEO;
  elements.videoOptions.hidden = mode === MODES.IMAGE;
  selectPromptTab(state.activePromptTab);
}

function setupIsLocked() {
  return Boolean(state.session) || state.starting || state.actionPending || state.initialising;
}

function variantsAreLocked() {
  return state.starting || state.actionPending || state.initialising || Boolean(state.session
    && (!state.session.generationComplete || ['running', 'pausing', 'stopping', 'exporting'].includes(state.session.status)));
}

function renderSetupControls() {
  const locked = setupIsLocked();
  [
    elements.modeSelect,
    elements.imagePrompts,
    elements.pipelineImagePrompts,
    elements.pipelineVideoPrompts,
    elements.uploadVideoPrompts,
    elements.ratioSelect,
    elements.pipelineRatioSelect,
    elements.resolutionSelect,
    elements.imageUpload,
    elements.uploadDropZone,
  ].forEach(control => { control.disabled = locked; });
  elements.variantOptions.querySelectorAll('input[name="variant"]').forEach(input => { input.disabled = variantsAreLocked(); });
  elements.zipContents.querySelectorAll('input[name="zip-contents"]').forEach(input => { input.disabled = variantsAreLocked(); });
  elements.uploadList.querySelectorAll('button[data-remove-asset]').forEach(button => { button.disabled = locked; });
}

function render() {
  syncInputs();
  renderMode();
  const counts = currentCounts();
  const validation = currentValidation();
  renderCounts(counts);
  renderUploads();
  renderSetupControls();
  renderOutputSummary(counts);
  renderValidation(validation, counts);
  renderSession();
  renderConnection();
  renderAction(validation);
  manager.render({ session: state.session, mode: state.config.mode, variants: state.config.variants,
    includeImages: state.config.includeImages, locked: variantsAreLocked(), actionPending: state.actionPending, isExtension });
  elements.autoSaveSetting.checked = state.config.autoSave;
  elements.autoSaveSetting.disabled = setupIsLocked();
  elements.launcherSetting.checked = state.showLauncher;
  elements.launcherSetting.disabled = state.initialising;
  elements.resetSettings.disabled = setupIsLocked();
  elements.clearDraftImages.disabled = setupIsLocked() || state.hashingCount > 0 || !state.uploads.length;
  setText(elements.settingsOutputSummary, `Current defaults: ${state.config.ratio} images · ${state.config.resolution} video · Variants ${state.config.variants.join(', ') || 'none'}.`);
}

function setView(view, focus = false) {
  if (!['generate', 'downloads', 'settings'].includes(view)) return;
  const scroller = document.querySelector('.scroll-area');
  state.scrollPositions[state.view] = scroller.scrollTop;
  state.view = view;
  document.querySelectorAll('.workspace-nav [data-view]').forEach(button => {
    const active = button.dataset.view === view;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    requiredElement(`${button.dataset.view}-view`).hidden = !active;
    if (active && focus) button.focus();
  });
  scroller.scrollTop = state.scrollPositions[view] || 0;
}

function showAlert(message) {
  const text = message instanceof Error ? message.message : String(message || 'Something went wrong.');
  setText(elements.alertRegion, text);
  elements.alertRegion.hidden = false;
}

function clearAlert() {
  elements.alertRegion.hidden = true;
  setText(elements.alertRegion, '');
}

function scheduleDraftSave() {
  window.clearTimeout(state.draftTimer);
  state.draftTimer = window.setTimeout(() => {
    saveDraft().catch(error => showAlert(error));
  }, 280);
}

async function saveDraft() {
  await putLocal('drafts', DRAFT_KEY, {
    config: serialiseConfig(),
    uploads: serialiseUploads(),
    showLauncher: state.showLauncher,
  });
}

function revokePreview(upload) {
  if (upload?.previewUrl) URL.revokeObjectURL(upload.previewUrl);
}

function revokeAllPreviews() {
  state.uploads.forEach(revokePreview);
}

function localFilenameKey(name) {
  return String(name || '').normalize('NFKC').trim().toLocaleLowerCase();
}

function typeForFile(file) {
  const supplied = String(file.type || '').trim().toLowerCase();
  if (supplied === 'image/jpg') return 'image/jpeg';
  if (ACCEPTED_TYPES.has(supplied)) return supplied;
  const extension = String(file.name || '').match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (extension === 'png') return 'image/png';
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'webp') return 'image/webp';
  return null;
}

function fileForStorage(file, type) {
  if (file.type === type) return file;
  return new File([file], file.name, { type, lastModified: file.lastModified });
}

function generateId(prefix) {
  if (typeof crypto.randomUUID === 'function') return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

async function hashFile(file) {
  if (!crypto.subtle) throw new Error('This browser cannot calculate the required local SHA-256 file identity.');
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function sortUploads(uploads) {
  try {
    return sortImages(uploads);
  } catch (error) {
    showAlert(error);
    return uploads;
  }
}

function validateIncomingFiles(files) {
  const existingNames = new Set([
    ...state.uploads.map(upload => localFilenameKey(upload.name)),
    ...state.pendingNames,
  ]);
  const accepted = [];
  const errors = [];

  files.forEach(file => {
    const name = localFilenameKey(file.name);
    const type = typeForFile(file);
    if (!name) {
      errors.push('A selected image has no filename.');
    } else if (!type) {
      errors.push(`${file.name || 'This file'} is not a PNG, JPG, or WebP image.`);
    } else if (!Number.isFinite(file.size) || file.size === 0) {
      errors.push(`${file.name} is empty and cannot be used.`);
    } else if (file.size > MAX_IMAGE_BYTES) {
      errors.push(`${file.name} is larger than 10 MiB.`);
    } else if (existingNames.has(name)) {
      errors.push(`${file.name} has the same name as an image already selected.`);
    } else {
      existingNames.add(name);
      state.pendingNames.add(name);
      accepted.push({ file: fileForStorage(file, type), type, name });
    }
  });

  return { accepted, errors };
}

function queueUploads(fileList) {
  if (setupIsLocked()) return;
  if (setupIsLocked()) return;
  const files = Array.from(fileList || []);
  if (!files.length) return;
  const { accepted, errors } = validateIncomingFiles(files);
  if (errors.length) showAlert(errors.join(' '));
  if (!accepted.length) return;

  state.hashingCount += accepted.length;
  render();
  const work = async () => {
    const added = [];
    const failures = [];
    for (const candidate of accepted) {
      try {
        const sha256 = await hashFile(candidate.file);
        const assetId = generateId('asset');
        const record = {
          blob: candidate.file,
          name: candidate.file.name,
          type: candidate.type,
          size: candidate.file.size,
          sha256,
          originalName: candidate.file.name,
        };
        await putLocal('assets', assetId, record);
        let previewUrl = '';
        try {
          previewUrl = URL.createObjectURL(candidate.file);
        } catch {
          // The compact list still works without a thumbnail URL.
        }
        added.push({
          assetId,
          name: candidate.file.name,
          type: candidate.type,
          size: candidate.file.size,
          sha256,
          previewUrl,
        });
      } catch (error) {
        failures.push(`${candidate.file.name}: ${error.message || 'could not be stored locally.'}`);
      }
    }
    if (added.length) {
      state.uploads = sortUploads([...state.uploads, ...added]);
      state.uploadRenderKey = null;
      scheduleDraftSave();
    }
    if (failures.length) showAlert(failures.join(' '));
  };

  const operation = state.uploadQueue.then(work, work);
  state.uploadQueue = operation.catch(() => {});
  operation.finally(() => {
    accepted.forEach(candidate => state.pendingNames.delete(candidate.name));
    state.hashingCount = Math.max(0, state.hashingCount - accepted.length);
    state.uploadRenderKey = null;
    render();
  }).catch(error => showAlert(error));
}

async function removeUpload(assetId) {
  if (setupIsLocked()) return;
  if (setupIsLocked()) return;
  const upload = state.uploads.find(item => item.assetId === assetId);
  if (!upload) return;
  state.uploads = state.uploads.filter(item => item.assetId !== assetId);
  revokePreview(upload);
  state.uploadRenderKey = null;
  scheduleDraftSave();
  render();
  try {
    await removeLocal('assets', assetId);
  } catch (error) {
    showAlert(error);
  }
}

function suggestedZipName() {
  const date = new Date().toISOString().slice(0, 10);
  const mode = state.config.mode === MODES.IMAGE ? 'images' : 'videos';
  return `mete-run-${date}-${mode}.zip`;
}

function pickerOptions(name) {
  const suggestedName = String(name || suggestedZipName()).endsWith('.zip') ? name || suggestedZipName() : `${name}.zip`;
  return {
    suggestedName,
    types: [{
      description: 'ZIP archive',
      accept: { 'application/zip': ['.zip'] },
    }],
  };
}

function pickerError(error) {
  if (error?.name === 'AbortError') return;
  if (error?.name === 'SecurityError' || typeof window.showSaveFilePicker !== 'function') {
    showAlert('Choose the ZIP location from the installed native Chrome sidebar. This preview or page cannot start automation without a file handle.');
    return;
  }
  showAlert(error?.message || 'A ZIP save location could not be selected.');
}

function applyRunResponse(response) {
  if (response !== undefined) setSessionFromResponse(response);
  render();
}

function startGeneration() {
  if (setupIsLocked()) return;
  const validation = currentValidation();
  state.startAttempted = true;
  render();
  if (!validation.valid) return;

  if (!isExtension) {
    showAlert('UI preview cannot generate. Install the Mete Run ZIP in Chrome and open the native sidebar to automate Meta AI and Vibes AI.');
    return;
  }
  if (typeof window.showSaveFilePicker !== 'function') {
    pickerError(new DOMException('File System Access is unavailable.', 'SecurityError'));
    return;
  }

  const config = serialiseConfig();
  const uploads = serialiseUploads();
  let picker;
  try {
    // This invocation stays directly in the CTA gesture, before any asynchronous work.
    picker = window.showSaveFilePicker(pickerOptions(suggestedZipName()));
  } catch (error) {
    pickerError(error);
    return;
  }

  state.starting = true;
  render();
  finishStarting(picker, config, uploads);
}

async function finishStarting(picker, config, uploads) {
  let handleId;
  try {
    const handle = await picker;
    if (!handle) throw new Error('No ZIP save location was selected.');
    handleId = generateId('zip');
    await putLocal('handles', handleId, handle);
    const response = await call('run:start', { config, uploads, handleId, zipName: handle.name });
    state.startAttempted = false;
    applyRunResponse(response);
  } catch (error) {
    await discardUnusedHandle(handleId);
    pickerError(error);
  } finally {
    state.starting = false;
    render();
  }
}

function exportZipAgain() {
  const session = state.session;
  if (!session?.generationComplete || !isExtension || state.actionPending || variantsAreLocked()) return;
  const variants = [...state.config.variants];
  const includeImages = state.config.includeImages;
  if (session.mode !== MODES.IMAGE && variants.length === 0) return;
  if (typeof window.showSaveFilePicker !== 'function') {
    pickerError(new DOMException('File System Access is unavailable.', 'SecurityError'));
    return;
  }

  let picker;
  try {
    // Pick synchronously from this direct button gesture before requesting the export.
    picker = window.showSaveFilePicker(pickerOptions(session.zipName || suggestedZipName()));
  } catch (error) {
    pickerError(error);
    return;
  }

  state.actionPending = true;
  render();
  finishExport(picker, variants, includeImages);
}

async function discardUnusedHandle(handleId) {
  if (!handleId) return;
  try {
    if ((await getLocal('runs', 'current'))?.handleId !== handleId) await removeLocal('handles', handleId);
  } catch { /* Keep a handle rather than deleting a destination that an active run may still need. */ }
}

async function finishExport(picker, variants, includeImages) {
  let handleId;
  try {
    const handle = await picker;
    if (!handle) throw new Error('No ZIP save location was selected.');
    handleId = generateId('zip');
    await putLocal('handles', handleId, handle);
    const response = await call('run:export', { handleId, variants, includeImages, zipName: handle.name });
    applyRunResponse(response);
  } catch (error) {
    await discardUnusedHandle(handleId);
    pickerError(error);
  } finally {
    state.actionPending = false;
    render();
  }
}

async function saveSelectedZip() {
  if (!isExtension || !state.session?.generationComplete || variantsAreLocked()
    || (state.session.mode !== MODES.IMAGE && !state.config.variants.length)) return;
  state.actionPending = true;
  clearAlert();
  render();
  try {
    applyRunResponse(await call('run:export', { variants: [...state.config.variants], includeImages: state.config.includeImages }));
  } catch (error) {
    showAlert(error);
  } finally {
    state.actionPending = false;
    render();
  }
}

async function performRunAction(type) {
  if (!isExtension || state.actionPending) return;
  if (type === 'run:clear') {
    const hasUnexportedResults = !state.session?.exportedAt;
    const warning = hasUnexportedResults
      ? 'Clear this cached run? Locally saved media that has not been exported will be deleted.'
      : 'Clear this cached run and remove its saved local results?';
    if (!window.confirm(warning)) return;
  }

  state.actionPending = true;
  render();
  try {
    const response = await call(type);
    applyRunResponse(response);
  } catch (error) {
    showAlert(error);
  } finally {
    state.actionPending = false;
    render();
  }
}

async function clearForNewRun() {
  if (!isExtension || state.actionPending) return;
  const hasUnexportedResults = !state.session?.exportedAt;
  const warning = hasUnexportedResults
    ? 'Start a new run? Locally saved media that has not been exported will be deleted.'
    : 'Start a new run? This clears the cached run and resets the current local setup.';
  if (!window.confirm(warning)) return;

  state.actionPending = true;
  render();
  try {
    await call('run:clear');
    const uploads = [...state.uploads];
    state.uploads = [];
    uploads.forEach(revokePreview);
    state.uploadRenderKey = null;
    await Promise.all(uploads.map(upload => removeLocal('assets', upload.assetId).catch(() => {})));
    await removeLocal('drafts', DRAFT_KEY);
    state.config = cloneDefaults();
    state.startAttempted = false;
    state.session = null;
  } catch (error) {
    showAlert(error);
  } finally {
    state.actionPending = false;
    render();
  }
}

async function focusProviderTab(button) {
  const tabId = Number(button.dataset.tabId);
  if (!Number.isInteger(tabId) || !isExtension) return;
  try {
    await call('tab:focus', { tabId, provider: button === elements.focusMetaButton ? 'meta' : 'vibes' });
  } catch (error) {
    showAlert(error);
  }
}

function setMode(mode) {
  if (setupIsLocked()) return;
  if (!isKnownMode(mode) || state.config.mode === mode) return;
  state.config.mode = mode;
  state.startAttempted = false;
  scheduleDraftSave();
  render();
}

function updateVariants() {
  if (variantsAreLocked()) return;
  setVariants([...elements.variantOptions.querySelectorAll('input[name="variant"]:checked')].map(input => Number(input.value)));
}

function setVariants(variants) {
  if (variantsAreLocked()) return;
  state.config.variants = variants.filter(value => Number.isInteger(value) && value >= 1 && value <= 4).sort((left, right) => left - right);
  scheduleDraftSave();
  render();
}

function updateZipContents() {
  if (variantsAreLocked()) return;
  const selected = elements.zipContents.querySelector('input[name="zip-contents"]:checked');
  setIncludeImages(selected?.value === 'images-videos');
}

function setIncludeImages(include) {
  if (variantsAreLocked()) return;
  state.config.includeImages = include;
  scheduleDraftSave();
  render();
}

async function changeLauncher() {
  const previous = state.showLauncher;
  state.showLauncher = elements.launcherSetting.checked;
  try {
    if (isExtension) await chrome.storage.local.set({ showLauncher: state.showLauncher });
    scheduleDraftSave();
    setText(elements.settingsNotice, 'Sidebar preference saved locally.');
  } catch (error) {
    state.showLauncher = previous;
    showAlert(error);
  }
  render();
}

function resetOutputSettings() {
  if (setupIsLocked()) return;
  state.config = { ...cloneDefaults(), mode: state.config.mode,
    imagePrompts: state.config.imagePrompts, videoPrompts: state.config.videoPrompts };
  scheduleDraftSave();
  setText(elements.settingsNotice, 'Output defaults restored. Your prompts and source images were kept.');
  render();
}

async function clearDraftImages() {
  if (setupIsLocked() || state.hashingCount || !state.uploads.length) return;
  if (!window.confirm('Remove all uploaded draft images from this extension? Your prompts will be kept.')) return;
  state.actionPending = true;
  window.clearTimeout(state.draftTimer);
  const uploads = state.uploads;
  state.uploads = [];
  uploads.forEach(revokePreview);
  state.uploadRenderKey = null;
  render();
  try {
    await saveDraft();
    await Promise.all(uploads.map(upload => removeLocal('assets', upload.assetId)));
    setText(elements.settingsNotice, 'Uploaded draft images cleared. Your prompts were kept.');
  } catch (error) {
    showAlert(error);
  } finally {
    state.actionPending = false;
    render();
  }
}

function bindEvents() {
  const workspaceTabs = [...document.querySelectorAll('.workspace-nav [data-view]')];
  workspaceTabs.forEach((button, index) => {
    button.addEventListener('click', () => setView(button.dataset.view));
    button.addEventListener('keydown', event => {
      const next = event.key === 'ArrowRight' ? (index + 1) % workspaceTabs.length
        : event.key === 'ArrowLeft' ? (index + workspaceTabs.length - 1) % workspaceTabs.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? workspaceTabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      setView(workspaceTabs[next].dataset.view, true);
    });
  });
  elements.autoSaveSetting.addEventListener('change', () => {
    if (setupIsLocked()) return;
    state.config.autoSave = elements.autoSaveSetting.checked;
    setText(elements.settingsNotice, state.config.autoSave ? 'Completed runs will save the ZIP automatically.' : 'Completed media will wait in Download Manager until you Save ZIP.');
    scheduleDraftSave();
    render();
  });
  elements.launcherSetting.addEventListener('change', changeLauncher);
  elements.resetSettings.addEventListener('click', resetOutputSettings);
  elements.clearDraftImages.addEventListener('click', clearDraftImages);
  elements.modeSelect.addEventListener('change', event => setMode(event.target.value));
  elements.imagePrompts.addEventListener('input', event => {
    state.config.imagePrompts = event.target.value;
    scheduleDraftSave();
    render();
  });
  elements.pipelineImagePrompts.addEventListener('input', event => {
    state.config.imagePrompts = event.target.value;
    scheduleDraftSave();
    render();
  });
  elements.pipelineVideoPrompts.addEventListener('input', event => {
    state.config.videoPrompts = event.target.value;
    scheduleDraftSave();
    render();
  });
  elements.uploadVideoPrompts.addEventListener('input', event => {
    state.config.videoPrompts = event.target.value;
    scheduleDraftSave();
    render();
  });
  elements.ratioSelect.addEventListener('change', event => {
    state.config.ratio = event.target.value;
    scheduleDraftSave();
    render();
  });
  elements.pipelineRatioSelect.addEventListener('change', event => {
    state.config.ratio = event.target.value;
    scheduleDraftSave();
    render();
  });
  elements.resolutionSelect.addEventListener('change', event => {
    state.config.resolution = event.target.value;
    scheduleDraftSave();
    render();
  });
  elements.variantOptions.addEventListener('change', updateVariants);
  elements.zipContents.addEventListener('change', updateZipContents);

  elements.imagePromptTab.addEventListener('click', () => selectPromptTab('image'));
  elements.videoPromptTab.addEventListener('click', () => selectPromptTab('video'));
  [elements.imagePromptTab, elements.videoPromptTab].forEach(tab => {
    tab.addEventListener('keydown', event => {
      const tabs = [elements.imagePromptTab, elements.videoPromptTab];
      const index = tabs.indexOf(event.currentTarget);
      let nextIndex;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') nextIndex = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') nextIndex = (index - 1 + tabs.length) % tabs.length;
      if (event.key === 'Home') nextIndex = 0;
      if (event.key === 'End') nextIndex = tabs.length - 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      selectPromptTab(nextIndex === 0 ? 'image' : 'video', true);
    });
  });

  elements.imageUpload.addEventListener('change', event => {
    queueUploads(event.target.files);
    event.target.value = '';
  });
  elements.uploadDropZone.addEventListener('click', () => {
    elements.imageUpload.click();
  });
  ['dragenter', 'dragover'].forEach(type => elements.uploadDropZone.addEventListener(type, event => {
    event.preventDefault();
    elements.uploadDropZone.classList.add('dragging');
  }));
  ['dragleave', 'dragend'].forEach(type => elements.uploadDropZone.addEventListener(type, event => {
    event.preventDefault();
    elements.uploadDropZone.classList.remove('dragging');
  }));
  elements.uploadDropZone.addEventListener('drop', event => {
    event.preventDefault();
    elements.uploadDropZone.classList.remove('dragging');
    queueUploads(event.dataTransfer?.files);
  });
  elements.uploadList.addEventListener('click', event => {
    const button = event.target.closest('button[data-remove-asset]');
    if (button) removeUpload(button.dataset.removeAsset);
  });

  elements.generateButton.addEventListener('click', startGeneration);
  elements.exportZipButton.addEventListener('click', exportZipAgain);
  elements.newRunButton.addEventListener('click', clearForNewRun);
  elements.clearRunButton.addEventListener('click', () => performRunAction('run:clear'));
  elements.runRecoveryActions.addEventListener('click', event => {
    const button = event.target.closest('button[data-run-action]');
    if (button) performRunAction(button.dataset.runAction);
  });
  elements.focusMetaButton.addEventListener('click', () => focusProviderTab(elements.focusMetaButton));
  elements.focusVibesButton.addEventListener('click', () => focusProviderTab(elements.focusVibesButton));

  window.addEventListener('unhandledrejection', event => {
    showAlert(event.reason instanceof Error ? event.reason : 'An unexpected local panel error occurred.');
  });
  window.addEventListener('error', event => {
    if (event.error) showAlert(event.error);
  });
  window.addEventListener('pagehide', () => {
    window.clearTimeout(state.draftTimer);
    saveDraft().catch(() => {});
    revokeAllPreviews();
  });
}

async function restoreDraft() {
  try {
    const draft = await getLocal('drafts', DRAFT_KEY);
    if (!draft || typeof draft !== 'object') return;
    state.config = normaliseConfig(draft.config);
    state.showLauncher = draft.showLauncher !== false;
    const storedUploads = Array.isArray(draft.uploads) ? draft.uploads : [];
    const restored = [];
    let unavailable = 0;

    for (const candidate of storedUploads) {
      if (!candidate || typeof candidate.assetId !== 'string') {
        unavailable += 1;
        continue;
      }
      const asset = await getLocal('assets', candidate.assetId);
      const blob = asset?.blob;
      if (!blob || typeof blob.arrayBuffer !== 'function' || !Number.isFinite(blob.size)) {
        unavailable += 1;
        continue;
      }
      const name = typeof candidate.name === 'string' ? candidate.name : asset.name;
      const type = typeof candidate.type === 'string' ? candidate.type : asset.type;
      const size = Number.isSafeInteger(candidate.size) ? candidate.size : asset.size;
      const sha256 = typeof candidate.sha256 === 'string' ? candidate.sha256 : asset.sha256;
      if (!name || !ACCEPTED_TYPES.has(type) || !Number.isSafeInteger(size) || !sha256) {
        unavailable += 1;
        continue;
      }
      let previewUrl = '';
      try {
        previewUrl = URL.createObjectURL(blob);
      } catch {
        // The original asset remains usable even when the browser cannot make a preview URL.
      }
      restored.push({ assetId: candidate.assetId, name, type, size, sha256, previewUrl });
    }

    state.uploads = sortUploads(restored);
    state.uploadRenderKey = null;
    if (unavailable) {
      showAlert(`${pluralise(unavailable, 'saved source image')} could not be restored. Upload it again before generating.`);
      scheduleDraftSave();
    }
  } catch (error) {
    showAlert(error);
  } finally {
    render();
  }
}

async function loadCurrentStatus() {
  if (!isExtension) return;
  try {
    const response = await call('status:get');
    setSessionFromResponse(response, true);
  } catch (error) {
    state.engineAlive = false;
    showAlert(error);
  } finally {
    render();
  }
}

function listenForStatus() {
  if (!isExtension || !chrome.storage?.onChanged) return;
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.showLauncher) {
      state.showLauncher = changes.showLauncher.newValue !== false;
      render();
    }
    const change = changes[STATUS_STORAGE_KEY] || changes.session;
    if (!change) return;
    setSessionFromResponse(change.newValue);
    render();
  });
}

async function initialise() {
  state.initialising = true;
  populateModeOptions();
  bindEvents();
  listenForStatus();
  clearAlert();
  render();
  await restoreDraft();
  if (isExtension) {
    try { state.showLauncher = (await chrome.storage.local.get('showLauncher')).showLauncher !== false; }
    catch (error) { showAlert(error); }
  }
  await loadCurrentStatus();
  state.initialising = false;
  render();
}

initialise();
