// =============================================================================
// feed.js — The price feed (the market itself)
// -----------------------------------------------------------------------------
// Produces the tape of prices the whole app trades against, and emits a "tick"
// event stream that the engine (for fills/P&L) and the chart (for drawing)
// listen to. One class, several modes:
//
//   * SYNTHETIC LIVE   — an endless, just-in-time generated market that advances
//                        on a wall-clock timer (open-ended practice).
//   * SYNTHETIC REPLAY — one bounded trading day, generated deterministically
//                        from a date seed; play / pause / scrub / change speed.
//   * REAL (delayed)   — real bars fetched from Yahoo (see app.js) loaded via
//                        loadLiveBars(); the app polls + drives rendering.
//   * CSV import        — load your own historical bars via loadCSV().
//
// HOW THE SYNTHETIC MARKET IS BUILT (so it looks/behaves like a real one):
//   * Bars are generated at a 30-second "base" resolution; higher timeframes are
//     aggregated on demand (getBars).
//   * Each base bar is a short random walk of `PATH_POINTS` micro-steps (this is
//     what lets the forming candle animate smoothly).
//   * Per-bar volatility "clusters" (calm stretches and wild stretches) via a
//     slowly mean-reverting log-volatility regime.
//   * Price mean-reverts toward a slowly drifting "fair-value anchor", so dips
//     recover instead of falling forever, and sessions are balanced up/down.
//
// PUBLIC SURFACE used by the rest of the app: subscribe(), getBars(tf), last,
// quote, dayUp, clockLabel, currentBarTime, sessionOpenPrice, start()/stop(),
// play()/pause(), setMode()/setDate()/reseed(), loadLiveBars(), loadCSV().
// =============================================================================

import { makeRng, hashSeed } from './rng.js';
import { CONTRACT, roundToTick } from './contract.js';

const BASE_SEC = 30;          // base bar = 30 seconds (the finest timeframe)
const PATH_POINTS = 12;       // micro-steps per base bar (forms/animates the candle)
const REVERT_KAPPA = 0.035;   // mean-reversion strength toward fair value (per bar)
const MIN_PER_YEAR = 252 * 1380;   // trading minutes per year (for vol scaling)
const SESSION_MIN = 390;                          // RTH 09:30–16:00 ET, in minutes
const SESSION_BARS = (SESSION_MIN * 60) / BASE_SEC;   // base bars in one session
const WARMUP_BARS = (180 * 60) / BASE_SEC;        // bars already elapsed when you "arrive" live
const FRAME_MS = 200;         // animation/timer cadence

