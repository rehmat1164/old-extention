export const MODES = Object.freeze({
  IMAGE: 'image',
  IMAGE_VIDEO: 'image-video',
  PROMPT_VIDEO: 'prompt-video',
});

export const MODE_OPTIONS = Object.freeze([
  Object.freeze({
    value: MODES.IMAGE,
    label: 'Image',
    description: 'Generate one image for each prompt.',
  }),
  Object.freeze({
    value: MODES.IMAGE_VIDEO,
    label: 'Image to video',
    description: 'Turn uploaded images into videos.',
  }),
  Object.freeze({
    value: MODES.PROMPT_VIDEO,
    label: 'Prompt to image to video',
    description: 'Generate images from prompts, then turn them into videos.',
  }),
]);

export const RATIOS = Object.freeze(['1:1', '16:9', '9:16', '4:3', '3:4']);
export const RESOLUTIONS = Object.freeze(['480p', '720p', '1080p']);

export const DEFAULT_SETTINGS = Object.freeze({
  mode: MODES.IMAGE,
  ratio: '9:16',
  resolution: '720p',
  variants: Object.freeze([1]),
  includeImages: false,
  autoSave: true,
  imagePrompts: '',
  videoPrompts: '',
});

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const MIME_EXTENSIONS = new Map([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/webp', 'webp'],
  ['video/mp4', 'mp4'],
]);
const MODE_VALUES = new Set(Object.values(MODES));
const MAX_VARIANT = 4;

