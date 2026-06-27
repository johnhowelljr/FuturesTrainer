// =============================================================================
// engine.js — The paper-trading account & order engine
// -----------------------------------------------------------------------------
// The brain of the simulator's account. It owns your cash, position, working
// orders, and the activity log, and it computes everything money-related:
// fills, average price, realized/unrealized P&L, fees, margin, buying power,
// and margin calls. It is fed a live quote (bid/ask/mark) on every tick and
// reacts (filling resting orders, checking margin) and then notifies the UI.
//
// FUTURES ACCOUNTING (important — not like stocks):
//   * Opening a position posts MARGIN per contract; the notional value is NOT
//     subtracted from cash.
//   * Cash only moves by realized P&L (closing trades) and fees.
//   * equity      = cash + unrealized P&L
//   * buyingPower = equity − margin currently in use
//
// `position.qty` is signed: positive = long, negative = short.
// All money is paper money — this never places a real order anywhere.
// =============================================================================

import { CONTRACT, feesPerSide, pnlDollars, round2, roundToTick } from './contract.js';

// Monotonic id source shared by orders and activity-log rows.
let ORDER_SEQ = 1;

export class Engine {
  /**
   * @param {object} cfg - The app config (start balance, fees, margins, etc.).
   *   The engine reads live values off this object, so updating `engine.cfg`
   *   changes its behavior immediately.
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.cash = cfg.startBalance;
    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.position = { qty: 0, avg: 0 };   // qty signed: + long / - short
    this.orders = [];                     // working (resting) orders
    this.activity = [];                   // fills, cancels, system messages (newest first)
    this.dayStartEquity = cfg.startBalance;
    this.quote = { bid: cfg.startPrice, ask: cfg.startPrice, mark: cfg.startPrice };
    this.listeners = new Set();
    this.marginCall = false;
    this._pendingClearOrders = false;     // set by a fill that closes the position
  }

  /**
   * Subscribe to account changes. The callback receives a {@link snapshot}
   * every time anything changes (fill, cancel, quote, reset).
   * @param {(snap:object)=>void} fn - Listener.
   * @returns {()=>void} An unsubscribe function.
   */
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  /** Notify all subscribers with a fresh snapshot. @returns {void} */
  _emit() { for (const fn of this.listeners) fn(this.snapshot()); }

  // ---- derived account values (computed live from position + quote) ----------

  /** @returns {number} Open (unrealized) P&L in dollars at the current mark. */
  get unrealized() {
    if (this.position.qty === 0) return 0;
    return round2((this.quote.mark - this.position.avg) * CONTRACT.pointValue * this.position.qty);
  }
  /** @returns {number} Margin currently posted = |contracts| × initial margin. */
  get marginUsed() { return Math.abs(this.position.qty) * this.cfg.initialMargin; }
  /** @returns {number} Account equity = cash + unrealized P&L. */
  get equity() { return round2(this.cash + this.unrealized); }
  /** @returns {number} Buying power = equity − margin in use. */
  get buyingPower() { return round2(this.equity - this.marginUsed); }
  /** @returns {number} Max additional contracts affordable at current buying power. */
  get maxContracts() { return Math.max(0, Math.floor(this.buyingPower / this.cfg.initialMargin)); }
  /** @returns {number} Today's P&L = equity now − equity at session start. */
  get dayPnl() { return round2(this.equity - this.dayStartEquity); }
  /** @returns {number} Total P&L = realized + unrealized. */
  get totalPnl() { return round2(this.realizedPnl + this.unrealized); }

  /**
   * The price a *marketable* order of the given side fills at: buys lift the
   * offer (ask), sells hit the bid.
   * @param {'buy'|'sell'} side
   * @returns {number} Fill price.
   */
  fillPriceFor(side) { return side === 'buy' ? this.quote.ask : this.quote.bid; }

  /**
   * Estimated fees for an order (one side).
   * @param {number} qty - Contracts.
   * @returns {number} Dollar fees.
   */
  estCost(qty) { return feesPerSide(this.cfg, qty); }

