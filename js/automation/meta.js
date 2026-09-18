(() => {
  'use strict';

  const api = globalThis.MeteAutomation;
  const D = api.dom;
  const author = '[data-message-author-role="assistant"], [data-author="assistant"], [data-testid="assistant-message"]';
  const user = '[data-message-author-role="user"], [data-author="user"], [data-testid="user-message"]';
  const feedback = 'button[aria-label="Copy response"], button[aria-label="Like this response"], button[aria-label="Dislike this response"]';

  function composer() {
    const nodes = [...document.querySelectorAll('[data-testid="composer-input"]')].filter(D.visible);
    return nodes.length === 1 ? nodes[0] : null;
  }

  function chatScope() {
    const main = document.querySelector('main, [role="main"]');
    if (!main) return null;
    const scrollers = [...main.querySelectorAll('[data-scroll-container]')].filter(D.visible);
    const named = scrollers.filter(node => (node.getAttribute('style') || '').includes('chat-scroller') || getComputedStyle(node).containerName?.split(' ').includes('chat-scroller'));
    if (named.length === 1) return named[0];
    const candidates = scrollers.filter(node => node.querySelector(`article, ${author}, ${user}`));
    return candidates.length === 1 ? candidates[0] : null;
  }

  function outputRoot(image, scope) {
    if (image.closest(`${user}, ${D.ignored}, [role="dialog"], [contenteditable="true"]`)) return null;
    const semantic = image.closest(author);
    if (semantic && scope.contains(semantic)) return semantic;
    for (let node = image.parentElement; node && node !== scope; node = node.parentElement) {
      if (!scope.contains(node) || node.querySelector(user)) return null;
      if (node.querySelector(feedback)) return node;
    }
    return null;
  }

  function imageCandidates(scope) {
    if (!scope) return [];
    const records = [];
    const seen = new Set();
    for (const image of scope.querySelectorAll('img')) {
      const root = outputRoot(image, scope);
      const url = D.imageUrl(image);
      if (!root || !D.allowedUrl(url, 'meta') || !D.visible(image)) continue;
      const generated = image.matches('[data-testid="generated-image"]') || image.closest('[data-testid="generated-image"]');
      const view = image.parentElement?.querySelector('[aria-label="View media"]') || image.closest('figure');
      const rect = image.getBoundingClientRect();
      if (!generated && !view && (Math.min(image.naturalWidth, image.naturalHeight) < 128 || Math.min(rect.width, rect.height) < 80)) continue;
      if (/avatar|profile picture|logo/i.test(image.alt || '')) continue;
      const sourceKey = D.mediaKey(url);
      if (seen.has(sourceKey)) continue;
      seen.add(sourceKey);
      records.push({ image, root, url, sourceKey, ready: D.imageReady(image, 96) });
    }
    return records;
  }

  function markerMatches(value, expected) {
    return expected.filter(item => {
      const escaped = item.marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^a-zA-Z0-9_])${escaped}(?=$|[^a-zA-Z0-9_])`, 'i').test(value);
    });
  }

  function identity(record, records, expected) {
    const proof = new Map(markerMatches(D.labels(record.image).join(' '), expected).map(item => [item.index, item]));
    for (let node = record.image.parentElement; node && record.root.contains(node); node = node.parentElement) {
      const local = records.filter(other => node.contains(other.image));
      if (local.length !== 1) break;
      const matches = markerMatches([...D.labels(node), D.text(node)].join(' '), expected);
      matches.forEach(item => proof.set(item.index, item));
      const heading = node.previousElementSibling;
      if (node !== record.root && heading?.matches('h1,h2,h3,h4,h5,h6,p,[role="heading"],figcaption') && !heading.querySelector('img,video')) {
        const before = markerMatches(D.text(heading), expected);
        before.forEach(item => proof.set(item.index, item));
      }
      if (node === record.root) break;
    }
    if (proof.size) return proof.size === 1 ? [...proof.values()][0] : null;
    return expected.length === 1 && records.length === 1 ? expected[0] : null;
  }

  function mapImages(records, expected) {
    if (records.length !== expected.length) return { error: `Meta returned ${records.length} images for ${expected.length} prompts. Exactly one separate image per prompt is required.` };
    const images = records.map(record => {
      const item = identity(record, records, expected);
      return item ? { index: item.index, label: item.marker, url: record.url, sourceKey: record.sourceKey } : null;
    });
    if (images.some(image => !image) || new Set(images.map(image => image?.index)).size !== expected.length) {
      return { error: 'Meta did not attach unique prompt labels to each image. The images cannot be matched safely; no completion-order guesses or downloads were made. Inspect this chat, then use a new run with fewer prompts if needed.' };
    }
    return { images: images.sort((left, right) => left.index - right.index) };
  }

  function requestEcho(scope, request) {
    const wanted = D.normaliseText(request);
    const candidates = [...scope.querySelectorAll(`${user}, article, p, [dir="auto"]`)]
      .filter(node => !node.closest(author) && !node.closest('[contenteditable="true"]'));
    return candidates.some(node => D.normaliseText(node.innerText || node.textContent) === wanted);
  }

  async function generate(payload, ctx) {
    D.assertPage('meta');
    if (typeof payload.request !== 'string' || !payload.request.trim() || !Array.isArray(payload.expected) || !payload.expected.length
      || payload.expected.some(item => !Number.isSafeInteger(item.index) || item.index < 1 || typeof item.marker !== 'string' || !item.marker.trim())
      || new Set(payload.expected.map(item => item.index)).size !== payload.expected.length
      || new Set(payload.expected.map(item => item.marker.toLowerCase())).size !== payload.expected.length) {
      throw D.error('INVALID_BATCH', 'Every image prompt must have a unique index and output marker.');
    }
    if (payload.expected.some(item => !markerMatches(payload.request, [item]).length)) throw D.error('INVALID_BATCH', 'The combined image request does not contain every expected output marker.');
    const initialUrl = location.href;
    if (new URL(initialUrl).pathname !== '/') {
      throw D.error('NEW_CHAT_REQUIRED', 'Start image generation in a new Meta AI chat on its home page. Existing chats are not reused or scraped.');
    }
    const editor = await D.waitFor(() => { D.assertPage('meta', initialUrl); return composer(); }, {
      signal: ctx.signal, message: 'The Meta AI composer is unavailable. Sign in, close overlays, and open a new chat before starting a new run.',
    });
    const baseline = new Set(imageCandidates(chatScope()).map(record => record.sourceKey));
    await ctx.checkpoint('meta:preparing', `Preparing one combined request for ${payload.expected.length} images.`, { baseline: [...baseline], expected: payload.expected });
    await D.fillEditor(editor, payload.request, ctx);
    D.assertPage('meta', initialUrl);
    await ctx.checkpoint('meta:submitting', 'Submitting the image batch once. Do not send other messages in this chat.', { submitted: true });
    D.submit(editor, editor.closest('form') || document.querySelector('main') || document, ctx.signal);
    const chat = await D.waitFor(() => {
      D.assertPage('meta');
      const scope = chatScope();
      return /^\/prompt\/[^/]+\/?$/.test(location.pathname) && scope && requestEcho(scope, payload.request) ? { url: location.href } : false;
    }, { signal: ctx.signal, timeout: 180_000, message: 'Meta did not confirm the submitted batch in a new chat. It was not sent again. Check the composer and chat before starting another run.' });
    await ctx.checkpoint('meta:generating', 'Waiting for all images in this batch’s new chat, with verified prompt labels.', { url: chat.url });
    let observed = 0;
    const final = await D.waitFor(async () => {
      D.assertPage('meta', chat.url);
      const scope = chatScope();
      if (!scope) return false;
      const fresh = imageCandidates(scope).filter(record => !baseline.has(record.sourceKey));
      if (fresh.length !== observed) {
        observed = fresh.length;
        await ctx.checkpoint('meta:generating', `Detected ${observed}/${payload.expected.length} images; checking labels and completion.`, { detected: observed });
      }
      if (fresh.length < payload.expected.length || fresh.some(record => !record.ready) || D.busy(scope) || D.busy(document.querySelector('main') || scope)) return false;
      return { records: fresh, mapping: mapImages(fresh, payload.expected) };
    }, {
      signal: ctx.signal, timeout: 25 * 60_000, stableFor: 2_000,
      signature: value => JSON.stringify([value.records.map(record => record.sourceKey), value.mapping]),
      message: () => `Meta image generation did not finish with ${payload.expected.length} verified separate images within 25 minutes (${observed} detected). Nothing was retried or downloaded. Check this chat for rate limits or missing labels.`,
    });
    if (final.mapping.error) throw D.error('IMAGE_MAPPING', final.mapping.error);
    if (payload.ratio) {
      const [width, height] = payload.ratio.split(':').map(Number);
      if (!width || !height || final.records.some(record => Math.abs((record.image.naturalWidth / record.image.naturalHeight) / (width / height) - 1) > 0.025)) {
        throw D.error('IMAGE_RATIO', `Meta returned an image with a different aspect ratio from ${payload.ratio}. The batch was not saved or sent to Vibes.`);
      }
    }
    const result = { url: chat.url, images: final.mapping.images };
    await ctx.checkpoint('meta:verified', 'Every image is ready and mapped to its prompt.', { images: result.images });
    return result;
  }

  api.meta = Object.freeze({ generate, composer, chatScope, imageCandidates, markerMatches, mapImages, requestEcho });
})();
