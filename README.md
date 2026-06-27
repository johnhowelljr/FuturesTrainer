# Futures Training Simulator — MYMU26

A Robinhood-Futures–style **paper trading simulator** for learning to trade futures.
It reproduces the Robinhood Legend futures chart and order flow using a synthetic or
replayed price feed. You start with **$10,000** in paper money. Pick the contract from
the header dropdown:

- **MYMU26** — Micro E-mini Dow ($0.50/point, 1.0 tick)
- **M2KU26** — Micro E-mini Russell 2000 ($5.00/point, 0.10 tick)

Everything (P&L, margin, chart precision, the ladder's tick spacing) adapts to the
selected contract.

> ⚠️ **Training only.** No real orders are ever placed and no real money is involved.
> Prices are synthetically generated (or imported from a CSV you provide).

---

## Run it

### Desktop app (Electron) — recommended

```bash
cd rhfutures
npm install      # one-time (downloads Electron)
npm start        # launches the standalone desktop window
```

The app is fully self-contained — it serves its bundled files over a private
`app://` scheme (no browser, no dev server, no internet needed). Your account,
positions, and settings persist between launches via `localStorage`.

### Build a self-contained, movable executable

```bash
npm run portable   # -> "release/Futures Training Simulator <ver>.exe"  (single ~68 MB file)
npm run dist       # NSIS installer + portable .exe
```

`npm run portable` produces **one self-contained `.exe`** — copy that single file to any
Windows PC and run it; it self-extracts and launches with no install, no Node, no Electron.

> If `npm run portable` ever fails with *"Cannot create symbolic link … A required
> privilege is not held"*, enable **Settings → For developers → Developer Mode** (one
> toggle) and retry — that's electron-builder extracting its (macOS) code-signing tools.

A faster, always-current **folder** build lives at `release/FuturesTrainingSimulator/`
(kept in sync with the source automatically); run the `.exe` inside it for quick local use.

### Browser mode (optional, no Electron)

```bash
npm run serve    # zero-dependency static server on http://localhost:5173
```

---

## What it reproduces (Robinhood Legend futures)

**Chart**
- Candlestick **and** line/area modes, Robinhood green/red, ET time axis.
- Timeframes: 30s / 1m / 5m / 15m / 1h / 1D, crosshair with O/H/L/C readout.
- **Indicators** menu (lightweight-charts v5): overlays — EMA 9/21, SMA 50/200, **VWAP**,
  **Bollinger Bands**; oscillator sub-panes — **Volume**, **RSI (14)**, **MACD (12,26,9)**.
  Toggleable; EMA 9/21 + VWAP on by default.
- Live last-price line, bid/ask, day change & % with color.

**Ladder (DOM / depth) widget** — the primary Robinhood Legend trading surface
- Sits between the chart and the order form. **Buy column left, Sell column right.**
- **Select a price level → LMT and STP options appear there**; choosing one routes to
  the **order confirmation screen** (or sends immediately if ⚡ auto-send is on) — the
  documented Legend flow, not a one-click fire.
- Working orders show as **+N / −N LMT/STP** tags. **Hard-press and drag** a tag up or
  down to modify it (this **cancels and replaces** the order); click **✕** to cancel.
- Live **bid/ask depth bars** and your **position average** are drawn in-grid.
- **Buy MKT / Sell MKT** buttons place instant market orders.
- Header: quantity stepper + the **⚡ auto-send** toggle. The **$** button toggles the
  y-axis between **Price and P&L**. Footer shows **Open / Day P&L**. Quantity and
  auto-send stay in sync with the order ticket.

**On-chart trading** (matches Robinhood Legend)
- **Buy / Sell** icons (upper-left) load the order form's side.
- **Right-click anywhere on the chart** (or the **“+”** on the right axis) opens an order
  menu at that price: above the market → *Buy stop* / *Sell limit*; below → *Buy limit* /
  *Sell stop*.
