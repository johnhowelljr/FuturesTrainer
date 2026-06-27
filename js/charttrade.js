// =============================================================================
// charttrade.js — On-chart trading overlay
// -----------------------------------------------------------------------------
// A transparent layer drawn on top of the price chart that adds Robinhood
// Legend's "trade from the chart" features:
//   * Buy / Sell icons (upper-left) and a "+" (right edge) that open the order
//     ticket.
//   * Right-clicking the chart opens the order ticket at the clicked price
//     (above the market = stop, below = limit).
//   * Working orders appear as draggable LMT / STP handles pinned to the price
//     axis — drag to modify (cancel + replace), click to load into the form, ✕
//     to cancel.
//   * The open position shows as a draggable "pill" at the average cost (size +
//     live P&L) — drag it to set a take-profit (limit) or stop (stop-loss).
//
// Like the ladder, this is "dumb" about the account and talks to the app through
// a `deps` object. It is re-rendered (`render()`) on every tick to reposition
// handles/pill as price scrolls.
// =============================================================================

import { CONTRACT, roundToTick, fmtPx, fmtUSDSigned } from './contract.js';

const GREEN = '#00c805', RED = '#ff5000';

/**
 * Decide whether a price implies a limit or a stop order for a given side, using
 * Robinhood's convention (buy above market = stop, below = limit; mirror for sell).
 * @param {'buy'|'sell'} side
 * @param {number} price - The chosen price.
 * @param {number} mark - The current market price.
 * @returns {'limit'|'stop'} The implied order type.
 */
function resolveType(side, price, mark) {
  if (side === 'buy') return price > mark ? 'stop' : 'limit';
  return price < mark ? 'stop' : 'limit';
}

export class ChartTrading {
  /**
   * @param {object} chart - The PriceChart instance (for coordinates + events).
   * @param {object} deps - App wiring:
   *   @param {object} deps.engine - Trading engine (orders/position, cancel).
   *   @param {object} deps.feed - Price feed (read `quote`).
   *   @param {()=>number} deps.getQty - Current order quantity.
   *   @param {()=>('day'|'gtc')} deps.getTif - Current time-in-force.
   *   @param {(side:'buy'|'sell')=>void} deps.setSide - Set order side (form).
   *   @param {(order:object, direct?:boolean)=>any} deps.submitOrder - Place an order.
   *   @param {(order:object)=>void} deps.selectOrder - Load an order into the form.
   *   @param {(opts:object)=>void} deps.openTicket - Open the floating order ticket.
   *   @param {(msg:string,kind?:string)=>void} deps.toast - Show a toast.
   */
  constructor(chart, deps) {
    this.chart = chart;
    this.deps = deps;
    this.dragging = null;
    this._build();
    // Robinhood enters chart orders via right-click -> the full order ticket.
    this.chart.onContextMenu((p) => this.deps.openTicket({
      side: 'buy',
      type: p.price > this.deps.feed.quote.mark ? 'stop' : 'limit',
      price: p.price,
    }));
  }

  /**
   * Build the overlay DOM once: the transparent layer, the Buy/Sell corner
   * icons, the "+" button, the drag "ghost" line, and the (legacy) popover.
   * @returns {void}
   */
  _build() {
    const root = this.chart.el;
    const layer = document.createElement('div');
    layer.className = 'ct-layer';
    root.appendChild(layer);
    this.layer = layer;

    // Buy / Sell corner icons (upper-left) -> open the order ticket.
    const corner = document.createElement('div');
    corner.className = 'ct-corner';
    corner.innerHTML =
      `<button class="ct-buy" title="Buy — load order form">Buy</button>` +
      `<button class="ct-sell" title="Sell — load order form">Sell</button>`;
    corner.querySelector('.ct-buy').addEventListener('click', () => this.deps.openTicket({ side: 'buy', type: 'market' }));
    corner.querySelector('.ct-sell').addEventListener('click', () => this.deps.openTicket({ side: 'sell', type: 'market' }));
    layer.appendChild(corner);

    // "+" add-order icon (right edge) -> open a limit ticket at the mark.
    const plus = document.createElement('button');
    plus.className = 'ct-plus'; plus.textContent = '+';
    plus.title = 'Add an order at a price';
    plus.addEventListener('click', () =>
      this.deps.openTicket({ side: 'buy', type: 'limit', price: Math.round(this.deps.feed.quote.mark) }));
    layer.appendChild(plus);

    // Dashed "ghost" line shown while dragging a handle/pill.
    this.ghost = document.createElement('div');
    this.ghost.className = 'ct-ghost'; this.ghost.hidden = true;
    layer.appendChild(this.ghost);

    // Legacy quick popover (kept but no longer the primary entry path).
    this.pop = document.createElement('div');
    this.pop.className = 'ct-pop'; this.pop.hidden = true;
    layer.appendChild(this.pop);
    document.addEventListener('pointerdown', (e) => {
      if (!this.pop.hidden && !this.pop.contains(e.target) && e.target !== plus) this._closePopover();
    });
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape') this._closePopover(); });

    // Containers we re-render
    this.pill = null;
    this.handles = [];
  }

