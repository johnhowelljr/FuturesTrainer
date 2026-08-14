// =============================================================================
// contract.js — Contract specs, fee/margin model, money math & formatting
// -----------------------------------------------------------------------------
// This is the single source of truth for "what am I trading and what is it
// worth". It defines:
//   * The 20 selectable futures contracts — equity index, energy, metals,
//     rates, FX, crypto and grain — and their real exchange specs.
//   * `CONTRACT` — the *active* contract (a mutable object every other module
//     reads), and helpers to switch which contract is active.
//   * `DEFAULT_CONFIG` — the user-editable settings (fees, margin, volatility…).
//   * Pure money helpers: per-side fees, dollar P&L, tick rounding, and the
//     currency/price/percent formatters used all over the UI.
//
// A "contract" here is a futures contract. Key spec terms:
//   * pointValue — dollars gained/lost per 1.0 index-point move, per contract.
//   * tickSize   — the smallest price increment the contract trades in.
//   * Symbol month codes: U = September, year 26 = 2026 -> MESU26 / MYMU26.
// All money is paper money for training; nothing here places real orders.
// =============================================================================

/**
 * The currently-active contract. This is a *mutable singleton*: other modules
 * import `CONTRACT` once and read its live fields, so switching contracts just
 * mutates this object (see {@link syncContract}). Defaults to MES.
 * @type {{symbol:string, root:string, name:string, description:string,
 *   exchange:string, monthLabel:string, pointValue:number, tickSize:number,
 *   tickValue:number, currency:string}}
 */
export const CONTRACT = {
  symbol: 'MESU26',
  root: 'MES',
  name: 'Micro E-mini S&P 500',
  description: 'Micro E-mini S&P 500',
  exchange: 'CME',
  monthLabel: 'Sep 2026',
  pointValue: 5.0,   // $ per 1.0 index point, per contract
  tickSize: 0.25,    // index points per tick
  get tickValue() { return this.tickSize * this.pointValue; },  // $ per tick ($1.25)
  quoteStyle: null,  // '32nds' for the Treasuries; null = plain decimals
  currency: 'USD',
};

/**
 * CME's usual maintenance/initial margin ratio — maintenance runs ~91% of the
 * initial requirement across the product line.
 */
const MAINT_RATIO = 0.909;

/** Round a dollar figure to the nearest $5 (how margin tables are quoted). */
const round5 = (x) => Math.round(x / 5) * 5;

/**
 * Fill in a spec's margin requirements from its notional value.
 *
 * Exchange margins are *not* fixed numbers — they're set per product and revised
 * whenever volatility moves, so hardcoding 20 pairs of "official" figures would
 * be inventing precision. Instead each spec carries `marginPct` (the rough share
 * of notional that product's margin runs at) and the dollars are derived from it.
 * Sanity check: this reproduces Robinhood's published micro figures to within
 * rounding — MES $2,455/$2,232, MYM $1,510/$1,370, M2K $935/$850.
 *
 * Everything here is editable in Settings; treat it as a realistic starting
 * point, not a live margin quote.
 *
 * @param {object} c - A raw spec (needs startPrice, pointValue, marginPct).
 * @returns {object} The spec plus `initialMargin` / `maintenanceMargin`.
 */
function withMargins(c) {
  const notional = c.startPrice * c.pointValue;
  const initialMargin = Math.max(25, round5(notional * (c.marginPct / 100)));
  return { ...c, initialMargin, maintenanceMargin: Math.max(25, round5(initialMargin * MAINT_RATIO)) };
}

/**
 * The 20 selectable contracts — the most-traded CME/CBOT/NYMEX/COMEX products,
 * spanning equity index, energy, metals, rates, FX, crypto and grain.
 *
 * Each entry carries intrinsic specs (symbol, pointValue, tickSize), a Yahoo
 * Finance symbol for live data, a `category` (drives the dropdown's optgroups),
 * and defaults for start price / volatility / margin. Switching contracts copies
 * one of these into {@link CONTRACT} and config.
 *
 * `startPrice` is only the offline fallback — the app re-anchors to the real
 * price on load whenever the Yahoo feed is reachable. Prices and front months
 * here were taken from that feed on 2026-08-14.
 *
 * Contract-month codes: Q = Aug, U = Sep, X = Nov, Z = Dec; 26 = 2026.
 */