- Working orders show draggable **LMT / STP** lines — drag to move (this **cancels and
  replaces** the order; you can't change type by dragging). Click the **✕** to cancel.
- A **position pill** at your average cost shows **quantity + live P&L**; drag it up or
  down to set a take-profit (limit) or stop for the open position.

**Order ticket**
- **Auto-send** toggle — **off by default** (Robinhood's default: orders go to a
  confirmation screen). On = send immediately.
- Order types: **Market, Limit, Stop** (the futures set Robinhood supports).
- **Time-in-force**: Day (GFD) or GTC. Day orders expire when the session rolls.
- Live estimated fill, notional, margin requirement, and fees.

**Account**
- Portfolio value, cash, buying power, open/realized/day P&L, fees paid, margin used.
- Position card with avg cost, mark, open P&L, return %, and one-click close.
- Working-orders list and an activity log of every fill/cancel/system event.

**Data source** (toolbar: Synthetic / Live data)
- **Synthetic** — the generated tape (mean-reverting, volatility clustering).
- **Live data** — **real, ~15-min-delayed** bars for the current day, pulled from
  Yahoo Finance (`MYM=F` / `M2K=F`) and polled every 30s. Fetched server-side
  (Electron main process or the dev server) to avoid browser CORS. Educational use;
  unofficial endpoint; not real-time (real-time CME data carries exchange fees).

**Synthetic feed modes**
- **Live** — an endless, generated tape that advances in real time.
- **Replay** — a full **daily feed** generated deterministically from the chosen date
  (seeded, so the same date always replays the same day). Play / pause / scrub /
  speed (1×–300×). Press **Space** to play/pause.
- **Import CSV** — load real historical bars (`time,open,high,low,close`) to replay
  an actual session.

---

## Accuracy / contract specs

**MYMU26 — Micro E-mini Dow Jones (CME)**
| Spec | Value |
|---|---|
| Point value (multiplier) | **$0.50 / index point** |
| Minimum tick | 1.0 point = **$0.50** |
| Start price (configurable) | 43,500 |

**Costs (Robinhood Futures defaults, all editable in Settings)**
- Commission **$0.75 / contract / side** — **$0.50 / side with Robinhood Gold**.
- CME exchange fee **$0.37 / side** + NFA fee **$0.02 / side**.
- Charged on **every** fill (round-trip = entry + exit).

**Margin**
- Initial **$1,510 / contract**, maintenance **$1,372** (Robinhood's MYM figures; editable).
- Optional auto-liquidation on a margin call.

**Math used**
- P&L: `(exit − entry) × $0.50 × contracts × side`  (side = +1 long / −1 short).
- Fills: market buys at the **ask**, sells at the **bid** (1-tick spread by default).
- `equity = cash + unrealized P&L` · `buying power = equity − margin used`.
- Cash changes only by **realized P&L** and **fees** (futures post margin, not notional).

Keyboard: **B** / **S** set Buy/Sell, **Space** toggles replay play/pause.

---

## Project layout

```
index.html        markup / layout
styles.css        Robinhood dark theme
electron/main.cjs Electron main process (self-contained desktop app)
server.js         zero-dependency static server (browser mode)
vendor/           TradingView Lightweight Charts (vendored, MIT)
js/
  contract.js     MYMU26 spec, fees, margin, formatting
  rng.js          seeded PRNG (reproducible feeds)
  feed.js         synthetic generator, live ticker, replay, CSV import
  engine.js       orders, fills, positions, P&L, costs, margin
  ladder.js       Ladder / DOM widget (click price levels to trade)
  charttrade.js   on-chart order entry (Buy/Sell icons, draggable lines, pill)
  orderticket.js  Robinhood-style floating order ticket
  chart.js        Lightweight Charts wrapper (candles/line, markers, lines)
  ui.js           DOM rendering
  store.js        localStorage persistence
  app.js          wiring / bootstrap
```

Reset the paper account anytime with the **Reset** button (top-right).
Adjust fees, margin, volatility, start price, and Gold status in **Settings (⚙)**.
