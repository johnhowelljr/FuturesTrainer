// =============================================================================
// indicators.js — Technical-indicator math
// -----------------------------------------------------------------------------
// Pure functions that turn an array of price bars into the data series that the
// chart draws (moving averages, VWAP, Bollinger Bands, RSI, MACD). No DOM, no
// charting library — just the numbers. chart.js calls these and feeds the
// results to lightweight-charts.
//
// Input "bars": an array of objects sorted oldest -> newest, each shaped like
//   { time:number, open:number, high:number, low:number, close:number, volume?:number }
//   (`time` is a UNIX timestamp in seconds; this is exactly what feed.getBars()
//   returns for the current timeframe).
//
// Output: arrays of { time, value } points (Bollinger returns
//   { time, upper, middle, lower }; MACD returns three series) — the format
//   lightweight-charts line/histogram series expect. Leading bars with no value
//   yet (e.g. the first 49 bars of a 50-period SMA) are simply omitted.
// =============================================================================

/**
 * Simple Moving Average — the mean close over the last `p` bars.
 * @param {Array<{time:number,close:number}>} bars - Price bars (oldest first).
 * @param {number} p - Period (number of bars to average).
 * @returns {Array<{time:number,value:number}>} One point per bar once enough
 *   history exists; empty array if there are fewer than `p` bars.
 */
export function sma(bars, p) {
  if (bars.length < p) return [];
  const out = [];
  let sum = 0;
  for (let i = 0; i < bars.length; i++) {
    sum += bars[i].close;
    if (i >= p) sum -= bars[i - p].close;   // slide the window
    if (i >= p - 1) out.push({ time: bars[i].time, value: sum / p });
  }
  return out;
}

/**
 * Exponential Moving Average — weights recent bars more heavily. Seeded with the
 * SMA of the first `p` bars, then smoothed with factor k = 2/(p+1).
 * @param {Array<{time:number,close:number}>} bars - Price bars (oldest first).
 * @param {number} p - Period.
 * @returns {Array<{time:number,value:number}>} EMA points; empty if < `p` bars.
 */
export function ema(bars, p) {
  if (bars.length < p) return [];
  const k = 2 / (p + 1);
  let seed = 0;
  for (let i = 0; i < p; i++) seed += bars[i].close;
  let e = seed / p;
  const out = [{ time: bars[p - 1].time, value: e }];
  for (let i = p; i < bars.length; i++) {
    e = bars[i].close * k + e * (1 - k);
    out.push({ time: bars[i].time, value: e });
  }
  return out;
}

/**
 * Session VWAP — Volume-Weighted Average Price, accumulated from the first bar.
 * Uses each bar's typical price (H+L+C)/3 weighted by its volume. If volume is
 * missing it degrades gracefully to an unweighted typical-price average.
 * @param {Array<{time:number,high:number,low:number,close:number,volume?:number}>} bars
 * @returns {Array<{time:number,value:number}>} One VWAP point per bar.
 */
export function vwap(bars) {
  const out = [];
  let pv = 0, vol = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    const v = b.volume || 1;
    pv += tp * v; vol += v;
    out.push({ time: b.time, value: pv / vol });
  }
  return out;
}

/**
 * Bollinger Bands — an SMA "middle" band with upper/lower bands at +/- `mult`
 * standard deviations of the close over the window.
 * @param {Array<{time:number,close:number}>} bars - Price bars.
 * @param {number} [p=20] - Period for the mean & standard deviation.
 * @param {number} [mult=2] - Std-dev multiplier for the band width.
 * @returns {Array<{time:number,upper:number,middle:number,lower:number}>}
 *   Band points; empty if fewer than `p` bars.
 */
export function bollinger(bars, p = 20, mult = 2) {
  if (bars.length < p) return [];
  const out = [];
  for (let i = p - 1; i < bars.length; i++) {
    let sum = 0;
    for (let j = i - p + 1; j <= i; j++) sum += bars[j].close;
    const mean = sum / p;
    let sq = 0;
    for (let j = i - p + 1; j <= i; j++) { const d = bars[j].close - mean; sq += d * d; }
    const sd = Math.sqrt(sq / p);
    out.push({ time: bars[i].time, upper: mean + mult * sd, middle: mean, lower: mean - mult * sd });
  }
  return out;
}

/**
 * Relative Strength Index (Wilder's smoothing) — a 0-100 momentum oscillator.
 * Values above ~70 are conventionally "overbought", below ~30 "oversold".
 * @param {Array<{time:number,close:number}>} bars - Price bars.
 * @param {number} [p=14] - Look-back period.
 * @returns {Array<{time:number,value:number}>} RSI points (0-100); empty if
 *   fewer than `p+1` bars.
 */
