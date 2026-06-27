// =============================================================================
// ui.js — DOM lookups + render helpers (the "view" layer)
// -----------------------------------------------------------------------------
// A thin, stateless rendering layer. It does NOT own any app state or wire up
// events — app.js does that. This module just:
//   * caches every element the app touches (the `els` map), and
//   * exposes pure render functions that take a value/snapshot and paint it into
//     the DOM (instrument header, account stats, position card, working orders,
//     activity log, order-ticket estimates), plus the toast helper.
//
// Each render function reads from an engine snapshot (see engine.snapshot()) or a
// small plain object and writes text/classes — no business logic lives here.
// =============================================================================

import { CONTRACT, fmtUSD, fmtUSDSigned, fmtPx, fmtPct } from './contract.js';

/** Shorthand for document.getElementById. @param {string} id @returns {HTMLElement} */
const $ = (id) => document.getElementById(id);

/**
 * Cached references to every element the app reads or writes, looked up once at
 * module load. app.js imports this and binds events / passes pieces to widgets.
 * @type {Object<string, HTMLElement>}
 */
export const els = {
  bpMini: $('bpMini'),
  symbol: $('symbol'), instSub: $('instSub'), contractSel: $('contractSel'),
  lastPrice: $('lastPrice'), chgAbs: $('chgAbs'), chgPct: $('chgPct'),
  bidPx: $('bidPx'), askPx: $('askPx'), sessClock: $('sessClock'),
  chart: $('chart'),
  tfTabs: $('tfTabs'), typeToggle: $('typeToggle'), modeToggle: $('modeToggle'),
  liveSpeed: $('liveSpeed'), liveSpeedWrap: $('liveSpeedWrap'), dataToggle: $('dataToggle'),
  indBtn: $('indBtn'), indMenu: $('indMenu'),
  replayBar: $('replayBar'), rpPlay: $('rpPlay'), rpScrub: $('rpScrub'),
  rpTime: $('rpTime'), rpSpeed: $('rpSpeed'), rpDate: $('rpDate'),
  sideToggle: $('sideToggle'), ordType: $('ordType'),
  autoSend: $('autoSend'), tifFld: $('tifFld'), tif: $('tif'),
  confirmDlg: $('confirmDlg'), cfSide: $('cfSide'), cfDetails: $('cfDetails'),
  cfCancel: $('cfCancel'), cfSubmit: $('cfSubmit'),
  qty: $('qty'), qtyMinus: $('qtyMinus'), qtyPlus: $('qtyPlus'),
  limitFld: $('limitFld'), limitPx: $('limitPx'), stopFld: $('stopFld'), stopPx: $('stopPx'),
  estFill: $('estFill'), estNotional: $('estNotional'), estMargin: $('estMargin'), estCost: $('estCost'),
  placeBtn: $('placeBtn'), ticketFoot: $('ticketFoot'),
  equity: $('equity'), cash: $('cash'), bp: $('bp'),
  openPnl: $('openPnl'), realPnl: $('realPnl'), dayPnl: $('dayPnl'),
  feesPaid: $('feesPaid'), marginUsed: $('marginUsed'),
  positionBox: $('positionBox'), ordersCard: $('ordersCard'), ordersList: $('ordersList'),
  activityList: $('activityList'),
  btnReset: $('btnReset'), btnSettings: $('btnSettings'), settings: $('settings'),
};

let toastTimer = null;
/**
 * Show a transient toast notification (auto-hides after ~3.2s).
 * @param {string} msg - Message text.
 * @param {'info'|'error'|'success'} [kind='info'] - Styling class.
 * @returns {void}
 */