const SPECS = [
  // ---- Equity index ---------------------------------------------------------
  { root: 'MES', symbol: 'MESU26', name: 'Micro E-mini S&P 500', description: 'Micro E-mini S&P 500', yahoo: 'MES=F',
    category: 'Equity index', exchange: 'CME', monthLabel: 'Sep 2026',
    pointValue: 5, tickSize: 0.25, startPrice: 7800, annualVolPct: 15, marginPct: 6.3 },
  { root: 'ES', symbol: 'ESU26', micro: 'MES', name: 'E-mini S&P 500', description: 'E-mini S&P 500', yahoo: 'ES=F',
    category: 'Equity index', exchange: 'CME', monthLabel: 'Sep 2026',
    pointValue: 50, tickSize: 0.25, startPrice: 7800, annualVolPct: 15, marginPct: 6.3 },
  { root: 'MNQ', symbol: 'MNQU26', name: 'Micro E-mini Nasdaq-100', description: 'Micro E-mini Nasdaq-100', yahoo: 'MNQ=F',
    category: 'Equity index', exchange: 'CME', monthLabel: 'Sep 2026',
    pointValue: 2, tickSize: 0.25, startPrice: 30075, annualVolPct: 20, marginPct: 5.6 },
  { root: 'NQ', symbol: 'NQU26', micro: 'MNQ', name: 'E-mini Nasdaq-100', description: 'E-mini Nasdaq-100', yahoo: 'NQ=F',
    category: 'Equity index', exchange: 'CME', monthLabel: 'Sep 2026',
    pointValue: 20, tickSize: 0.25, startPrice: 30075, annualVolPct: 20, marginPct: 5.6 },
  { root: 'MYM', symbol: 'MYMU26', name: 'Micro E-mini Dow', description: 'Micro E-mini Dow Jones Industrial Average', yahoo: 'MYM=F',
    category: 'Equity index', exchange: 'CBOT', monthLabel: 'Sep 2026',
    pointValue: 0.5, tickSize: 1.0, startPrice: 53800, annualVolPct: 14, marginPct: 5.6 },
  { root: 'YM', symbol: 'YMU26', micro: 'MYM', name: 'E-mini Dow', description: 'E-mini Dow Jones Industrial Average', yahoo: 'YM=F',
    category: 'Equity index', exchange: 'CBOT', monthLabel: 'Sep 2026',
    pointValue: 5, tickSize: 1.0, startPrice: 53800, annualVolPct: 14, marginPct: 5.6 },
  { root: 'M2K', symbol: 'M2KU26', name: 'Micro E-mini Russell 2000', description: 'Micro E-mini Russell 2000', yahoo: 'M2K=F',
    category: 'Equity index', exchange: 'CME', monthLabel: 'Sep 2026',
    pointValue: 5, tickSize: 0.1, startPrice: 3070, annualVolPct: 20, marginPct: 6.1 },
  { root: 'RTY', symbol: 'RTYU26', micro: 'M2K', name: 'E-mini Russell 2000', description: 'E-mini Russell 2000', yahoo: 'RTY=F',
    category: 'Equity index', exchange: 'CME', monthLabel: 'Sep 2026',
    pointValue: 50, tickSize: 0.1, startPrice: 3070, annualVolPct: 20, marginPct: 6.1 },

  // ---- Energy ---------------------------------------------------------------
  { root: 'MCL', symbol: 'MCLU26', name: 'Micro WTI Crude Oil', description: 'Micro WTI Crude Oil (100 bbl)', yahoo: 'MCL=F',
    category: 'Energy', exchange: 'NYMEX', monthLabel: 'Sep 2026',
    pointValue: 100, tickSize: 0.01, startPrice: 82.2, annualVolPct: 35, marginPct: 10 },
  { root: 'CL', symbol: 'CLU26', micro: 'MCL', name: 'WTI Crude Oil', description: 'WTI Crude Oil (1,000 bbl)', yahoo: 'CL=F',
    category: 'Energy', exchange: 'NYMEX', monthLabel: 'Sep 2026',
    pointValue: 1000, tickSize: 0.01, startPrice: 82.2, annualVolPct: 35, marginPct: 10 },
  { root: 'NG', symbol: 'NGU26', name: 'Natural Gas', description: 'Henry Hub Natural Gas (10,000 MMBtu)', yahoo: 'NG=F',
    category: 'Energy', exchange: 'NYMEX', monthLabel: 'Sep 2026',
    pointValue: 10000, tickSize: 0.001, startPrice: 2.75, annualVolPct: 55, marginPct: 13 },

  // ---- Metals ---------------------------------------------------------------
  { root: 'MGC', symbol: 'MGCZ26', name: 'Micro Gold', description: 'Micro Gold (10 troy oz)', yahoo: 'MGC=F',
    category: 'Metals', exchange: 'COMEX', monthLabel: 'Dec 2026',
    pointValue: 10, tickSize: 0.1, startPrice: 4440, annualVolPct: 16, marginPct: 6 },
  { root: 'GC', symbol: 'GCZ26', micro: 'MGC', name: 'Gold', description: 'Gold (100 troy oz)', yahoo: 'GC=F',
    category: 'Metals', exchange: 'COMEX', monthLabel: 'Dec 2026',
    pointValue: 100, tickSize: 0.1, startPrice: 4440, annualVolPct: 16, marginPct: 6 },
  { root: 'SI', symbol: 'SIU26', name: 'Silver', description: 'Silver (5,000 troy oz)', yahoo: 'SI=F',
    category: 'Metals', exchange: 'COMEX', monthLabel: 'Sep 2026',
    pointValue: 5000, tickSize: 0.005, startPrice: 65, annualVolPct: 28, marginPct: 10 },
  { root: 'HG', symbol: 'HGU26', name: 'Copper', description: 'Copper (25,000 lb)', yahoo: 'HG=F',
    category: 'Metals', exchange: 'COMEX', monthLabel: 'Sep 2026',
    pointValue: 25000, tickSize: 0.0005, startPrice: 6.6, annualVolPct: 24, marginPct: 8 },

  // ---- Interest rates -------------------------------------------------------
  // Quoted in 32nds (`quoteStyle`), the way the exchange and every broker shows
  // them: ZN ticks in half-32nds and prints 3 digits (108'195), ZB ticks in
  // whole 32nds and prints 2 (108'25). See fmt32/parsePx below.
  { root: 'ZN', symbol: 'ZNU26', name: '10-Year T-Note', description: '10-Year U.S. Treasury Note ($100,000 face)', yahoo: 'ZN=F',
    category: 'Rates', exchange: 'CBOT', monthLabel: 'Sep 2026', quoteStyle: '32nds',
    pointValue: 1000, tickSize: 0.015625, startPrice: 108.578125, annualVolPct: 6, marginPct: 1.6 },
  { root: 'ZB', symbol: 'ZBU26', name: '30-Year T-Bond', description: '30-Year U.S. Treasury Bond ($100,000 face)', yahoo: 'ZB=F',
    category: 'Rates', exchange: 'CBOT', monthLabel: 'Sep 2026', quoteStyle: '32nds',
    pointValue: 1000, tickSize: 0.03125, startPrice: 108.78125, annualVolPct: 11, marginPct: 4 },

  // ---- FX -------------------------------------------------------------------
  { root: '6E', symbol: '6EU26', name: 'Euro FX', description: 'Euro FX (€125,000)', yahoo: '6E=F',
    category: 'FX', exchange: 'CME', monthLabel: 'Sep 2026',
    pointValue: 125000, tickSize: 0.00005, startPrice: 1.158, annualVolPct: 8, marginPct: 2.5 },

  // ---- Crypto ---------------------------------------------------------------
  { root: 'MBT', symbol: 'MBTQ26', name: 'Micro Bitcoin', description: 'Micro Bitcoin (0.1 BTC)', yahoo: 'MBT=F',
    category: 'Crypto', exchange: 'CME', monthLabel: 'Aug 2026',
    pointValue: 0.1, tickSize: 5, startPrice: 63200, annualVolPct: 45, marginPct: 40 },

  // ---- Agriculture ----------------------------------------------------------
  // Grains trade in cents/bushel, so a "point" is one cent: 481.25 = $4.8125/bu.
  { root: 'ZC', symbol: 'ZCZ26', name: 'Corn', description: 'Corn (5,000 bushels)', yahoo: 'ZC=F',
    category: 'Agriculture', exchange: 'CBOT', monthLabel: 'Dec 2026',
    pointValue: 50, tickSize: 0.25, startPrice: 481.25, annualVolPct: 20, marginPct: 6 },
];