export function rsi(bars, p = 14) {
  if (bars.length < p + 1) return [];
  let gain = 0, loss = 0;
  for (let i = 1; i <= p; i++) { const d = bars[i].close - bars[i - 1].close; if (d >= 0) gain += d; else loss -= d; }
  gain /= p; loss /= p;
  const rs = () => (loss === 0 ? 100 : 100 - 100 / (1 + gain / loss));
  const out = [{ time: bars[p].time, value: rs() }];
  for (let i = p + 1; i < bars.length; i++) {
    const d = bars[i].close - bars[i - 1].close;
    gain = (gain * (p - 1) + (d > 0 ? d : 0)) / p;   // Wilder smoothing
    loss = (loss * (p - 1) + (d < 0 ? -d : 0)) / p;
    out.push({ time: bars[i].time, value: rs() });
  }
  return out;
}

/**
 * MACD — Moving Average Convergence/Divergence. The MACD line is fastEMA −
 * slowEMA; the signal line is an EMA of the MACD line; the histogram is their
 * difference.
 * @param {Array<{time:number,close:number}>} bars - Price bars.
 * @param {number} [fast=12] - Fast EMA period.
 * @param {number} [slow=26] - Slow EMA period.
 * @param {number} [signal=9] - Signal EMA period.
 * @returns {{ macd: Array<{time,value}>, signal: Array<{time,value}>,
 *   hist: Array<{time,value}> }} Three aligned series (the signal/histogram
 *   start later than the MACD line because they need extra warm-up).
 */
export function macd(bars, fast = 12, slow = 26, signal = 9) {
  // Local EMA that returns an index-aligned array (null until the period warms
  // up) rather than ema()'s compact {time,value} list — alignment matters so we
  // can subtract f[i] - s[i] at matching indices below.
  const emaArr = (period) => {
    const k = 2 / (period + 1); let e = null, seed = 0; const arr = [];
    for (let i = 0; i < bars.length; i++) {
      if (i < period - 1) { seed += bars[i].close; arr.push(null); }
      else if (i === period - 1) { seed += bars[i].close; e = seed / period; arr.push(e); }
      else { e = bars[i].close * k + e * (1 - k); arr.push(e); }
    }
    return arr;
  };
  const f = emaArr(fast), s = emaArr(slow);
  const macdLine = [], sigLine = [], hist = [];
  // The signal line is an EMA *of the MACD line*, so it can't start until the
  // MACD line exists AND has `signal` points of its own. `count` tracks how many
  // MACD points we've seen; `seed` accumulates the first `signal` of them to seed
  // that EMA (same SMA-seed trick as ema()). That's why signal/hist begin later.
  const k = 2 / (signal + 1); let se = null, count = 0, seed = 0;
  for (let i = 0; i < bars.length; i++) {
    if (f[i] == null || s[i] == null) continue;   // slow EMA not warmed up yet
    const m = f[i] - s[i];
    macdLine.push({ time: bars[i].time, value: m });
    count++;
    if (count < signal) { seed += m; continue; }       // still seeding the signal EMA
    if (count === signal) { seed += m; se = seed / signal; }   // seed = SMA of first `signal` MACD pts
    else se = m * k + se * (1 - k);                     // thereafter: standard EMA recurrence
    sigLine.push({ time: bars[i].time, value: se });
    hist.push({ time: bars[i].time, value: m - se });  // histogram = MACD − signal
  }
  return { macd: macdLine, signal: sigLine, hist };
}

/**
 * The catalog of indicators the user can toggle in the Indicators menu.
 * Each entry: { id, label, color, ... }.
 *   - `compute(bars)` — for price-pane overlays; returns the series data.
 *   - `bands: true`   — Bollinger-style; `compute` returns {upper,middle,lower}.
 *   - `pane: true`    — an oscillator drawn in its own sub-pane below price
 *                       (Volume/RSI/MACD); chart.js owns how those are built.
 * @type {Array<{id:string,label:string,color:string,width?:number,
 *   bands?:boolean,pane?:boolean,compute?:(bars:any[])=>any}>}
 */
export const INDICATOR_DEFS = [
  { id: 'ema9', label: 'EMA 9', color: '#f5d020', width: 2, compute: (b) => ema(b, 9) },
  { id: 'ema21', label: 'EMA 21', color: '#00bcd4', width: 2, compute: (b) => ema(b, 21) },
  { id: 'sma50', label: 'SMA 50', color: '#2196f3', width: 1, compute: (b) => sma(b, 50) },
  { id: 'sma200', label: 'SMA 200', color: '#ff5252', width: 1, compute: (b) => sma(b, 200) },
  { id: 'vwap', label: 'VWAP', color: '#b388ff', width: 2, compute: (b) => vwap(b) },
  { id: 'bb', label: 'Bollinger Bands (20, 2)', color: '#787b86', width: 1, bands: true, compute: (b) => bollinger(b, 20, 2) },
  { id: 'volume', label: 'Volume', color: '#5d6b78', pane: true },
  { id: 'rsi', label: 'RSI (14)', color: '#c792ea', pane: true },
  { id: 'macd', label: 'MACD (12, 26, 9)', color: '#2196f3', pane: true },
];
