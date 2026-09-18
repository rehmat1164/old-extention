import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_SETTINGS,
  MODE_OPTIONS,
  MODES,
  RATIOS,
  RESOLUTIONS,
  assetFilename,
  batchImagePrompt,
  createSession,
  exportPlan,
  parsePrompts,
  runManifest,
  sortImages,
  validateConfig,
} from '../js/lib/model.js';

function image(assetId, name, type = 'image/png', size = 1024) {
  return { assetId, name, type, size, sha256: `hash-${assetId}` };
}

test('model exposes only the three supported modes and expected options', () => {
  assert.deepEqual(MODES, {
    IMAGE: 'image',
    IMAGE_VIDEO: 'image-video',
    PROMPT_VIDEO: 'prompt-video',
  });
  assert.deepEqual(MODE_OPTIONS.map(({ value }) => value), Object.values(MODES));
  assert.deepEqual(RATIOS, ['1:1', '16:9', '9:16', '4:3', '3:4']);
  assert.deepEqual(RESOLUTIONS, ['480p', '720p', '1080p']);
  assert.deepEqual(DEFAULT_SETTINGS, {
    mode: 'image',
    ratio: '9:16',
    resolution: '720p',
    variants: [1],
    includeImages: false,
    autoSave: true,
    imagePrompts: '',
    videoPrompts: '',
  });
});

test('prompt parsing supports CRLF and whitespace-only blank separators', () => {
  assert.deepEqual(
    parsePrompts(' first line\r\nsecond line\r\n \t\u00a0\r\n third line\r\nfourth line '),
    ['first line\nsecond line', 'third line\nfourth line'],
  );
});

test('automatic ZIP saving defaults on and validates the manual review setting', () => {
  for (const autoSave of [true, false]) {
    const session = createSession({ imagePrompts: 'An apple', autoSave });
    assert.equal(session.settings.autoSave, autoSave);
    assert.equal(runManifest(session).settings.autoSave, autoSave);
  }
  assert.equal(validateConfig({ imagePrompts: 'An apple', autoSave: 'false' }).valid, false);
});

test('image names sort naturally and reject ambiguous duplicate mappings', () => {
  const uploads = [
    image('ten', 'image10.png'),
    image('two', 'image 2.png'),
    image('one', '1.jpg', 'image/jpeg'),
  ];
  assert.deepEqual(sortImages(uploads).map(({ name }) => name), ['1.jpg', 'image 2.png', 'image10.png']);
  assert.throws(
    () => sortImages([image('one', 'Image 1.png'), image('two', 'image 1.png')]),
    /Duplicate upload filename/,
  );
});

test('configuration validates all three workflow counts', () => {
  const imageOnly = validateConfig({
    ...DEFAULT_SETTINGS,
    imagePrompts: 'A snowy mountain\n\nA coastal village',
  });
  assert.equal(imageOnly.valid, true);
  assert.equal(imageOnly.count, 2);

  const imageToVideo = validateConfig({
    ...DEFAULT_SETTINGS,
    mode: MODES.IMAGE_VIDEO,
    videoPrompts: 'Slow camera move\n\nWarm sunset motion',
  }, [image('two', 'image 2.png'), image('one', 'image 1.png')]);
  assert.equal(imageToVideo.valid, true);
  assert.equal(imageToVideo.count, 2);

  const promptToVideo = validateConfig({
    ...DEFAULT_SETTINGS,
    mode: MODES.PROMPT_VIDEO,
    imagePrompts: 'A fox in a forest\n\nA whale in the ocean',
    videoPrompts: 'The fox walks forward\n\nThe whale dives down',
  });
  assert.equal(promptToVideo.valid, true);
  assert.equal(promptToVideo.count, 2);
});

test('configuration strictly rejects invalid options, variants, and image files', () => {
  const result = validateConfig({
    ...DEFAULT_SETTINGS,
    mode: MODES.IMAGE_VIDEO,
    ratio: '2:1',
    resolution: '4k',
    variants: [1, '2', 1, 5],
    videoPrompts: 'Animate this',
  }, [image('bad', 'bad.gif', 'image/gif', 10 * 1024 * 1024 + 1)]);

  assert.equal(result.valid, false);
  assert.match(result.errors.join('\n'), /Ratio must be one of/);
  assert.match(result.errors.join('\n'), /Resolution must be one of/);
  assert.match(result.errors.join('\n'), /whole numbers from 1 to 4/);
  assert.match(result.errors.join('\n'), /selected more than once/);
  assert.match(result.errors.join('\n'), /PNG, JPG, or WebP/);
  assert.match(result.errors.join('\n'), /10 MiB/);
});

test('sessions map image-to-video prompts to natural filename order', () => {
  const session = createSession({
    ...DEFAULT_SETTINGS,
    mode: MODES.IMAGE_VIDEO,
    videoPrompts: 'Prompt one\n\nPrompt two\n\nPrompt ten',
  }, [
    image('ten', 'image10.png'),
    image('two', 'image 2.png'),
    image('one', '1.jpg', 'image/jpeg'),
  ], 'session-123');

  assert.equal(session.id, 'session-123');
  assert.equal(session.status, 'ready');
  assert.equal(session.stage, 'setup');
  assert.deepEqual(session.jobs.map(({ originalName, videoPrompt }) => [originalName, videoPrompt]), [
    ['1.jpg', 'Prompt one'],
    ['image 2.png', 'Prompt two'],
    ['image10.png', 'Prompt ten'],
  ]);
  assert.equal(session.jobs[0].image.assetId, 'one');
  assert.equal(session.zipName, 'mete-run-session123.zip');
  assert.equal(assetFilename('session-123', 1, 'image/jpeg'), 'mete_session123_image_001.jpg');
});