/**
 * Registry of selectable contracts, keyed by root symbol (MES, CL, GC, …).
 * Built from {@link SPECS} with margins derived by {@link withMargins}.
 */
export const CONTRACTS = Object.fromEntries(SPECS.map((c) => [c.root, withMargins(c)]));

/**
 * The contract roots in display order, grouped for the header dropdown's
 * `<optgroup>`s. Derived from SPECS so the menu can never drift from the specs.
 * @returns {Array<{category:string, roots:string[]}>} Groups in registry order.
 */
export function contractGroups() {
  const groups = [];
  for (const c of SPECS) {
    const g = groups.find((x) => x.category === c.category);
    if (g) g.roots.push(c.root);
    else groups.push({ category: c.category, roots: [c.root] });
  }
  return groups;
}

/**
 * Make `CONTRACT` reflect the contract named by `cfg.contractKey`.
 *
 * Copies the intrinsic fields (symbol, tick size, etc.) from the registry, but
 * takes the dollar multiplier from `cfg.pointValue` so a user override in
 * Settings is respected. Call this before the feed/engine read CONTRACT.
 *
 * @param {object} cfg - The app config; uses `cfg.contractKey` and `cfg.pointValue`.
 * @returns {void} Mutates the shared `CONTRACT` object in place.
 */
