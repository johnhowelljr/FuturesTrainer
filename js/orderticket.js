// =============================================================================
// orderticket.js — The floating Robinhood-style order ticket
// -----------------------------------------------------------------------------
// The draggable order panel that pops up when you Buy/Sell from the chart (the
// corner icons, the "+", or a right-click). It mirrors Robinhood Legend's
// futures ticket: a drag handle + symbol + live price, a Buy/Sell toggle, order
// type, a Quantity field with ± steppers, a buying-power warning, a price field
// (with Bid/Ask), time-in-force, the estimated buying-power effect, and
// Cancel / Buy·Sell buttons.
//
// It keeps its own little `state` and re-renders itself; placing an order calls
// `deps.place(order)` (provided by the app).
// =============================================================================

import { CONTRACT, fmtPx, fmtUSD, fmtUSDSigned, feesPerSide, roundToTick } from './contract.js';

export class OrderTicket {
  /**
   * @param {object} deps - App wiring:
   *   @param {object} deps.engine - Trading engine (read position/buying power).
   *   @param {object} deps.feed - Price feed (read `quote`).
   *   @param {(order:object)=>{ok:boolean,reason?:string}} deps.place - Place the
   *     order (the ticket itself is the confirmation, so this places directly).
   *   @param {(msg:string,kind?:string)=>void} deps.toast - Show a toast.
   */
  constructor(deps) {
    this.deps = deps;
    this.isOpen = false;
    this.state = { side: 'buy', type: 'market', qty: 1, price: null, tif: 'day' };
    this._build();
  }

