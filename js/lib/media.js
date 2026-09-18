import { allowedMediaUrl } from './policy.js';

const CHUNK_BYTES = 1024 * 1024;
const LIMITS = { image: 32 * 1024 * 1024, video: 256 * 1024 * 1024 };

export function assetBlob(record) {
  const blob = record instanceof Blob ? record : record?.blob;
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error('A local media file is missing or empty.');
  return blob;
}

export async function mediaType(blob, kind) {
  const bytes = new Uint8Array(await blob.slice(0, 48).arrayBuffer());
  const text = new TextDecoder('ascii').decode(bytes);
  let type;
  if (bytes[0] === 0x89 && text.slice(1, 4) === 'PNG' && bytes[4] === 13 && bytes[5] === 10) type = 'image/png';
  else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) type = 'image/jpeg';
  else if (text.startsWith('RIFF') && text.slice(8, 12) === 'WEBP') type = 'image/webp';
  else if (text.slice(4, 8) === 'ftyp' && /^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)/.test(text.slice(8, 12))) type = 'video/mp4';
  if (!type || !type.startsWith(`${kind}/`)) {
    throw new Error(`The provider returned an invalid ${kind} file, not a completed ${kind === 'video' ? 'MP4 video' : 'PNG, JPG, or WebP image'}. Nothing was exported.`);
  }
  return type;
}

export async function sha256(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function dataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function boundedResponse(response, limit) {
  if (!response.ok) throw new Error(`Media download returned HTTP ${response.status}.`);
  if (Number(response.headers.get('content-length')) > limit) throw new Error('The generated file exceeds the local test build size limit.');
  const chunks = [];
  const reader = response.body?.getReader();
  if (!reader) throw new Error('The provider returned an empty media response.');
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('The generated file exceeds the local test build size limit.');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return new Blob(chunks);
}

async function readInTab(url, limit, readChunk, checkCancelled) {
  const chunks = [];
  let offset = 0;
  let total;
  while (total === undefined || offset < total) {
    checkCancelled();
    const chunk = await readChunk({ url, offset, length: CHUNK_BYTES });
    if (!Number.isSafeInteger(chunk?.total) || chunk.total < 1 || chunk.total > limit || chunk.offset !== offset
      || (total !== undefined && total !== chunk.total) || typeof chunk.base64 !== 'string') {
      throw new Error('The page returned an invalid or oversized media chunk.');
    }
    total = chunk.total;
    const bytes = Uint8Array.from(atob(chunk.base64), character => character.charCodeAt(0));
    if (!bytes.length || bytes.length > CHUNK_BYTES || offset + bytes.length > total) throw new Error('The media transfer was incomplete.');
    chunks.push(bytes);
    offset += bytes.length;
  }
  return new Blob(chunks);
}

export async function downloadMedia({ url, kind, provider, readChunk, checkCancelled = () => {}, fetcher = fetch }) {
  if (!allowedMediaUrl(url, provider)) throw new Error('This media address is outside the bundled provider allowlist. The file was not downloaded.');
  if (!LIMITS[kind]) throw new Error('Unsupported media type.');
  checkCancelled();
  let blob;
  let directError;
  if (!url.startsWith('blob:')) {
    try {
      const response = await fetcher(url, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(120_000) });
      blob = await boundedResponse(response, LIMITS[kind]);
    } catch (error) { directError = error; }
  }
  if (!blob && readChunk) blob = await readInTab(url, LIMITS[kind], readChunk, checkCancelled);
  if (!blob) throw directError || new Error('This media file is no longer available. Keep its provider tab open.');
  checkCancelled();
  return blob.slice(0, blob.size, await mediaType(blob, kind));
}
