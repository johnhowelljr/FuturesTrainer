// =============================================================================
// app.js — Application bootstrap & controller (the "wiring")
// -----------------------------------------------------------------------------
// The conductor. It creates the core objects (Feed, Engine, PriceChart, the
// ChartTrading overlay, the Ladder, and the floating OrderTicket), connects them
// to the DOM and to each other, and owns all the user-event handlers (toolbar,
// order ticket, indicators menu, replay controls, contract selector, settings,
// keyboard shortcuts). Almost everything here is glue:
//
//   feed  --(tick/reset/end)-->  redraw chart + ladder + overlay, mark the engine
//   engine --(snapshot)-->       redraw account/position/orders, persist state
//   user events -->              place/cancel orders, switch timeframe/mode/etc.
//
// Business logic lives in the modules this imports; this file decides *when* to
// call them. State that survives reloads is saved (debounced) via store.js.
// =============================================================================

import { DEFAULT_CONFIG, CONTRACT, CONTRACTS, fmtPx, fmtUSD, roundToTick, syncContract, loadContractDefaults } from './contract.js';
import { Feed } from './feed.js';
import { Engine } from './engine.js';
import { PriceChart } from './chart.js';
import { ChartTrading } from './charttrade.js';
import { Ladder } from './ladder.js';
import { OrderTicket } from './orderticket.js';
import { INDICATOR_DEFS } from './indicators.js';
import { loadState, saveState } from './store.js';
import * as ui from './ui.js';

/** Timeframe id -> seconds per bar (mirrors feed.js; used for marker snapping). */
const TF_SECONDS = { '30s': 30, '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1D': 86400 };
/** Order-type id -> human label for toasts/confirmations. */
const TYPE_LABEL = { market: 'Market', limit: 'Limit', stop: 'Stop' };

// Hard guard: if the charting library didn't load (opened as a file:// without
// the server), tell the user how to run it properly.
if (!window.LightweightCharts) {
  document.getElementById('chart').innerHTML =
    '<div style="padding:24px;color:#9aa3ad">Chart library failed to load. Run via <code>node server.js</code> and reload.</div>';
}

// ---- state ----------------------------------------------------------------
const state = loadState();
let cfg = state.config;
let prefs = state.prefs;
if (prefs.autoSend === undefined) prefs.autoSend = cfg.autoSend ?? true;
if (prefs.tif === undefined) prefs.tif = cfg.defaultTif || 'day';
syncContract(cfg);   // set CONTRACT (symbol, tick, multiplier) before the feed/engine use it

const feed = new Feed(cfg);
const engine = new Engine(cfg);
engine.load(state.account);

/**
 * Reflect the active contract + multiplier across the UI: the contract selector,
 * header symbol/subtitle, and the chart's price precision. Call after any
 * contract/config change.
 * @returns {void}
 */
function applyContractCfg() {
  syncContract(cfg);
  ui.els.contractSel.value = cfg.contractKey;
  ui.els.symbol.textContent = CONTRACT.symbol;
  ui.els.instSub.textContent = `${CONTRACT.monthLabel} · ${CONTRACT.exchange} · ${fmtUSD(CONTRACT.pointValue)} / point`;
  chart.setPriceFormat(CONTRACT.tickSize);
}

const chart = new PriceChart(ui.els.chart);
let timeframe = prefs.timeframe || '5m';
let tradeMarkers = [];     // {time, side, qty} arrow markers for fills
let lastActivityId = 0;    // high-water mark so we only add markers for NEW fills
let pendingOrder = null;   // order awaiting the confirmation dialog

// ---- persistence (debounced) ----------------------------------------------
let saveTimer = null;
/** Save config/account/prefs to localStorage, debounced ~600ms. @returns {void} */
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveState({ config: cfg, account: engine.toJSON(), prefs }), 600);
}

// ---- chart legend overlay (floating O/H/L/C on hover) ---------------------
const legend = document.createElement('div');
legend.className = 'chart-legend';
ui.els.chart.appendChild(legend);
chart.onCrosshair((bar) => {
  if (!bar) { legend.classList.remove('show'); return; }
  legend.classList.add('show');
  const f = fmtPx;
  if (bar.bar?.open != null) {
    const b = bar.bar, up = b.close >= b.open;
    legend.innerHTML = `<span>O <b>${f(b.open)}</b></span><span>H <b>${f(b.high)}</b></span>` +
      `<span>L <b>${f(b.low)}</b></span><span class="${up ? 'up' : 'down'}">C <b>${f(b.close)}</b></span>`;
  } else if (bar.bar) {
    legend.innerHTML = `<span>Price <b>${f(bar.bar.close)}</b></span>`;
  }
});

