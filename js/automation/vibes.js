(() => {
  'use strict';

  const api = globalThis.MeteAutomation;
  const D = api.dom;
  const cardSelector = '[data-asset-id], [data-media-id], [data-video-id], [data-testid="generated-video"], [data-video-url], [data-video-thumbnail]';
  const nodeIds = new WeakMap();
  const knownImages = new Map();
  const knownVideoThumbnails = new Map();
  let nextNodeId = 0;

  function projectUrl(value = location.href) {
    try { return D.providerFor(value) === 'vibes' && /^\/projects\/[^/]+\/?$/.test(new URL(value).pathname); }
    catch { return false; }
  }

  function composer(videoOnly = true) {
    const candidates = [...document.querySelectorAll('[contenteditable="true"], textarea')].filter(D.visible)
      .filter(node => videoOnly ? /^Describe a video\.{0,3}$/i.test(node.getAttribute('data-placeholder') || node.getAttribute('aria-label') || node.getAttribute('placeholder') || '')
        : /^Describe (?:a video|an image)\.{0,3}$/i.test(node.getAttribute('data-placeholder') || node.getAttribute('aria-label') || node.getAttribute('placeholder') || ''));
    if (candidates.length !== 1) return null;
    const editor = candidates[0];
    const section = editor.closest('section, form');
    return section ? { editor, section } : null;
  }

  async function project(payload, ctx) {
    D.assertPage('vibes');
    if (location.pathname !== '/') throw D.error('VIBES_HOME_REQUIRED', 'Open the Vibes Projects home page before creating a project.');
    const create = await D.waitFor(() => { D.assertPage('vibes'); return D.control(document.querySelector('main') || document, 'Create new'); }, {
      signal: ctx.signal, message: 'The Vibes Create new button is unavailable. Sign in to Vibes and open its Projects page.',
    });
    await ctx.checkpoint('vibes:project-opening', 'Opening one new Vibes project.', { initialUrl: location.href });
    D.click(create, ctx.signal);
    await D.waitFor(() => { D.assertPage('vibes'); return projectUrl(); }, {
      signal: ctx.signal, timeout: 180_000, message: 'Vibes did not open a new project after Create new. It was not clicked again.',
    });
    await ctx.checkpoint('vibes:project-opened', 'The new Vibes project is identified.', { projectUrl: location.href });
    return { url: location.href };
  }

  async function videoComposer(ctx, url) {
    let current = await D.waitFor(() => { D.assertPage('vibes', url); return composer(false); }, {
      signal: ctx.signal, message: 'The Vibes Describe a video composer is unavailable. Open the project’s Generate tab and close other dialogs.',
    });
    if (!composer()) {
      D.click(D.control(current.section, 'Image'), ctx.signal);
      const video = await D.waitFor(() => D.control(document, 'Video'), { signal: ctx.signal, timeout: 10_000, message: 'Vibes did not expose its Video mode option.' });
      D.click(video, ctx.signal);
      current = await D.waitFor(() => composer(), { signal: ctx.signal, timeout: 10_000, message: 'Vibes did not switch to Video mode.' });
    }
    if (D.editorValue(current.editor)) throw D.error('COMPOSER_NOT_EMPTY', 'The Vibes composer has an existing draft. Clear it before starting; no prompt was overwritten.');
    if (!D.control(current.section, /^(?:Add|Remove) start frame$/i, { includeDisabled: true })) {
      D.click(D.control(current.section, /^Start,?\s*end frame$/i), ctx.signal);
      await D.waitFor(() => D.control(composer().section, /^(?:Add|Remove) start frame$/i, { includeDisabled: true }), {
        signal: ctx.signal, timeout: 10_000, message: 'The Vibes Start, end frame controls did not appear.',
      });
    }
    for (const slot of ['start', 'end']) {
      const remove = D.control(composer().section, `Remove ${slot} frame`, { includeDisabled: true });
      if (remove) {
        await ctx.checkpoint('vibes:clearing-frame', `Removing the previous ${slot} frame before image upload.`);
        D.click(remove, ctx.signal);
        await D.waitFor(() => !D.control(composer().section, `Remove ${slot} frame`, { includeDisabled: true }), {
          signal: ctx.signal, timeout: 15_000, message: `Vibes did not remove the previous ${slot} frame. The next image was not uploaded.`,
        });
      }
    }
    return composer();
  }

  function frameGallery(frame) {
    const tab = D.control(frame, 'This project', { includeDisabled: true });
    if (!tab) return null;
    for (let node = tab.parentElement; node && node !== frame; node = node.parentElement) {
      if (D.control(node, 'Add to video', { includeDisabled: true })) return node;
    }
    return null;
  }

  function namedImages(root, filename) {
    return [...root.querySelectorAll('img')].filter(D.visible).filter(image => {
      const values = [...D.labels(image), ...D.labels(image.parentElement)];
      return values.some(value => value.trim() === filename);
    });
  }

  function startImage() {
    const current = composer();
    if (!current) return null;
    const remove = D.control(current.section, 'Remove start frame', { includeDisabled: true });
    for (let node = remove?.parentElement; node && node !== current.section; node = node.parentElement) {
      const images = [...node.querySelectorAll('img')].filter(D.visible);
      if (images.length === 1 && !node.contains(current.editor)) return images[0];
      if (images.length > 1) return null;
    }
    return null;
  }

  function hasIdentity(image, upload) {
    return !!image && D.mediaKey(D.imageUrl(image)) === upload.sourceKey && D.imageReady(image);
  }

  async function uploadFrame(payload, reconstructed, ctx, url) {
    const current = composer();
    D.click(D.control(current.section, 'Add start frame'), ctx.signal);
    let frame = await D.waitFor(() => D.dialog('Select start frame'), { signal: ctx.signal, message: 'Vibes did not open Select start frame.' });
    const thisProject = D.control(frame, 'This project', { includeDisabled: true });
    if (!thisProject) throw D.error('FRAME_SCOPE', 'The start-frame picker does not expose This project. Cross-project media will not be selected.');
    D.click(thisProject, ctx.signal);
    let gallery = await D.waitFor(() => frameGallery(D.dialog('Select start frame') || frame), {
      signal: ctx.signal, timeout: 15_000, message: 'The current-project gallery could not be separated from the start-frame preview.',
    });
    const baseline = new Set([...gallery.querySelectorAll('img')].map(image => D.mediaKey(D.imageUrl(image))).filter(Boolean));
    if (namedImages(gallery, reconstructed.filename).length) throw D.error('DUPLICATE_UPLOAD', 'An image with this unique run filename is already present. It was not uploaded or submitted again.');
    await ctx.checkpoint('vibes:before-upload', `Preparing image ${payload.index} as ${reconstructed.filename}.`, { upload: { label: payload.uploadLabel, filename: reconstructed.filename, sha256: reconstructed.sha256, verified: false }, uploadBaseline: [...baseline] });
    D.click(D.control(frame, 'Upload'), ctx.signal);
    const uploadDialog = await D.waitFor(() => D.dialog('Upload images'), { signal: ctx.signal, message: 'The Vibes Upload images dialog did not appear.' });
    const inputs = [...uploadDialog.querySelectorAll('input[type="file"]')];
    if (inputs.length !== 1) throw D.error('UPLOAD_INPUT', 'Vibes must expose exactly one file input in Upload images. No other input was used.');
    const transfer = new DataTransfer();
    transfer.items.add(reconstructed.file);
    inputs[0].files = transfer.files;
    inputs[0].dispatchEvent(new Event('input', { bubbles: true }));
    inputs[0].dispatchEvent(new Event('change', { bubbles: true }));
    const attached = inputs[0].files;
    if (attached.length !== 1 || attached[0].name !== reconstructed.filename || attached[0].type !== reconstructed.file.type
      || await D.digest(await attached[0].arrayBuffer()) !== reconstructed.sha256) {
      throw D.error('UPLOAD_MISMATCH', 'The file input did not retain exactly the selected image and fingerprint. Nothing was uploaded.');
    }
    const uploadButton = await D.waitFor(() => { D.assertPage('vibes', url); return D.control(uploadDialog, 'Upload'); }, {
      signal: ctx.signal, timeout: 120_000, message: 'Vibes did not enable Upload for the selected start frame.',
    });
    await ctx.checkpoint('vibes:uploading', `Uploading image ${payload.index}; waiting for its exact filename and thumbnail.`, { uploadSubmitted: true });
    D.click(uploadButton, ctx.signal);
    const selected = await D.waitFor(() => {
      D.assertPage('vibes', url);
      if (D.dialog('Upload images')) return false;
      frame = D.dialog('Select start frame');
      gallery = frame && frameGallery(frame);
      if (!gallery) return false;
      const matches = namedImages(gallery, reconstructed.filename);
      if (matches.length > 1) throw D.error('AMBIGUOUS_UPLOAD', 'More than one thumbnail has the current run filename. No start frame was selected.');
      const image = matches[0];
      const sourceKey = D.mediaKey(D.imageUrl(image));
      return image && D.allowedUrl(D.imageUrl(image), 'vibes') && D.imageReady(image) && sourceKey && !baseline.has(sourceKey) && !D.busy(gallery) ? { image, sourceKey } : false;
    }, {
      signal: ctx.signal, timeout: 20 * 60_000, stableFor: 900, signature: value => value.sourceKey,
      message: 'The exact uploaded image did not become ready in This project within 20 minutes. Old thumbnails, videos, and similarly named files were not selected.',
    });
    const upload = { label: payload.uploadLabel, filename: reconstructed.filename, sourceKey: selected.sourceKey, sha256: reconstructed.sha256, verified: false };
    knownImages.set(selected.sourceKey, { index: payload.index, filename: reconstructed.filename });
    D.annotate(selected.image, `Image ${payload.index}`, reconstructed.filename);
    await ctx.checkpoint('vibes:uploaded', `Image ${payload.index} uploaded; checking its selected preview.`, { upload });
    D.click(selected.image, ctx.signal);
    await D.waitFor(() => {
      D.assertPage('vibes', url);
      frame = D.dialog('Select start frame');
      gallery = frame && frameGallery(frame);
      if (!frame || !gallery || !D.control(frame, 'Add to video')) return false;
      const previews = [...frame.querySelectorAll('img')].filter(image => !gallery.contains(image) && hasIdentity(image, upload));
      return previews.length === 1;
    }, {
      signal: ctx.signal, timeout: 120_000, stableFor: 500,
      message: 'The selected preview did not match this image’s uploaded thumbnail. Add to video was not clicked.',
    });
    await ctx.checkpoint('vibes:selecting-frame', `The selected preview matches image ${payload.index}; adding it as the start frame.`, { upload });
    D.click(D.control(frame, 'Add to video'), ctx.signal);
    await D.waitFor(() => { D.assertPage('vibes', url); return !D.dialog('Select start frame') && hasIdentity(startImage(), upload); }, {
      signal: ctx.signal, timeout: 120_000, stableFor: 650,
      message: 'Vibes did not attach the verified image to its start-frame slot. Video generation was not submitted.',
    });
    upload.verified = true;
    D.annotate(startImage(), `Image ${payload.index}`, reconstructed.filename);
    await ctx.checkpoint('vibes:frame-verified', `Image ${payload.index} is verified in the start-frame slot.`, { upload });
    return upload;
  }

  function selectedChoice(node, pattern) {
    if (!node) return false;
    if (node.matches('option')) return node.selected;
    if (['aria-checked', 'aria-selected', 'aria-pressed'].some(attribute => node.getAttribute(attribute) === 'true')) return true;
    if (/^(?:checked|on|active|selected)$/.test(node.getAttribute('data-state') || '')) return true;
    const peers = [...node.parentElement.querySelectorAll(D.controls)].filter(peer => D.visible(peer) && pattern.test(D.name(peer)));
    const secondary = peer => /text-secondary/.test(peer.getAttribute('class') || '');
    return peers.length > 1 && !secondary(node) && peers.filter(peer => peer !== node).every(secondary);
  }

  function option(value) {
    const selects = [...document.querySelectorAll('select')].filter(D.visible)
      .filter(select => [...select.options].some(item => item.text.trim() === value || item.value === value));
    if (selects.length > 1) throw D.error('AMBIGUOUS_SETTING', `More than one control offers ${value}. Close unrelated menus.`);
    if (selects.length === 1) {
      const select = selects[0];
      return { select, node: [...select.options].find(item => item.text.trim() === value || item.value === value) };
    }
    const node = D.control(document, value, { includeDisabled: true });
    return node ? { node } : null;
  }

  async function chooseSetting(value, pattern, ctx) {
    let choice = option(value);
    if (!choice) return false;
    if (choice.select) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(choice.select, choice.node.value);
      choice.select.dispatchEvent(new Event('input', { bubbles: true }));
      choice.select.dispatchEvent(new Event('change', { bubbles: true }));
    } else if (!selectedChoice(choice.node, pattern)) D.click(choice.node, ctx.signal);
    await D.waitFor(() => {
      choice = option(value);
      if (choice?.node) choice.node.blur?.();
      return choice && selectedChoice(choice.node, pattern);
    }, { signal: ctx.signal, timeout: 15_000, stableFor: 350, message: `Vibes did not expose a confirmed selected state for ${value}. Generation was not submitted with an unverified setting.` });
    return true;
  }

  function ratioMatches(width, height, ratio) {
    const [left, right] = ratio.split(':').map(Number);
    return width > 0 && height > 0 && Math.abs((width / height) / (left / right) - 1) <= 0.025;
  }

  async function configure(payload, upload, ctx, url) {
    if (!['480p', '720p', '1080p'].includes(payload.resolution) || !['1:1', '16:9', '9:16', '4:3', '3:4'].includes(payload.ratio)) {
      throw D.error('INVALID_SETTINGS', 'Choose a supported resolution and aspect ratio before generating.');
    }
    const advanced = D.control(composer().section, /^Advanced(?:\s.*)?$/i);
    if (!advanced) throw D.error('ADVANCED_MISSING', 'Vibes does not expose Advanced settings; the requested resolution cannot be verified.');
    D.click(advanced, ctx.signal);
    await D.waitFor(() => option(payload.resolution), { signal: ctx.signal, timeout: 15_000, message: `Vibes Advanced does not offer ${payload.resolution}. No alternate resolution was silently selected.` });
    await chooseSetting(payload.resolution, /^\d+p$/i, ctx);
    const source = startImage();
    const ratio = payload.ratioSource === 'image'
      ? ['1:1', '16:9', '9:16', '4:3', '3:4'].find(value => ratioMatches(source?.naturalWidth, source?.naturalHeight, value)) || `${source?.naturalWidth}:${source?.naturalHeight}`
      : payload.ratio;
    const ratioControl = await chooseSetting(ratio, /^\d+\s*:\s*\d+$/, ctx);
    if (!ratioControl && !ratioMatches(source?.naturalWidth, source?.naturalHeight, ratio)) {
      throw D.error('RATIO_UNSUPPORTED', `Vibes cannot confirm the ${ratio} start-frame aspect ratio. Generation was not submitted.`);
    }
    const selectedResolution = option(payload.resolution)?.node;
    D.click(composer().editor, ctx.signal);
    await D.waitFor(() => !selectedResolution?.isConnected || !D.visible(selectedResolution) || advanced.getAttribute('aria-expanded') === 'false', {
      signal: ctx.signal, timeout: 10_000, message: 'The Vibes Advanced menu did not close. Close the menu before starting a new run.',
    });
    D.assertPage('vibes', url);
    if (!hasIdentity(startImage(), upload)) throw D.error('FRAME_CHANGED', 'The start frame changed while setting video options. Nothing was submitted.');
    await ctx.checkpoint('vibes:configured', `Video settings verified: ${payload.resolution}, ${ratio}${ratioControl ? '' : ' from the start frame; output dimensions will also be checked'}.`, {
      settings: { resolution: payload.resolution, ratio, ratioSource: ratioControl ? 'control' : 'start-frame' },
    });
    return ratio;
  }

  function galleryRoot() {
    const main = document.querySelector('main');
    if (!main) return null;
    const upload = D.control(main, 'Upload media', { includeDisabled: true });
    const section = upload?.closest('section');
    return section && !section.contains(composer()?.editor) ? section : main;
  }

  function stableCardKey(card) {
    for (const attribute of ['data-asset-id', 'data-media-id', 'data-video-id']) {
      if (card.getAttribute(attribute)) return `${attribute}:${card.getAttribute(attribute)}`;
    }
    return '';
  }

  function cardFor(node, root) {
    const explicit = node.closest(cardSelector);
    if (explicit && explicit !== root && root.contains(explicit)) return explicit;
    const button = node.closest('button, [role="button"], figure, article, [role="listitem"]');
    if (button && button !== root && root.contains(button)) return button;
    for (let candidate = node; candidate.parentElement && candidate.parentElement !== root; candidate = candidate.parentElement) {
      const siblings = [...candidate.parentElement.children].filter(sibling => !sibling.matches('img,video,source') && sibling.querySelector('img,video,[data-status="generating"]'));
      if (siblings.length > 1) return candidate;
    }
    return node.matches('img,video') ? node.parentElement : node;
  }

  function videoSources(card) {
    const videos = card.matches('video') ? [card] : [...card.querySelectorAll('video')];
    const values = videos.flatMap(video => [video.currentSrc, video.src, ...[...video.querySelectorAll('source')].map(source => source.src)]);
    const tagged = card.matches('[data-video-url]') ? [card] : [...card.querySelectorAll('[data-video-url]')];
    values.push(...tagged.map(node => node.getAttribute('data-video-url')));
    const links = card.matches('a[href]') ? [card] : [...card.querySelectorAll('a[href]')];
    values.push(...links.filter(link => link.type === 'video/mp4' || /\.mp4(?:[?#]|$)/i.test(link.getAttribute('href') || '')).map(link => link.href));
    const absolute = values.filter(Boolean).map(value => {
      try { return new URL(value, location.href).href; } catch { return ''; }
    });
    return [...new Set(absolute.filter(value => D.allowedUrl(value, 'vibes')))];
  }

  function cards(root = galleryRoot()) {
    if (!root) return [];
    const current = composer();
    const nodes = new Set();
    for (const node of root.querySelectorAll(`img, video, ${cardSelector}, [data-status="generating"], a[href*=".mp4"]`)) {
      if (!D.visible(node) || node.closest(`${D.ignored}, [role="dialog"]`) || current?.section.contains(node)) continue;
      if (node.matches('img') && /avatar|profile picture|logo/i.test(node.alt || '')) continue;
      const card = cardFor(node, root);
      if (card && card !== root) nodes.add(card);
    }
    const unique = [...nodes].filter(node => ![...nodes].some(other => other !== node && other.contains(node)));
    unique.sort((left, right) => left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
    return unique.map(card => {
      if (!nodeIds.has(card)) nodeIds.set(card, `node:${++nextNodeId}`);
      const images = [...card.querySelectorAll('img')];
      if (card.matches('img')) images.unshift(card);
      const sources = videoSources(card);
      const group = card.closest('[data-generation-id], [data-request-id], [data-batch-id]');
      const groupKey = group ? ['data-generation-id', 'data-request-id', 'data-batch-id'].map(attribute => group.getAttribute(attribute)).find(Boolean) : '';
      const explicitLabel = [...D.labels(card), ...images.flatMap(D.labels), D.text(card)].join(' ');
      const labelled = [...explicitLabel.matchAll(/\b(?:Video|Variant|Candidate)\s*#?\s*(\d+)\b/gi)].map(match => Number(match[1]));
      const variants = [...new Set(labelled)];
      return { card, key: nodeIds.get(card), stableKey: stableCardKey(card), groupKey, images, sources, variant: variants.length === 1 ? variants[0] : null,
        sourceKeys: [...new Set([...sources, ...images.map(D.imageUrl)].map(D.mediaKey).filter(Boolean))] };
    });
  }

  function freshCards(current, baseline) {
    const matched = new Set();
    for (const before of baseline) {
      let found = current.filter(record => record.card === before.card || (before.stableKey && record.stableKey === before.stableKey)
        || (before.card.isConnected && (record.card.contains(before.card) || before.card.contains(record.card))));
      if (!found.length && !before.card.isConnected) {
        found = current.filter(record => record.sourceKeys.some(key => before.sourceKeys.includes(key)));
      }
      if (found.length !== 1 || matched.has(found[0])) throw D.error('BASELINE_CHANGED', 'The project media grid was replaced or became ambiguous. Existing assets cannot safely be separated from this request; no video order was guessed.');
      matched.add(found[0]);
    }
    return current.filter(record => !matched.has(record));
  }

  function freezeGroup(records) {
    if (records.length !== 4) throw D.error('VARIANT_COUNT', 'Vibes must create exactly four new video cards for this image.');
    const groupKeys = new Set(records.map(record => record.groupKey).filter(Boolean));
    if (groupKeys.size > 1) throw D.error('MIXED_GROUP', 'The new video cards belong to different generation groups. They were not combined.');
    const labels = records.map(record => record.variant);
    if (labels.some(Boolean) && (new Set(labels).size !== 4 || ![1, 2, 3, 4].every(value => labels.includes(value)))) {
      throw D.error('VARIANT_MAPPING', 'The four new video cards do not have a unique Video 1–4 mapping. No variant order was guessed.');
    }
    return { explicit: labels.every(Boolean), records: records.map((record, index) => ({ ...record, variant: labels.every(Boolean) ? record.variant : index + 1 })) };
  }

  function reconcileGroup(group, current) {
    if (current.length !== 4) throw D.error('VARIANT_COUNT', 'The generation group changed after its four video identities were recorded.');
    const matched = group.records.map(before => {
      const matches = current.filter(record => record.card === before.card || (before.stableKey && before.stableKey === record.stableKey));
      if (matches.length !== 1) throw D.error('VARIANT_IDENTITY', 'A generated video card disappeared or lost its stable identity. No replacement was guessed.');
      const currentRecord = matches[0];
      if (group.explicit && currentRecord.variant !== before.variant) throw D.error('VARIANT_IDENTITY', 'The provider changed a video’s variant label.');
      return { ...currentRecord, variant: before.variant };
    });
    if (!group.explicit && matched.some((record, index) => record.card !== current[index].card)) {
      throw D.error('VARIANT_ORDER', 'Vibes reordered unlabelled video cards during completion. Their variant order cannot be proved; nothing was downloaded.');
    }
    group.records = matched;
    return matched;
  }

  function hover(record) {
    record.card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const target = record.images[0] || record.card;
    const bounds = target.getBoundingClientRect();
    const options = { bubbles: true, clientX: bounds.x + bounds.width / 2, clientY: bounds.y + bounds.height / 2, view: window };
    for (const type of ['pointerover', 'pointerenter']) target.dispatchEvent(new PointerEvent(type, { ...options, pointerType: 'mouse' }));
    for (const type of ['mouseover', 'mouseenter', 'mousemove']) target.dispatchEvent(new MouseEvent(type, options));
  }

  function playback(record, probes) {
    const sources = videoSources(record.card);
    if (!sources.length) return null;
    const videos = record.card.matches('video') ? [record.card] : [...record.card.querySelectorAll('video')];
    let video = videos.find(node => D.allowedUrl(node.currentSrc || node.src, 'vibes'));
    const remote = sources.filter(value => value.startsWith('https:'));
    if (new Set(remote.map(D.mediaKey)).size > 1) throw D.error('VIDEO_SOURCE', 'A video card exposes conflicting file URLs. No alternate file was guessed.');
    let url = remote[0] || video?.currentSrc || video?.src || sources[0];
    if (!video) {
      const keys = new Set(sources.map(D.mediaKey));
      if (keys.size !== 1) throw D.error('VIDEO_SOURCE', 'A video card exposes conflicting playback URLs. No thumbnail or alternate file was guessed.');
      let probe = probes.get(record.variant);
      if (probe && probe.url !== url) { probe.video.removeAttribute('src'); probe.video.load(); probe.video.remove(); probes.delete(record.variant); probe = null; }
      if (!probe) {
        video = document.createElement('video');
        video.setAttribute('data-mete-run-ui', '');
        video.muted = true;
        video.preload = 'auto';
        Object.assign(video.style, { position: 'fixed', width: '1px', height: '1px', opacity: '0', pointerEvents: 'none' });
        video.src = url;
        document.documentElement.append(video);
        video.load();
        probes.set(record.variant, { video, url });
      } else video = probe.video;
    } else if (video.preload !== 'auto' && video.readyState < 2) {
      video.preload = 'auto';
      video.load();
    }
    url = remote[0] || video.currentSrc || url;
    return { url, video, width: video.videoWidth, height: video.videoHeight,
      ready: !video.error && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && Number.isFinite(video.duration) && video.duration > 0 && !D.busy(record.card) };
  }

  async function awaitVideos(payload, upload, baseline, ctx, url) {
    let group;
    const hovered = new WeakSet();
    const probes = new Map();
    let count = 0;
    let lastReady = '';
    try {
      return await D.waitFor(async () => {
        D.assertPage('vibes', url);
        const fresh = freshCards(cards(), baseline);
        count = fresh.length;
        if (fresh.length > 4) throw D.error('VARIANT_COUNT', `Vibes exposed ${fresh.length} new media cards for one image. Mixed or extra outputs were not assigned as four variants.`);
        if (!group && fresh.length < 4) return false;
        if (!group) {
          group = freezeGroup(fresh);
          await ctx.checkpoint('vibes:variants-identified', `Image ${payload.index}: all four candidate card identities recorded before waiting for playback.`, {
            variantCards: group.records.map(record => ({ variant: record.variant, sourceKey: record.stableKey || record.key, group: record.groupKey })),
          });
        }
        const records = reconcileGroup(group, fresh);
        const ready = [];
        for (const record of records) {
          const hoverTarget = record.images[0] || record.card;
          if (!hovered.has(hoverTarget)) { D.checkAbort(ctx.signal); hovered.add(hoverTarget); hover(record); }
          const media = playback(record, probes);
          if (!media?.ready) continue;
          if (!ratioMatches(media.width, media.height, payload.ratio)) throw D.error('OUTPUT_RATIO', `Video ${record.variant} for image ${payload.index} has a different aspect ratio from ${payload.ratio}. It was not exported.`);
          if (Math.abs(Math.min(media.width, media.height) - Number.parseInt(payload.resolution, 10)) > 2) {
            throw D.error('OUTPUT_RESOLUTION', `Video ${record.variant} for image ${payload.index} is ${media.width}×${media.height}, not the requested ${payload.resolution}. It was not exported.`);
          }
          const sourceKey = D.mediaKey(media.url);
          const label = `Image ${payload.index} · Video ${record.variant}`;
          ready.push({ variant: record.variant, url: media.url, sourceKey, label });
          for (const image of record.images) {
            const thumbnailKey = D.mediaKey(D.imageUrl(image));
            if (!thumbnailKey || knownImages.has(thumbnailKey)) continue;
            const labels = knownVideoThumbnails.get(thumbnailKey) || new Set();
            labels.add(label);
            knownVideoThumbnails.set(thumbnailKey, labels);
          }
          D.annotate(record.images[0] || media.video, label);
        }
        ready.sort((left, right) => left.variant - right.variant);
        if (new Set(ready.map(item => item.sourceKey)).size !== ready.length) throw D.error('DUPLICATE_VIDEO', 'Multiple video cards resolve to the same video file. Four distinct variants could not be verified.');
        const signature = JSON.stringify(ready);
        if (signature !== lastReady) {
          lastReady = signature;
          await ctx.checkpoint('vibes:generating', `Image ${payload.index}: ${ready.length}/4 videos ready, verified against their original cards.`, { upload, variants: ready });
        }
        return ready.length === 4 && !D.busy(galleryRoot()) && !D.busy(composer().section) ? ready : false;
      }, {
        signal: ctx.signal, timeout: 25 * 60_000, stableFor: 2_000, signature: value => JSON.stringify(value),
        message: () => `Vibes did not expose four completed, distinct playable videos within 25 minutes (${count} new cards detected). If it shows only thumbnails or changed its media UI, the local adapter cannot prove the video URLs. Nothing was retried or downloaded.`,
      });
    } finally {
      for (const { video } of probes.values()) { video.removeAttribute('src'); video.load(); video.remove(); }
    }
  }

  async function generate(payload, ctx) {
    if (typeof payload?.projectUrl !== 'string' || !projectUrl(payload.projectUrl)) throw D.error('PROJECT_REQUIRED', 'A verified project URL from this run is required before generating videos.');
    D.assertPage('vibes', payload.projectUrl);
    if (!Number.isSafeInteger(payload.index) || payload.index < 1 || payload.expectedVariants !== 4 || typeof payload.prompt !== 'string' || !payload.prompt.trim()) {
      throw D.error('INVALID_VIDEO_JOB', 'Each image must have one non-empty video prompt, a stable index, and exactly four expected video candidates.');
    }
    const url = payload.projectUrl;
    const reconstructed = await D.imageFile(payload);
    D.checkAbort(ctx.signal);
    if (D.busy(galleryRoot() || document.querySelector('main') || document)) throw D.error('PROJECT_BUSY', 'This Vibes project is already generating media. Wait for it before starting another run.');
    await ctx.checkpoint('vibes:preparing', `Image ${payload.index}: local bytes and SHA-256 verified; preparing the Video composer.`);
    await videoComposer(ctx, url);
    const upload = await uploadFrame(payload, reconstructed, ctx, url);
    const ratio = await configure(payload, upload, ctx, url);
    upload.ratio = ratio;
    const current = composer();
    await D.fillEditor(current.editor, payload.prompt, ctx);
    D.assertPage('vibes', url);
    if (!hasIdentity(startImage(), upload)) throw D.error('FRAME_CHANGED', 'The start frame changed before submission. No video request was sent.');
    const baseline = cards();
    if (baseline.some(record => D.busy(record.card)) || D.busy(current.section)) throw D.error('PROJECT_BUSY', 'This project is already generating media. Wait for it before starting a new run.');
    await ctx.checkpoint('vibes:submitting', `Submitting image ${payload.index} once to generate four videos. Do not generate or upload other media in this project.`, {
      upload, submitted: true, videoBaseline: baseline.map(record => ({ sourceKey: record.stableKey || record.key, sources: record.sourceKeys })),
    });
    D.submit(current.editor, current.section, ctx.signal);
    await D.waitFor(() => {
      D.assertPage('vibes', url);
      return D.editorValue(composer()?.editor) === '' || D.busy(composer()?.section || document) || freshCards(cards(), baseline).length > 0;
    }, { signal: ctx.signal, timeout: 120_000, message: 'Vibes did not acknowledge the video request. It was not sent again; inspect the composer before starting a new run.' });
    await ctx.checkpoint('vibes:generating', `Image ${payload.index} accepted; waiting for all four video candidates.`, { upload });
    const variants = await awaitVideos({ ...payload, ratio }, upload, baseline, ctx, url);
    return { url, upload, variants };
  }

  if (D.providerFor() === 'vibes') {
    let scheduled;
    const observer = new MutationObserver(() => {
      if (scheduled || (!knownImages.size && !knownVideoThumbnails.size)) return;
      scheduled = setTimeout(() => {
        scheduled = null;
        for (const image of document.querySelectorAll('img')) {
          const known = knownImages.get(D.mediaKey(D.imageUrl(image)));
          const videos = knownVideoThumbnails.get(D.mediaKey(D.imageUrl(image)));
          const badge = D.annotation(image);
          if (known && !badge?.textContent.includes('· Video ')) D.annotate(image, `Image ${known.index}`, known.filename);
          else if (videos && !badge?.textContent.includes('· Video ')) D.annotate(image, videos.size === 1 ? [...videos][0] : 'Video preview', [...videos].join('; '));
        }
      }, 150);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'alt'] });
  }

  api.vibes = Object.freeze({ project, generate, projectUrl, composer, frameGallery, namedImages, startImage, selectedChoice,
    ratioMatches, cards, freshCards, freezeGroup, reconcileGroup, videoSources, playback });
})();
