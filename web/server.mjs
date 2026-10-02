// Zero-dependency production server for Photoshop.eth for the web: serves web/dist on $PORT (default 3000) at 0.0.0.0,
// with correct MIME types (application/wasm for the pixel engine), long-cache hashed assets, and SPA fallback.
// Builds web/dist first if it's missing, so `npm install && npm start` from a fresh clone just works.
import { createServer } from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
if (!existsSync(join(dist, 'index.html'))) {
  console.log('[compositor] web/dist missing, building…');
  if (!existsSync(join(here, 'node_modules', 'vite'))) execSync('npm ci --include=dev --no-audit --no-fund', { cwd: here, stdio: 'inherit' });
  execSync('npm run build', { cwd: here, stdio: 'inherit', env: { ...process.env, BASE_PATH: process.env.BASE_PATH || '/' } });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
  '.onnx': 'application/octet-stream', '.woff2': 'font/woff2',
};

const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || '0.0.0.0';

createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  let path;
  try { path = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end(); return; }
  if (path === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok'); return; }
  let file = normalize(join(dist, path));
  if (!file.startsWith(dist)) { res.writeHead(403).end(); return; }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  // SPA fallback: unknown paths without a file extension get the app shell.
  if (!existsSync(file)) {
    if (extname(path)) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
    file = join(dist, 'index.html');
  }
  const ext = extname(file).toLowerCase();
  const headers = {
    'Content-Type': TYPES[ext] || 'application/octet-stream',
    'Content-Length': statSync(file).size,
    'Cache-Control': file.includes(`${join(dist, 'assets')}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
}).listen(port, host, () => console.log(`[compositor] serving ${dist} on http://${host}:${port}`));