// ---- floating order ticket (opened from the chart) ------------------------

/**
 * Place an order directly (used by the floating ticket, which *is* the
 * confirmation step). Shows a success/working/error toast.
 * @param {object} order - {side,type,qty,tif,limitPx,stopPx}.
 * @returns {{ok:boolean, reason?:string, filled?:boolean}} Engine result.
 */
function place(order) {
  const res = engine.placeOrder(order);
  if (!res.ok) { ui.toast(res.reason, 'error'); return res; }
  if (res.filled) ui.toast(`${order.side === 'buy' ? 'Bought' : 'Sold'} ${order.qty} ${CONTRACT.symbol} @ ${fmtPx(res.price)}`, 'success');
  else ui.toast(`Order working: ${order.side} ${order.qty} ${TYPE_LABEL[order.type].toLowerCase()}`, 'info');
  return res;
}
const orderTicket = new OrderTicket({ engine, feed, place, toast: ui.toast });

// ---- chart trading overlay ------------------------------------------------
const ct = new ChartTrading(chart, {
  engine, feed,
  getQty: () => ticketQty(),
  getTif: () => prefs.tif,
  setSide,
  submitOrder,
  selectOrder,
  openTicket: (opts) => orderTicket.open(opts),
  toast: ui.toast,
});
chart.onVisibleRangeChange(() => ct.render());

// ---- ladder (DOM) widget --------------------------------------------------
const ladder = new Ladder(document.getElementById('ladder'), {
  engine, feed,
  getQty: () => ticketQty(),
  setQty: (delta) => { ui.els.qty.value = Math.max(1, ticketQty() + delta); updateTicketMeta(); },
  getAutoSend: () => prefs.autoSend,
  setAutoSend: (v) => { prefs.autoSend = v; ui.els.autoSend.checked = v; updateTicketMeta(); persist(); },
  submitOrder,
  toast: ui.toast,
});

// ---- rendering ------------------------------------------------------------
/** @returns {boolean} Whether price is up on the session (for chart coloring). */
const dayUp = () => feed.dayUp;

/**
 * Full chart rebuild: re-fetch bars for the timeframe and redraw candles,
 * indicators, markers, position/order lines, the overlay, and the ladder. Used
 * on timeframe/mode/contract/settings changes.
 * @returns {void}
 */
function fullRedraw() {
  const bars = feed.getBars(timeframe);
  chart.setData(bars, TF_SECONDS[timeframe], dayUp());
  chart.renderIndicators(bars, prefs.indicators);
  chart.setMarkers(tradeMarkers);
  chart.setPositionLine(engine.position.avg, engine.position.qty);
  chart.setOrderLines(engine.orders);
  ct.render();
  ladder.render();
}

/**
 * Lightweight per-tick redraw: update just the last bar + indicators + overlay +
 * ladder + the floating ticket (cheaper than a full rebuild).
 * @returns {void}
 */
function tickRedraw() {
  const bars = feed.getBars(timeframe);
  const last = bars[bars.length - 1];
  if (last) chart.updateLast(last, dayUp());
  chart.renderIndicators(bars, prefs.indicators);
  ct.render();
  ladder.render();
  orderTicket.refresh();
}

/** Repaint the instrument header from the current quote/clock. @returns {void} */
function renderHeader() {
  const q = feed.quote;
  ui.renderInstrument({ mark: q.mark, bid: q.bid, ask: q.ask, open: feed.sessionOpenPrice, clock: feed.clockLabel });
}

/** Repaint all account-related panels from an engine snapshot. @param {object} snap @returns {void} */
function renderAccount(snap) {
  ui.renderAccount(snap);
  ui.renderPosition(snap);
  ui.renderOrders(snap);
  ui.renderActivity(snap);
}

/**
 * Add chart arrow markers for any fills that happened since the last call
 * (tracked by activity id) at the current bar time.
 * @returns {void}
 */
