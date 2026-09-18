import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, posix } from 'node:path';
import { extensionFiles } from './extension-files.mjs';

const files = await extensionFiles();
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, 'Mete Run');
assert.equal(manifest.background.type, 'module');
assert.equal(manifest.side_panel.default_path, 'sidepanel.html');
assert.equal(manifest.update_url, undefined, 'Local builds must not have an updater.');
assert.equal(manifest.web_accessible_resources, undefined, 'Privileged panels must not be exposed to websites.');
assert.deepEqual([...manifest.permissions].sort(), ['offscreen', 'sidePanel', 'storage', 'tabs', 'unlimitedStorage']);
assert.deepEqual(manifest.host_permissions, [
  'https://meta.ai/*', 'https://www.meta.ai/*', 'https://vibes.ai/*', 'https://www.vibes.ai/*',
  'https://*.fbcdn.net/*', 'https://*.fbsbx.com/*',
]);
for (const file of [manifest.background.service_worker, manifest.side_panel.default_path,
  ...manifest.content_scripts.flatMap(script => script.js), ...Object.values(manifest.icons)]) {
  assert.ok(files.includes(file), `Manifest references an unpackaged file: ${file}`);
}
for (const file of files) {
  const bytes = await readFile(file);
  if (!/\.(?:js|html|css)$/.test(file)) continue;
  const source = bytes.toString();
  assert.doesNotMatch(source, /gist\.githubusercontent|integrate\.api\.nvidia|fonts\.googleapis|fonts\.gstatic|eval\s*\(/i, file);
  if (file.endsWith('.js')) {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) {
      assert.ok(files.includes(posix.normalize(`${dirname(file)}/${match[1]}`)), `Missing import ${match[1]} in ${file}`);
    }
  }
  if (file.endsWith('.html')) {
    for (const match of source.matchAll(/(?:src|href)="([^"]+)"/g)) {
      assert.ok(!/^https?:|^\/\//.test(match[1]), `Remote UI asset in ${file}: ${match[1]}`);
      if (!match[1].startsWith('#')) assert.ok(files.includes(match[1]), `Missing HTML resource: ${match[1]}`);
    }
  }
}
console.log(`Local extension checks passed (${files.length} packaged files).`);
