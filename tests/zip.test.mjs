import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createZipBlob, crc32, writeZip } from '../js/lib/zip.js';

function uint16(view, offset) {
  return view.getUint16(offset, true);
}

function uint32(view, offset) {
  return view.getUint32(offset, true);
}

function readArchive(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.byteLength - 22;
  assert.equal(uint32(view, end), 0x06054b50);
  const count = uint16(view, end + 10);
  let offset = uint32(view, end + 16);
  const files = [];

  for (let index = 0; index < count; index += 1) {
    assert.equal(uint32(view, offset), 0x02014b50);
    assert.equal(uint16(view, offset + 8) & 0x0800, 0x0800);
    const crc = uint32(view, offset + 16);
    const size = uint32(view, offset + 24);
    const nameLength = uint16(view, offset + 28);
    const extraLength = uint16(view, offset + 30);
    const commentLength = uint16(view, offset + 32);
    const localOffset = uint32(view, offset + 42);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    assert.equal(uint32(view, localOffset), 0x04034b50);
    assert.equal(uint16(view, localOffset + 6) & 0x0008, 0x0008);
    const localNameLength = uint16(view, localOffset + 26);
    const localExtraLength = uint16(view, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = bytes.subarray(dataStart, dataStart + size);
    const descriptor = dataStart + size;
    assert.equal(uint32(view, descriptor), 0x08074b50);
    assert.equal(uint32(view, descriptor + 4), crc);
    assert.equal(uint32(view, descriptor + 8), size);
    assert.equal(crc32(data), crc);
    files.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function fixtureArchive() {
  return createZipBlob([
    { name: 'images/hello.txt', blob: new Blob(['hello Mete Run']) },
    { name: 'images/niño-猫.txt', blob: new Blob(['unicode works']) },
    { name: 'videos/empty.mp4', blob: new Blob([]) },
  ]);
}

test('CRC32 matches the standard check value', () => {
  assert.equal(crc32('123456789'), 0xcbf43926);
});

test('asynchronous progress is settled before close, and its failures abort the archive', async () => {
  let reported = false;
  let closed = false;
  await writeZip([{ name: 'image.png', blob: new Blob(['image']) }], {
    async write() {},
    async close() { assert.equal(reported, true); closed = true; },
  }, async () => { await new Promise(resolve => setTimeout(resolve, 2)); reported = true; });
  assert.equal(closed, true);
  let aborted = false;
  await assert.rejects(writeZip([{ name: 'image.png', blob: new Blob(['image']) }], {
    async write() {}, async close() { assert.fail('A failed progress checkpoint cannot commit the ZIP.'); },
    async abort() { aborted = true; },
  }, async () => { throw new Error('Checkpoint unavailable'); }), /Checkpoint unavailable/);
  assert.equal(aborted, true);
});

test('ZIP writer emits UTF-8 store entries with descriptors and valid CRCs', async () => {
  const archive = await fixtureArchive();
  assert.equal(archive.type, 'application/zip');
  const files = readArchive(new Uint8Array(await archive.arrayBuffer()));
  assert.deepEqual(files.map(({ name }) => name), [
    'images/hello.txt',
    'images/niño-猫.txt',
    'videos/empty.mp4',
  ]);
  assert.equal(new TextDecoder().decode(files[0].data), 'hello Mete Run');
  assert.equal(new TextDecoder().decode(files[1].data), 'unicode works');
  assert.equal(files[2].data.byteLength, 0);
});

test('generated archives open with Python zipfile when it is available', async (t) => {
  const probe = spawnSync('python3', ['--version']);
  if (probe.error || probe.status !== 0) {
    t.skip('python3 is unavailable');
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), 'mete-run-zip-'));
  try {
    const archivePath = join(directory, 'archive.zip');
    writeFileSync(archivePath, new Uint8Array(await (await fixtureArchive()).arrayBuffer()));
    execFileSync('python3', ['-c', [
      'import sys, zipfile',
      'with zipfile.ZipFile(sys.argv[1]) as archive:',
      "  assert archive.read('images/hello.txt') == b'hello Mete Run'",
      "  assert archive.read('images/niño-猫.txt') == b'unicode works'",
      "  assert archive.read('videos/empty.mp4') == b''",
    ].join('\n'), archivePath], { stdio: 'pipe' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('streaming writes report progress and close a successful writer', async () => {
  const chunks = [];
  const progress = [];
  const writer = {
    closed: false,
    aborted: false,
    async write(chunk) {
      chunks.push(new Uint8Array(chunk));
    },
    async close() {
      this.closed = true;
    },
    async abort() {
      this.aborted = true;
    },
  };

  const result = await writeZip([
    { name: 'videos/large.mp4', blob: new Blob([new Uint8Array(256 * 1024)]) },
  ], writer, (event) => progress.push(event));
  assert.equal(writer.closed, true);
  assert.equal(writer.aborted, false);
  assert.equal(result.entries, 1);
  assert.ok(chunks.length > 3);
  assert.equal(progress.at(-1).progress, 1);
  readArchive(new Uint8Array(await new Blob(chunks).arrayBuffer()));
});

test('unsafe paths and writer failures abort rather than leave a partial archive', async () => {
  const unsafeWriter = {
    aborted: false,
    async write() {},
    async close() {},
    async abort() {
      this.aborted = true;
    },
  };
  await assert.rejects(
    writeZip([{ name: '../escape.txt', blob: new Blob(['no']) }], unsafeWriter),
    /Unsafe ZIP entry path/,
  );
  assert.equal(unsafeWriter.aborted, true);

  const brokenWriter = {
    aborted: false,
    async write() {
      throw new Error('disk full');
    },
    async close() {},
    async abort() {
      this.aborted = true;
    },
  };
  await assert.rejects(
    writeZip([{ name: 'images/safe.txt', blob: new Blob(['content']) }], brokenWriter),
    /disk full/,
  );
  assert.equal(brokenWriter.aborted, true);

  await assert.rejects(
    createZipBlob([
      { name: 'images/one.txt', blob: new Blob(['1']) },
      { name: 'images/ONE.txt', blob: new Blob(['2']) },
    ]),
    /Duplicate ZIP entry path/,
  );
});
