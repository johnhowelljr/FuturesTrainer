// =============================================================================
// chart.js — The price chart (TradingView Lightweight Charts v5 wrapper)
// -----------------------------------------------------------------------------
// Wraps the lightweight-charts library into one tidy `PriceChart` class styled
// like Robinhood. It owns the candlestick + area(line) series, the ET time axis,
// trade markers, the position/working-order price lines, the overlay indicators
// (EMA/SMA/VWAP/Bollinger drawn on the price), and the oscillator sub-panes
// (Volume/RSI/MACD drawn in their own panels below the price).
//
// The app gives this class plain bar arrays and indicator on/off flags; this
// class translates them into the charting library's API. It also exposes a few
// coordinate helpers (price<->pixel) that the on-chart trading overlay uses.
// =============================================================================

import { INDICATOR_DEFS, rsi, macd } from './indicators.js';

const LWC = window.LightweightCharts;   // the global from the vendored UMD build

const GREEN = '#00C805';
const RED = '#FF5000';
const GREEN_A = 'rgba(0,200,5,0.5)';    // translucent green for volume/MACD bars
const RED_A = 'rgba(255,80,0,0.5)';

// ET formatters for axis ticks (minutes / seconds) and the crosshair tooltip.
const etFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
const etFmtSec = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' });
const etFmtFull = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: 'America/New_York' });

export class PriceChart {
  /**
   * Create the chart inside a container element.
   * @param {HTMLElement} el - The element to render the chart into (it fills it
   *   and auto-resizes with it).
   */
  constructor(el) {
    this.el = el;
    this.type = 'candles';   // 'candles' | 'line'
    this.tfSeconds = 300;    // seconds-per-bar of the current timeframe
    this._orderLines = [];   // working-order price lines currently drawn
    this._posLine = null;    // the position average price line

    this.chart = LWC.createChart(el, {
      layout: {
        background: { type: 'solid', color: 'transparent' },
        textColor: '#9aa3ad',
        fontFamily: 'Inter, -apple-system, "Segoe UI", Roboto, sans-serif',
        fontSize: 11,
        panes: { separatorColor: 'rgba(255,255,255,0.10)', separatorHoverColor: 'rgba(255,255,255,0.2)' },
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.04)' },
        horzLines: { color: 'rgba(255,255,255,0.04)' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)', scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: true,
        secondsVisible: true,
        rightOffset: 4,
        // sub-minute timeframes show seconds; everything else shows HH:MM (ET).
        tickMarkFormatter: (t) => (this._tfSec && this._tfSec < 60 ? etFmtSec : etFmt).format(new Date(t * 1000)),
      },
      crosshair: {
        mode: LWC.CrosshairMode.Normal,
        vertLine: { color: 'rgba(255,255,255,0.25)', width: 1, style: 3, labelBackgroundColor: '#1f2933' },
        horzLine: { color: 'rgba(255,255,255,0.25)', width: 1, style: 3, labelBackgroundColor: '#1f2933' },
      },
      localization: {
        timeFormatter: (t) => etFmtFull.format(new Date(t * 1000)) + ' ET',
        priceFormatter: (p) => Number(p).toLocaleString('en-US', { minimumFractionDigits: this._priceDecimals || 0, maximumFractionDigits: this._priceDecimals || 0 }),
      },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });

    this.candles = this.chart.addSeries(LWC.CandlestickSeries, {
      upColor: GREEN, downColor: RED, wickUpColor: GREEN, wickDownColor: RED,
      borderVisible: false, priceLineVisible: true, priceLineColor: 'rgba(255,255,255,0.35)',
      priceLineStyle: 2, lastValueVisible: true,
    });
    this.area = this.chart.addSeries(LWC.AreaSeries, {
      lineColor: GREEN, lineWidth: 2,
      topColor: 'rgba(0,200,5,0.28)', bottomColor: 'rgba(0,200,5,0.0)',
      priceLineVisible: true, priceLineColor: 'rgba(255,255,255,0.35)', priceLineStyle: 2,
      visible: false, lastValueVisible: true,
    });
    // v5: markers are a series *primitive*, not a series method.
    this._candleMarkers = LWC.createSeriesMarkers(this.candles, []);
    this._areaMarkers = LWC.createSeriesMarkers(this.area, []);

