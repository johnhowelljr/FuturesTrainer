// =============================================================================
// server.js — Zero-dependency static dev server for the browser version
// -----------------------------------------------------------------------------
// Serves the app over plain HTTP so the browser gets a stable origin (needed for
// ES modules + a persistent localStorage), and proxies delayed market data from
// Yahoo Finance through `/__yahoo` so the page can fetch quotes without tripping
// browser CORS. Uses only Node's built-ins — no npm install required.
//
// Usage: `node server.js`  (then open http://localhost:5173). The PORT env var
// overrides the default. This is the BROWSER path; the Electron app uses its own
// `app://` protocol handler (electron/main.cjs) and does not need this server.
// =============================================================================
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Project root (this file's directory) — the static file base. */
const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
/** Listen port (override with the PORT env var). */
const PORT = Number(process.env.PORT) || 5173;

/** File extension -> Content-Type for the responses we serve. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

// Request handler: routes the Yahoo proxy, then serves a static file under ROOT
// (with index fallback and path-traversal protection).
const server = createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host}`);
    let urlPath = decodeURIComponent(reqUrl.pathname);
    // Proxy delayed market data (Yahoo) to dodge browser CORS.
    if (urlPath === '/__yahoo') {
      const symbol = reqUrl.searchParams.get('symbol') || '';
      const interval = reqUrl.searchParams.get('interval') || '1m';
      const range = reqUrl.searchParams.get('range') || '1d';
      const y = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
      try {
        const yr = await fetch(y, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        const body = await yr.text();
        res.writeHead(yr.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }).end(body);
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ chart: { error: { description: String(err) } } }));
      }
      return;
    }
    if (urlPath === '/') urlPath = '/index.html';
    // Prevent path traversal: resolve and confirm the target stays under ROOT.
    const filePath = normalize(join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(filePath).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('404 Not Found');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    }).end(body);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('500 ' + err.message);
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  RH Futures (training sim) running:  ${url}\n`);
  // Best-effort auto-open the browser (Windows / macOS / Linux).
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"`
    : process.platform === 'darwin' ? `open "${url}"`
    : `xdg-open "${url}"`;
  import('node:child_process').then(({ exec }) => exec(cmd, () => {})).catch(() => {});
});