/** Timeframe id -> seconds per bar. Drives both aggregation and axis labels. */
const TF_SECONDS = { '30s': 30, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1D': 86400 };

/**
 * UNIX-seconds timestamp for 09:30 ET on a given date (June -> EDT = UTC-4, so
 * 13:30Z). Good enough for the time-axis labels.
 * @param {string} dateStr - "YYYY-MM-DD".
 * @returns {number} Epoch seconds at the session open.
 */
function sessionOpenEpoch(dateStr) {
  return Math.floor(Date.parse(`${dateStr}T13:30:00Z`) / 1000);
}

/**
 * Today's date as "YYYY-MM-DD" in local time.
 * @returns {string} Date string used for live seeding & labels.
 */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class Feed {
  /**
   * @param {object} cfg - App config (startPrice, annualVolPct, driftPctPerYear,
   *   spreadTicks, etc.). The feed reads live values off it.
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.mode = 'live';
    this.real = false;       // true when fed by a real (delayed) data source
    this.listeners = new Set();

    this.dateStr = todayStr();
    this.session = [];       // base 30s bars: {time, open, high, low, close, volume, path[]}
    this.dailyBars = [];     // ~150 prior daily bars (+ today) for the 1D timeframe
    this.pos = 0;            // fractional index into session (the fraction => forming bar)
    this.playing = false;
    this.speed = 15;         // replay speed multiple
    this._liveSpeed = 1;     // live speed multiple (1 = real time: a 30s bar takes 30s)
    this._timer = null;
    this._lastFrame = 0;

    this._initSession();
  }

  // ---- generation -----------------------------------------------------------

  /**
   * U-shaped intraday seasonality multiplier — markets are busiest near the open
   * and close, quietest midday. Scales the per-bar volatility & volume.
   * @param {number} index - Base-bar index within the session.
   * @returns {number} A factor roughly in [0.85, 1.40].
   */
  _seasonal(index) {
    const x = (((index % SESSION_BARS) + SESSION_BARS) % SESSION_BARS) / SESSION_BARS;
    return 0.85 + 0.55 * (Math.cos(2 * Math.PI * x) * 0.5 + 0.5);
  }

  /**
   * Advance the market "regime" by one bar: nudges the mean-reverting
   * log-volatility (`_logv`, creating calm vs wild stretches) and drifts the
   * slowly-moving fair-value anchor (`_anchor`) that price reverts toward.
   * @returns {void} Mutates `_logv` and `_anchor`.
   */
  _stepRegime() {
    // log-vol is an AR(1) process: *0.97 pulls it back toward 0 (so wild/calm
    // stretches persist but always decay), + a gaussian kick. Clamped to keep
    // exp(_logv) in a sane multiplier range (~0.33x–3.7x normal volatility).
    this._logv = Math.max(-1.1, Math.min(1.3, this._logv * 0.97 + this._rng.gaussian() * 0.25));
    // The anchor itself random-walks (with a tiny per-bar slice of the annual
    // drift). Because price chases the anchor, moving the anchor is what makes a
    // session trend up OR down — the drift is symmetric so neither dominates.
    const baseDrift = ((this.cfg.driftPctPerYear ?? 4) / 100) / MIN_PER_YEAR * (BASE_SEC / 60);
    this._anchor *= Math.exp(this._rng.gaussian() * this._perBar * 1.2 + baseDrift);
  }

  /**
   * Generate one completed 30-second base bar as a short random walk that
   * mean-reverts toward the anchor, with occasional fat-tail jumps. Also derives
   * a plausible synthetic volume from the bar's range & time of day.
   * @param {number} index - Base-bar index within the session.
   * @param {number} prevClose - Close of the previous bar (this bar's open).
   * @returns {{time:number, open:number, high:number, low:number, close:number,
   *   volume:number, path:number[]}} The bar plus its intra-bar price path (used
   *   to animate the forming candle).
   */
  _genBar(index, prevClose) {
    const t = this._sessionOpen + index * BASE_SEC;
    // Per-micro-step volatility: base stdev × time-of-day × current regime,
    // divided by sqrt(steps) so the whole bar's variance matches `sigmaStep`
    // regardless of PATH_POINTS (variance adds, so stdev scales by sqrt).
    const sigmaStep = (this._perBar * this._seasonal(index) * Math.exp(this._logv)) / Math.sqrt(PATH_POINTS);
    // Mean reversion in LOG space: the gap to the anchor, scaled by REVERT_KAPPA,
    // is the total pull for this bar; spread evenly across the micro-steps. The
    // farther price has wandered from fair value, the stronger the pull back.
    const revert = REVERT_KAPPA * (Math.log(this._anchor) - Math.log(prevClose));
    const driftStep = revert / PATH_POINTS;
    const path = [prevClose];   // path[0] is the open (= previous close)
    let p = prevClose;
    // ~2.5% of bars get a one-off "jump" injected at the midpoint -> fat tails,
    // i.e. the occasional spike a pure gaussian walk would never produce.
    let jump = 0;
    if (this._rng.uniform() < 0.025) jump = this._rng.gaussian() * sigmaStep * 8;
    for (let k = 0; k < PATH_POINTS; k++) {
      // Geometric step: shock is a % move (random + reversion + optional jump),
      // applied multiplicatively so prices can't go negative.
      const shock = this._rng.gaussian() * sigmaStep + driftStep + (k === (PATH_POINTS >> 1) ? jump : 0);
      p = p * Math.exp(shock);
      path.push(p);
    }
    const closes = path.map(roundToTick);
    const open = closes[0], close = closes[closes.length - 1];
    const high = Math.max(...closes), low = Math.min(...closes);
    // Fake volume from the bar's range (wider range = more activity) and time of
    // day, plus jitter — purely for the volume pane's shape, not used in P&L.
    const ticks = (high - low) / CONTRACT.tickSize;
    const volume = Math.max(1, Math.round((120 + ticks * 18) * this._seasonal(index) * (0.6 + 0.8 * this._rng.uniform())));
    return { time: t, open, high, low, close, volume, path: closes };
  }

  /**
   * Lazily generate base bars up to index `i` (no-op in real-data mode, where
   * bars are fetched not generated). Each new bar advances the regime first.
   * @param {number} i - Highest base-bar index that must exist.
   * @returns {void}
   */
  _ensureUpTo(i) {
    if (this.real) return;   // real data is fetched, never generated
    // Generate on demand so a "live" session can run forever without pre-building
    // an unbounded array — we only ever materialize bars up to where playback is.
    while (this.session.length <= i) {
      const idx = this.session.length;
      const prev = idx === 0 ? this._startPrice : this.session[idx - 1].close;
      this._stepRegime();   // advance regime exactly once per generated bar
      this.session.push(this._genBar(idx, prev));
    }
  }

  /**
   * Generate ~150 prior daily bars (for the 1D timeframe), rescaled so the most
   * recent daily close lands exactly on the configured start price — i.e. today
   * opens right where you set it.
   * @returns {void} Fills `this.dailyBars` and pins `this._startPrice`.
   */
  _genDailyHistory() {
    const target = this._startPrice;            // configured "current" level
    const rng = makeRng(this.mode === 'replay' ? hashSeed('daily:' + this.dateStr) : ((this._seed ^ 0x9e3779b9) >>> 0));
    const annualVol = (this.cfg.annualVolPct ?? 14) / 100;
    const dVol = annualVol / Math.sqrt(252);
    const N = 150;
    const openEpoch = this._sessionOpen;
    // Walk a daily random series FORWARD from the target. It won't land back on
    // the target, so we record raw bars and rescale afterward (below).
    let px = target;
    const raw = [];
    for (let d = N; d >= 1; d--) {
      const o = px;
      const r = rng.gaussian() * dVol + ((this.cfg.driftPctPerYear ?? 4) / 100) / 252;
      const c = o * Math.exp(r);
      // Wick beyond the body by a fraction of daily vol so candles look real.
      const hi = Math.max(o, c) * (1 + Math.abs(rng.gaussian()) * dVol * 0.6);
      const lo = Math.min(o, c) * (1 - Math.abs(rng.gaussian()) * dVol * 0.6);
      raw.push({ d, o, hi, lo, c });
      px = c;
    }
    // Uniformly scale every bar so the most recent close == the start price.
    // This pins "today" to the configured level without distorting bar shapes.
    const scale = target / px;
    this.dailyBars = raw.map((b) => ({
      time: openEpoch - b.d * 86400,
      open: roundToTick(b.o * scale), high: roundToTick(b.hi * scale),
      low: roundToTick(b.lo * scale), close: roundToTick(b.c * scale),
    }));
    this._startPrice = target;
  }

  /**
   * (Re)build a synthetic session from scratch for the current mode/date. Seeds
   * the RNG (random for live so each load is a fresh market; date-derived for
   * replay so a date always replays the same), resets the regime, generates the
   * daily history, and positions playback (mid-session for live, start for replay).
   * @returns {void}
   */
  _initSession() {
    this.real = false;     // synthetic init clears any real-data state
    this._sessionOpen = sessionOpenEpoch(this.dateStr);
    this._startPrice = roundToTick(this.cfg.startPrice ?? 43500);
    // Seed choice IS the live-vs-replay difference: replay derives the seed from
    // the date (+start price) so the same date always replays an identical tape;
    // live mixes Math.random with the clock so every load is a brand-new market.
    this._seed = this.mode === 'replay'
      ? hashSeed('replay:' + this.dateStr + ':' + (this.cfg.startPrice ?? 43500))
      : ((Math.floor(Math.random() * 0xffffffff) ^ Date.now()) >>> 0);
    this._rng = makeRng(this._seed);
    // Convert annual volatility -> per-minute -> per-bar stdev. Variance scales
    // linearly with time, so stdev scales with sqrt(time) (the sqrt factors).
    this._perMin = ((this.cfg.annualVolPct ?? 14) / 100) / Math.sqrt(MIN_PER_YEAR);
    this._perBar = this._perMin * Math.sqrt(BASE_SEC / 60);  // stdev over one base bar
    this._logv = 0;                    // reset the volatility regime
    this._anchor = this._startPrice;   // fair-value level price reverts toward
    this.session = [];
    this._genDailyHistory();           // also pins _startPrice
    if (this.mode === 'replay') {
      this._ensureUpTo(SESSION_BARS - 1);
      this.pos = 0;
      this.playing = false;
    } else {
      this._ensureUpTo(WARMUP_BARS);   // arrive mid-session with context
      this.pos = WARMUP_BARS;
      this.playing = true;
    }
  }

  // ---- public state ---------------------------------------------------------

  /** @returns {number} Total bars in the session (fixed for replay, growing live). */
  get sessionLength() { return this.mode === 'replay' ? SESSION_BARS : this.session.length; }

  /**
   * Build the partially-formed current bar from the fractional playback position
   * — only the revealed slice of the current base bar's intra-bar path, so the
   * rightmost candle grows smoothly.
   * @returns {{time:number, open:number, high:number, low:number, close:number,
   *   volume:number}} The forming bar.
   */
  _formingBar() {
    // `pos` is fractional: the integer part is which base bar, the fraction is
    // how far into that bar's pre-computed micro-path we've "played".
    const i = Math.floor(this.pos);
    this._ensureUpTo(i);
    const bar = this.session[i];
    if (!bar) return this.session[this.session.length - 1];   // past the end -> last real bar
    const frac = this.pos - i;
    // Reveal only the first `k` points of the path; high/low/close are computed
    // from that slice, so the candle's wick and body grow as time advances.
    const k = Math.max(1, Math.min(bar.path.length, Math.floor(frac * bar.path.length) + 1));
    const sub = bar.path.slice(0, k);
    return {
      time: bar.time,
      open: sub[0],
      high: Math.max(...sub),
      low: Math.min(...sub),
      close: sub[sub.length - 1],
      volume: bar.volume || 0,
    };
  }

  /** @returns {number} The current last/mark price (used for P&L marking). */
  get last() {
    if (this.real) { const s = this.session; return s.length ? s[s.length - 1].close : this._startPrice; }
    return this._formingBar().close;
  }

  /**
   * The current quote, with a synthetic bid/ask straddling the mark by the
   * configured spread (in ticks).
   * @returns {{mark:number, bid:number, ask:number}}
   */
  get quote() {
    const mark = this.last;
    const w = (this.cfg.spreadTicks ?? 1) * CONTRACT.tickSize;
    const bid = roundToTick(mark - w / 2);
    const ask = bid + w;
    return { mark, bid, ask };
  }

  /** @returns {number} The session's opening price (for the "Today" % change). */
  get sessionOpenPrice() { return this.session[0]?.open ?? this._startPrice; }

  /** @returns {number} Timestamp (epoch sec) of the current bar — for placing trade markers. */
  get currentBarTime() {
    if (this.real) { const s = this.session; return s.length ? s[s.length - 1].time : this._sessionOpen; }
    return this._sessionOpen + Math.floor(this.pos) * BASE_SEC;
  }

  /** @returns {boolean} True if price is up on the session (drives green/red coloring). */
  get dayUp() { return this.last >= this.sessionOpenPrice; }

  /**
   * Aggregate the base (30s) bars into the requested timeframe. The 1D view uses
   * the synthetic daily history (+ today). Aggregation buckets bars by
   * floor(time / tfSeconds) and merges OHLC + volume.
   * @param {'30s'|'1m'|'5m'|'15m'|'1h'|'1D'} tf - Timeframe id.
   * @returns {Array<{time:number,open:number,high:number,low:number,close:number,volume:number}>}
   *   Bars ready for the chart/indicators, oldest first, last one still forming.
   */
  getBars(tf) {
    if (tf === '1D' && !this.real) {
      const today = this._todayDailyBar();
      return [...this.dailyBars, today];
    }
    const sec = TF_SECONDS[tf] || 300;
    const upto = Math.floor(this.pos);   // index of the bar currently forming
    const out = [];
    let cur = null;   // the timeframe bucket we're currently filling
    for (let i = 0; i <= upto && i < this.session.length; i++) {
      // The last base bar is the FORMING one; earlier ones are final.
      const b = i === upto ? this._formingBar() : this.session[i];
      // Bucket key = bar time floored to the timeframe. A new key starts a new
      // aggregated candle; the same key merges into the one in progress.
      const bucket = Math.floor(b.time / sec) * sec;
      if (!cur || cur.time !== bucket) {
        cur = { time: bucket, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
        out.push(cur);
      } else {
        cur.high = Math.max(cur.high, b.high);   // open stays from the first base bar;
        cur.low = Math.min(cur.low, b.low);      // high/low extend, close tracks the latest,
        cur.close = b.close;                     // volume sums across the bucket.
        cur.volume += b.volume || 0;
      }
    }
    return out;
  }

  /**
   * Build today's single daily candle by aggregating the session so far (used as
   * the last bar of the 1D view).
   * @returns {{time:number,open:number,high:number,low:number,close:number}}
   */
  _todayDailyBar() {
    const upto = Math.floor(this.pos);
    let o = this.session[0]?.open ?? this._startPrice, hi = -Infinity, lo = Infinity, c = o;
    for (let i = 0; i <= upto && i < this.session.length; i++) {
      const b = i === upto ? this._formingBar() : this.session[i];
      hi = Math.max(hi, b.high); lo = Math.min(lo, b.low); c = b.close;
    }
    return { time: this._sessionOpen, open: o, high: hi, low: lo, close: c };
  }

  /** @returns {string} The session "wall clock" at the current position, e.g. "01:32 PM ET". */
  get clockLabel() {
    let t;
    if (this.real) {
      const s = this.session; t = s.length ? s[s.length - 1].time : this._sessionOpen;
    } else {
      const i = Math.min(Math.floor(this.pos), this.sessionLength - 1);
      t = this._sessionOpen + Math.max(0, i) * BASE_SEC;
    }
    return new Intl.DateTimeFormat('en-US', {
      hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York',
    }).format(new Date(t * 1000)) + ' ET';
  }

  // ---- playback / events ----------------------------------------------------

  /**
   * Subscribe to feed events.
   * @param {(evt:{type:'tick'|'reset'|'state'|'end', newBar?:boolean})=>void} fn
   * @returns {()=>void} Unsubscribe function.
   */
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Emit an event to all subscribers. @param {object} evt @returns {void} */
  _emit(evt) { for (const fn of this.listeners) fn(evt); }

  /**
   * One animation frame: advance the playback position by real elapsed time
   * scaled by the current speed (so candle durations are honored), generate any
   * needed new bars (live), end the session (replay), and emit a tick. No-op in
   * real-data mode (the app polls instead).
   * @param {number} now - `performance.now()` timestamp.
   * @returns {void}
   */
  _frame(now) {
    if (this.real || !this.playing) return;
    // Advance by REAL elapsed time (not a fixed step) so playback speed is
    // independent of frame rate / tab throttling — dt is whatever actually passed.
    const dt = now - this._lastFrame;
    this._lastFrame = now;
    // Real ms per base (30s) bar. At 1× a 30s bar takes 30s, a 1m candle 1 min…
    const mult = this.mode === 'replay' ? this.speed : this._liveSpeed;
    const barMs = (BASE_SEC * 1000) / mult;
    const before = Math.floor(this.pos);
    this.pos += dt / barMs;   // fractional advance -> smooth forming candle

    if (this.mode === 'replay' && this.pos >= SESSION_BARS) {
      this.pos = SESSION_BARS;   // clamp at the close; don't run past the day
      this.pause();
      this._emit({ type: 'end' });
    }
    // Pre-generate one bar ahead in live mode so _formingBar always has a path.
    if (this.mode === 'live') this._ensureUpTo(Math.floor(this.pos) + 1);

    // `newBar` lets listeners know a base bar just completed (vs. same bar still
    // forming) — the chart uses it to decide append vs. update.
    const after = Math.floor(this.pos);
    this._emit({ type: 'tick', newBar: after > before });
  }

  /** Start the animation timer (idempotent). @returns {void} */
  start() {
    if (this._timer) return;
    this._lastFrame = performance.now();
    this._timer = setInterval(() => this._frame(performance.now()), FRAME_MS);
  }
  /** Stop the animation timer. @returns {void} */
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
  /** Resume playback. @returns {void} */
  play() { this.playing = true; this._lastFrame = performance.now(); this._emit({ type: 'state' }); }
  /** Pause playback. @returns {void} */
  pause() { this.playing = false; this._emit({ type: 'state' }); }
  /** Toggle play/pause. @returns {void} */
  togglePlay() { this.playing ? this.pause() : this.play(); }

  /** Set the replay speed multiple. @param {number} mult @returns {void} */
  setSpeed(mult) { this.speed = mult; }
  /** Set the live speed multiple (1 = real time). @param {number} mult @returns {void} */
  setLiveSpeed(mult) { this._liveSpeed = mult; }

  /**
   * Jump playback to a fraction of the session (replay scrubber).
   * @param {number} f - Fraction in [0, 1].
   * @returns {void}
   */
  seekFraction(f) {
    this.pos = Math.max(0, Math.min(this.sessionLength, f * this.sessionLength));
    if (this.mode === 'live') this._ensureUpTo(Math.floor(this.pos) + 1);
    this._emit({ type: 'tick', newBar: true });
  }
  /** @returns {number} Playback progress as a fraction in [0, 1]. */
  get progressFraction() { return this.sessionLength ? this.pos / this.sessionLength : 0; }

  /**
   * Switch between 'live' and 'replay' and regenerate the session. Emits 'reset'.
   * @param {'live'|'replay'} mode
   * @param {string} [dateStr] - Date for replay ("YYYY-MM-DD").
   * @returns {void}
   */
  setMode(mode, dateStr) {
    this.mode = mode;
    if (dateStr) this.dateStr = dateStr;
    this._initSession();
    this._emit({ type: 'reset' });
  }
  /** Change the replay date and regenerate. @param {string} dateStr @returns {void} */
  setDate(dateStr) { this.dateStr = dateStr; this._initSession(); this._emit({ type: 'reset' }); }

  /**
   * Regenerate the synthetic market (new random seed) — e.g. after a config
   * change. Emits 'reset'.
   * @param {object} [cfg] - Optional new config to adopt.
   * @returns {void}
   */
  reseed(cfg) { if (cfg) this.cfg = cfg; this._initSession(); this._emit({ type: 'reset' }); }

  /**
   * Import historical bars from CSV text and load them as a replayable session.
   * @param {string} text - CSV with columns `time,open,high,low,close` (time =
   *   epoch seconds or an ISO date/time). A header row is skipped automatically.
   * @returns {void}
   * @throws {Error} If no valid rows are found.
   */
  loadCSV(text) {
    const rows = text.trim().split(/\r?\n/);
    const bars = [];
    for (const line of rows) {
      const parts = line.split(',').map((s) => s.trim());
      if (parts.length < 5) continue;
      const tRaw = parts[0];
      if (/[a-zA-Z]/.test(tRaw) && !/^\d/.test(tRaw)) continue; // header
      const t = /^\d+$/.test(tRaw) ? Number(tRaw) : Math.floor(Date.parse(tRaw) / 1000);
      const [o, h, l, c] = parts.slice(1, 5).map(Number);
      if (![t, o, h, l, c].every(Number.isFinite)) continue;
      // synthesize an intra-bar path that visits both extremes
      const path = c >= o ? [o, l, h, c] : [o, h, l, c];
      bars.push({ time: t, open: o, high: h, low: l, close: c, path: path.map(roundToTick) });
    }
    if (!bars.length) throw new Error('No valid rows (need time,open,high,low,close).');
    bars.sort((a, b) => a.time - b.time);
    this.mode = 'replay';
    this.session = bars;
    this._sessionOpen = bars[0].time;
    this._startPrice = bars[0].open;
    this.dailyBars = [];
    this.pos = 0;
    this.playing = false;
    this._emit({ type: 'reset' });
  }

  /**
   * Load real (delayed) bars for the current day as the session. The app fetches
   * these from Yahoo and re-calls this on each poll; rendering is driven by the
   * app (no synthetic timer runs in real mode).
   * @param {Array<{time:number,open:number,high:number,low:number,close:number,volume?:number}>} bars
   * @returns {void}
   */
  loadLiveBars(bars) {
    if (!bars || !bars.length) return;
    this.real = true;
    this.mode = 'live';
    this.playing = false;
    this.session = bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 }));
    this.dailyBars = [];
    this._sessionOpen = bars[0].time;
    this._startPrice = bars[0].open;
    this.pos = this.session.length;   // show every bar; the last one is "now"
  }
}