    this._resize = new ResizeObserver(() => this.chart.applyOptions({ width: el.clientWidth, height: el.clientHeight }));
    this._resize.observe(el);
    this.chart.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  }

  /**
   * Subscribe to crosshair movement (drives the floating O/H/L/C legend).
   * @param {(info:{time:number, bar:object|null}|null)=>void} cb - Called with the
   *   hovered bar (or null when the cursor leaves the chart).
   * @returns {void}
   */
  onCrosshair(cb) {
    this.chart.subscribeCrosshairMove((param) => {
      if (!param.time || !param.point) { cb(null); return; }
      const c = param.seriesData.get(this.candles);
      const a = param.seriesData.get(this.area);
      cb({ time: param.time, bar: c || (a ? { close: a.value } : null) });
    });
  }

  /**
   * Switch between candlestick and line(area) display.
   * @param {'candles'|'line'} type
   * @returns {void}
   */
  setType(type) {
    this.type = type;
    this.candles.applyOptions({ visible: type === 'candles' });
    this.area.applyOptions({ visible: type === 'line' });
    this._applyDayColor(this._dayUp ?? true);
  }

  /**
   * Tint the line/area green or red depending on whether the session is up.
   * @param {boolean} up - True if price is up on the day.
   * @returns {void}
   */
  _applyDayColor(up) {
    this._dayUp = up;
    const c = up ? GREEN : RED;
    this.area.applyOptions({
      lineColor: c,
      topColor: up ? 'rgba(0,200,5,0.28)' : 'rgba(255,80,0,0.26)',
      bottomColor: up ? 'rgba(0,200,5,0.0)' : 'rgba(255,80,0,0.0)',
    });
  }

  /**
   * Replace the whole bar set (on timeframe/mode/contract change).
   * @param {Array<{time,open,high,low,close}>} bars - Aggregated bars.
   * @param {number} tfSeconds - Seconds-per-bar of the timeframe (for marker snapping).
   * @param {boolean} [dayUp] - Whether the day is up (for line color).
   * @returns {void}
   */
  setData(bars, tfSeconds, dayUp) {
    this.tfSeconds = tfSeconds;
    this._tfSec = tfSeconds;
    this._barCount = bars.length;
    if (dayUp != null) this._applyDayColor(dayUp);
    this.candles.setData(bars);
    this.area.setData(bars.map((b) => ({ time: b.time, value: b.close })));
  }

  /**
   * Scroll/zoom so the most recent `n` bars are visible at a readable size
   * (what Robinhood does on a timeframe switch — not the whole session squeezed in).
   * @param {number} [n=90] - How many recent bars to frame.
   * @returns {void}
   */
  showRecent(n = 90) {
    const c = this._barCount || 0;
    if (c < 3) { this.fit(); return; }
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, c - n), to: c + 1 });
  }

  /**
   * Update just the most recent (forming) bar each live tick — appends a new bar
   * when its time advances and auto-scrolls to follow.
   * @param {{time,open,high,low,close}} bar - The latest bar.
   * @param {boolean} [dayUp] - Whether the day is up (for line color).
   * @returns {void}
   */
  updateLast(bar, dayUp) {
    if (dayUp != null) this._applyDayColor(dayUp);
    this.candles.update(bar);
    this.area.update({ time: bar.time, value: bar.close });
  }

  /**
   * Set the price-axis precision to the active contract's tick (0 decimals for
   * MYM's 1.0 tick, 1 decimal for M2K's 0.10 tick).
   * @param {number} tickSize - The contract tick size.
   * @returns {void}
   */
  setPriceFormat(tickSize) {
    this._priceDecimals = tickSize >= 1 ? 0 : (String(tickSize).split('.')[1] || '').length;
    const fmt = { type: 'price', precision: this._priceDecimals, minMove: tickSize };
    this.candles.applyOptions({ priceFormat: fmt });
    this.area.applyOptions({ priceFormat: fmt });
  }

  // ---- overlay indicators (lines on the price pane) -------------------------

  /**
   * Get (creating if needed) a line series used for an overlay indicator.
   * @param {string} id - Unique series id (e.g. 'ema9', 'bb_u').
   * @param {string} color - Line color.
   * @param {number} [width] - Line width.
   * @returns {object} The lightweight-charts line series.
   */
  _ensureInd(id, color, width) {
    this._ind = this._ind || {};
    if (!this._ind[id]) {
      this._ind[id] = this.chart.addSeries(LWC.LineSeries, {
        color, lineWidth: width || 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
    } else {
      this._ind[id].applyOptions({ color, lineWidth: width || 1 });
    }
    return this._ind[id];
  }
  /** Remove an overlay indicator series by id (if present). @param {string} id @returns {void} */
  _removeInd(id) {
    if (this._ind && this._ind[id]) { this.chart.removeSeries(this._ind[id]); delete this._ind[id]; }
  }

  /**
   * Draw/update/remove all indicators to match the active set. Overlays (moving
   * averages, VWAP, Bollinger) are drawn on the price pane; oscillators are
   * handed off to {@link _renderOscillators}.
   * @param {Array<{time,open,high,low,close,volume}>} bars - Current timeframe bars.
   * @param {Object<string,boolean>} active - Map of indicator id -> on/off.
   * @returns {void}
   */
  renderIndicators(bars, active) {
    active = active || {};
    for (const def of INDICATOR_DEFS) {
      if (def.pane) continue;                              // oscillators handled below
      if (def.bands) {
        const sub = ['_u', '_m', '_l'];
        if (!active[def.id]) { sub.forEach((s) => this._removeInd(def.id + s)); continue; }
        const data = def.compute(bars);
        this._ensureInd(def.id + '_u', def.color, 1).setData(data.map((d) => ({ time: d.time, value: d.upper })));
        this._ensureInd(def.id + '_m', def.color, def.width).setData(data.map((d) => ({ time: d.time, value: d.middle })));
        this._ensureInd(def.id + '_l', def.color, 1).setData(data.map((d) => ({ time: d.time, value: d.lower })));
      } else {
        if (!active[def.id]) { this._removeInd(def.id); continue; }
        this._ensureInd(def.id, def.color, def.width).setData(def.compute(bars));
      }
    }
    this._renderOscillators(bars, active);
  }

  // ---- oscillator sub-panes (Volume / RSI / MACD) ---------------------------

  /** Remove every oscillator series (used when the active set changes). @returns {void} */
  _teardownOsc() {
    if (!this._osc) return;
    for (const id in this._osc) for (const s of this._osc[id].series) this.chart.removeSeries(s);
    this._osc = {};
  }

  /**
   * Create the series for one oscillator in the given pane.
   * @param {'volume'|'rsi'|'macd'} id - Which oscillator.
   * @param {number} pane - Pane index (1+, below the price pane).
   * @returns {{series: object[]}} The created series (1 for volume/rsi, 3 for macd).
   */
  _buildOsc(id, pane) {
    const o = { series: [] };
    const noLine = { priceLineVisible: false, lastValueVisible: false };
    if (id === 'volume') {
      o.series.push(this.chart.addSeries(LWC.HistogramSeries, { priceFormat: { type: 'volume' }, ...noLine }, pane));
    } else if (id === 'rsi') {
      const s = this.chart.addSeries(LWC.LineSeries, { color: '#c792ea', lineWidth: 1, priceLineVisible: false, lastValueVisible: true }, pane);
      s.createPriceLine({ price: 70, color: 'rgba(255,255,255,0.16)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
      s.createPriceLine({ price: 30, color: 'rgba(255,255,255,0.16)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
      o.series.push(s);
    } else if (id === 'macd') {
      o.series.push(this.chart.addSeries(LWC.HistogramSeries, noLine, pane));                               // histogram
      o.series.push(this.chart.addSeries(LWC.LineSeries, { color: '#2196f3', lineWidth: 1, ...noLine }, pane)); // macd line
      o.series.push(this.chart.addSeries(LWC.LineSeries, { color: '#ff6d00', lineWidth: 1, ...noLine }, pane)); // signal line
    }
    return o;
  }

  /**
   * Push fresh data into an oscillator's series for the current bars.
   * @param {'volume'|'rsi'|'macd'} id
   * @param {Array} bars - Current timeframe bars.
   * @returns {void}
   */
  _setOscData(id, bars) {
    const o = this._osc[id]; if (!o) return;
    if (id === 'volume') {
      o.series[0].setData(bars.map((b) => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? GREEN_A : RED_A })));
    } else if (id === 'rsi') {
      o.series[0].setData(rsi(bars, 14));
    } else if (id === 'macd') {
      const m = macd(bars);
      o.series[0].setData(m.hist.map((d) => ({ time: d.time, value: d.value, color: d.value >= 0 ? GREEN_A : RED_A })));
      o.series[1].setData(m.macd);
      o.series[2].setData(m.signal);
    }
  }

  /**
   * Reconcile the oscillator sub-panes with the active set: when the set
   * changes, rebuild the panes (contiguously, price pane stays largest); then
   * push current data into each. Cheap on every tick (only data updates).
   * @param {Array} bars - Current timeframe bars.
   * @param {Object<string,boolean>} active - Indicator on/off map.
   * @returns {void}
   */
  _renderOscillators(bars, active) {
    const order = INDICATOR_DEFS.filter((d) => d.pane && active[d.id]).map((d) => d.id);
    // `sig` is a cheap signature of WHICH oscillators are on and in what order.
    // Rebuilding panes is expensive (and resets their height), so we only do the
    // teardown/rebuild when the signature actually changes — otherwise we fall
    // straight through to the data-only update at the bottom (runs every tick).
    const sig = order.join(',');
    if (sig !== this._oscSig) {
      this._teardownOsc();
      this._osc = {};
      // Pane indices must be contiguous (1, 2, 3…) under the price pane (pane 0).
      order.forEach((id, i) => { this._osc[id] = this._buildOsc(id, i + 1); });
      this._oscSig = sig;
      const panes = this.chart.panes();
      // Stretch factors are relative: price pane 3.2 vs each oscillator 1 keeps
      // price dominant no matter how many oscillators are stacked below it.
      if (panes[0]) panes[0].setStretchFactor(order.length ? 3.2 : 1);
      for (let p = 1; p <= order.length; p++) if (panes[p]) panes[p].setStretchFactor(1);
    }
    for (const id of order) this._setOscData(id, bars);
  }

  /** Zoom to fit all bars. @returns {void} */
  fit() { this.chart.timeScale().fitContent(); }
  /** Scroll to the live (right) edge. @returns {void} */
  scrollToRealtime() { this.chart.timeScale().scrollToRealTime(); }

  /**
   * Place buy/sell arrow markers on the chart from trade fills. Each marker's
   * time is snapped to the current timeframe's bar bucket.
   * @param {Array<{time:number, side:'buy'|'sell', qty:number}>} trades
   * @returns {void}
   */
  setMarkers(trades) {
    const markers = trades.map((t) => ({
      // Snap the fill time onto the timeframe grid so the marker sits on a real
      // bar (a fill at 10:03:47 on the 5m chart lands on the 10:00 candle).
      time: Math.floor(t.time / this.tfSeconds) * this.tfSeconds,
      position: t.side === 'buy' ? 'belowBar' : 'aboveBar',
      color: t.side === 'buy' ? GREEN : RED,
      shape: t.side === 'buy' ? 'arrowUp' : 'arrowDown',
      text: `${t.side === 'buy' ? 'B' : 'S'} ${t.qty}`,
    })).sort((a, b) => a.time - b.time);   // lightweight-charts requires markers in time order
    // Markers belong to a specific series, so we keep one set per series and only
    // populate whichever one is currently visible (candles vs. line).
    this._candleMarkers.setMarkers(this.type === 'candles' ? markers : []);
    this._areaMarkers.setMarkers(this.type === 'line' ? markers : []);
  }

  /**
   * Draw (or clear) the dashed average-cost line for the open position.
   * @param {number} avg - Average entry price.
   * @param {number} qty - Signed position size (0 clears the line).
   * @returns {void}
   */
  setPositionLine(avg, qty) {
    const series = this.activeSeries;
    if (this._posLine) { this._posLineSeries.removePriceLine(this._posLine); this._posLine = null; }
    if (qty && avg) {
      this._posLineSeries = series;
      this._posLine = series.createPriceLine({
        price: avg, color: '#c6cdd6', lineWidth: 1, lineStyle: 2,
        axisLabelVisible: true, title: `Avg ${qty > 0 ? 'L' : 'S'}${Math.abs(qty)}`,
      });
    }
  }

  /**
   * Draw horizontal price lines for all working (resting) orders, replacing any
   * previously drawn.
   * @param {Array<{side,type,qty,limitPx,stopPx}>} orders
   * @returns {void}
   */
  setOrderLines(orders) {
    const series = this.activeSeries;
    for (const l of this._orderLines) l.series.removePriceLine(l.line);
    this._orderLines = [];
    for (const o of orders) {
      const price = o.type === 'stop' ? o.stopPx : (o.limitPx ?? o.stopPx);
      if (!Number.isFinite(price)) continue;
      const color = o.side === 'buy' ? '#3b82f6' : '#f59e0b';
      const line = series.createPriceLine({
        price, color, lineWidth: 1, lineStyle: 1, axisLabelVisible: true,
        title: `${o.side === 'buy' ? 'Buy' : 'Sell'} ${o.qty} ${o.type === 'stop' ? 'stop' : 'lmt'}`,
      });
      this._orderLines.push({ series, line });
    }
  }

  // ---- coordinate helpers for the on-chart trading overlay ------------------

  /** @returns {object} The currently visible main series (candles or area). */
  get activeSeries() { return this.type === 'candles' ? this.candles : this.area; }
  /** @param {number} price @returns {number|null} Pixel Y for a price (null if off-scale). */
  priceToY(price) { return this.activeSeries.priceToCoordinate(price); }
  /** @param {number} y @returns {number|null} Price at a pixel Y (null if off-scale). */
  coordinateToPrice(y) { return this.activeSeries.coordinateToPrice(y); }
  /** @returns {number} Width in px of the right price axis (to align overlay handles). */
  priceScaleWidth() { try { return this.chart.priceScale('right').width(); } catch { return 56; } }

  /**
   * Subscribe to left-clicks on the chart, reporting the clicked price.
   * @param {(info:{price:number,x:number,y:number,time:number})=>void} cb
   * @returns {void}
   */
  onClick(cb) {
    this.chart.subscribeClick((param) => {
      if (!param.point) return;
      const price = this.coordinateToPrice(param.point.y);
      if (price == null) return;
      cb({ price, x: param.point.x, y: param.point.y, time: param.time });
    });
  }

  /**
   * Subscribe to right-clicks (the Robinhood-style order context entry),
   * reporting the price at the cursor.
   * @param {(info:{price:number,x:number,y:number})=>void} cb
   * @returns {void}
   */
  onContextMenu(cb) {
    this.el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const rect = this.el.getBoundingClientRect();
      const price = this.coordinateToPrice(e.clientY - rect.top);
      if (price == null) return;
      cb({ price, x: e.clientX - rect.left, y: e.clientY - rect.top });
    });
  }

  /**
   * Subscribe to visible-range changes (so the trading overlay can reposition
   * its handles when you pan/zoom).
   * @param {()=>void} cb
   * @returns {void}
   */
  onVisibleRangeChange(cb) { this.chart.timeScale().subscribeVisibleTimeRangeChange(cb); }
}