function captureMarkers() {
  // Only NEW fills: activity ids are monotonic, so anything above the high-water
  // mark hasn't been turned into a marker yet. This runs on every engine emit,
  // so without the id gate we'd re-add markers for the same fill repeatedly.
  const fills = engine.activity.filter((a) => a.kind === 'fill' && a.id > lastActivityId);
  if (fills.length) {
    lastActivityId = Math.max(...engine.activity.map((a) => a.id));
    // Stamp the marker at the CURRENT bar time (when it filled), not the fill's
    // own timestamp, so it lands on the candle the user is watching.
    for (const f of fills) tradeMarkers.push({ time: feed.currentBarTime, side: f.side, qty: f.qty });
    chart.setMarkers(tradeMarkers);
  }
}

// ---- inline order ticket --------------------------------------------------
/** @returns {'buy'|'sell'} The currently selected side in the inline ticket. */
function ticketSide() { return ui.els.sideToggle.querySelector('.active').dataset.side; }
/** @returns {number} The current quantity (>= 1) from the inline ticket. */
function ticketQty() { return Math.max(1, Math.floor(Number(ui.els.qty.value) || 1)); }
/** @returns {'market'|'limit'|'stop'} The selected order type. */
function ticketType() { return ui.els.ordType.value; }

/**
 * Recompute and paint the inline ticket's estimates (fill, notional, margin,
 * cost), the place-button label, the footer help text, and re-render the ladder.
 * @returns {void}
 */
function updateTicketMeta() {
  const side = ticketSide(); const qty = ticketQty(); const type = ticketType();
  let fillPx;
  if (type === 'market') fillPx = engine.fillPriceFor(side);
  else if (type === 'limit') fillPx = Number(ui.els.limitPx.value) || null;
  else fillPx = Number(ui.els.stopPx.value) || null;
  const notional = (fillPx ?? feed.quote.mark) * CONTRACT.pointValue * qty;
  ui.renderTicketMeta({ fillPx, notional, margin: qty * cfg.initialMargin, cost: engine.estCost(qty) });
  ui.setPlaceButton(side, qty);
  ui.els.ticketFoot.textContent = ({
    market: 'Market order fills at the ' + (side === 'buy' ? 'offer (ask)' : 'bid') + '. Fees included.',
    limit: 'Limit rests until the market reaches your price.',
    stop: 'Stop becomes a market order once the stop price trades.',
  })[type] + (prefs.autoSend ? '' : ' · Review before sending.');
  ladder.render();
}

/**
 * Show/hide the price + TIF fields for the current order type and seed sensible
 * default prices, then refresh estimates.
 * @returns {void}
 */
function syncTicketFields() {
  const type = ticketType();
  ui.els.limitFld.hidden = type !== 'limit';
  ui.els.stopFld.hidden = type !== 'stop';
  ui.els.tifFld.hidden = type === 'market';
  const q = feed.quote, side = ticketSide();
  if (type === 'limit' && !ui.els.limitPx.value) ui.els.limitPx.value = Math.round(side === 'buy' ? q.ask : q.bid);
  if (type === 'stop' && !ui.els.stopPx.value) ui.els.stopPx.value = Math.round(side === 'buy' ? q.ask + 10 : q.bid - 10);
  updateTicketMeta();
}

/**
 * Select the order side in the inline ticket and re-sync fields.
 * @param {'buy'|'sell'} side
 * @returns {void}
 */
function setSide(side) {
  for (const b of ui.els.sideToggle.children) b.classList.toggle('active', b.dataset.side === side);
  prefs.side = side;
  syncTicketFields();
  document.getElementById('ticket')?.scrollIntoView({ block: 'nearest' });
}

/**
 * Load an existing working order's parameters into the inline ticket form (used
 * when you click an order handle on the chart).
 * @param {object} o - The order to load.
 * @returns {void}
 */
function selectOrder(o) {
  ui.els.ordType.value = o.type; prefs.ordType = o.type;
  ui.els.qty.value = o.qty;
  ui.els.tif.value = o.tif || 'day'; prefs.tif = o.tif || 'day';
  if (o.type === 'limit') ui.els.limitPx.value = o.limitPx;
  if (o.type === 'stop') ui.els.stopPx.value = o.stopPx;
  setSide(o.side);
  ui.toast('Order loaded into form', 'info');
}

/**
 * Central order submission. Honors the auto-send preference: when off, a market
 * confirmation dialog is shown first. Chart-drag replacements bypass review.
 * @param {object} order - {side,type,qty,tif,limitPx,stopPx}.
 * @param {boolean} [isReplace=false] - True for cancel+replace drags (skip review).
 * @returns {{ok:boolean, pending?:boolean}} Result (pending = awaiting confirm).
 */