export class ConfigValidationError extends Error {
  constructor(errors) {
    super(errors.join(' '));
    this.name = 'ConfigValidationError';
    this.errors = [...errors];
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configValue(config, key) {
  return config[key] === undefined ? DEFAULT_SETTINGS[key] : config[key];
}

function normaliseMime(type) {
  const mime = typeof type === 'string' ? type.trim().toLowerCase() : '';
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

function normaliseFilename(name) {
  return String(name).normalize('NFKC').trim().toLowerCase();
}

function promptText(value, label, errors) {
  if (typeof value !== 'string') {
    errors.push(`${label} must be text.`);
    return [];
  }
  return parsePrompts(value);
}

function compareText(left, right) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareNumberTokens(left, right) {
  const leftDigits = left.replace(/^0+(?=\d)/, '');
  const rightDigits = right.replace(/^0+(?=\d)/, '');
  if (leftDigits.length !== rightDigits.length) {
    return leftDigits.length - rightDigits.length;
  }
  const valueOrder = compareText(leftDigits, rightDigits);
  return valueOrder || left.length - right.length;
}

function filenameTokens(name) {
  const stem = normaliseFilename(name).replace(/\.[^./\\]+$/, '');
  return stem.match(/\d+|[^\d\W_]+/gu) || [];
}

function compareNaturalFilename(left, right) {
  const leftTokens = filenameTokens(left);
  const rightTokens = filenameTokens(right);
  const length = Math.min(leftTokens.length, rightTokens.length);

  for (let index = 0; index < length; index += 1) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];
    const leftNumber = /^\d+$/.test(leftToken);
    const rightNumber = /^\d+$/.test(rightToken);
    let order;

    if (leftNumber && rightNumber) {
      order = compareNumberTokens(leftToken, rightToken);
    } else if (leftNumber !== rightNumber) {
      order = leftNumber ? -1 : 1;
    } else {
      order = compareText(leftToken, rightToken);
    }
    if (order) return order;
  }

  return leftTokens.length - rightTokens.length || compareText(normaliseFilename(left), normaliseFilename(right));
}

function duplicateUploadErrors(uploads, errors) {
  const assetIds = new Set();
  const names = new Set();

  uploads.forEach((upload, index) => {
    if (!isPlainObject(upload)) return;
    if (typeof upload.assetId === 'string' && upload.assetId.trim()) {
      const assetId = upload.assetId.trim();
      if (assetIds.has(assetId)) {
        errors.push(`Upload ${index + 1} duplicates an asset ID.`);
      }
      assetIds.add(assetId);
    }
    if (typeof upload.name === 'string' && upload.name.trim()) {
      const name = normaliseFilename(upload.name);
      if (names.has(name)) {
        errors.push(`Upload ${index + 1} has a duplicate filename.`);
      }
      names.add(name);
    }
  });
}

function validateUploads(uploads, errors) {
  uploads.forEach((upload, index) => {
    const label = `Upload ${index + 1}`;
    if (!isPlainObject(upload)) {
      errors.push(`${label} must be an image asset.`);
      return;
    }
    if (typeof upload.assetId !== 'string' || !upload.assetId.trim()) {
      errors.push(`${label} is missing an asset ID.`);
    }
    if (typeof upload.name !== 'string' || !upload.name.trim()) {
      errors.push(`${label} is missing a filename.`);
    }
    if (!IMAGE_MIME_TYPES.has(normaliseMime(upload.type))) {
      errors.push(`${label} must be a PNG, JPG, or WebP image.`);
    }
    if (!Number.isSafeInteger(upload.size) || upload.size < 0 || upload.size > MAX_IMAGE_BYTES) {
      errors.push(`${label} must be an image no larger than 10 MiB.`);
    }
  });
  duplicateUploadErrors(uploads, errors);
}

function selectedVariants(value, errors) {
  if (!Array.isArray(value)) {
    errors.push('Video variants must be an array.');
    return [];
  }

  const variants = [];
  const seen = new Set();
  value.forEach((variant) => {
    if (!Number.isInteger(variant) || variant < 1 || variant > MAX_VARIANT) {
      errors.push('Video variants must be whole numbers from 1 to 4.');
      return;
    }
    if (seen.has(variant)) {
      errors.push(`Video variant ${variant} is selected more than once.`);
      return;
    }
    seen.add(variant);
    variants.push(variant);
  });
  return variants;
}

function uploadDescriptor(upload) {
  return {
    assetId: upload.assetId,
    name: upload.name,
    type: normaliseMime(upload.type),
    size: upload.size,
    sha256: upload.sha256 ?? null,
  };
}

function runPrefix(runId) {
  const prefix = String(runId ?? '')
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toLowerCase()
    .slice(0, 32);
  return prefix || 'run';
}

function extensionFromName(name) {
  if (typeof name !== 'string') return '';
  const match = /\.([a-zA-Z0-9]+)$/.exec(name.trim());
  if (!match) return '';
  const extension = match[1].toLowerCase();
  if (extension === 'jpeg') return 'jpg';
  return ['png', 'jpg', 'webp'].includes(extension) ? extension : '';
}

function imageExtension(image, originalName) {
  const type = normaliseMime(image?.type);
  if (type && !IMAGE_MIME_TYPES.has(type)) return '';
  const extension = MIME_EXTENSIONS.get(type);
  return extension || extensionFromName(image?.name) || extensionFromName(originalName);
}

function assetIdOf(asset) {
  return typeof asset?.assetId === 'string' && asset.assetId.trim() ? asset.assetId : null;
}

function paddedIndex(index) {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new RangeError('Asset index must be a positive whole number.');
  }
  return String(index).padStart(3, '0');
}

function assertSession(session) {
  if (!isPlainObject(session) || !MODE_VALUES.has(session.mode) || !Array.isArray(session.jobs)) {
    throw new TypeError('A Mete Run session with jobs is required.');
  }
}

function orderedJobs(session) {
  const jobs = [...session.jobs];
  const seen = new Set();
  jobs.forEach((job) => {
    if (!isPlainObject(job) || !Number.isSafeInteger(job.index) || job.index < 1 || seen.has(job.index)) {
      throw new Error('Session jobs must have unique positive indexes.');
    }
    seen.add(job.index);
  });
  return jobs.sort((left, right) => left.index - right.index);
}

function strictSessionVariants(session) {
  const variants = session.settings?.variants;
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error('A video session needs at least one selected variant.');
  }
  const seen = new Set();
  variants.forEach((variant) => {
    if (!Number.isInteger(variant) || variant < 1 || variant > MAX_VARIANT || seen.has(variant)) {
      throw new Error('Session video variants must be unique whole numbers from 1 to 4.');
    }
    seen.add(variant);
  });
  return [...variants];
}

