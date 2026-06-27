// =============================================================================
// ladder.js — The trading Ladder / DOM widget
// -----------------------------------------------------------------------------
// The vertical price-depth grid between the chart and the order panels — the
// primary Robinhood Legend futures trading surface. Behavior:
//   * Buy column on the LEFT, Sell column on the RIGHT, price (or P&L) center.
//   * Click a price level -> small LMT / STP buttons appear; choosing one places
//     the order (through the confirmation screen unless ⚡ auto-send is on).
//     Clicking the ask side buys, the bid side sells.
//   * Working orders show as +N / −N LMT/STP tags; drag a tag up/down to modify
//     it (cancel + replace), or click its ✕ to cancel.
//   * Buy MKT / Sell MKT buttons place instant market orders.
//   * Header: quantity stepper + the ⚡ auto-send toggle and a $ button that
//     toggles the y-axis between Price and P&L. Footer: Open / Day P&L.
//
// The ladder is "dumb" about the account: it calls into a `deps` object the app
// wires up (see the constructor) and is re-rendered on every tick.
// =============================================================================

import { CONTRACT, roundToTick, fmtPx, fmtUSDSigned } from './contract.js';
import { hashSeed } from './rng.js';

const ROWS = 41;             // number of price levels shown (odd, so a middle row exists)
const HALF = (ROWS - 1) / 2;
const DEADBAND = 8;          // re-center only when price drifts this many ticks off-center

export class Ladder {
  /**
   * @param {HTMLElement} el - Container element the ladder renders into.
   * @param {object} deps - Wiring provided by the app:
   *   @param {object} deps.engine - The trading engine (read orders/position, cancel).
   *   @param {object} deps.feed - The price feed (read `quote`).
   *   @param {()=>number} deps.getQty - Current order quantity.
   *   @param {(delta:number)=>void} deps.setQty - Change quantity by +/-1.
   *   @param {()=>boolean} deps.getAutoSend - Is auto-send on?
   *   @param {(v:boolean)=>void} deps.setAutoSend - Toggle auto-send.
   *   @param {(order:object, direct?:boolean)=>any} deps.submitOrder - Place an order
   *     (respects auto-send/confirmation unless `direct` is true).
   */
  constructor(el, deps) {
    this.el = el;
    this.deps = deps;
    this.center = null;       // price the grid is centered on
    this._top = null;         // price of the top row
    this.choosing = null;     // { price, side } -> show LMT/STP buttons at a level
    this.dragging = null;     // { order, price } -> modifying an order by dragging
    this.axis = 'price';      // 'price' | 'pnl'
    this.rowEls = [];
    this._build();
  }