function submitOrder(order, isReplace = false) {
  if (prefs.autoSend || isReplace) {
    const res = engine.placeOrder(order);
    if (!res.ok) { ui.toast(res.reason, 'error'); return res; }
    if (res.filled) ui.toast(`${order.side === 'buy' ? 'Bought' : 'Sold'} ${order.qty} ${CONTRACT.symbol} @ ${fmtPx(res.price)}`, 'success');
    else ui.toast(`Order working: ${order.side} ${order.qty} ${TYPE_LABEL[order.type].toLowerCase()}`, 'info');
    return res;
  }
  openConfirm(order);
  return { ok: true, pending: true };
}

/**
 * Populate and open the order-confirmation dialog for a pending order (the
 * Robinhood "review before sending" screen).
 * @param {object} order - The order to confirm.
 * @returns {void}
 */
function openConfirm(order) {
  pendingOrder = order;
  const px = order.type === 'market' ? engine.fillPriceFor(order.side) : (order.limitPx ?? order.stopPx);
  ui.els.cfSide.textContent = `${order.side === 'buy' ? 'Buy' : 'Sell'} ${order.qty} ${CONTRACT.symbol}`;
  ui.els.cfSide.className = `cf-side ${order.side === 'buy' ? 'up' : 'down'}`;
  const priceLabel = order.type === 'market' ? 'Est. fill' : order.type === 'stop' ? 'Stop price' : 'Limit price';
  ui.els.cfDetails.innerHTML = `
    <div><span>Order type</span><b>${TYPE_LABEL[order.type]}</b></div>
    <div><span>${priceLabel}</span><b>${fmtPx(px)}</b></div>
    <div><span>Time in force</span><b>${(order.tif || 'day').toUpperCase()}</b></div>
    <div><span>Notional</span><b>${fmtUSD(px * CONTRACT.pointValue * order.qty)}</b></div>
    <div><span>Margin required</span><b>${fmtUSD(order.qty * cfg.initialMargin)}</b></div>
    <div><span>Est. fees</span><b>${fmtUSD(engine.estCost(order.qty))}</b></div>`;
  ui.els.cfSubmit.className = order.side === 'buy' ? 'primary buy' : 'primary sell';
  ui.els.cfSubmit.textContent = `${order.side === 'buy' ? 'Buy' : 'Sell'} ${order.qty} ${CONTRACT.symbol}`;
  ui.els.confirmDlg.showModal();
}
ui.els.cfCancel.addEventListener('click', () => { pendingOrder = null; ui.els.confirmDlg.close(); });
ui.els.cfSubmit.addEventListener('click', () => {
  if (pendingOrder) submitOrder(pendingOrder, true);
  pendingOrder = null; ui.els.confirmDlg.close();
});

// ---- feed subscription (drives all chart/market rendering) ----------------
// This fires on every feed event and is the heartbeat of the app: it marks the
// engine to the new quote (which may fill resting orders) and redraws.
feed.subscribe((evt) => {
  // On a session swap, cancel working orders FIRST. The new tape can start at a
  // wildly different price, and an un-cancelled limit/stop would instantly fill
  // ("teleport-fill") against it. Cancel before onQuote sees the new quote.
  if (evt.type === 'reset') engine.cancelAllOrders();
  engine.onQuote(feed.quote);   // <- this is where resting orders get a chance to fill
  renderHeader();
  // reset = brand-new session: reset day P&L baseline and do a full rebuild.
  if (evt.type === 'reset') { engine.newDay(); fullRedraw(); chart.showRecent(); }
  // tick = same session moving forward: cheap update of just the last bar.
  else if (evt.type === 'tick') { tickRedraw(); }
  // end = replay reached the close: expire any day orders (GTC survive).
  else if (evt.type === 'end') { engine.expireDayOrders(); }
  if (feed.mode === 'replay') {   // keep the replay scrubber/clock/play button in sync
    ui.els.rpScrub.value = String(Math.round(feed.progressFraction * 1000));
    ui.els.rpTime.textContent = feed.clockLabel;
    ui.els.rpPlay.textContent = feed.playing ? '⏸' : '▶';
  }
  // Market-order estimates move with the quote, so refresh them every tick.
  if (ticketType() === 'market') updateTicketMeta();
});