  /**
   * Apply a fill to the position: update average price, realize P&L on any
   * contracts that were closed, move cash by realized − fees, log it, and flag
   * a position-close if it went flat/flipped. This is the heart of the math.
   * @param {'buy'|'sell'} side - Direction of the fill.
   * @param {number} qty - Contracts filled (positive).
   * @param {number} price - Fill price in index points.
   * @param {string} label - Tag for the log (e.g. 'market', 'limit', 'flatten').
   * @returns {{realized:number, fee:number, price:number}} What happened.
   */
  _applyFill(side, qty, price, label) {
    // Work in SIGNED quantities so longs/shorts use one code path: a buy is +qty,
    // a sell is -qty. `old` is the current signed position, `next` is what it
    // becomes. Everything below keys off the sign relationship between them.
    const signed = side === 'buy' ? qty : -qty;
    const old = this.position.qty;
    const oldAvg = this.position.avg;
    const next = old + signed;

    // Realize P&L ONLY on contracts that reduce an existing opposite position.
    // (Opposite sign = this fill is closing, not adding.) Adds realize nothing —
    // P&L on the part that just opened stays unrealized until it's later closed.
    let realized = 0;
    if (old !== 0 && Math.sign(signed) !== Math.sign(old)) {
      const closed = Math.min(Math.abs(signed), Math.abs(old));   // can't close more than we held
      realized = pnlDollars(oldAvg, price, closed, Math.sign(old));
    }

    // New average price — four mutually-exclusive cases by how `next` relates to `old`:
    let avg;
    if (next === 0) avg = 0;                                          // fully flat -> no avg
    else if (old === 0 || Math.sign(signed) === Math.sign(old)) {
      // Opening fresh, or adding to the same side -> volume-weighted average of
      // the old lots and the new ones. (qty here == |signed| for the new lots.)
      avg = (oldAvg * Math.abs(old) + price * qty) / Math.abs(next);
    } else if (Math.abs(signed) <= Math.abs(old)) {
      avg = oldAvg;                                                    // partial reduce -> remaining lots keep their cost
    } else {
      // Flip: closed the whole old position AND opened a new one on the other
      // side; the leftover contracts open at this fill price.
      avg = price;
    }

    // Cash only moves by realized P&L and fees (futures post margin, not notional).
    const fee = feesPerSide(this.cfg, qty);
    this.realizedPnl = round2(this.realizedPnl + realized);
    this.cash = round2(this.cash + realized - fee);
    this.feesPaid = round2(this.feesPaid + fee);
    this.position = { qty: next, avg: round2(avg) };

    // Closed (next===0) or flipped (sign changed) -> any resting stops/limits for
    // the old position are now meaningless. Flag it; _clearOrdersOnClose() acts
    // on the flag AFTER the current order loop so we don't mutate mid-iteration.
    if (old !== 0 && (next === 0 || Math.sign(next) !== Math.sign(old))) this._pendingClearOrders = true;

    this._log('fill', `${side === 'buy' ? 'Bought' : 'Sold'} ${qty} ${CONTRACT.symbol} @ ${price}` +
      (realized ? `  ·  P&L ${realized >= 0 ? '+' : ''}${round2(realized)}` : ''),
      { side, qty, price, fee, realized: round2(realized), label });
    return { realized: round2(realized), fee, price };
  }

