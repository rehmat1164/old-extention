import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createZipBlob } from '../js/lib/zip.js';
import { extensionFiles } from './extension-files.mjs';

await import('./check.mjs');
const files = await extensionFiles();
const destination = resolve('dist/mete-run-local');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const entries = [];
for (const file of files) {
  await mkdir(dirname(`${destination}/${file}`), { recursive: true });
  await cp(file, `${destination}/${file}`);
  entries.push({ name: `mete-run-local/${file}`, blob: new Blob([await readFile(file)]) });
}
const bytes = new Uint8Array(await (await createZipBlob(entries)).arrayBuffer());
const output = 'dist/mete-run-local-test.zip';
await writeFile(output, bytes);
const hash = createHash('sha256').update(bytes).digest('hex');
await writeFile('dist/mete-run-local-test.sha256', `${hash}  mete-run-local-test.zip\n`);
console.log(`Built ${output} (${bytes.length.toLocaleString()} bytes).`);
console.log(`SHA-256 ${hash}`);
console.log('Extract the ZIP, then Load unpacked → mete-run-local in Chrome. No Git publication was performed.');
