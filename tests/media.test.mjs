import assert from 'node:assert/strict';
import test from 'node:test';
import { allowedMediaUrl, providerForUrl, publicStatus, vibesProjectUrl } from '../js/lib/policy.js';
import { downloadMedia, mediaType, sha256 } from '../js/lib/media.js';

const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);

test('provider and media allowlists reject lookalike hosts, credentials, non-HTTPS and local files', () => {
  for (const url of ['https://meta.ai.evil.test/', 'http://vibes.ai/', 'https://u:p@meta.ai/', 'https://vibes.ai:8080/', 'file:///etc/passwd', 'javascript:alert(1)']) {
    assert.equal(providerForUrl(url), null, url);
    assert.equal(allowedMediaUrl(url, 'meta'), false, url);
  }
  assert.equal(providerForUrl('https://www.meta.ai/prompt/123'), 'meta');
  assert.equal(allowedMediaUrl('https://video.fbcdn.net/file.mp4?token=private', 'vibes'), true);
  assert.equal(allowedMediaUrl('blob:https://vibes.ai/id', 'vibes'), true);
  assert.equal(allowedMediaUrl('blob:https://meta.ai/id', 'vibes'), false);
  assert.equal(allowedMediaUrl('https://anything.test/file.mp4', 'vibes'), false);
});

test('binary media validation rejects a thumbnail or HTML pretending to be a video', async () => {
  assert.equal(await mediaType(new Blob([pngBytes]), 'image'), 'image/png');
  await assert.rejects(mediaType(new Blob([pngBytes], { type: 'video/mp4' }), 'video'), /invalid video/);
  await assert.rejects(mediaType(new Blob(['<html>Please sign in</html>'], { type: 'image/png' }), 'image'), /invalid image/);
  await assert.rejects(mediaType(new Blob([new Uint8Array(4), 'ftypavif']), 'video'), /invalid video/);
  assert.match(await sha256(new Blob([pngBytes])), /^[0-9a-f]{64}$/);
});

test('media fetch never contacts an unapproved host', async () => {
  let fetched = false;
  await assert.rejects(downloadMedia({ url: 'https://evil.test/video.mp4', provider: 'vibes', kind: 'video', fetcher: () => { fetched = true; } }), /allowlist/);
  assert.equal(fetched, false);
});

test('media fetch validates bytes, blocks redirects and uses chunked page fallback for blob URLs', async () => {
  let options;
  const direct = await downloadMedia({
    url: 'https://media.fbcdn.net/image.png', provider: 'meta', kind: 'image',
    fetcher: async (_, opts) => { options = opts; return new Response(pngBytes); },
  });
  assert.equal(direct.type, 'image/png');
  assert.equal(options.redirect, 'error');
  const local = await downloadMedia({
    url: 'blob:https://www.meta.ai/example', provider: 'meta', kind: 'image',
    readChunk: async ({ offset }) => ({ total: pngBytes.length, offset, base64: Buffer.from(pngBytes).toString('base64') }),
  });
  assert.equal(local.size, pngBytes.length);
  await assert.rejects(downloadMedia({
    url: 'blob:https://www.meta.ai/example', provider: 'meta', kind: 'image',
    readChunk: async () => ({ total: 99, offset: 1, base64: '' }),
  }), /invalid or oversized/);
});

test('public status excludes signed result URLs and binary transfer data', () => {
  const status = publicStatus({
    jobs: [{ image: { assetId: 'a', url: 'https://cdn/?secret=1', dataUrl: 'data:private', sourceKey: 'secret' },
      upload: { filename: 'image.png', verified: true, sourceKey: 'https://cdn/?secret=4' }, variants: [{ variant: 1, url: 'https://cdn/?secret=2' }] }],
    meta: { tabId: 1, url: 'https://www.meta.ai/prompt/test', images: [{ url: 'https://cdn/?secret=3' }] },
    operation: { id: 'op', action: 'meta:generate', payload: 'private media data' },
  });
  assert.doesNotMatch(JSON.stringify(status), /secret|data:private|private media data/);
  assert.equal(status.jobs[0].image.assetId, 'a');
  assert.equal(status.jobs[0].upload.verified, true);
});

test('project identities are exact Vibes project paths, not arbitrary provider URLs', () => {
  assert.equal(vibesProjectUrl('https://vibes.ai/projects/one/?token=private'), 'https://vibes.ai/projects/one');
  for (const url of ['https://vibes.ai/', 'https://vibes.ai/projects/one/other', 'https://vibes.ai.evil.test/projects/one', undefined]) {
    assert.equal(vibesProjectUrl(url), null);
  }
});
