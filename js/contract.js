// =============================================================================
// contract.js — Contract specs, fee/margin model, money math & formatting
// -----------------------------------------------------------------------------
// This is the single source of truth for "what am I trading and what is it
// worth". It defines:
//   * The selectable futures contracts (Micro E-mini Dow `MYM`, Micro Russell
//     `M2K`) and their real exchange specs.
//   * `CONTRACT` — the *active* contract (a mutable object every other module
//     reads), and helpers to switch which contract is active.
//   * `DEFAULT_CONFIG` — the user-editable settings (fees, margin, volatility…).
//   * Pure money helpers: per-side fees, dollar P&L, tick rounding, and the
//     currency/price/percent formatters used all over the UI.
//
// A "contract" here is a futures contract. Key spec terms:
//   * pointValue — dollars gained/lost per 1.0 index-point move, per contract.
//   * tickSize   — the smallest price increment the contract trades in.
//   * Symbol month codes: U = September, year 26 = 2026 -> MYMU26 / M2KU26.
// All money is paper money for training; nothing here places real orders.
// =============================================================================

/**
 * The currently-active contract. This is a *mutable singleton*: other modules
 * import `CONTRACT` once and read its live fields, so switching contracts just
 * mutates this object (see {@link syncContract}). Defaults to MYM.
 * @type {{symbol:string, root:string, name:string, description:string,
 *   exchange:string, monthLabel:string, pointValue:number, tickSize:number,
 *   tickValue:number, currency:string}}
 */
export const CONTRACT = {
  symbol: 'MYMU26',
  root: 'MYM',
  name: 'Micro E-mini Dow',
  description: 'Micro E-mini Dow Jones Industrial Average',
  exchange: 'CME',
  monthLabel: 'Sep 2026',
  pointValue: 0.5,   // $ per 1.0 index point, per contract
  tickSize: 1.0,     // index points per tick
  get tickValue() { return this.tickSize * this.pointValue; },  // $ per tick
  currency: 'USD',
};

/**
 * Registry of selectable contracts (CME Micro E-minis, Sep 2026). Each entry
 * carries intrinsic specs (symbol, pointValue, tickSize) plus sensible default
 * margins / start price / volatility and a Yahoo Finance symbol for live data.
 * Switching contracts copies one of these into {@link CONTRACT} and config.
 */
export const CONTRACTS = {
  MYM: {
    symbol: 'MYMU26', root: 'MYM', name: 'Micro E-mini Dow', yahoo: 'MYM=F',
    description: 'Micro E-mini Dow Jones Industrial Average', exchange: 'CME', monthLabel: 'Sep 2026',
    pointValue: 0.5, tickSize: 1.0, startPrice: 52400, initialMargin: 1510, maintenanceMargin: 1372, annualVolPct: 14,
  },
  M2K: {
    symbol: 'M2KU26', root: 'M2K', name: 'Micro E-mini Russell 2000', yahoo: 'M2K=F',
    description: 'Micro E-mini Russell 2000', exchange: 'CME', monthLabel: 'Sep 2026',
    pointValue: 5.0, tickSize: 0.1, startPrice: 3025, initialMargin: 930, maintenanceMargin: 850, annualVolPct: 20,
  },
};

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
  const c = CONTRACTS[cfg.contractKey] || CONTRACTS.MYM;   // fall back to MYM for an unknown key
  CONTRACT.symbol = c.symbol; CONTRACT.root = c.root; CONTRACT.name = c.name;
  CONTRACT.description = c.description; CONTRACT.exchange = c.exchange;
  CONTRACT.monthLabel = c.monthLabel; CONTRACT.tickSize = c.tickSize;
  // pointValue comes from CONFIG (so a user override sticks), not the registry —
  // this is what lets you trade MYM at E-mini ($5) sizing from Settings.
  CONTRACT.pointValue = cfg.pointValue ?? c.pointValue;
}

/**
 * Load a contract's *default* specs into the config object. Used when the user
 * switches contracts, so margins/start price/volatility/point value reset to
 * that instrument's sensible defaults.
 *
 * @param {'MYM'|'M2K'} key - Which contract to load.
 * @param {object} cfg - The config object to mutate.
 * @returns {void} Mutates `cfg` in place (sets contractKey, pointValue,
 *   initialMargin, maintenanceMargin, startPrice, annualVolPct).
 */
export function loadContractDefaults(key, cfg) {
  const c = CONTRACTS[key] || CONTRACTS.MYM;
  cfg.contractKey = key;
  cfg.pointValue = c.pointValue;
  cfg.initialMargin = c.initialMargin;
  cfg.maintenanceMargin = c.maintenanceMargin;
  cfg.startPrice = c.startPrice;
  cfg.annualVolPct = c.annualVolPct;
}

/**
 * How many decimal places the active contract's prices need.
 * @returns {number} 0 for whole-point ticks (MYM, tick 1.0), 1 for the 0.10
 *   tick (M2K), etc. Derived from `CONTRACT.tickSize`.
 */
export function tickDecimals() {
  const t = CONTRACT.tickSize || 1;
  return t >= 1 ? 0 : (String(t).split('.')[1] || '').length;
}

/**
 * The default, user-overridable configuration (persisted/edited via Settings).
 * Defaults approximate Robinhood Futures + CME for MYM. All money is paper.
 */
export const DEFAULT_CONFIG = {
  contractKey: 'MYM',        // which contract is active (MYM | M2K)
  startBalance: 10000,

  // Per-contract, per-side costs (round-trip = 2x). Editable to match your broker.
  // Robinhood Futures: $0.75/contract/side standard, $0.50/side for Gold members.
  goldMember: false,         // Gold -> $0.50/side commission
  commissionPerSide: 0.75,   // Robinhood Futures commission (per contract, per side)
  exchangeFeePerSide: 0.37,  // CME micro exchange fee
  nfaFeePerSide: 0.02,       // NFA regulatory fee

  // Dollar multiplier per index point, per contract. $0.50 = MYM (Micro E-mini
  // Dow, the real spec). Set to 5.00 to trade E-mini Dow (YM) sizing = 10x P&L.
  pointValue: 0.5,

  // Margin (per contract). Robinhood lists ~$1,510 to start trading MYM.
  initialMargin: 1510,
  maintenanceMargin: 1372,

  // Order-entry defaults (mirrors Robinhood Legend).
  autoSend: false,           // RH default: off (orders go to a confirmation screen)
  defaultTif: 'day',         // good-for-day; 'gtc' also available

  // Market microstructure for fills.
  spreadTicks: 1,            // quoted bid/ask width, in ticks
  autoLiquidate: true,       // flatten automatically on a margin call

  // Synthetic price generator.
  startPrice: 52400,         // starting index level (auto-anchored to the real price when online)
  annualVolPct: 14,          // annualized volatility, %
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
 * contract and thousands separators, e.g. 52387 -> "52,387", 3025.6 -> "3,025.6".
 * @param {number} px - A price in index points.
 * @returns {string} Display price.
 */
export function fmtPx(px) {
  const d = tickDecimals();   // 0 for MYM (1.0 tick), 1 for M2K (0.10 tick)
  return Number(px).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
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
