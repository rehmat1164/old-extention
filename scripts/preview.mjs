import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, relative, extname, sep } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.PORT || 3000);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.mp4': 'video/mp4',
  '.json': 'application/json; charset=utf-8', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8', '.sha256': 'text/plain; charset=utf-8'
};
const allowed = ['js/', 'css/', 'images/', 'preview/', 'tests/fixtures/'];

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname).slice(1);
    if (!path) path = 'preview/index.html';
    if (path === 'downloads/mete-run-local-test.zip') path = 'dist/mete-run-local-test.zip';
    else if (path === 'downloads/mete-run-local-test.sha256') path = 'dist/mete-run-local-test.sha256';
    else if (!['sidepanel.html'].includes(path) && !allowed.some(prefix => path.startsWith(prefix))) {
      res.writeHead(404).end('Not found');
      return;
    }
    const file = resolve(root, path);
    if (!file.startsWith(root + sep) || relative(root, file).split(sep).join('/') !== path || !(await stat(file)).isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    const headers = {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    };
    if (path.endsWith('.zip')) headers['Content-Disposition'] = 'attachment; filename="mete-run-local-test.zip"';
    res.writeHead(200, headers);
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found. The test ZIP may still be building.');
  }
}).listen(port, '0.0.0.0', () => console.log(`Mete Run preview on port ${port}`));