function selectedVariantForJob(job, variant) {
  const matches = Array.isArray(job.variants)
    ? job.variants.filter((candidate) => candidate && candidate.variant === variant)
    : [];
  if (matches.length !== 1 || assetIdOf(matches[0]) === null) {
    throw new Error(`Job ${job.index} is missing selected video variant ${variant}.`);
  }
  if (normaliseMime(matches[0].type) !== 'video/mp4') {
    throw new Error(`Job ${job.index} video variant ${variant} is not an MP4 asset.`);
  }
  return matches[0];
}

function plannedImage(job) {
  const assetId = assetIdOf(job.image);
  const extension = imageExtension(job.image, job.originalName);
  if (assetId === null || !extension) {
    throw new Error(`Job ${job.index} is missing a complete image asset.`);
  }
  return {
    assetId,
    path: `images/image_${paddedIndex(job.index)}.${extension}`,
  };
}

function manifestAssetId(value) {
  if (typeof value === 'string' && /^(?:data:|https?:\/\/)/i.test(value.trim())) return null;
  return value ?? null;
}

function manifestHash(value) {
  if (typeof value === 'string' && /^(?:data:|https?:\/\/)/i.test(value.trim())) return null;
  return value ?? null;
}

function safeServiceUrl(value, serviceHost) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const allowed = host === serviceHost || host === `www.${serviceHost}` || host.endsWith(`.${serviceHost}`);
    if (url.protocol !== 'https:' || !allowed) return null;
    return `${url.origin}${url.pathname}`;
  } catch {
    return null;
  }
}

function serviceUrl(session, service, host) {
  const state = session[service];
  const candidates = [
    session[`${service}Url`],
    state?.chatUrl,
    state?.projectUrl,
    state?.url,
  ];
  for (const candidate of candidates) {
    const valid = safeServiceUrl(candidate, host);
    if (valid) return valid;
  }
  return null;
}

function manifestVariants(job, selected) {
  const multiple = selected.length > 1;
  return (Array.isArray(job.variants) ? job.variants : [])
    .filter((variant) => isPlainObject(variant) && Number.isInteger(variant.variant))
    .sort((left, right) => left.variant - right.variant)
    .map((variant) => {
      const isSelected = selected.includes(variant.variant);
      return {
        variant: variant.variant,
        assetId: manifestAssetId(variant.assetId),
        type: normaliseMime(variant.type) || null,
        sha256: manifestHash(variant.sha256),
        filename: isSelected
          ? `videos/video_${paddedIndex(job.index)}${multiple ? `_variant_${variant.variant}` : ''}.mp4`
          : null,
      };
    });
}

function manifestSelectedVariants(session) {
  const values = session.settings?.variants;
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  return values.filter((variant) => {
    if (!Number.isInteger(variant) || variant < 1 || variant > MAX_VARIANT || seen.has(variant)) return false;
    seen.add(variant);
    return true;
  });
}

function makeRunId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID();
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Split textarea content only where a genuinely blank line separates prompts. */
export function parsePrompts(text) {
  if (text === undefined || text === null || text === '') return [];
  const normalized = String(text).replace(/\r\n?|[\u2028\u2029]/g, '\n');
  return normalized
    .split(/\n[^\S\r\n]*\n(?:[^\S\r\n]*\n)*/)
    .map((prompt) => prompt.trim())
    .filter(Boolean);
}

/** Sort source images by filename rather than by asynchronous upload completion. */
export function sortImages(uploads = []) {
  if (!Array.isArray(uploads)) throw new TypeError('Uploads must be an array.');

  const names = new Set();
  const assetIds = new Set();
  uploads.forEach((upload, index) => {
    if (!isPlainObject(upload) || typeof upload.name !== 'string' || typeof upload.assetId !== 'string') {
      throw new TypeError(`Upload ${index + 1} needs an asset ID and filename.`);
    }
    const name = normaliseFilename(upload.name);
    const assetId = upload.assetId.trim();
    if (!name || !assetId) throw new TypeError(`Upload ${index + 1} needs an asset ID and filename.`);
    if (names.has(name)) throw new Error(`Duplicate upload filename: ${upload.name}`);
    if (assetIds.has(assetId)) throw new Error(`Duplicate upload asset ID: ${assetId}`);
    names.add(name);
    assetIds.add(assetId);
  });

  return [...uploads].sort((left, right) => {
    const filenameOrder = compareNaturalFilename(left.name, right.name);
    if (filenameOrder) return filenameOrder;
    return compareText(left.assetId.trim(), right.assetId.trim())
      || compareText(String(left.sha256 ?? ''), String(right.sha256 ?? ''))
      || compareText(normaliseMime(left.type), normaliseMime(right.type))
      || Number(left.size ?? 0) - Number(right.size ?? 0);
  });
}