export function syncContract(cfg) {
  const c = CONTRACTS[cfg.contractKey] || CONTRACTS.MES;   // fall back to MES for an unknown key
  CONTRACT.symbol = c.symbol; CONTRACT.root = c.root; CONTRACT.name = c.name;
  CONTRACT.description = c.description; CONTRACT.exchange = c.exchange;
  CONTRACT.monthLabel = c.monthLabel; CONTRACT.tickSize = c.tickSize;
  CONTRACT.quoteStyle = c.quoteStyle || null;   // null for everything but ZN/ZB
  // pointValue comes from CONFIG (so a user override sticks), not the registry —
  // this is what lets you trade MES at E-mini ($50) sizing from Settings.
  CONTRACT.pointValue = cfg.pointValue ?? c.pointValue;
}

/**
 * Load a contract's *default* specs into the config object. Used when the user
 * switches contracts, so margins/start price/volatility/point value reset to
 * that instrument's sensible defaults.
 *
 * @param {string} key - Which contract to load (a {@link CONTRACTS} root, e.g. 'MES').
 * @param {object} cfg - The config object to mutate.
 * @returns {void} Mutates `cfg` in place (sets contractKey, pointValue,
 *   initialMargin, maintenanceMargin, startPrice, annualVolPct).
 */
export function loadContractDefaults(key, cfg) {
  const c = CONTRACTS[key] || CONTRACTS.MES;
  cfg.contractKey = key;
  cfg.pointValue = c.pointValue;
  cfg.initialMargin = c.initialMargin;
  cfg.maintenanceMargin = c.maintenanceMargin;
  cfg.startPrice = c.startPrice;
  cfg.annualVolPct = c.annualVolPct;
}

/**
 * How many decimal places the active contract's prices need.
 * @returns {number} 2 for the 0.25 tick (MES), 0 for whole-point ticks (MYM,
 *   tick 1.0), 1 for the 0.10 tick (M2K). Derived from `CONTRACT.tickSize`.
 */
export function tickDecimals() {
  const t = CONTRACT.tickSize || 1;
  return t >= 1 ? 0 : (String(t).split('.')[1] || '').length;
}

// ---- fractional (32nds) quoting --------------------------------------------
// Treasury futures aren't quoted in decimals: a 10-year note at 108.609375 is
// "108'195" — 108 points, 19 thirty-seconds, and a half. ZB ticks in whole
// 32nds (2 digits after the apostrophe); ZN ticks in halves (3 digits, the last
// being 0 or 5). Every price the user reads or types for those products goes
// through the pair of functions below.