  /**
   * Place an order. Market orders fill immediately at the current quote; limit/
   * stop/stop-limit orders rest until the market reaches them. Rejects if a new
   * position would exceed buying power.
   * @param {object} o
   * @param {'buy'|'sell'} o.side
   * @param {'market'|'limit'|'stop'|'stop_limit'} [o.type='market']
   * @param {number} o.qty - Contracts (floored to >= 1).
   * @param {number} [o.limitPx] - Limit price (required for limit/stop_limit).
   * @param {number} [o.stopPx] - Stop trigger price (required for stop/stop_limit).
   * @param {'day'|'gtc'} [o.tif='day'] - Time in force for resting orders.
   * @returns {{ok:boolean, reason?:string, filled?:boolean, orderId?:number,
   *   realized?:number, fee?:number, price?:number}} Result. `ok:false` carries a
   *   human `reason`; market fills return `filled:true`; resting orders return
   *   `orderId`.
   */
  placeOrder({ side, type, qty, limitPx, stopPx, tif }) {
    qty = Math.max(1, Math.floor(qty || 0));
    type = type || 'market';

    // Buying-power check, but ONLY for a fill that grows |position|. Reducing or
    // closing never needs margin (it frees it), so those always pass — important
    // so you can always exit even when fully margined. `1e-6` absorbs float noise
    // so an exactly-affordable order isn't rejected by a rounding hair.
    const signed = side === 'buy' ? qty : -qty;
    const resultingQty = this.position.qty + signed;
    const addedExposure = Math.max(0, Math.abs(resultingQty) - Math.abs(this.position.qty));
    if (addedExposure > 0) {
      const needed = Math.abs(resultingQty) * this.cfg.initialMargin;
      const fee = feesPerSide(this.cfg, qty);
      if (needed > this.equity - fee + 1e-6) {
        return { ok: false, reason: `Not enough buying power. Need ${money(needed)} margin; have ${money(this.buyingPower)}.` };
      }
    }

    if (type === 'market') {
      const price = this.fillPriceFor(side);
      const res = this._applyFill(side, qty, price, 'market');
      this._afterChange();
      return { ok: true, filled: true, ...res };
    }

    // Resting order (limit / stop / stop_limit). Prices snap to the tick grid.
    const order = {
      id: ORDER_SEQ++, side, type, qty, tif: tif || 'day',
      limitPx: limitPx != null ? roundToTick(Number(limitPx)) : null,
      stopPx: stopPx != null ? roundToTick(Number(stopPx)) : null,
      // `triggered` gates whether the order can fill. A plain limit is live the
      // instant it's placed; a stop/stop-limit stays untriggered until price
      // trades through its stop (see _processOrders), then behaves like a limit.
      triggered: type === 'limit',
      placedAt: Date.now(),
    };
    if ((type === 'limit' || type === 'stop_limit') && !Number.isFinite(order.limitPx))
      return { ok: false, reason: 'Enter a limit price.' };
    if ((type === 'stop' || type === 'stop_limit') && !Number.isFinite(order.stopPx))
      return { ok: false, reason: 'Enter a stop price.' };

    this.orders.push(order);
    this._log('order', `${labelSide(side)} ${qty} ${typeLabel(type)} ` +
      `${order.stopPx != null ? 'stop ' + order.stopPx + ' ' : ''}${order.limitPx != null ? 'limit ' + order.limitPx : ''}`.trim(),
      { orderId: order.id });
    // It may be immediately marketable — check against current quote.
    this._processOrders();
    this._afterChange();
    return { ok: true, filled: false, orderId: order.id };
  }

  /**
   * Cancel a working order by id (no-op if it isn't found).
   * @param {number} id - Order id.
   * @returns {void}
   */
  cancelOrder(id) {
    const i = this.orders.findIndex((o) => o.id === id);
    if (i === -1) return;
    const o = this.orders.splice(i, 1)[0];
    this._log('cancel', `Canceled ${labelSide(o.side)} ${o.qty} ${typeLabel(o.type)}`, { orderId: id });
    this._afterChange();
  }

  /**
   * Close the whole open position immediately with a market order (the "Close
   * position" button). No-op if already flat.
   * @returns {void}
   */
  flatten() {
    if (this.position.qty === 0) return;
    const side = this.position.qty > 0 ? 'sell' : 'buy';
    const price = this.fillPriceFor(side);
    this._applyFill(side, Math.abs(this.position.qty), price, 'flatten');
    this._afterChange();
  }

  /**
   * Feed the engine a fresh market quote each tick. Triggers resting-order
   * processing, a margin check, and a UI update.
   * @param {{bid:number, ask:number, mark:number}} quote
   * @returns {void}
   */
  onQuote(quote) {
    this.quote = quote;
    this._processOrders();
    this._checkMargin();
    this._emit();
  }