export function validateConfig(config = {}, uploads = []) {
  const errors = [];
  const source = isPlainObject(config) ? config : {};
  if (!isPlainObject(config)) errors.push('Configuration must be an object.');

  const mode = configValue(source, 'mode');
  const ratio = configValue(source, 'ratio');
  const resolution = configValue(source, 'resolution');
  const variants = selectedVariants(configValue(source, 'variants'), errors);
  const includeImages = configValue(source, 'includeImages');
  const autoSave = configValue(source, 'autoSave');
  const imagePrompts = promptText(configValue(source, 'imagePrompts'), 'Image prompts', errors);
  const videoPrompts = promptText(configValue(source, 'videoPrompts'), 'Video prompts', errors);
  const uploadList = Array.isArray(uploads) ? uploads : [];

  if (!Array.isArray(uploads)) errors.push('Uploads must be an array.');
  if (!MODE_VALUES.has(mode)) errors.push('Choose a valid generation mode.');
  if (!RATIOS.includes(ratio)) errors.push(`Ratio must be one of: ${RATIOS.join(', ')}.`);
  if (!RESOLUTIONS.includes(resolution)) errors.push(`Resolution must be one of: ${RESOLUTIONS.join(', ')}.`);
  if (typeof includeImages !== 'boolean') errors.push('Include images must be true or false.');
  if (typeof autoSave !== 'boolean') errors.push('Automatic ZIP saving must be true or false.');
  validateUploads(uploadList, errors);

  let count = 0;
  if (mode === MODES.IMAGE) {
    count = imagePrompts.length;
    if (count === 0) errors.push('Add at least one image prompt.');
  } else if (mode === MODES.IMAGE_VIDEO) {
    count = uploadList.length;
    if (count === 0) errors.push('Add at least one source image.');
    if (videoPrompts.length !== count) {
      errors.push('Provide exactly one video prompt for each uploaded image.');
    }
    if (variants.length === 0) errors.push('Select at least one video variant.');
  } else if (mode === MODES.PROMPT_VIDEO) {
    count = imagePrompts.length;
    if (count === 0 || videoPrompts.length === 0) {
      errors.push('Add at least one image prompt and one video prompt.');
    }
    if (imagePrompts.length !== videoPrompts.length) {
      errors.push('Image prompts and video prompts must have the same count.');
    }
    if (variants.length === 0) errors.push('Select at least one video variant.');
  }

  return {
    valid: errors.length === 0,
    errors,
    imagePrompts,
    videoPrompts,
    count,
  };
}

export function batchImagePrompt(prompts, ratio = DEFAULT_SETTINGS.ratio) {
  const values = Array.isArray(prompts)
    ? prompts.map((prompt, index) => {
      if (typeof prompt !== 'string' || !prompt.trim()) {
        throw new TypeError(`Prompt ${index + 1} must be non-empty text.`);
      }
      return prompt.trim().replace(/\r\n?/g, '\n');
    })
    : parsePrompts(prompts);
  if (!values.length) throw new Error('At least one image prompt is required.');
  if (!RATIOS.includes(ratio)) throw new RangeError(`Unsupported ratio: ${ratio}`);

  const numberedPrompts = values
    .map((prompt, index) => `Image ${index + 1}:\n${prompt}`)
    .join('\n\n');
  const count = values.length;
  return [
    `Create the following images in a ${ratio} aspect ratio.`,
    numberedPrompts,
    `Return exactly ${count} SEPARATE images, one for each numbered prompt above, in the same order. Label each result Image 1 through Image ${count}. Do not make a collage, grid, contact sheet, or multi-panel image.`,
  ].join('\n\n');
}

export function assetFilename(runId, index, mime) {
  const extension = MIME_EXTENSIONS.get(normaliseMime(mime));
  if (!extension) throw new RangeError(`Unsupported asset MIME type: ${mime}`);
  return `mete_${runPrefix(runId)}_image_${paddedIndex(index)}.${extension}`;
}