  /**
   * Build the static DOM (header, the 41 row elements, footer) once and wire the
   * header controls + delegated row events.
   * @returns {void}
   */
  _build() {
    this.el.innerHTML = `
      <div class="lad-head">
        <div class="lad-qty">
          <button data-q="-1" aria-label="decrease">−</button>
          <span id="ladQty">1</span>
          <button data-q="1" aria-label="increase">+</button>
        </div>
        <div class="lad-head-r">
          <button class="lad-axis" id="ladAxis" title="Toggle Price / P&L axis">$</button>
          <button class="lad-bolt" id="ladBolt" title="Auto-send (skip the confirmation screen)">⚡</button>
        </div>
      </div>
      <div class="lad-cols"><span>Buy</span><span id="ladColMid">Price</span><span>Sell</span></div>
      <div class="lad-body" id="ladBody"></div>
      <div class="lad-pnl"><span>Open <b id="ladOpen">$0.00</b></span><span>Day <b id="ladDay">$0.00</b></span></div>
      <div class="lad-mkt">
        <button class="lad-buymkt" id="ladBuyMkt">Buy MKT<small>—</small></button>
        <button class="lad-sellmkt" id="ladSellMkt">Sell MKT<small>—</small></button>
      </div>`;

    const body = this.el.querySelector('#ladBody');
    for (let i = 0; i < ROWS; i++) {
      const row = document.createElement('div');
      row.className = 'lad-row';
      row.innerHTML =
        `<div class="lad-cell lad-buy"></div>` +
        `<div class="lad-cell lad-px"></div>` +
        `<div class="lad-cell lad-sell"></div>`;
      body.appendChild(row);
      this.rowEls.push(row);
    }

    body.addEventListener('click', (e) => this._onClick(e));
    body.addEventListener('pointerdown', (e) => this._onPointerDown(e));
    // clicking away from a half-built order cancels the LMT/STP prompt
    document.addEventListener('pointerdown', (e) => {
      if (this.choosing && !this.el.contains(e.target)) { this.choosing = null; this.render(); }
    });

    this.el.querySelector('.lad-qty').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      this.deps.setQty(Number(b.dataset.q)); this.render();
    });
    this.el.querySelector('#ladBolt').addEventListener('click', () => { this.deps.setAutoSend(!this.deps.getAutoSend()); this.render(); });
    this.el.querySelector('#ladAxis').addEventListener('click', () => { this.axis = this.axis === 'price' ? 'pnl' : 'price'; this.render(); });
    this.el.querySelector('#ladBuyMkt').addEventListener('click', () => this.deps.submitOrder({ side: 'buy', type: 'market', qty: this.deps.getQty(), tif: 'day' }));
    this.el.querySelector('#ladSellMkt').addEventListener('click', () => this.deps.submitOrder({ side: 'sell', type: 'market', qty: this.deps.getQty(), tif: 'day' }));
  }

  // ---- interaction ----------------------------------------------------------

  /**
   * Handle a click in the ladder body (event-delegated): pick LMT/STP for a
   * half-built order, cancel an order via its ✕, or select a price level to
   * prompt for LMT/STP.
   * @param {MouseEvent} e
   * @returns {void}
   */
  _onClick(e) {
    // 1) choose LMT or STP for a half-built order
    const choose = e.target.closest('.lad-choose button');
    if (choose) {
      const { price, side } = this.choosing || {};
      const type = choose.dataset.t;
      if (price != null) this.deps.submitOrder({
        side, type, qty: this.deps.getQty(), tif: 'day',
        limitPx: type === 'limit' ? price : null,
        stopPx: type === 'stop' ? price : null,
      });
      this.choosing = null; this.render();
      return;
    }
    // 2) cancel an order
    const cancel = e.target.closest('[data-cancel]');
    if (cancel) { this.deps.engine.cancelOrder(Number(cancel.dataset.cancel)); this.choosing = null; return; }
    // 3) ignore clicks on an existing order tag (those are for dragging)
    if (e.target.closest('.lad-ord')) return;
    // 4) select a price level -> prompt LMT / STP
    const cell = e.target.closest('.lad-buy, .lad-sell');
    const row = e.target.closest('.lad-row');
    if (!cell || !row) return;
    const price = Number(row.dataset.px);
    const side = cell.classList.contains('lad-buy') ? 'buy' : 'sell';
    this.choosing = { price, side };
    this.render();
  }

  /**
   * Begin dragging a working-order tag (pointer down on the tag, not its ✕).
   * Wires temporary document-level move/up listeners.
   * @param {PointerEvent} e
   * @returns {void}
   */
  _onPointerDown(e) {
    const tag = e.target.closest('.lad-ord');
    if (!tag || e.target.closest('[data-cancel]')) return;
    e.preventDefault();
    const order = this.deps.engine.orders.find((o) => o.id === Number(tag.dataset.oid));
    if (!order) return;
    this.dragging = { order, price: null };
    const move = (ev) => this._dragMove(ev);
    const up = () => { this._dragEnd(); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  /**
   * Convert a screen Y coordinate to the ladder price at that row.
   * @param {number} clientY - Pointer Y in viewport coords.
   * @returns {number} The tick-aligned price for that row.
   */
  _priceAtY(clientY) {
    const body = this.el.querySelector('#ladBody');
    const r = body.getBoundingClientRect();
    let idx = Math.floor(((clientY - r.top) / r.height) * ROWS);
    idx = Math.max(0, Math.min(ROWS - 1, idx));
    return roundToTick(this._top - idx * CONTRACT.tickSize);
  }

  /**
   * While dragging an order tag: track the target price and highlight the row
   * under the cursor.
   * @param {PointerEvent} e
   * @returns {void}
   */
  _dragMove(e) {
    if (!this.dragging) return;
    this.dragging.price = this._priceAtY(e.clientY);
    const half = CONTRACT.tickSize / 2;
    for (const row of this.rowEls) row.classList.toggle('drag-target', Math.abs(Number(row.dataset.px) - this.dragging.price) < half);
  }

  /**
   * Finish a drag: if the price changed, cancel the old order and place a new one
   * at the new price (same side/type/qty) — Robinhood's "modify = cancel+replace".
   * @returns {void}
   */
  _dragEnd() {
    const d = this.dragging; this.dragging = null;
    for (const row of this.rowEls) row.classList.remove('drag-target');
    if (!d || d.price == null) { this.render(); return; }
    // Only act if the price actually changed. Modify = cancel + replace at the
    // new price; pass `direct: true` so it skips the confirmation screen (you've
    // already committed by dragging). Type/side/qty/tif are carried over.
    const cur = d.order.type === 'stop' ? d.order.stopPx : d.order.limitPx;
    if (d.price !== cur) {
      this.deps.engine.cancelOrder(d.order.id);
      this.deps.submitOrder({
        side: d.order.side, type: d.order.type, qty: d.order.qty, tif: d.order.tif,
        limitPx: d.order.type === 'limit' ? d.price : null,
        stopPx: d.order.type === 'stop' ? d.price : null,
      }, true);
    }
    this.render();
  }

  /**
   * Synthetic order-book size for a price level — bigger near the inside market,
   * slowly "breathing" over time so the depth looks alive. Purely cosmetic.
   * @param {number} price - The level's price.
   * @param {number} mark - Current mark price.
   * @returns {number} A plausible size (contracts) for that level.
   */
  _depth(price, mark) {
    // Seed the "randomness" from price + a time bucket that ticks every 1.4s, so
    // depth is stable within a bucket but "breathes" (re-rolls) between buckets —
    // alive-looking without flickering every animation frame.
    const bucket = Math.floor(Date.now() / 1400);
    const r = (hashSeed(roundToTick(price).toFixed(4) + ':' + bucket) % 1000) / 1000;
    // Exponential falloff with distance from the mark: deepest at the inside
    // market, thinning out toward the edges of the ladder, plus the jitter `r`.
    const distTicks = Math.abs(price - mark) / CONTRACT.tickSize;
    const base = Math.exp(-distTicks / (HALF * 0.5));
    return Math.max(1, Math.round((6 + 130 * base) * (0.45 + r)));
  }

  /**
   * Re-render the whole ladder from current quote + engine state. Re-centers on
   * price (with a deadband to avoid jitter), fills each row's depth/orders, and
   * updates the header/footer. Called every tick.
   * @returns {void}
   */
  render() {
    const tick = CONTRACT.tickSize;
    const q = this.deps.feed.quote;
    const mark = roundToTick(q.mark), bid = roundToTick(q.bid), ask = roundToTick(q.ask);
    // Deadband re-centering: only recenter when price drifts more than DEADBAND
    // ticks off the middle. Without this the ladder would scroll every tick and
    // be impossible to click; with it the grid holds still until price wanders.
    if (this.center == null || Math.abs(mark - this.center) > DEADBAND * tick) this.center = mark;
    this._top = roundToTick(this.center + HALF * tick);   // price of row 0 (top)

    const eng = this.deps.engine;
    const pos = eng.position;
    // Compare prices as fixed-4 strings, not floats: 0.10-tick contracts have
    // values like 3025.3000000001 that won't === cleanly. Keying by string fixes
    // both the row-highlight matching and the order lookup below.
    const k = (p) => roundToTick(p).toFixed(4);
    const avgKey = pos.qty ? k(pos.avg) : null;
    const markK = k(mark), bidK = k(bid), askK = k(ask);
    // Index resting orders by "side:price" so each row can find its order in O(1).
    const orderBy = new Map();
    for (const o of eng.orders) orderBy.set(o.side + ':' + k(o.type === 'stop' ? o.stopPx : o.limitPx), o);

    for (let i = 0; i < ROWS; i++) {
      const price = roundToTick(this._top - i * tick);
      const pk = k(price);
      const row = this.rowEls[i];
      row.dataset.px = price;
      row.className = 'lad-row' +
        (pk === markK ? ' last' : '') + (pk === bidK ? ' best-bid' : '') +
        (pk === askK ? ' best-ask' : '') + (pk === avgKey ? ' avg' : '');

      // Depth only shows on the correct side of the market: bids at/below the
      // bid (buy column), asks at/above the ask (sell column).
      const isBid = price <= bid, isAsk = price >= ask;
      const size = this._depth(price, mark);
      const pct = Math.min(100, (size / 150) * 100);   // bar width, capped at 100%
      row.children[0].innerHTML = this._cell('buy', price, isBid ? size : 0, pct, orderBy.get('buy:' + pk));
      row.children[2].innerHTML = this._cell('sell', price, isAsk ? size : 0, pct, orderBy.get('sell:' + pk));

      const mid = row.children[1];
      if (this.axis === 'pnl') {
        // Show what the open position (or 1 lot if flat) would be worth at this price.
        const refQty = pos.qty || this.deps.getQty();
        const ref = pos.qty ? pos.avg : mark;
        const sign = pos.qty < 0 ? -1 : 1;
        mid.textContent = fmtUSDSigned((price - ref) * CONTRACT.pointValue * Math.abs(refQty) * sign);
      } else mid.textContent = fmtPx(price);
    }

    // header / footer
    this.el.querySelector('#ladQty').textContent = this.deps.getQty();
    this.el.querySelector('#ladBolt').classList.toggle('on', this.deps.getAutoSend());
    this.el.querySelector('#ladAxis').classList.toggle('on', this.axis === 'pnl');
    this.el.querySelector('#ladColMid').textContent = this.axis === 'pnl' ? 'P&L' : 'Price';
    const setMoney = (id, v) => { const e = this.el.querySelector(id); e.textContent = fmtUSDSigned(v); e.className = v > 0 ? 'up' : v < 0 ? 'down' : ''; };
    setMoney('#ladOpen', eng.unrealized);
    setMoney('#ladDay', eng.dayPnl);
    this.el.querySelector('#ladBuyMkt').querySelector('small').textContent = fmtPx(ask);
    this.el.querySelector('#ladSellMkt').querySelector('small').textContent = fmtPx(bid);
  }

  /**
   * Build the inner HTML for one buy/sell cell: the LMT/STP chooser if this is
   * the selected level, a working-order tag if one rests here, otherwise the
   * depth bar + size number.
   * @param {'buy'|'sell'} side - Which side column.
   * @param {number} price - The row's price.
   * @param {number} size - Depth size to show (0 = none).
   * @param {number} pct - Depth bar width as a percentage.
   * @param {object} [ord] - A resting order at this level, if any.
   * @returns {string} HTML for the cell.
   */
  _cell(side, price, size, pct, ord) {
    // showing LMT/STP options for this exact level?
    if (this.choosing && this.choosing.side === side && Math.abs(this.choosing.price - price) < CONTRACT.tickSize / 2) {
      return `<span class="lad-choose"><button data-t="limit">LMT</button><button data-t="stop">STP</button></span>`;
    }
    if (ord) {
      const tag = ord.type === 'stop' ? 'STP' : 'LMT';
      const sign = ord.side === 'buy' ? '+' : '−';
      return `<span class="lad-ord ${side}" data-oid="${ord.id}" title="Drag to modify · ✕ to cancel">${sign}${ord.qty} ${tag}<i data-cancel="${ord.id}">✕</i></span>`;
    }
    const bar = size ? `<i class="bar" style="width:${pct}%"></i>` : '';
    return `${bar}<b class="sz">${size || ''}</b>`;
  }
}