// ---- engine subscription (drives all account rendering) -------------------
// Fires whenever the account changes (fill, cancel, quote-mark, reset). Note the
// two subscriptions can both run per tick — feed -> onQuote -> engine emit — but
// each only touches its own concern, so the double render is cheap and correct.
engine.subscribe((snap) => {
  renderAccount(snap);
  captureMarkers();   // add chart arrows for any brand-new fills in this snapshot
  chart.setPositionLine(snap.position.avg, snap.position.qty);
  chart.setOrderLines(snap.orders);
  ct.render();
  ladder.render();
  persist();   // debounced — safe to call on every change
});

// ---- toolbar: timeframe + live speed --------------------------------------
ui.els.tfTabs.addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  timeframe = btn.dataset.tf; prefs.timeframe = timeframe;
  for (const b of ui.els.tfTabs.children) b.classList.toggle('active', b === btn);
  fullRedraw(); chart.showRecent(); persist();
});
ui.els.liveSpeed.addEventListener('change', (e) => {
  feed.setLiveSpeed(Number(e.target.value)); prefs.liveSpeed = Number(e.target.value); persist();
});

// ---- real (delayed) market data -------------------------------------------
let realPollTimer = null;

/**
 * Fetch intraday bars from Yahoo Finance (via the server's `__yahoo` proxy).
 * @param {string} symbol - Yahoo symbol (e.g. "MYM=F").
 * @param {string} [interval='1m'] - Bar interval.
 * @param {string} [range='1d'] - Look-back range.
 * @returns {Promise<Array<{time,open,high,low,close,volume}>>} Parsed bars.
 * @throws {Error} If Yahoo returns no usable result.
 */
async function fetchYahoo(symbol, interval = '1m', range = '1d') {
  const res = await fetch(`__yahoo?symbol=${encodeURIComponent(symbol)}&interval=${interval}&range=${range}`);
  const j = await res.json();
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error((j.chart && j.chart.error && j.chart.error.description) || 'no data');
  const t = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const bars = [];
  for (let i = 0; i < t.length; i++) {
    const o = q.open?.[i], h = q.high?.[i], l = q.low?.[i], c = q.close?.[i];
    if ([o, h, l, c].some((x) => x == null)) continue;
    bars.push({ time: t[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] || 0 });
  }
  return bars;
}

/**
 * Load the active contract's real (delayed) bars into the feed and redraw. On
 * failure/empty (offline, market closed) falls back to synthetic on first load.
 * @param {boolean} firstLoad - True for the initial load (frames + toasts).
 * @returns {Promise<void>}
 */
async function refreshRealLive(firstLoad) {
  const sym = CONTRACTS[cfg.contractKey].yahoo;
  let bars;
  try { bars = await fetchYahoo(sym); }
  catch (e) { ui.toast('Live data: ' + e.message, 'error'); if (firstLoad) setDataSource('synthetic'); return; }
  if (!bars.length) { ui.toast('Live data: market closed or no bars yet', 'info'); if (firstLoad) setDataSource('synthetic'); return; }
  feed.loadLiveBars(bars);
  engine.onQuote(feed.quote);
  renderHeader();
  fullRedraw();
  if (firstLoad) { chart.showRecent(); ui.toast(`Live ${CONTRACT.symbol} · delayed ~15 min`, 'success'); }
}

/**
 * Sync the toolbar's visibility (data-source buttons, mode toggle, replay bar,
 * live-speed control) to the current preferences.
 * @returns {void}
 */
function updateToolbar() {
  const real = prefs.dataSource === 'real';
  for (const b of ui.els.dataToggle.children) b.classList.toggle('active', b.dataset.src === (real ? 'real' : 'synthetic'));
  ui.els.modeToggle.hidden = real;
  ui.els.replayBar.hidden = real || prefs.mode !== 'replay';
  ui.els.liveSpeedWrap.hidden = real || prefs.mode === 'replay';
}

/**
 * Switch between 'synthetic' and 'real' data sources. Flattens the position and
 * cancels orders (they don't carry across sources), then either starts the
 * synthetic feed or begins polling Yahoo every 30s.
 * @param {'synthetic'|'real'} src
 * @returns {void}
 */
function setDataSource(src) {
  prefs.dataSource = src;
  clearInterval(realPollTimer); realPollTimer = null;   // stop any prior real-data polling
  // Flatten + cancel: a position priced against one tape is meaningless on the
  // other, so we always start the new source flat. Clear markers for the same reason.
  engine.flatten(); engine.cancelAllOrders();
  tradeMarkers = [];
  if (src === 'real') {
    feed.stop();                 // no synthetic timer in real mode — Yahoo polling drives it
    refreshRealLive(true);
    realPollTimer = setInterval(() => refreshRealLive(false), 30000);   // ~delayed data; 30s is plenty
  } else {
    feed.real = false;
    feed.setMode(prefs.mode || 'live');
    feed.start();                // restart the synthetic animation timer
  }
  updateToolbar(); persist();
}

