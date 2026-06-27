// =============================================================================
// electron/main.cjs — Electron main process (the desktop app shell)
// -----------------------------------------------------------------------------
// Runs the simulator as a fully self-contained desktop app. Instead of a dev
// server, it registers a custom, secure scheme (`app://bundle/...`) and serves
// the bundled web files through it — which gives ES modules, fetch, and a STABLE
// localStorage origin, and works transparently from inside the packaged asar
// archive (so moving the .exe to another machine "just works", no port, no
// network). It also proxies Yahoo market data so the renderer can fetch quotes
// without CORS. CommonJS (.cjs) because the Electron main process isn't an ES
// module.
// =============================================================================
const { app, BrowserWindow, protocol, shell, Menu } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');   // project root: index.html, js/, vendor/, styles.css
const SCHEME = 'app';

/** File extension -> Content-Type for files served over the app:// scheme. */
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
  '.map': 'application/json',
};

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

/**
 * Proxy a delayed market-data request to Yahoo Finance and return it as JSON, so
 * the renderer can fetch quotes without hitting CORS.
 * @param {URL} reqUrl - The incoming app:// request URL (reads symbol/interval/range).
 * @returns {Promise<Response>} A fetch Response with Yahoo's JSON (or a 502 error JSON).
 */
function proxyYahoo(reqUrl) {
  const symbol = reqUrl.searchParams.get('symbol') || '';
  const interval = reqUrl.searchParams.get('interval') || '1m';
  const range = reqUrl.searchParams.get('range') || '1d';
  const y = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
  return fetch(y, { headers: { 'User-Agent': 'Mozilla/5.0' } })
    .then((r) => r.text().then((body) => new Response(body, { status: r.status, headers: { 'content-type': 'application/json' } })))
    .catch((e) => new Response(JSON.stringify({ chart: { error: { description: String(e) } } }), { status: 502, headers: { 'content-type': 'application/json' } }));
}

/**
 * Handler for the app:// scheme. Routes the Yahoo proxy, otherwise serves a
 * bundled file under ROOT (index fallback + path-traversal protection). Reads
 * transparently from the asar archive in the packaged build.
 * @param {Request} request - The protocol request.
 * @returns {Response|Promise<Response>} The file or an error response.
 */
function serveBundle(request) {
  const reqUrl = new URL(request.url);
  if (reqUrl.pathname === '/__yahoo') return proxyYahoo(reqUrl);
  let rel = decodeURIComponent(reqUrl.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(ROOT, rel));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    return new Response('Forbidden', { status: 403 });
  }
  try {
    const data = fs.readFileSync(filePath);                 // fs reads transparently from asar
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    return new Response(data, { headers: { 'content-type': type } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/**
 * Create the main application window and load the bundled app over app://. Uses
 * a sandboxed, context-isolated renderer (no Node in the page) and routes
 * external links to the user's real browser.
 * @returns {BrowserWindow} The created window.
 */
function createWindow() {
  const win = new BrowserWindow({
    width: 1500, height: 950, minWidth: 1024, minHeight: 680,
    backgroundColor: '#0a0d10',
    title: 'Futures — Training Simulator',
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-finish-load', () => console.log('[app] loaded', win.webContents.getURL()));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('[app] did-fail-load', code, desc, url));
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 3) console.error('[renderer error]', message); });
  // open any external links in the user's real browser, not a new app window
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.loadURL(`${SCHEME}://bundle/index.html`);
  return win;
}

app.whenReady().then(() => {
  protocol.handle(SCHEME, serveBundle);
  Menu.setApplicationMenu(null);   // clean, app-like chrome
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
