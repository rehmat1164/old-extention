import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_RUN_KEY,
  STORE_NAMES,
  clear,
  entries,
  get,
  getCurrentRun,
  put,
  putCurrentRun,
  remove,
} from '../js/lib/store.js';

test.beforeEach(async () => {
  await Promise.all(STORE_NAMES.map(store => clear(store)));
});

test('stores Blob assets directly and round-trips the current session', async () => {
  const blob = new Blob(['local image bytes'], { type: 'image/png' });
  await put('assets', 'asset:image:1', { blob, runId: 'run-1' });

  const asset = await get('assets', 'asset:image:1');
  assert.ok(asset.blob instanceof Blob);
  assert.equal(asset.blob.type, 'image/png');
  assert.equal(await asset.blob.text(), 'local image bytes');

  const session = { id: 'run-1', status: 'ready', jobs: [{ index: 1 }] };
  await putCurrentRun(session);
  assert.deepEqual(await getCurrentRun(), session);
  assert.deepEqual(await get('runs', CURRENT_RUN_KEY), session);
});

test('lists entries and removes or clears only the selected store', async () => {
  await put('drafts', 'draft-b', { value: 'b' });
  await put('drafts', 'draft-a', { value: 'a' });
  await put('assets', 'asset-1', new Blob(['keep me']));

  assert.deepEqual(await entries('drafts'), [
    { key: 'draft-a', value: { value: 'a' } },
    { key: 'draft-b', value: { value: 'b' } },
  ]);

  await remove('drafts', 'draft-a');
  assert.equal(await get('drafts', 'draft-a'), undefined);
  assert.deepEqual(await entries('drafts'), [{ key: 'draft-b', value: { value: 'b' } }]);

  await clear('drafts');
  assert.deepEqual(await entries('drafts'), []);
  assert.ok(await get('assets', 'asset-1'));
});

test('surfaces an aborted transaction error and remains usable afterward', async () => {
  await assert.rejects(
    put('assets', undefined, { invalid: true }),
    error => error.message === 'Mete Run assets transaction failed.' && error.cause?.name === 'DataError',
  );

  await put('assets', 'asset:after-error', new Blob(['recovered']));
  const asset = await get('assets', 'asset:after-error');
  assert.equal(await asset.text(), 'recovered');
});

test('rejects unknown object stores before opening a transaction', () => {
  assert.throws(() => get('unknown', 'any-key'), /Unknown Mete Run store/);
});
