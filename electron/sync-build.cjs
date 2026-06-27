// =============================================================================
// electron/sync-build.cjs — Refresh the packaged build's app payload
// -----------------------------------------------------------------------------
// Copies the current source (index.html, styles.css, package.json, and the js/
// vendor/ electron/ folders) into the already-built portable app's
// `resources/app`, so the packaged .exe reflects the latest code WITHOUT a full
// re-pack. It runs automatically after each change (a Claude Code Stop hook) and
// via `npm run sync`.
//
// Why this exists: a full `electron-builder` run can't complete in this
// environment (its code-signing step needs admin / Developer Mode to create
// symlinks), so instead of rebuilding from scratch we surgically update the one
// folder the packaged app actually executes. No-op if no portable build exists.
// =============================================================================
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'release', 'FuturesTrainingSimulator');
const APP = path.join(BUILD, 'resources', 'app');   // the payload the packaged app runs

if (!fs.existsSync(BUILD)) process.exit(0);   // no portable build yet — nothing to sync

try {
  fs.mkdirSync(APP, { recursive: true });
  for (const f of ['index.html', 'styles.css', 'package.json']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(APP, f));
  }
  for (const d of ['js', 'vendor', 'electron']) {
    fs.cpSync(path.join(ROOT, d), path.join(APP, d), { recursive: true });
  }
  console.log('[sync-build] packaged Electron app payload updated');
} catch (e) {
  console.error('[sync-build] skipped:', e.message);
}
process.exit(0);
