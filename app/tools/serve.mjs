/**
 * A tiny static server for trying the build on this PC.
 *
 * Run it with:   npm run serve      then open http://localhost:4173/#demo
 *
 * Serves dist/ under http://localhost:4173/ (localhost counts as a secure
 * context, so the service worker runs too). The media function's CORS allows
 * http://localhost:*, so the real app works here as well with ?k=<key>.
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../', import.meta.url));
const folder = join(app, process.argv[2] ?? 'dist');
const port = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  let file = normalize(join(folder, path));
  if (!file.startsWith(folder)) {
    res.writeHead(403).end();
    return;
  }
  try {
    if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}).listen(port, () => console.log(`Serving ${folder} on http://localhost:${port}/`));