export function toast(msg, kind = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/** Map a number's sign to a CSS class. @param {number} x @returns {'up'|'down'|'flat'} */
function signClass(x) { return x > 0 ? 'up' : x < 0 ? 'down' : 'flat'; }

/**
 * Paint the instrument header: last price, absolute & % change vs the session
 * open (green/red), bid/ask, and the session clock.
 * @param {{mark:number, bid:number, ask:number, open:number, clock:string}} q
 * @returns {void}
 */
export function renderInstrument({ mark, bid, ask, open, clock }) {
  els.lastPrice.textContent = fmtPx(mark);
  const chg = mark - open;
  const pct = open ? (chg / open) * 100 : 0;
  const cls = signClass(chg);
  els.chgAbs.textContent = `${chg >= 0 ? '+' : ''}${fmtPx(chg)}`;
  els.chgPct.textContent = `(${fmtPct(pct)})`;
  const row = els.chgAbs.parentElement;
  row.classList.remove('up', 'down', 'flat'); row.classList.add(cls);
  els.lastPrice.classList.remove('up', 'down', 'flat'); els.lastPrice.classList.add(cls);
  els.bidPx.textContent = fmtPx(bid);
  els.askPx.textContent = fmtPx(ask);
  els.sessClock.textContent = clock;
}

/**
 * Paint the account stats panel (equity, cash, buying power, fees, margin used,
 * and the three P&L figures).
 * @param {object} s - Engine snapshot.
 * @returns {void}
 */
export function renderAccount(s) {
  els.bpMini.textContent = fmtUSD(s.buyingPower);
  els.equity.textContent = fmtUSD(s.equity);
  els.cash.textContent = fmtUSD(s.cash);
  els.bp.textContent = fmtUSD(s.buyingPower);
  els.feesPaid.textContent = fmtUSD(s.feesPaid);
  els.marginUsed.textContent = fmtUSD(s.marginUsed);
  setSignedMoney(els.openPnl, s.unrealized);
  setSignedMoney(els.realPnl, s.realizedPnl);
  setSignedMoney(els.dayPnl, s.dayPnl);
}

/**
 * Write a signed dollar value into an element with the matching up/down/flat class.
 * @param {HTMLElement} el
 * @param {number} x - Signed amount.
 * @returns {void}
 */
function setSignedMoney(el, x) {
  el.textContent = fmtUSDSigned(x);
  el.classList.remove('up', 'down', 'flat');
  el.classList.add(signClass(x));
}

/**
 * Paint the position card: an empty state when flat, otherwise side/size,
 * avg cost, mark, open P&L, return %, and a Close button.
 * @param {object} s - Engine snapshot.
 * @returns {void}
 */
export function renderPosition(s) {
  const box = els.positionBox;
  if (!s.position.qty) {
    box.className = 'position-empty';
    box.innerHTML = 'No open position';
    return;
  }
  const qty = s.position.qty;
  const long = qty > 0;
  const ret = s.marginUsed ? (s.unrealized / s.marginUsed) * 100 : 0;
  box.className = 'position-live';
  box.innerHTML = `
    <div class="pos-top">
      <span class="pos-side ${long ? 'up' : 'down'}">${long ? 'LONG' : 'SHORT'} ${Math.abs(qty)}</span>
      <span class="pos-sym">${CONTRACT.symbol}</span>
    </div>
    <div class="pos-grid">
      <div><span>Avg cost</span><b>${fmtPx(s.position.avg)}</b></div>
      <div><span>Mark</span><b>${fmtPx(s.quote.mark)}</b></div>
      <div><span>Open P&L</span><b class="${signClass(s.unrealized)}">${fmtUSDSigned(s.unrealized)}</b></div>
      <div><span>Return</span><b class="${signClass(ret)}">${fmtPct(ret)}</b></div>
    </div>
    <button class="close-pos" data-action="flatten">Close position (market)</button>
  `;
}

/**
 * Paint the working-orders list (hidden when there are none). Each row shows
 * side/qty, the price(s), and a cancel button (data-action wired by app.js).
 * @param {object} s - Engine snapshot.
 * @returns {void}
 */
export function renderOrders(s) {
  if (!s.orders.length) { els.ordersCard.hidden = true; els.ordersList.innerHTML = ''; return; }
  els.ordersCard.hidden = false;
  els.ordersList.innerHTML = s.orders.map((o) => {
    const px = o.type === 'stop' ? `stop ${fmtPx(o.stopPx)}`
      : o.type === 'stop_limit' ? `stop ${fmtPx(o.stopPx)} / lmt ${fmtPx(o.limitPx)}`
      : `limit ${fmtPx(o.limitPx)}`;
    return `<div class="order-row">
      <span class="ord-side ${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.qty}</span>
      <span class="ord-px">${px}</span>
      <button class="ord-cancel" data-action="cancel" data-id="${o.id}">✕</button>
    </div>`;
  }).join('');
}

/**
 * Paint the activity log (most recent 40 rows), color-coded by kind
 * (fill/system/other) with a timestamp.
 * @param {object} s - Engine snapshot.
 * @returns {void}
 */
export function renderActivity(s) {
  if (!s.activity.length) { els.activityList.innerHTML = '<div class="muted">No activity yet.</div>'; return; }
  els.activityList.innerHTML = s.activity.slice(0, 40).map((a) => {
    const time = new Date(a.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const cls = a.kind === 'fill' ? (a.side === 'buy' ? 'up' : 'down') : a.kind === 'system' ? 'sys' : 'muted2';
    return `<div class="act-row ${cls}"><span class="act-t">${time}</span><span class="act-x">${a.text}</span></div>`;
  }).join('');
}

/**
 * Paint the order-ticket estimate row (fill price, notional, margin, cost). Any
 * null field renders as a dash.
 * @param {{fillPx:?number, notional:?number, margin:?number, cost:?number}} est
 * @returns {void}
 */
export function renderTicketMeta({ fillPx, notional, margin, cost }) {
  els.estFill.textContent = fillPx == null ? '—' : fmtPx(fillPx);
  els.estNotional.textContent = notional == null ? '—' : fmtUSD(notional);
  els.estMargin.textContent = margin == null ? '—' : fmtUSD(margin);
  els.estCost.textContent = cost == null ? '—' : fmtUSD(cost);
}

/**
 * Update the inline ticket's place button label + buy/sell color.
 * @param {'buy'|'sell'} side
 * @param {number} qty
 * @returns {void}
 */
export function setPlaceButton(side, qty) {
  els.placeBtn.textContent = `${side === 'buy' ? 'Buy' : 'Sell'} ${qty} ${CONTRACT.symbol}`;
  els.placeBtn.classList.toggle('buy', side === 'buy');
  els.placeBtn.classList.toggle('sell', side === 'sell');
}