ui.els.dataToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn || btn.dataset.src === prefs.dataSource) return;
  setDataSource(btn.dataset.src);
});

/**
 * Best-effort: re-anchor the SYNTHETIC market to the real current price (so it
 * matches Robinhood, e.g. ~52,400 for the Dow, not a stale default). Silently
 * does nothing offline or in real-data mode.
 * @returns {Promise<void>}
 */
async function anchorSyntheticPrice() {
  if (prefs.dataSource === 'real' || feed.real) return;
  try {
    const bars = await fetchYahoo(CONTRACTS[cfg.contractKey].yahoo);
    // Re-check feed.real after the await: the user may have flipped to real-data
    // mode while this network request was in flight — don't clobber that.
    if (!bars.length || feed.real) return;
    const px = roundToTick(bars[bars.length - 1].close);
    // Only reseed if the real level differs from our start price by at least a
    // tick — avoids a pointless regenerate when we're already on the money.
    if (px > 0 && Math.abs(px - cfg.startPrice) >= CONTRACT.tickSize) {
      cfg.startPrice = px;
      feed.reseed(cfg);          // regenerate the synthetic tape around the real level
      fullRedraw(); chart.showRecent(); persist();
    }
  } catch { /* offline -> keep the configured default */ }
}
ui.els.typeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  prefs.chartType = btn.dataset.type;
  for (const b of ui.els.typeToggle.children) b.classList.toggle('active', b === btn);
  chart.setType(prefs.chartType); fullRedraw(); persist();
});

// ---- indicators menu ------------------------------------------------------
/** Build the indicators dropdown from INDICATOR_DEFS, checking the active ones. @returns {void} */
function buildIndicatorMenu() {
  ui.els.indMenu.innerHTML = INDICATOR_DEFS.map((d) =>
    `<label class="ind-item"><input type="checkbox" data-id="${d.id}"${prefs.indicators[d.id] ? ' checked' : ''}>` +
    `<span class="ind-swatch" style="background:${d.color}"></span>${d.label}</label>`).join('');
}
ui.els.indBtn.addEventListener('click', (e) => { e.stopPropagation(); ui.els.indMenu.hidden = !ui.els.indMenu.hidden; });
ui.els.indMenu.addEventListener('change', (e) => {
  const cb = e.target.closest('input[type=checkbox]'); if (!cb) return;
  prefs.indicators[cb.dataset.id] = cb.checked;
  fullRedraw(); persist();
});
document.addEventListener('click', (e) => {
  if (!ui.els.indMenu.hidden && e.target !== ui.els.indBtn && !ui.els.indMenu.contains(e.target)) ui.els.indMenu.hidden = true;
});
ui.els.modeToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  const mode = btn.dataset.mode;
  for (const b of ui.els.modeToggle.children) b.classList.toggle('active', b === btn);
  prefs.mode = mode;
  updateToolbar();
  tradeMarkers = [];
  feed.setMode(mode, mode === 'replay' ? (ui.els.rpDate.value || feed.dateStr) : undefined);
  if (mode === 'live') feed.play();
  fullRedraw(); chart.showRecent(); persist();
});

// ---- replay controls ------------------------------------------------------
ui.els.rpPlay.addEventListener('click', () => feed.togglePlay());
ui.els.rpScrub.addEventListener('input', (e) => feed.seekFraction(Number(e.target.value) / 1000));
ui.els.rpSpeed.addEventListener('change', (e) => { feed.setSpeed(Number(e.target.value)); prefs.speed = Number(e.target.value); persist(); });
ui.els.rpDate.addEventListener('change', (e) => { tradeMarkers = []; feed.setDate(e.target.value); fullRedraw(); chart.showRecent(); });

// CSV import button (added programmatically into the replay bar).
const importBtn = document.createElement('button');
importBtn.className = 'rp-import'; importBtn.textContent = 'Import CSV';
importBtn.title = 'Load historical bars: time,open,high,low,close';
const fileInput = document.createElement('input');
fileInput.type = 'file'; fileInput.accept = '.csv,text/csv'; fileInput.hidden = true;
importBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0]; if (!file) return;
  try { feed.loadCSV(await file.text()); tradeMarkers = []; fullRedraw(); chart.showRecent(); ui.toast(`Loaded ${file.name}`, 'success'); }
  catch (err) { ui.toast(err.message, 'error'); }
  fileInput.value = '';
});
ui.els.replayBar.append(importBtn, fileInput);