  /**
   * Walk all working orders against the current quote and fill any that have
   * been reached (limit through its price, stop triggered, stop-limit triggered
   * then filled). Runs the post-close order cleanup before and after.
   * @returns {void}
   */
  _processOrders() {
    this._clearOrdersOnClose();   // honor a close flagged by a market/flatten fill
    const { bid, ask } = this.quote;
    // Build a fresh list of survivors rather than splicing while iterating.
    const remaining = [];
    for (const o of this.orders) {
      let fill = null;   // stays null = not reached this tick
      if (o.type === 'limit') {
        // A limit fills when the market reaches your price or better. Buys care
        // about the ask, sells about the bid. The min/max gives price improvement
        // (you never fill worse than your limit) when the quote gapped past it.
        if (o.side === 'buy' && ask <= o.limitPx) fill = Math.min(o.limitPx, ask);
        else if (o.side === 'sell' && bid >= o.limitPx) fill = Math.max(o.limitPx, bid);
      } else if (o.type === 'stop') {
        // A stop becomes a market order once price trades through the stop, so it
        // fills at the quote (no price protection — that's the stop's nature).
        if (o.side === 'buy' && ask >= o.stopPx) fill = ask;
        else if (o.side === 'sell' && bid <= o.stopPx) fill = bid;
      } else if (o.type === 'stop_limit') {
        // Two phases: arm on the stop, then behave like a limit. `triggered`
        // persists on the order so once armed it stays armed across ticks.
        if (!o.triggered) {
          if (o.side === 'buy' && ask >= o.stopPx) o.triggered = true;
          else if (o.side === 'sell' && bid <= o.stopPx) o.triggered = true;
        }
        if (o.triggered) {
          if (o.side === 'buy' && ask <= o.limitPx) fill = Math.min(o.limitPx, ask);
          else if (o.side === 'sell' && bid >= o.limitPx) fill = Math.max(o.limitPx, bid);
        }
      }
      if (fill != null) this._applyFill(o.side, o.qty, fill, o.type);
      else remaining.push(o);   // not reached -> keep it working
    }
    this.orders = remaining;
    // A fill above may have closed/flipped the position; clear leftovers now —
    // AFTER reassigning this.orders, or the cleared list would be clobbered.
    this._clearOrdersOnClose();
  }

  /**
   * If the position just closed (or flipped), cancel every remaining resting
   * order so a leftover stop/limit can't open a fresh unwanted position. Guarded
   * by the `_pendingClearOrders` flag set in {@link _applyFill}.
   * @returns {void}
   */
  _clearOrdersOnClose() {
    if (!this._pendingClearOrders) return;
    this._pendingClearOrders = false;
    if (!this.orders.length) return;
    const n = this.orders.length;
    this.orders = [];
    this._log('system', `Canceled ${n} resting order${n > 1 ? 's' : ''} — position closed.`, {});
  }

  /**
   * Check for a margin call (equity below maintenance margin). Logs a warning
   * and, if `cfg.autoLiquidate`, flattens the position automatically.
   * @returns {void}
   */
  _checkMargin() {
    if (this.position.qty === 0) { this.marginCall = false; return; }
    const maint = Math.abs(this.position.qty) * this.cfg.maintenanceMargin;
    if (this.equity < maint) {
      // Edge into a call: only log the first time so a sustained breach doesn't
      // spam the activity feed every tick (the `if (!this.marginCall)` guard).
      if (!this.marginCall) {
        this.marginCall = true;
        this._log('system', `⚠ Margin call: equity ${money(this.equity)} < maintenance ${money(maint)}.`, {});
      }
      if (this.cfg.autoLiquidate) {
        this._log('system', 'Auto-liquidating position.', {});
        this.flatten();
        this.marginCall = false;
      }
    } else {
      this.marginCall = false;
    }
  }

  /** Re-run order processing + margin check + emit after any account change. @returns {void} */
  _afterChange() { this._processOrders(); this._checkMargin(); this._emit(); }