  // ---- legacy quick popover (kept for reference; right-click now opens the ticket) ----

  /**
   * Open the small price popover with Buy/Sell buttons at a price (legacy path).
   * @param {number} price - Starting price.
   * @param {number} x - Cursor X within the chart.
   * @param {number} y - Cursor Y within the chart.
   * @returns {void}
   */
  _openPopover(price, x, y) {
    if (this.dragging) return;
    const mark = this.deps.feed.quote.mark;
    let px = roundToTick(price);
    const qty = this.deps.getQty();
    const render = () => {
      const buyType = resolveType('buy', px, mark);
      const sellType = resolveType('sell', px, mark);
      this.pop.innerHTML = `
        <div class="ct-pop-head">
          <button class="ct-nudge" data-d="1">▲</button>
          <div class="ct-pop-px">${fmtPx(px)}</div>
          <button class="ct-nudge" data-d="-1">▼</button>
        </div>
        <div class="ct-pop-sub">${qty} contract${qty > 1 ? 's' : ''} · ${this.deps.getTif().toUpperCase()}</div>
        <div class="ct-pop-btns">
          <button class="ct-pop-buy">Buy ${buyType}</button>
          <button class="ct-pop-sell">Sell ${sellType}</button>
        </div>`;
      this.pop.querySelectorAll('.ct-nudge').forEach((b) =>
        b.addEventListener('click', () => { px = roundToTick(px + Number(b.dataset.d) * CONTRACT.tickSize); render(); }));
      this.pop.querySelector('.ct-pop-buy').addEventListener('click', () => this._submitAt('buy', px));
      this.pop.querySelector('.ct-pop-sell').addEventListener('click', () => this._submitAt('sell', px));
    };
    render();
    this.pop.hidden = false;
    const w = this.chart.el.clientWidth, h = this.chart.el.clientHeight;
    const pw = 170, ph = 96;
    this.pop.style.left = Math.max(8, Math.min(x - pw / 2, w - pw - this.chart.priceScaleWidth() - 8)) + 'px';
    this.pop.style.top = Math.max(8, Math.min(y - ph - 12, h - ph - 30)) + 'px';
  }

  /** Hide the legacy popover. @returns {void} */
  _closePopover() { this.pop.hidden = true; }

  /**
   * Submit an order at a price from the legacy popover (type resolved by side
   * vs the mark).
   * @param {'buy'|'sell'} side
   * @param {number} price
   * @returns {void}
   */
  _submitAt(side, price) {
    const mark = this.deps.feed.quote.mark;
    const type = resolveType(side, price, mark);
    this.deps.submitOrder({
      side, type, qty: this.deps.getQty(), tif: this.deps.getTif(),
      limitPx: type === 'limit' ? price : null,
      stopPx: type === 'stop' ? price : null,
    });
    this._closePopover();
  }

  /**
   * Re-draw the order handles and the position pill at their current prices.
   * Skips re-drawing whatever is mid-drag. Called every tick.
   * @returns {void}
   */
  render() {
    const eng = this.deps.engine;
    // Offset handles left of the price axis so they sit over the chart, not the
    // scale. The axis width changes with price magnitude, so re-read it each draw.
    const rightPad = this.chart.priceScaleWidth() + 6;

    // Order handles are re-created from scratch each render (prices move every
    // tick) — EXCEPT the one being dragged, which we leave alone so the drag
    // isn't interrupted by its own element being torn down mid-gesture.
    for (const h of this.handles) if (h.el !== this.dragging?.el) h.el.remove();
    this.handles = this.handles.filter((h) => h.el === this.dragging?.el);
    for (const o of eng.orders) {
      if (this.dragging?.order?.id === o.id) continue;   // skip the dragged order
      const price = o.type === 'stop' ? o.stopPx : o.limitPx;
      const y = this.chart.priceToY(price);
      if (y == null) continue;   // price scrolled off-screen -> no handle to draw
      const el = document.createElement('div');
      el.className = `ct-handle ${o.side}`;
      el.style.top = y + 'px';
      el.style.right = rightPad + 'px';
      el.innerHTML = `<span class="ct-tag">${o.type === 'stop' ? 'STP' : 'LMT'} ${o.qty}</span>` +
        `<span class="ct-price">${fmtPx(price)}</span><span class="ct-x" title="Cancel">✕</span>`;
      el.querySelector('.ct-x').addEventListener('pointerdown', (e) => {
        e.stopPropagation(); eng.cancelOrder(o.id);
      });
      el.addEventListener('pointerdown', (e) => this._startDrag(e, el, { kind: 'order', order: o }));
      this.layer.appendChild(el);
      this.handles.push({ el, order: o });
    }

    // position pill at the average cost
    const pos = eng.position;
    if (this.dragging?.kind === 'pill') return;
    if (this.pill) { this.pill.remove(); this.pill = null; }
    if (pos.qty) {
      const y = this.chart.priceToY(pos.avg);
      if (y == null) return;
      const long = pos.qty > 0;
      const upnl = eng.unrealized;
      const el = document.createElement('div');
      el.className = `ct-pill ${long ? 'long' : 'short'}`;
      el.style.top = y + 'px';
      el.style.right = rightPad + 'px';
      el.title = 'Drag to set a take-profit (limit) or stop';
      el.innerHTML = `<b>${long ? 'LONG' : 'SHORT'} ${Math.abs(pos.qty)}</b>` +
        `<span class="ct-pnl ${upnl >= 0 ? 'up' : 'down'}">${fmtUSDSigned(upnl)}</span>`;
      el.addEventListener('pointerdown', (e) => this._startDrag(e, el, { kind: 'pill' }));
      this.layer.appendChild(el);
      this.pill = el;
    }
  }