test('sessions canonicalize the common image/jpg alias for binary verification', () => {
  const session = createSession({
    ...DEFAULT_SETTINGS,
    mode: MODES.IMAGE_VIDEO,
    videoPrompts: 'Move through the scene',
  }, [image('source', 'source.jpg', 'image/jpg')], 'jpg-alias');

  assert.equal(session.jobs[0].image.type, 'image/jpeg');
});

test('batch image prompts request separately labelled images without a collage', () => {
  const prompt = batchImagePrompt(['A red kite', 'A blue boat'], '16:9');
  assert.match(prompt, /Image 1:\nA red kite/);
  assert.match(prompt, /Image 2:\nA blue boat/);
  assert.match(prompt, /exactly 2 SEPARATE images/);
  assert.match(prompt, /same order/);
  assert.match(prompt, /16:9 aspect ratio/);
  assert.match(prompt, /Do not make a collage/);
});

test('export plans include every selected asset with stable output names', () => {
  const session = createSession({
    ...DEFAULT_SETTINGS,
    mode: MODES.PROMPT_VIDEO,
    includeImages: true,
    variants: [1, 2],
    imagePrompts: 'First image\n\nSecond image',
    videoPrompts: 'First video\n\nSecond video',
  }, [], 'run-plan');
  session.jobs[0].image = image('image-1', 'generated-1.png');
  session.jobs[1].image = image('image-2', 'generated-2.webp', 'image/webp');
  session.jobs[0].variants = [
    { variant: 1, assetId: 'video-11', type: 'video/mp4' },
    { variant: 2, assetId: 'video-12', type: 'video/mp4' },
  ];
  session.jobs[1].variants = [
    { variant: 1, assetId: 'video-21', type: 'video/mp4' },
    { variant: 2, assetId: 'video-22', type: 'video/mp4' },
  ];

  assert.deepEqual(exportPlan(session), [
    { assetId: 'image-1', path: 'images/image_001.png' },
    { assetId: 'image-2', path: 'images/image_002.webp' },
    { assetId: 'video-11', path: 'videos/video_001_variant_1.mp4' },
    { assetId: 'video-12', path: 'videos/video_001_variant_2.mp4' },
    { assetId: 'video-21', path: 'videos/video_002_variant_1.mp4' },
    { assetId: 'video-22', path: 'videos/video_002_variant_2.mp4' },
  ]);

  session.jobs[1].variants = [{ variant: 1, assetId: 'video-21', type: 'video/mp4' }];
  assert.throws(() => exportPlan(session), /missing selected video variant 2/);

  session.jobs[1].variants = [
    { variant: 1, assetId: 'video-21', type: 'video/mp4' },
    { variant: 2, assetId: 'video-22' },
  ];
  assert.throws(() => exportPlan(session), /variant 2 is not an MP4 asset/);
});

test('image-mode exports images even when includeImages is false', () => {
  const session = createSession({ ...DEFAULT_SETTINGS, imagePrompts: 'One image' }, [], 'image-only');
  session.jobs[0].image = image('generated', 'generated.jpg', 'image/jpeg');
  assert.deepEqual(exportPlan(session), [{ assetId: 'generated', path: 'images/image_001.jpg' }]);
});

test('manifests retain workflow mappings without source URLs or raw data URLs', () => {
  const session = createSession({
    ...DEFAULT_SETTINGS,
    mode: MODES.PROMPT_VIDEO,
    includeImages: true,
    variants: [2],
    imagePrompts: 'A lantern',
    videoPrompts: 'The lantern sways',
  }, [], 'manifest-run');
  session.meta = { chatUrl: 'https://www.meta.ai/prompt/chat-id?signature=secret' };
  session.vibes = { projectUrl: 'https://vibes.ai/projects/project-id?token=secret' };
  session.jobs[0].image = {
    ...image('image-1', 'generated.png'),
    src: 'data:image/png;base64,private',
  };
  session.jobs[0].variants = [{
    variant: 2,
    assetId: 'video-1',
    type: 'video/mp4',
    sha256: 'video-hash',
    src: 'https://signed-cdn.example/video.mp4?signature=private',
  }];

  const manifest = runManifest(session);
  const serialized = JSON.stringify(manifest);
  assert.equal(manifest.chatUrl, 'https://www.meta.ai/prompt/chat-id');
  assert.equal(manifest.projectUrl, 'https://vibes.ai/projects/project-id');
  assert.equal(manifest.jobs[0].image.filename, 'images/image_001.png');
  assert.equal(manifest.jobs[0].variants[0].filename, 'videos/video_001.mp4');
  assert.equal(manifest.jobs[0].variants[0].sha256, 'video-hash');
  assert.doesNotMatch(serialized, /signed-cdn|data:image|signature=private|token=secret/);
});