  /**
   * Prepend a row to the activity log (capped at 200 rows).
   * @param {'fill'|'order'|'cancel'|'system'} kind - Row category (drives color).
   * @param {string} text - Human-readable message.
   * @param {object} extra - Extra fields merged into the row (side, qty, etc.).
   * @returns {void}
   */
  _log(kind, text, extra) {
    this.activity.unshift({ id: ORDER_SEQ++, ts: Date.now(), kind, text, ...extra });
    if (this.activity.length > 200) this.activity.pop();
  }

  /**
   * Cancel all working orders *without* filling them (used when the data
   * source/session is swapped so orders don't teleport-fill at new prices).
   * @returns {void}
   */
  cancelAllOrders() {
    if (!this.orders.length) return;
    const n = this.orders.length;
    this.orders = [];
    this._log('system', `${n} working order(s) canceled (session change).`, {});
  }

  /**
   * Expire Good-for-day orders when the session rolls; GTC orders stay.
   * @returns {void}
   */
  expireDayOrders() {
    const before = this.orders.length;
    this.orders = this.orders.filter((o) => o.tif === 'gtc');
    if (this.orders.length !== before) this._log('system', `${before - this.orders.length} day order(s) expired at session close.`, {});
  }

  /** Mark "now" as the start of a new trading day for Day-P&L. @returns {void} */
  newDay() { this.dayStartEquity = this.equity; this._emit(); }

  /**
   * Reset the account to its starting balance and clear everything.
   * @param {object} [cfg] - Optional new config to adopt at reset.
   * @returns {void}
   */
  resetAccount(cfg) {
    if (cfg) this.cfg = cfg;
    this.cash = this.cfg.startBalance;
    this.realizedPnl = 0;
    this.feesPaid = 0;
    this.position = { qty: 0, avg: 0 };
    this.orders = [];
    this.activity = [];
    this.dayStartEquity = this.cfg.startBalance;
    this.marginCall = false;
    this._log('system', `Account reset to ${money(this.cfg.startBalance)}.`, {});
    this._emit();
  }

  /**
   * Build a read-only snapshot of the full account state for the UI. Includes
   * all derived values (equity, buying power, P&L) so renderers don't recompute.
   * @returns {object} The snapshot passed to subscribers.
   */
  snapshot() {
    return {
      cash: this.cash, realizedPnl: this.realizedPnl, feesPaid: this.feesPaid,
      position: { ...this.position }, orders: this.orders.map((o) => ({ ...o })),
      activity: this.activity, quote: this.quote,
      unrealized: this.unrealized, equity: this.equity, buyingPower: this.buyingPower,
      marginUsed: this.marginUsed, maxContracts: this.maxContracts,
      dayPnl: this.dayPnl, totalPnl: this.totalPnl, marginCall: this.marginCall,
    };
  }

  /**
   * The minimal slice of state worth persisting (no derived values).
   * @returns {object} Saved by store.js.
   */
  toJSON() {
    return {
      cash: this.cash, realizedPnl: this.realizedPnl, feesPaid: this.feesPaid,
      position: this.position, orders: this.orders, activity: this.activity,
      dayStartEquity: this.dayStartEquity,
    };
  }

  /**
   * Restore a previously-saved account (from {@link toJSON}). Tolerant of
   * missing fields.
   * @param {object|null} s - Saved account, or null for a fresh account.
   * @returns {void}
   */
  load(s) {
    if (!s) return;
    this.cash = s.cash ?? this.cash;
    this.realizedPnl = s.realizedPnl ?? 0;
    this.feesPaid = s.feesPaid ?? 0;
    this.position = s.position ?? { qty: 0, avg: 0 };
    this.orders = s.orders ?? [];
    this.activity = s.activity ?? [];
    this.dayStartEquity = s.dayStartEquity ?? this.cash;
  }
}

/** Format a dollar amount for log messages. @param {number} x @returns {string} */
function money(x) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(x || 0);
}
/** "buy"/"sell" -> "Buy"/"Sell". @param {string} s @returns {string} */
function labelSide(s) { return s === 'buy' ? 'Buy' : 'Sell'; }
/** Order type -> human label. @param {string} t @returns {string} */
function typeLabel(t) { return { market: 'market', limit: 'limit', stop: 'stop', stop_limit: 'stop-limit' }[t] || t; }