  // ---- dragging -------------------------------------------------------------

  /**
   * Begin dragging a handle or the pill; wires temporary move/up listeners.
   * @param {PointerEvent} e
   * @param {HTMLElement} el - The element being dragged.
   * @param {{kind:'order'|'pill', order?:object}} info - What's being dragged.
   * @returns {void}
   */
  _startDrag(e, el, info) {
    e.preventDefault(); e.stopPropagation();
    const rect = this.chart.el.getBoundingClientRect();
    this.dragging = { ...info, el, rect, moved: 0, startY: e.clientY, price: null };
    try { if (e.pointerId != null) el.setPointerCapture?.(e.pointerId); } catch { /* synthetic events */ }
    const move = (ev) => this._onDragMove(ev);
    const up = (ev) => { this._onDragEnd(ev); document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
  }

  /**
   * During a drag: move the element, track the target price, and show the ghost
   * line + live price label.
   * @param {PointerEvent} e
   * @returns {void}
   */
  _onDragMove(e) {
    const d = this.dragging; if (!d) return;
    // Accumulate total travel so _onDragEnd can tell a real drag from a click
    // (a click jitters only a pixel or two; a drag moves much more).
    d.moved += Math.abs(e.clientY - d.startY);
    const y = e.clientY - d.rect.top;
    const price = roundToTick(this.chart.coordinateToPrice(y));
    if (price == null || !Number.isFinite(price)) return;
    d.price = price;
    d.el.style.top = y + 'px';
    this.ghost.hidden = false;
    this.ghost.style.top = y + 'px';
    this.ghost.dataset.px = fmtPx(price);
    const pe = d.el.querySelector('.ct-price'); if (pe) pe.textContent = fmtPx(price);
  }

  /**
   * Finish a drag. A tiny move counts as a click: clicking an order handle loads
   * it into the form. A real drag of an order handle cancels+replaces it at the
   * new price; dragging the position pill places a take-profit/stop for the
   * position.
   * @returns {void}
   */
  _onDragEnd() {
    const d = this.dragging; this.dragging = null; this.ghost.hidden = true;
    if (!d) return;
    // < 4px total travel (or no valid price) = the user clicked, didn't drag.
    const click = d.moved < 4 || d.price == null;
    if (d.kind === 'order') {
      if (click) { this.deps.selectOrder(d.order); }     // click -> load into the form
      else {
        // drag -> modify via cancel + replace at the dropped price (direct = no review)
        this.deps.engine.cancelOrder(d.order.id);
        this.deps.submitOrder({
          side: d.order.side, type: d.order.type, qty: d.order.qty, tif: d.order.tif,
          limitPx: d.order.type === 'limit' ? d.price : null,
          stopPx: d.order.type === 'stop' ? d.price : null,
        }, true);
      }
    } else if (d.kind === 'pill' && !click) {
      // Dragging the position pill creates an EXIT order for the whole position:
      // opposite side, sized to the position. resolveType() then decides whether
      // dropping above/below the mark means a take-profit (limit) or a stop.
      const pos = this.deps.engine.position;
      const side = pos.qty > 0 ? 'sell' : 'buy';
      const type = resolveType(side, d.price, this.deps.feed.quote.mark);
      this.deps.submitOrder({
        side, type, qty: Math.abs(pos.qty), tif: this.deps.getTif(),
        limitPx: type === 'limit' ? d.price : null,
        stopPx: type === 'stop' ? d.price : null,
      }, true);
    }
    this.render();
  }
}