// ---- inline order ticket events -------------------------------------------
ui.els.sideToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  ui.els.limitPx.value = ''; ui.els.stopPx.value = '';
  setSide(btn.dataset.side); persist();
});
ui.els.autoSend.addEventListener('change', () => { prefs.autoSend = ui.els.autoSend.checked; updateTicketMeta(); persist(); });
ui.els.tif.addEventListener('change', () => { prefs.tif = ui.els.tif.value; persist(); });
ui.els.ordType.addEventListener('change', () => { prefs.ordType = ticketType(); syncTicketFields(); persist(); });
ui.els.qty.addEventListener('input', updateTicketMeta);
ui.els.qtyMinus.addEventListener('click', () => { ui.els.qty.value = Math.max(1, ticketQty() - 1); updateTicketMeta(); });
ui.els.qtyPlus.addEventListener('click', () => { ui.els.qty.value = ticketQty() + 1; updateTicketMeta(); });
ui.els.limitPx.addEventListener('input', updateTicketMeta);
ui.els.stopPx.addEventListener('input', updateTicketMeta);

ui.els.placeBtn.addEventListener('click', () => {
  submitOrder({
    side: ticketSide(), type: ticketType(), qty: ticketQty(), tif: prefs.tif,
    limitPx: ui.els.limitPx.value ? Number(ui.els.limitPx.value) : null,
    stopPx: ui.els.stopPx.value ? Number(ui.els.stopPx.value) : null,
  });
});

// Position-card actions (Close position / cancel order), event-delegated.
document.querySelector('.side-col').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-action]'); if (!btn) return;
  if (btn.dataset.action === 'flatten') { engine.flatten(); ui.toast('Position closed', 'info'); }
  if (btn.dataset.action === 'cancel') engine.cancelOrder(Number(btn.dataset.id));
});

// ---- contract selector ----------------------------------------------------
ui.els.contractSel.addEventListener('change', (e) => {
  engine.flatten();             // close any open position in the old contract first
  engine.cancelAllOrders();
  loadContractDefaults(e.target.value, cfg);
  engine.cfg = cfg;
  applyContractCfg();           // sets CONTRACT (tick/multiplier), header, chart precision
  tradeMarkers = [];
  if (prefs.dataSource === 'real') refreshRealLive(true);   // fetch the new symbol's real tape
  else { feed.reseed(cfg); anchorSyntheticPrice(); }        // fresh synthetic, anchored to real level
  updateTicketMeta(); persist();
  ui.toast(`Switched to ${CONTRACT.name} (${CONTRACT.symbol})`, 'success');
});

// ---- reset + settings -----------------------------------------------------
ui.els.btnReset.addEventListener('click', () => {
  if (!confirm('Reset the paper account to your start balance? This clears positions and history.')) return;
  tradeMarkers = []; lastActivityId = 0;
  engine.resetAccount(cfg);
  fullRedraw();
  ui.toast('Account reset', 'success');
});