export function createSession(config = {}, uploads = [], id = makeRunId()) {
  const validation = validateConfig(config, uploads);
  if (!validation.valid) throw new ConfigValidationError(validation.errors);
  if (typeof id !== 'string' || !id.trim()) throw new TypeError('Session ID must be non-empty text.');

  const source = isPlainObject(config) ? config : {};
  const mode = configValue(source, 'mode');
  const settings = {
    ratio: configValue(source, 'ratio'),
    resolution: configValue(source, 'resolution'),
    variants: [...configValue(source, 'variants')],
    includeImages: configValue(source, 'includeImages'),
    autoSave: configValue(source, 'autoSave'),
  };
  const now = new Date().toISOString();
  let jobs;

  if (mode === MODES.IMAGE) {
    jobs = validation.imagePrompts.map((imagePrompt, index) => ({
      index: index + 1,
      imagePrompt,
      videoPrompt: null,
      originalName: null,
      image: null,
      upload: null,
      variants: [],
      status: 'pending',
    }));
  } else if (mode === MODES.IMAGE_VIDEO) {
    jobs = sortImages(uploads).map((image, index) => ({
      index: index + 1,
      imagePrompt: null,
      videoPrompt: validation.videoPrompts[index],
      originalName: image.name,
      image: uploadDescriptor(image),
      upload: null,
      variants: [],
      status: 'pending',
    }));
  } else {
    jobs = validation.imagePrompts.map((imagePrompt, index) => ({
      index: index + 1,
      imagePrompt,
      videoPrompt: validation.videoPrompts[index],
      originalName: null,
      image: null,
      upload: null,
      variants: [],
      status: 'pending',
    }));
  }

  return {
    id,
    mode,
    settings,
    status: 'ready',
    stage: 'setup',
    message: '',
    createdAt: now,
    updatedAt: now,
    zipName: `mete-run-${runPrefix(id)}.zip`,
    meta: null,
    vibes: null,
    jobs,
    log: [],
  };
}

export function exportPlan(session) {
  assertSession(session);
  const jobs = orderedJobs(session);
  const wantsImages = session.mode === MODES.IMAGE || session.settings?.includeImages === true;
  const images = wantsImages ? jobs.map(plannedImage) : [];

  if (session.mode === MODES.IMAGE) return images;

  const variants = strictSessionVariants(session);
  const multiple = variants.length > 1;
  const videos = jobs.flatMap((job) => variants.map((variant) => {
    const asset = selectedVariantForJob(job, variant);
    return {
      assetId: asset.assetId,
      path: `videos/video_${paddedIndex(job.index)}${multiple ? `_variant_${variant}` : ''}.mp4`,
    };
  }));
  return [...images, ...videos];
}

export function runManifest(session) {
  assertSession(session);
  const selected = manifestSelectedVariants(session);
  const imageFiles = session.mode === MODES.IMAGE || session.settings?.includeImages === true;
  const jobs = orderedJobs(session);

  return {
    version: 1,
    id: manifestAssetId(session.id),
    mode: session.mode,
    createdAt: session.createdAt ?? null,
    zipName: session.zipName ?? null,
    settings: {
      ratio: session.settings?.ratio ?? null,
      resolution: session.settings?.resolution ?? null,
      variants: selected,
      includeImages: session.settings?.includeImages === true,
      autoSave: session.settings?.autoSave !== false,
    },
    chatUrl: serviceUrl(session, 'meta', 'meta.ai'),
    projectUrl: serviceUrl(session, 'vibes', 'vibes.ai'),
    jobs: jobs.map((job) => {
      const extension = imageExtension(job.image, job.originalName);
      return {
        index: job.index,
        imagePrompt: typeof job.imagePrompt === 'string' ? job.imagePrompt : null,
        videoPrompt: typeof job.videoPrompt === 'string' ? job.videoPrompt : null,
        originalName: typeof job.originalName === 'string' ? job.originalName : null,
        image: job.image
          ? {
            assetId: manifestAssetId(job.image.assetId),
            type: normaliseMime(job.image.type) || null,
            sha256: manifestHash(job.image.sha256),
            filename: imageFiles && extension ? `images/image_${paddedIndex(job.index)}.${extension}` : null,
          }
          : null,
        variants: manifestVariants(job, selected),
      };
    }),
  };
}
