// =============================================================================
// store.js — Persistence (browser localStorage)
// -----------------------------------------------------------------------------
// Saves and restores everything that should survive a reload: the editable
// config (fees/margin/contract), the paper account (cash, position, orders,
// activity), and UI preferences (timeframe, chart type, indicators on, etc.).
//
// Everything is stored under one JSON key in localStorage. In the Electron app
// this persists per-user because the app runs on a stable `app://` origin.
// All reads/writes are wrapped in try/catch — if storage is unavailable the app
// still runs, it just won't remember between sessions.
// =============================================================================

import { DEFAULT_CONFIG } from './contract.js';

/** The single localStorage key everything is saved under. */
const KEY = 'rhfutures.v1';

/**
 * Load the saved app state, falling back to fresh defaults when nothing is
 * stored or the data is corrupt. Saved values are merged *over* the defaults so
 * newly-added config/pref fields always have a value.
 *
 * @returns {{ config: object, account: (object|null), prefs: object }}
 *   - `config`  - merged DEFAULT_CONFIG + saved overrides.
 *   - `account` - the saved engine snapshot, or `null` for a fresh $10k account.
 *   - `prefs`   - merged default UI prefs + saved overrides.
 */
export function loadState() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { config: { ...DEFAULT_CONFIG }, account: null, prefs: defaultPrefs() };
    const s = JSON.parse(raw);
    // Spread defaults FIRST, saved values SECOND, so saved data wins but any
    // field added in a newer app version (absent from old saves) still gets a
    // value. This is what makes upgrades non-breaking without a migration step.
    return {
      config: { ...DEFAULT_CONFIG, ...(s.config || {}) },
      account: s.account || null,
      prefs: { ...defaultPrefs(), ...(s.prefs || {}) },
    };
  } catch {
    // Corrupt/unparseable JSON -> behave like a first run rather than crash.
    return { config: { ...DEFAULT_CONFIG }, account: null, prefs: defaultPrefs() };
  }
}

/**
 * Persist the current state. Called (debounced) whenever something changes.
 * @param {{ config: object, account: object, prefs: object }} state - The three
 *   buckets to save. Silently ignores storage errors.
 * @returns {void}
 */
export function saveState({ config, account, prefs }) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ config, account, prefs }));
  } catch { /* storage full / disabled — ignore for a training tool */ }
}

/**
 * Wipe all saved state (used by a hard reset). Silently ignores errors.
 * @returns {void}
 */
export function clearState() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/**
 * The default UI preferences for a brand-new user.
 * @returns {object} Fresh prefs: 1-minute candles, live synthetic feed, the
 *   default order side/type, replay & live speeds, and the indicators that are
 *   on out of the box (EMA 9, EMA 21, VWAP).
 */
function defaultPrefs() {
  return { timeframe: '1m', chartType: 'candles', mode: 'live', side: 'buy', ordType: 'market', speed: 15, liveSpeed: 1, dataSource: 'synthetic', indicators: { ema9: true, ema21: true, vwap: true } };
}
