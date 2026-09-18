const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;
const MAX_UINT32_BIGINT = BigInt(MAX_UINT32);
const LOCAL_FILE_HEADER = 0x04034b50;
const CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const DATA_DESCRIPTOR = 0x08074b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const UTF8_DATA_DESCRIPTOR_FLAGS = 0x0808;
const STORE_METHOD = 0;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 0x0314;
const CHUNK_SIZE = 1024 * 1024;
const encoder = new TextEncoder();

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  CRC_TABLE[index] = value >>> 0;
}

function zipError(message, cause) {
  const error = new Error(message);
  if (cause) error.cause = cause;
  return error;
}

function assertUint16(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT16) {
    throw new RangeError(`${label} exceeds ZIP32 limits.`);
  }
}

function assertUint32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_UINT32) {
    throw new RangeError(`${label} exceeds ZIP32 limits.`);
  }
}

function writeUint16(view, offset, value) {
  assertUint16(value, '16-bit ZIP value');
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  assertUint32(value, '32-bit ZIP value');
  view.setUint32(offset, value, true);
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  throw new TypeError('Blob streams must yield binary chunks.');
}

function supportedBlob(value) {
  return value
    && typeof value === 'object'
    && Number.isSafeInteger(value.size)
    && value.size >= 0
    && (typeof value.stream === 'function' || (typeof value.slice === 'function' && typeof value.arrayBuffer === 'function'));
}