/**
 * Is the active contract quoted in 32nds rather than decimals?
 * @returns {boolean} True for the Treasury products (ZN, ZB).
 */
export function isFractionalQuote() { return CONTRACT.quoteStyle === '32nds'; }

/**
 * How many sub-divisions of a 1/32 the active contract trades in.
 * @returns {number} 1 for ZB (ticks are whole 32nds), 2 for ZN (halves).
 */
function subTicksPer32() {
  return Math.max(1, Math.round((1 / 32) / CONTRACT.tickSize));
}

/**
 * Format a price in exchange 32nds notation.
 *
 * @param {number} px - Price in decimal points (108.609375).
 * @param {boolean} [group=true] - Insert thousands separators in the whole part.
 * @returns {string} e.g. "108'195" (ZN) or "108'25" (ZB); negatives keep their
 *   sign, so a -0.15625 change reads "-0'05".
 */
function fmt32(px, group = true) {
  const sign = px < 0 ? '-' : '';
  const sub = subTicksPer32();
  const units = Math.round(Math.abs(px) * 32 * sub);   // whole sub-32nds, no float fuzz
  const per = 32 * sub;
  const whole = Math.floor(units / per);
  const rem = units - whole * per;
  const thirtySeconds = Math.floor(rem / sub);
  const frac = rem - thirtySeconds * sub;              // 0 .. sub-1
  const w = group ? whole.toLocaleString('en-US') : String(whole);
  const head = `${sign}${w}'${String(thirtySeconds).padStart(2, '0')}`;
  // CME writes the part-32nd as one decimal digit: ½ -> 5 (and ¼ -> 2, ¾ -> 7).
  return sub === 1 ? head : head + String(Math.floor((frac / sub) * 10));
}

/**
 * Parse a price the user typed. Accepts the active contract's native notation
 * plus plain decimals, so both "108'195" and "108.609375" work.
 *
 * Recognised 32nds forms: `108'19`, `108-19`, `108'195`, `108'19.5`.
 * @param {string|number} str - Raw input value.
 * @returns {number|null} The decimal price, or null if it isn't a price yet
 *   (empty, or a half-typed value like "108'").
 */
