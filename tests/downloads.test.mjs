import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession, exportPlan } from '../js/lib/model.js';
import { downloadInventory } from '../js/lib/downloads.js';

function fixture() {
  const session = createSession({ mode: 'prompt-video', imagePrompts: 'Apple\n\nLake', videoPrompts: 'Orbit\n\nFly', variants: [2, 4], includeImages: true }, [], 'downloads');
  for (const job of session.jobs) {
    job.image = { assetId: `image-${job.index}`, type: 'image/png', size: 100, sha256: `image-hash-${job.index}` };
    job.upload = { verified: true };
    job.variants = [4, 2, 1, 3].map(variant => ({ variant, url: `https://media.fbcdn.net/private-${variant}?signature=secret`,
      ...([2, 4].includes(variant) ? { assetId: `video-${job.index}-${variant}`, size: 200, type: 'video/mp4' } : {}) }));
  }
  return session;
}

test('download manager derives numbered filenames from the actual export mapping, never arrival order', () => {
  const session = fixture();
  session.jobs.reverse();
  const inventory = downloadInventory(session);
  assert.deepEqual(inventory.groups.map(group => group.index), [1, 2]);
  assert.deepEqual(inventory.files.filter(file => file.selected).map(({ path, assetId }) => ({ path, assetId }))
    .sort((a, b) => a.path.localeCompare(b.path)), exportPlan(session).sort((a, b) => a.path.localeCompare(b.path)));
  assert.equal(inventory.selected, 6);
  assert.equal(inventory.ready, 6);
  assert.equal(inventory.cached, 6);
  assert.equal(inventory.bytes, 1000);
  assert.doesNotMatch(JSON.stringify(inventory), /signature=|fbcdn/);
});

test('uncached and excluded candidates remain distinguishable from pending or locally saved files', () => {
  const session = fixture();
  let inventory = downloadInventory(session, { variants: [1], includeImages: false });
  assert.equal(inventory.selected, 2);
  assert.equal(inventory.ready, 0);
  assert.equal(inventory.cached, 6);
  assert.equal(inventory.files[0].selected, false);
  assert.equal(inventory.files[0].assetId, 'image-1');
  assert.equal(inventory.files[0].path, null);
  assert.deepEqual(inventory.files.filter(file => file.selected).map(file => [file.state, file.path]), [
    ['available', 'videos/video_001.mp4'], ['available', 'videos/video_002.mp4'],
  ]);
  session.jobs[1].variants = [];
  inventory = downloadInventory(session, { variants: [1], includeImages: false });
  assert.equal(inventory.groups[1].files.find(file => file.variant === 1).state, 'pending');
  assert.equal(downloadInventory(session, { variants: [], includeImages: false }).selected, 0);
});

test('only matching file identities and filenames can be described as present in the last ZIP', () => {
  const session = fixture();
  session.lastExport = { name: 'saved.zip', files: exportPlan(session) };
  assert.ok(downloadInventory(session).files.filter(file => file.selected).every(file => file.state === 'archived'));
  const changed = downloadInventory(session, { variants: [2], includeImages: false });
  assert.ok(changed.files.filter(file => file.selected).every(file => file.state === 'local'));
  assert.equal(changed.files.find(file => file.variant === 2).path, 'videos/video_001.mp4');
  session.jobs[0].image.assetId = 'different-image';
  assert.equal(downloadInventory(session).files[0].state, 'local');
});

test('image-only downloads stay selected independently of the video include-images preference', () => {
  const session = createSession({ imagePrompts: 'An apple' });
  let inventory = downloadInventory(session, { includeImages: false });
  assert.equal(inventory.selected, 1);
  assert.equal(inventory.ready, 0);
  session.jobs[0].image = { assetId: 'image', type: 'image/jpeg', size: 300 };
  inventory = downloadInventory(session, { includeImages: false });
  assert.equal(inventory.ready, 1);
  assert.equal(inventory.files[0].path, 'images/image_001.jpg');
  assert.deepEqual(downloadInventory(null).files, []);
});