function safePath(name) {
  if (typeof name !== 'string' || !name) throw new TypeError('ZIP entry names must be non-empty text.');
  const normalized = name.normalize('NFC');
  if (
    normalized.length === 0
    || normalized.includes('\\')
    || normalized.includes('\0')
    || /[\u0001-\u001f\u007f]/.test(normalized)
    || normalized.startsWith('/')
    || /^[a-zA-Z]:/.test(normalized)
    || normalized.endsWith('/')
  ) {
    throw new Error(`Unsafe ZIP entry path: ${name}`);
  }
  const parts = normalized.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe ZIP entry path: ${name}`);
  }
  return normalized;
}

function createLocalHeader(nameBytes) {
  const bytes = new Uint8Array(30 + nameBytes.byteLength);
  const view = new DataView(bytes.buffer);
  writeUint32(view, 0, LOCAL_FILE_HEADER);
  writeUint16(view, 4, VERSION_NEEDED);
  writeUint16(view, 6, UTF8_DATA_DESCRIPTOR_FLAGS);
  writeUint16(view, 8, STORE_METHOD);
  writeUint16(view, 10, 0);
  writeUint16(view, 12, 0);
  writeUint32(view, 14, 0);
  writeUint32(view, 18, 0);
  writeUint32(view, 22, 0);
  writeUint16(view, 26, nameBytes.byteLength);
  writeUint16(view, 28, 0);
  bytes.set(nameBytes, 30);
  return bytes;
}

function createDataDescriptor(crc, size) {
  const bytes = new Uint8Array(16);
  const view = new DataView(bytes.buffer);
  writeUint32(view, 0, DATA_DESCRIPTOR);
  writeUint32(view, 4, crc);
  writeUint32(view, 8, size);
  writeUint32(view, 12, size);
  return bytes;
}

function createCentralDirectoryHeader(entry) {
  const bytes = new Uint8Array(46 + entry.nameBytes.byteLength);
  const view = new DataView(bytes.buffer);
  writeUint32(view, 0, CENTRAL_DIRECTORY_HEADER);
  writeUint16(view, 4, VERSION_MADE_BY);
  writeUint16(view, 6, VERSION_NEEDED);
  writeUint16(view, 8, UTF8_DATA_DESCRIPTOR_FLAGS);
  writeUint16(view, 10, STORE_METHOD);
  writeUint16(view, 12, 0);
  writeUint16(view, 14, 0);
  writeUint32(view, 16, entry.crc);
  writeUint32(view, 20, entry.size);
  writeUint32(view, 24, entry.size);
  writeUint16(view, 28, entry.nameBytes.byteLength);
  writeUint16(view, 30, 0);
  writeUint16(view, 32, 0);
  writeUint16(view, 34, 0);
  writeUint16(view, 36, 0);
  writeUint32(view, 38, 0);
  writeUint32(view, 42, entry.localOffset);
  bytes.set(entry.nameBytes, 46);
  return bytes;
}

function createEndOfCentralDirectory(entryCount, directorySize, directoryOffset) {
  const bytes = new Uint8Array(22);
  const view = new DataView(bytes.buffer);
  writeUint32(view, 0, END_OF_CENTRAL_DIRECTORY);
  writeUint16(view, 4, 0);
  writeUint16(view, 6, 0);
  writeUint16(view, 8, entryCount);
  writeUint16(view, 10, entryCount);
  writeUint32(view, 12, directorySize);
  writeUint32(view, 16, directoryOffset);
  writeUint16(view, 20, 0);
  return bytes;
}

function preflight(entries) {
  if (!Array.isArray(entries)) throw new TypeError('ZIP entries must be an array.');
  if (entries.length > MAX_UINT16) throw new RangeError('ZIP has too many entries for ZIP32.');

  const paths = new Set();
  let localSize = 0n;
  let directorySize = 0n;
  const prepared = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new TypeError(`ZIP entry ${index + 1} must be an object.`);
    const name = safePath(entry.name);
    const duplicateKey = name.toLocaleLowerCase('en-US');
    if (paths.has(duplicateKey)) throw new Error(`Duplicate ZIP entry path: ${name}`);
    paths.add(duplicateKey);
    if (!supportedBlob(entry.blob)) throw new TypeError(`ZIP entry ${name} must contain a Blob.`);
    if (entry.blob.size > MAX_UINT32) throw new RangeError(`ZIP entry ${name} exceeds ZIP32 limits.`);

    const nameBytes = encoder.encode(name);
    assertUint16(nameBytes.byteLength, `ZIP entry name ${name}`);
    const blobSize = BigInt(entry.blob.size);
    const localOffset = localSize;
    localSize += 30n + BigInt(nameBytes.byteLength) + blobSize + 16n;
    directorySize += 46n + BigInt(nameBytes.byteLength);
    if (localSize > MAX_UINT32_BIGINT || directorySize > MAX_UINT32_BIGINT) {
      throw new RangeError('ZIP exceeds ZIP32 limits.');
    }
    return {
      name,
      nameBytes,
      blob: entry.blob,
      size: entry.blob.size,
      localOffset: Number(localOffset),
      crc: 0,
    };
  });

  const archiveSize = localSize + directorySize + 22n;
  if (archiveSize > MAX_UINT32_BIGINT) throw new RangeError('ZIP exceeds ZIP32 limits.');
  return {
    entries: prepared,
    payloadBytes: prepared.reduce((sum, entry) => sum + entry.size, 0),
    directoryOffset: Number(localSize),
    directorySize: Number(directorySize),
  };
}

async function streamBlob(blob, onChunk) {
  if (typeof blob.stream === 'function') {
    const stream = blob.stream();
    if (!stream || typeof stream.getReader !== 'function') {
      throw new TypeError('Blob stream is not readable.');
    }
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        await onChunk(toBytes(value));
      }
    } catch (error) {
      try {
        await reader.cancel(error);
      } catch {
        // Preserve the original stream/write failure.
      }
      throw error;
    } finally {
      reader.releaseLock?.();
    }
  }

  for (let offset = 0; offset < blob.size; offset += CHUNK_SIZE) {
    const part = blob.slice(offset, Math.min(offset + CHUNK_SIZE, blob.size));
    await onChunk(new Uint8Array(await part.arrayBuffer()));
  }
}

function updateCrc(crc, bytes) {
  let value = crc;
  for (let index = 0; index < bytes.byteLength; index += 1) {
    value = CRC_TABLE[(value ^ bytes[index]) & 0xff] ^ (value >>> 8);
  }
  return value >>> 0;
}

function progressEvent(entry, entryIndex, entryCount, completedBytes, totalBytes) {
  return {
    name: entry.name,
    entryIndex: entryIndex + 1,
    entryCount,
    completedBytes,
    totalBytes,
    progress: totalBytes === 0 ? 1 : completedBytes / totalBytes,
  };
}

async function abortWritable(writable, reason) {
  if (typeof writable?.abort !== 'function') return;
  try {
    await writable.abort(reason);
  } catch {
    // The original error is more useful than an abort failure.
  }
}

export function crc32(value) {
  const bytes = typeof value === 'string' ? encoder.encode(value) : toBytes(value);
  return (updateCrc(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
}

export async function writeZip(entries, writable, onProgress) {
  if (!writable || typeof writable.write !== 'function' || typeof writable.close !== 'function') {
    throw new TypeError('A writable with write() and close() is required.');
  }
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw new TypeError('onProgress must be a function.');
  }

  let completed = false;
  try {
    const plan = preflight(entries);
    let written = 0;
    let completedPayload = 0;
    const write = async (bytes) => {
      await writable.write(bytes);
      written += bytes.byteLength;
    };

    for (let index = 0; index < plan.entries.length; index += 1) {
      const entry = plan.entries[index];
      await write(createLocalHeader(entry.nameBytes));
      let size = 0;
      let crc = 0xffffffff;
      await streamBlob(entry.blob, async (chunk) => {
        if (size + chunk.byteLength > entry.size) {
          throw new Error(`ZIP entry ${entry.name} produced more data than its Blob size.`);
        }
        crc = updateCrc(crc, chunk);
        size += chunk.byteLength;
        await write(chunk);
        completedPayload += chunk.byteLength;
        if (onProgress) await onProgress(progressEvent(entry, index, plan.entries.length, completedPayload, plan.payloadBytes));
      });
      if (size !== entry.size) {
        throw new Error(`ZIP entry ${entry.name} produced less data than its Blob size.`);
      }
      entry.crc = (crc ^ 0xffffffff) >>> 0;
      await write(createDataDescriptor(entry.crc, size));
      if (onProgress && entry.size === 0) {
        await onProgress(progressEvent(entry, index, plan.entries.length, completedPayload, plan.payloadBytes));
      }
    }

    for (const entry of plan.entries) await write(createCentralDirectoryHeader(entry));
    await write(createEndOfCentralDirectory(plan.entries.length, plan.directorySize, plan.directoryOffset));
    await writable.close();
    completed = true;
    return { entries: plan.entries.length, bytesWritten: written };
  } catch (error) {
    if (!completed) await abortWritable(writable, error);
    throw error;
  }
}

export async function createZipBlob(entries) {
  const chunks = [];
  let aborted = false;
  const writable = {
    async write(chunk) {
      chunks.push(new Uint8Array(toBytes(chunk)));
    },
    async close() {},
    async abort() {
      aborted = true;
      chunks.length = 0;
    },
  };
  await writeZip(entries, writable);
  if (aborted) throw zipError('ZIP writer aborted.');
  return new Blob(chunks, { type: 'application/zip' });
}