export function parsePx(str) {
  if (typeof str === 'number') return Number.isFinite(str) ? str : null;
  const s = String(str ?? '').trim();
  if (!s) return null;
  const m = isFractionalQuote() && s.match(/^(-?)(\d+)\s*['´`\-]\s*(\d{1,3}(?:\.\d+)?)$/);
  if (m) {
    const [, sign, whole, digits] = m;
    // "195" means 19.5 thirty-seconds; "19" and "19.5" mean themselves.
    const thirtySeconds = digits.includes('.') || digits.length <= 2
      ? Number(digits)
      : Number(digits.slice(0, 2)) + Number(digits.slice(2)) / 10;
    const px = Number(whole) + thirtySeconds / 32;
    return sign === '-' ? -px : px;
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * The default, user-overridable configuration (persisted/edited via Settings).
 * Defaults approximate Robinhood Futures + CME for MES. All money is paper.
 */
export const DEFAULT_CONFIG = {
  contractKey: 'MES',        // which contract is active (any CONTRACTS root)
  startBalance: 10000,

  // Per-contract, per-side costs (round-trip = 2x). Editable to match your broker.
  // Robinhood Futures: $0.75/contract/side standard, $0.50/side for Gold members.
  goldMember: false,         // Gold -> $0.50/side commission
  commissionPerSide: 0.75,   // Robinhood Futures commission (per contract, per side)
  exchangeFeePerSide: 0.37,  // CME micro exchange fee
  nfaFeePerSide: 0.02,       // NFA regulatory fee

  // Dollar multiplier per index point, per contract. $5.00 = MES (Micro E-mini
  // S&P 500, the real spec). Set to 50.00 to trade E-mini S&P (ES) sizing = 10x P&L.
  pointValue: 5.0,

  // Margin (per contract). Robinhood lists ~$2,455 to start trading MES.
  initialMargin: 2455,
  maintenanceMargin: 2232,

  // Order-entry defaults (mirrors Robinhood Legend).
  autoSend: false,           // RH default: off (orders go to a confirmation screen)
  defaultTif: 'day',         // good-for-day; 'gtc' also available

  // Market microstructure for fills.
  spreadTicks: 1,            // quoted bid/ask width, in ticks
  autoLiquidate: true,       // flatten automatically on a margin call

  // Synthetic price generator.
  startPrice: 7800,          // starting index level (auto-anchored to the real price when online)
  annualVolPct: 15,          // annualized volatility, %
  driftPctPerYear: 4,        // gentle upward drift, %
};

/**
 * Total commissions + exchange + NFA fees for one side of a trade.
 * @param {object} cfg - Config holding the per-side fee fields.
 * @param {number} qty - Number of contracts on that side.
 * @returns {number} Dollar fee for the side (round-trip is twice this), rounded
 *   to cents.
 */
export function feesPerSide(cfg, qty) {
  const per = cfg.commissionPerSide + cfg.exchangeFeePerSide + cfg.nfaFeePerSide;
  return round2(per * qty);
}

/**
 * Dollar profit/loss of a price move for a position, using the active contract's
 * point value.
 * @param {number} entry - Entry (average) price in index points.
 * @param {number} exit  - Exit/mark price in index points.
 * @param {number} qty   - Number of contracts (always positive here).
 * @param {number} side  - +1 for a long, -1 for a short.
 * @returns {number} Signed dollar P&L (profit positive).
 */
export function pnlDollars(entry, exit, qty, side) {
  return (exit - entry) * CONTRACT.pointValue * qty * side;
}

/**
 * Snap a raw price to the active contract's tick grid.
 * @param {number} px - Any price.
 * @returns {number} The nearest valid tick price (float noise cleaned up so
 *   0.10-tick contracts compare cleanly).
 */
export function roundToTick(px) {
  const t = CONTRACT.tickSize;
  // Round to the nearest multiple of the tick, then a second round to 6 dp scrubs
  // the binary-float fuzz (e.g. 3025.3000000000002 -> 3025.3) so price === checks
  // and string keys elsewhere behave.
  return Math.round((Math.round(px / t) * t) * 1e6) / 1e6;
}

/**
 * Round a dollar amount to cents (2 dp), avoiding binary-float drift.
 * @param {number} x - Any number.
 * @returns {number} `x` rounded to 2 decimal places.
 */
export function round2(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }

// ---- formatting helpers -----------------------------------------------------
const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const USD_SIGNED = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', signDisplay: 'always' });

/**
 * Format a number as USD, e.g. 1234.5 -> "$1,234.50".
 * @param {number} x - Amount (nullish treated as 0).
 * @returns {string} Currency string.
 */
export function fmtUSD(x) { return USD.format(x || 0); }

/**
 * Format a number as USD with an explicit sign, e.g. 12 -> "+$12.00",
 * -5 -> "-$5.00". Used for P&L so gains/losses read clearly.
 * @param {number} x - Amount (nullish treated as 0).
 * @returns {string} Signed currency string.
 */
export function fmtUSDSigned(x) { return USD_SIGNED.format(x || 0); }

/**
 * Format an index price with the right number of decimals for the active
 * contract and thousands separators, e.g. 7812.25 -> "7,812.25", 52387 -> "52,387".
 * @param {number} px - A price in index points.
 * @returns {string} Display price.
 */
export function fmtPx(px) {
  if (isFractionalQuote()) return fmt32(px);   // 108'195 for the Treasuries
  const d = tickDecimals();   // 2 for MES (0.25 tick), 0 for MYM (1.0 tick)
  return Number(px).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/**
 * Format a price for an `<input>` value — same notation as {@link fmtPx} but
 * without thousands separators, which a `type="number"` field would reject and
 * {@link parsePx} would have to strip back off.
 * @param {number} px - A price in points.
 * @returns {string} e.g. "108'195", "7802.25", "53794".
 */
export function fmtPxRaw(px) {
  if (isFractionalQuote()) return fmt32(px, false);
  return Number(px).toFixed(tickDecimals());
}

/**
 * Format a percentage with a leading sign and 2 decimals, e.g. 0.5 -> "+0.50%".
 * @param {number} x - The percentage value (already in %, not a fraction).
 * @returns {string} Signed percent string.
 */
export function fmtPct(x) {
  const s = x >= 0 ? '+' : '';
  return `${s}${x.toFixed(2)}%`;
}