  /**
   * Build the ticket DOM once (hidden), append it to the body, and wire all the
   * field events + drag handle.
   * @returns {void}
   */
  _build() {
    const el = document.createElement('div');
    el.className = 'rh-ticket'; el.hidden = true;
    el.innerHTML = `
      <div class="rh-tk-head" id="tkGrip">
        <span class="rh-tk-dots">⠿</span>
        <span class="rh-tk-sym">/${CONTRACT.symbol}</span>
        <span class="rh-tk-hpx" id="tkHpx">—</span>
        <button class="rh-tk-x" id="tkX" aria-label="Close">✕</button>
      </div>
      <div class="rh-tk-body">
        <div class="seg rh-tk-side" id="tkSide">
          <button data-side="buy" class="active">Buy</button>
          <button data-side="sell">Sell</button>
        </div>

        <div class="rh-tk-row">
          <label>Order type</label>
          <select id="tkType">
            <option value="market">Market</option>
            <option value="limit">Limit</option>
            <option value="stop">Stop</option>
          </select>
        </div>

        <div class="rh-tk-field">
          <div class="rh-tk-lbl">Quantity<small id="tkQtySub">1 contract</small></div>
          <div class="rh-tk-inp">
            <input id="tkQty" type="number" min="1" step="1" value="1" inputmode="numeric" />
            <span class="rh-tk-steps"><button data-q="1">+</button><button data-q="-1">−</button></span>
          </div>
        </div>

        <div class="rh-tk-warn" id="tkWarn" hidden></div>

        <div class="rh-tk-field" id="tkPriceField" hidden>
          <div class="rh-tk-lbl" id="tkPriceLbl">Limit price<small id="tkBidAsk">Bid — · Ask —</small></div>
          <div class="rh-tk-inp">
            <input id="tkPrice" type="number" step="1" inputmode="decimal" />
            <span class="rh-tk-steps"><button data-p="1">+</button><button data-p="-1">−</button></span>
          </div>
        </div>

        <div class="rh-tk-row">
          <label>Time in force</label>
          <select id="tkTif">
            <option value="day">Good for day</option>
            <option value="gtc">Good till canceled</option>
          </select>
        </div>

        <div class="rh-tk-bp">
          <div class="rh-tk-bp-row"><span>Est BP effect</span><b id="tkBpEffect">—</b></div>
          <div class="rh-tk-bp-sub">Buying power <span id="tkBp">—</span></div>
        </div>

        <div class="rh-tk-disc">Paper trading simulator — not affiliated with Robinhood.</div>

        <div class="rh-tk-actions">
          <button class="rh-tk-cancel" id="tkCancel">Cancel</button>
          <button class="rh-tk-submit" id="tkSubmit">Buy /${CONTRACT.symbol}</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    this.el = el;
    /** Shorthand: find a child element by id. @param {string} id @returns {HTMLElement} */
    this.$ = (id) => el.querySelector('#' + id);

    // events
    this.$('tkX').addEventListener('click', () => this.close());
    this.$('tkCancel').addEventListener('click', () => this.close());
    this.$('tkSide').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      this.state.side = b.dataset.side; this._defaultPrice(); this._render();
    });
    this.$('tkType').addEventListener('change', (e) => { this.state.type = e.target.value; this._defaultPrice(); this._render(); });
    this.$('tkTif').addEventListener('change', (e) => { this.state.tif = e.target.value; });
    this.$('tkQty').addEventListener('input', (e) => { this.state.qty = Math.max(1, Math.floor(Number(e.target.value) || 1)); this._render(); });
    this.$('tkPrice').addEventListener('input', (e) => { this.state.price = Number(e.target.value) || null; this._render(); });
    el.querySelector('.rh-tk-field .rh-tk-steps').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      this.state.qty = Math.max(1, this.state.qty + Number(b.dataset.q)); this._render();
    });
    this.$('tkPriceField').querySelector('.rh-tk-steps').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      const step = Number(b.dataset.p) * CONTRACT.tickSize;
      this.state.price = roundToTick((this.state.price ?? this.deps.feed.quote.mark) + step); this._render();
    });
    this.$('tkSubmit').addEventListener('click', () => this._submit());
    window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen) this.close(); });
    this._makeDraggable(this.$('tkGrip'));
  }

  /**
   * Set a sensible default price for the current side/type (natural price for a
   * limit, a few ticks away for a stop). No-op price for market orders.
   * @returns {void}
   */
  _defaultPrice() {
    const q = this.deps.feed.quote;
    const t = this.state.type, s = this.state.side;
    if (t === 'market') { this.state.price = null; return; }
    const off = 10 * CONTRACT.tickSize;   // a few ticks away for stops
    if (t === 'limit') this.state.price = roundToTick(s === 'buy' ? q.ask : q.bid);
    else this.state.price = roundToTick(s === 'buy' ? q.ask + off : q.bid - off);
  }

  /**
   * Open the ticket, optionally pre-filled.
   * @param {object} [opts]
   * @param {'buy'|'sell'} [opts.side='buy']
   * @param {'market'|'limit'|'stop'} [opts.type='market']
   * @param {number|null} [opts.price=null] - Price to pre-fill (for limit/stop).
   * @returns {void}
   */
  open({ side = 'buy', type = 'market', price = null } = {}) {
    this.state.side = side; this.state.type = type; this.state.qty = 1; this.state.tif = 'day';
    this.state.price = price != null ? roundToTick(price) : null;
    if (type !== 'market' && this.state.price == null) this._defaultPrice();
    this.isOpen = true;
    this.el.hidden = false;
    if (!this._placed) {   // first open -> dock it to the right (until the user drags it)
      this.el.style.top = '92px';
      this.el.style.left = '';
      this.el.style.right = '372px';
    }
    this._render();
    this.$('tkQty').focus({ preventScroll: true });
    this.$('tkQty').select?.();
  }

  /** Close/hide the ticket. @returns {void} */
  close() { this.isOpen = false; this.el.hidden = true; }

  /** Re-render live fields (price, bid/ask, buying power) — called each tick while open. @returns {void} */
  refresh() { if (this.isOpen) this._render(); }

  /**
   * Compute the estimated buying-power effect of the pending order (mirrors the
   * engine's margin math) and whether it would exceed buying power.
   * @returns {{effect:number, insufficient:boolean, fee:number}} `effect` is the
   *   signed dollar change to buying power; `insufficient` blocks submission.
   */
  _bp() {
    const eng = this.deps.engine, cfg = eng.cfg;
    const { side, qty } = this.state;
    const signed = side === 'buy' ? qty : -qty;
    const result = eng.position.qty + signed;
    // Split the order into the part that GROWS exposure vs. the part that SHRINKS
    // it (one order can do both when it flips the position). Added contracts lock
    // up margin (negative effect); reduced contracts free margin (positive).
    const added = Math.max(0, Math.abs(result) - Math.abs(eng.position.qty));
    const reduced = Math.max(0, Math.abs(eng.position.qty) - Math.abs(result));
    const fee = feesPerSide(cfg, qty);
    const effect = reduced * cfg.initialMargin - added * cfg.initialMargin - fee;
    // Only the added portion can be unaffordable; reducing/closing always passes.
    // Mirrors the engine's own check so the ticket warns before you submit.
    const insufficient = added > 0 && added * cfg.initialMargin + fee > eng.buyingPower + 1e-6;
    return { effect, insufficient, fee };
  }

  /**
   * Re-paint the ticket from `state` + the live quote/account: header price,
   * side, quantity, price field visibility/labels, buying-power effect, the
   * insufficient-funds warning, and the submit button's label/enabled state.
   * Avoids overwriting an input the user is actively typing in.
   * @returns {void}
   */
  _render() {
    const s = this.state, q = this.deps.feed.quote, eng = this.deps.engine;
    // header + side
    this.$('tkHpx').textContent = fmtPx(q.mark);
    for (const b of this.$('tkSide').children) b.classList.toggle('active', b.dataset.side === s.side);
    this.$('tkSide').className = `seg rh-tk-side ${s.side}`;
    // controls reflect state — but DON'T overwrite a field the user is actively
    // typing in (the live tick re-renders ~5x/sec; without this guard your
    // half-typed price would be stomped every frame). Hence the activeElement check.
    const setVal = (id, v) => { const e = this.$(id); if (document.activeElement !== e) e.value = v; };
    this.$('tkType').value = s.type;
    this.$('tkTif').value = s.tif;
    setVal('tkQty', s.qty);
    this.$('tkQtySub').textContent = `${s.qty} contract${s.qty > 1 ? 's' : ''}`;
    // price field
    const showPrice = s.type !== 'market';
    this.$('tkPriceField').hidden = !showPrice;
    if (showPrice) {
      this.$('tkPriceLbl').firstChild.textContent = s.type === 'stop' ? 'Stop price' : 'Limit price';
      this.$('tkBidAsk').textContent = `Bid ${fmtPx(q.bid)} · Ask ${fmtPx(q.ask)}`;
      setVal('tkPrice', s.price ?? '');
    }
    // buying power
    const { effect, insufficient } = this._bp();
    const be = this.$('tkBpEffect');
    be.textContent = fmtUSDSigned(effect); be.className = effect < 0 ? 'down' : 'up';
    this.$('tkBp').textContent = fmtUSD(eng.buyingPower);
    // warning + submit
    const warn = this.$('tkWarn');
    warn.hidden = !insufficient;
    if (insufficient) warn.textContent = "You don't have enough buying power to place this order.";
    const sub = this.$('tkSubmit');
    sub.textContent = `${s.side === 'buy' ? 'Buy' : 'Sell'} /${CONTRACT.symbol}`;
    sub.className = `rh-tk-submit ${s.side}`;
    const needPrice = showPrice && !Number.isFinite(s.price);
    sub.disabled = insufficient || needPrice;
  }

  /**
   * Build the order from the current state and submit it via `deps.place`. On
   * success the ticket closes; on rejection it shows the reason as a toast.
   * @returns {void}
   */
  _submit() {
    const s = this.state;
    const order = {
      side: s.side, type: s.type, qty: s.qty, tif: s.tif,
      limitPx: s.type === 'limit' ? s.price : null,
      stopPx: s.type === 'stop' ? s.price : null,
    };
    const res = this.deps.place(order);
    if (res && res.ok === false) { this.deps.toast(res.reason, 'error'); return; }
    this.close();
  }

  /**
   * Make the ticket draggable by its header grip.
   * @param {HTMLElement} handle - The drag handle element.
   * @returns {void}
   */
  _makeDraggable(handle) {
    let sx, sy, ox, oy, dragging = false;
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      dragging = true; this._placed = true;
      const r = this.el.getBoundingClientRect();
      this.el.style.right = ''; this.el.style.left = r.left + 'px'; this.el.style.top = r.top + 'px';
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      const move = (ev) => { if (!dragging) return; this.el.style.left = ox + (ev.clientX - sx) + 'px'; this.el.style.top = oy + (ev.clientY - sy) + 'px'; };
      const up = () => { dragging = false; document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    });
  }
}