const S = ui.els.settings;
/** Set a settings input's value by id. @param {string} id @param {*} v @returns {void} */
const setVal = (id, v) => { document.getElementById(id).value = v; };
ui.els.btnSettings.addEventListener('click', () => {
  setVal('setStart', cfg.startBalance); document.getElementById('setGold').checked = !!cfg.goldMember;
  setVal('setComm', cfg.commissionPerSide); setVal('setExch', cfg.exchangeFeePerSide); setVal('setNfa', cfg.nfaFeePerSide);
  setVal('setInitMargin', cfg.initialMargin); setVal('setMaintMargin', cfg.maintenanceMargin);
  setVal('setPointValue', cfg.pointValue);
  setVal('setSpread', cfg.spreadTicks); setVal('setStartPx', cfg.startPrice); setVal('setVol', cfg.annualVolPct);
  document.getElementById('setAutoLiq').checked = !!cfg.autoLiquidate;
  S.showModal();
});
S.addEventListener('close', () => {
  // <dialog> close fires for both Save and Cancel; only persist on Save. The
  // returnValue is set by the Save button's value attribute in the markup.
  if (S.returnValue !== 'save') return;
  // num() reads a numeric input, falling back to the old value if it's blank/NaN.
  const num = (id, d) => { const v = Number(document.getElementById(id).value); return Number.isFinite(v) ? v : d; };
  const gold = document.getElementById('setGold').checked;
  cfg = {
    ...cfg,
    startBalance: num('setStart', cfg.startBalance),
    goldMember: gold,
    // Gold membership forces the discounted $0.50/side commission and ignores the
    // typed commission field; otherwise use what was entered (default $0.75).
    commissionPerSide: gold ? 0.5 : num('setComm', 0.75),
    exchangeFeePerSide: num('setExch', cfg.exchangeFeePerSide),
    nfaFeePerSide: num('setNfa', cfg.nfaFeePerSide),
    initialMargin: num('setInitMargin', cfg.initialMargin),
    maintenanceMargin: num('setMaintMargin', cfg.maintenanceMargin),
    pointValue: Math.max(0.01, num('setPointValue', cfg.pointValue)),
    spreadTicks: Math.max(1, num('setSpread', cfg.spreadTicks)),
    startPrice: num('setStartPx', cfg.startPrice),
    annualVolPct: num('setVol', cfg.annualVolPct),
    autoLiquidate: document.getElementById('setAutoLiq').checked,
  };
  engine.cfg = cfg;             // engine reads cfg live, so this takes effect immediately
  applyContractCfg();           // pointValue/tick may have changed -> refresh header + chart precision
  feed.reseed(cfg);             // vol/start-price changes mean a fresh tape
  fullRedraw(); chart.showRecent(); updateTicketMeta(); persist();
  ui.toast('Settings saved', 'success');
});

// ---- keyboard shortcuts ---------------------------------------------------
// Space = play/pause (replay), B/S = set Buy/Sell side — ignored while typing.
window.addEventListener('keydown', (e) => {
  const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT';
  if (e.code === 'Space' && feed.mode === 'replay' && !typing) { e.preventDefault(); feed.togglePlay(); }
  if (!typing && (e.key === 'b' || e.key === 'B')) setSide('buy');
  if (!typing && (e.key === 's' || e.key === 'S')) setSide('sell');
});

// ---- boot -----------------------------------------------------------------
/**
 * One-time startup: apply contract config, build menus, restore all saved UI
 * state (timeframe, chart type, side, type, auto-send, TIF, speeds, mode), do the
 * first render, start the feed, and pick the data source.
 * @returns {void}
 */
function boot() {
  applyContractCfg();   // header symbol/name + chart price precision for the active contract
  if (!prefs.indicators) prefs.indicators = { ema9: true, ema21: true, vwap: true };
  buildIndicatorMenu();
  for (const b of ui.els.tfTabs.children) b.classList.toggle('active', b.dataset.tf === timeframe);
  chart.setType(prefs.chartType || 'candles');
  for (const b of ui.els.typeToggle.children) b.classList.toggle('active', b.dataset.type === (prefs.chartType || 'candles'));
  for (const b of ui.els.sideToggle.children) b.classList.toggle('active', b.dataset.side === (prefs.side || 'buy'));
  ui.els.ordType.value = prefs.ordType || 'market';
  ui.els.autoSend.checked = !!prefs.autoSend;
  ui.els.tif.value = prefs.tif || 'day';
  ui.els.rpDate.value = feed.dateStr;
  ui.els.rpSpeed.value = String(prefs.speed || 15);
  feed.setSpeed(prefs.speed || 15);
  ui.els.liveSpeed.value = String(prefs.liveSpeed || 1);
  feed.setLiveSpeed(prefs.liveSpeed || 1);

  const mode = prefs.mode || 'live';
  for (const b of ui.els.modeToggle.children) b.classList.toggle('active', b.dataset.mode === mode);
  updateToolbar();
  if (mode !== feed.mode) feed.setMode(mode, mode === 'replay' ? feed.dateStr : undefined);

  syncTicketFields();
  engine.onQuote(feed.quote);
  renderHeader();
  fullRedraw();
  chart.showRecent();
  feed.start();
  lastActivityId = engine.activity.length ? Math.max(...engine.activity.map((a) => a.id)) : 0;
  if (prefs.dataSource === 'real') setDataSource('real');   // restore real-data mode
  else anchorSyntheticPrice();                              // start synthetic at the real level
}
boot();

// Expose the live objects on window for debugging from the dev console.
window.__sim = { feed, engine, chart, ct, ladder, get cfg() { return cfg; } };
