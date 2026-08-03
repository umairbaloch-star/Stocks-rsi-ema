# PSX RSI Dashboard

A short-term swing-trading dashboard for the Pakistan Stock Exchange: every
listed equity's **RSI**, computed at a selectable look-back period and chart
interval, matching TradingView's own RSI to within normal vendor-data noise.
Built for a specific strategy — buy a stock when it's oversold, sell within
1–2 weeks — not for long-horizon investing.

It loads the **KSE-100 index stocks first** (tagged with a "100" badge) so
the meaningful ~100 companies appear fast without hammering PSX with all
~750 requests at once; a **"Load more"** button then fetches everything
else on demand. Illiquid stocks (thin daily volume) are hidden from the
list entirely by default — see [Liquidity floor](#liquidity-floor) below.

## What it does, from a trader's point of view

- **RSI period selector** — RSI(14) standard, RSI(5) swing, or RSI(2)
  Connors, each with its own oversold/overbought thresholds (30/70, 20/80,
  10/90). RSI(14) can take *months* to travel 30→70; RSI(5)/RSI(2) round-trip
  in days, which is what actually matches a 1–2 week hold.
- **Chart interval selector** — TradingView-style day-and-up rows (1D/2D/3D,
  1W/2W, 1M/3M/6M/12M). Sub-daily intervals aren't offered because PSX's free
  feed is end-of-day only — there's no intraday history to build them from.
- **Buy-signal screener** — a fixed rule, independent of whatever period/
  interval you're currently viewing: a stock is tagged **BUY** when its
  *daily* RSI(14) ≤ 35 (genuinely beaten down) **and** daily RSI(2) ≤ 10
  (short-term stretched right now). Exit plan: daily RSI(14) recrosses ~50,
  or +5–8% profit, or ~10 sessions pass — whichever comes first.
- **Dynamic per-row insight** — expanding a row shows a live reading of
  *whatever* RSI you're currently viewing (selected period × interval), with
  zone-appropriate advice (dip-entry plan, "approaching oversold", take-profit
  zone, or "no edge here"). This is separate from, and follows, the fixed
  screener rule above.
- **Watchlist** — star any stock; it's saved to this browser's localStorage
  and shown on a dedicated `/watchlist` page. A starred stock never
  disappears from view even if it later becomes illiquid (see below).
- **Live refresh** — the Refresh button re-fetches current prices for every
  loaded stock and recomputes RSI, without re-crawling all ~750 stocks'
  history (see [Data freshness](#data-freshness)).
- **Market-breadth summary** — Tracked / Buy signals / Oversold / Overbought
  / Neutral tiles plus a distribution bar, all computed from the
  currently-selected period/interval.
- **Confidence score** — a weighted 0–100 "Score" column next to RSI,
  combining four inputs on *daily* candles (same fixed-daily rule as the
  buy-signal screener, independent of the viewed period/interval):
  **RSI depth (35%)** — how far into oversold RSI(14)/RSI(2) currently are;
  **trend (25%)** — price vs. its 50-day SMA, so a dip is only scored well
  if it's in an uptrend or reclaiming one, not a falling knife;
  **volume (20%)** — today's volume vs. its 20-day average, confirming real
  buying interest behind the bounce; **MACD momentum (20%)** — whether the
  MACD(12,26,9) histogram is positive and rising. Expanding a row shows the
  full breakdown. This is a confirmation layer *alongside* the RSI screener,
  never a replacement for its fixed rule — see `lib/indicators.js`.

## Liquidity floor

A stock trading a handful of shares a day can show a compelling RSI dip for
no reason other than nobody trading it — that's a trap, not a signal, for a
strategy that needs to exit within 1–2 weeks (wide spreads, no counterparty
to sell to). So:

- Any non-KSE-100 stock trading under **`PSX_MIN_VOLUME`** shares that day
  (default **100,000** — see [Environment variables](#environment-variables))
  is excluded from the dashboard entirely, and — since volume is already
  known from the single market-watch page fetched before any per-symbol
  history request — its history is never even fetched, saving the request.
- **KSE-100 stocks are always shown**, regardless of volume — the floor only
  filters the remaining ~650 equities.
- **Watchlisted stocks are always shown**, regardless of volume — starring a
  stock exempts it, so a position you're tracking can't silently vanish if
  it goes quiet for a session. The exemption list is sent by the client on
  every request (`?watch=SYM1,SYM2,...`) since the watchlist only lives in
  browser localStorage and the server has no other way to know about it.
- Volume is tracked as a deliberate **tri-state**, not a plain number:
  `null` = a market-watch row confirmed zero trades today (excluded);
  `undefined` = no market-watch data at all for that symbol, e.g. a
  market-watch outage (left alone — unknown liquidity is never treated as
  low liquidity, so an outage can't silently empty the dashboard).

## Data freshness

Two different refresh mechanisms, deliberately separate:

1. **Historical bars** (used for RSI's look-back window) only change once
   per trading day, and re-crawling all ~750 stocks' history is slow and
   risks PSX's rate limiter. This runs on a **15-minute TTL**
   (`lib/cache.js`), automatically, in the background.
2. **Live prices** — the only thing that actually changes intraday — come
   from a *single* market-watch page request. Pressing **Refresh**
   (`?refresh=1` on `/api/stocks`) re-fetches just that page, swaps each
   loaded stock's latest close for its live price, and recomputes the whole
   RSI grid from cached history (pure CPU, near-instant). A 10-second floor
   prevents rapid clicking from hammering PSX.

`updatedAt` in the API response is the freshest of the two.

## Data source

PSX's free, unofficial public JSON feed at `dps.psx.com.pk` (the same
endpoints that power PSX's own market-watch page). There is no official free
PSX API; this is undocumented and could change or rate-limit without notice
— all fetching logic lives in `lib/psx.js` to make it easy to swap later.

- `GET /symbols` — full list of listed instruments (debt instruments
  filtered out).
- `GET /market-watch` (HTML, parsed) — live current price, today's volume,
  and KSE-100 membership for every symbol, in one request.
- `GET /timeseries/eod/{symbol}` — daily EOD history per symbol. Rows with
  `close <= 0` or non-finite values are dropped (feed glitches — see
  `docs/PROGRESS.md` for the PKGS incident this fixed).

**PSX blocks some cloud IP ranges outright** (see
[Deploying on Render](#deploying-on-render-free-tier)) — including, as of
this writing, this development sandbox's IP, which 503s on `/symbols` under
sustained load. That's an infrastructure fact, not a bug in this code.

## Architecture

- **`lib/psx.js`** — raw PSX fetches with retry/backoff for transient
  503s/connection resets. `fetchSymbols()`, `fetchMarketWatch()` (parses
  the market-watch page into `symbol → { current, volume, isKse100 }`),
  `fetchEodSeries()` (sanitizes bad rows).
- **`lib/rsi.js`** — pure calculation, no I/O:
  - `calculateRSISeries(closes, period)` — Wilder's RSI.
  - `adjustForCorporateActions(series)` — back-adjusts for splits/bonuses.
    Only scales on a single-day **drop** beyond -20% (dilution always drops
    the price); a big single-day *rise*, however large, is left alone as
    real trading — see `docs/PROGRESS.md` for the MDTL bug this fixed.
  - `resampleSeries(series, {unit, n})` — buckets daily closes into
    day/week/month candles of any run length, for `RSI_INTERVALS`.
  - `RSI_PERIODS` — the 3 selectable look-back periods with their
    thresholds/exit levels/hold times (see table below).
  - `RSI_INTERVALS` — the 9 selectable chart intervals.
  - `BUY_SIGNAL` — the fixed screener thresholds (`rsi14Max: 35`,
    `rsi2Max: 10`).
- **`lib/indicators.js`** — pure calculation, no I/O, for the confidence
  score: `calculateSMA`/`calculateEMA`, `calculateMACD` (12,26,9),
  `calculateCloseATR` (a close-to-close volatility **proxy**, not true ATR —
  PSX's EOD feed has no high/low), and `computeCompositeScore()` — the
  weighted 0–100 score plus its per-input breakdown. `SCORE_WEIGHTS` names
  the four weights so the UI renders the same numbers it scored with.
- **`lib/cache.js`** — server-side in-memory state (needs a long-lived
  server, not per-request serverless — see deployment below):
  - Two-phase fetch: **core** (KSE-100) eagerly, **rest** on "Load more".
  - Per stock, computes the full **period × interval RSI grid** (3×9 = 27
    values) up front, so the frontend's dropdowns switch instantly with no
    refetch. Chart history is NOT included in this payload — see
    `getRsiHistory()` / `/api/history` below.
  - `refreshLivePrices()` — the live-refresh path described above.
  - `getRsiHistory(symbol, intervalKey, period)` — computes one stock's RSI
    trend series on demand from the cached daily series, for the expanded
    chart. Kept out of the main payload to keep it small.
  - The liquidity floor and its KSE-100/watchlist exemptions (see above).
  - Tunable via env vars — see below.
- **`app/api/stocks/route.js`** — serves the cached data; `?scope=all`
  triggers the "rest" phase, `?refresh=1` triggers a live-price refresh,
  `?watch=SYM1,SYM2` registers the current watchlist for exemption.
- **`app/api/history/route.js`** — `?symbol=&interval=&period=` → one
  stock's RSI trend series for the expanded chart.
- **`app/hooks.js`** — `useStocks(watchSymbols)` (polling: 2s while filling,
  5min idle; sends the watchlist on every request) and `useWatchlist()`
  (localStorage, synced across tabs via the `storage` event).
- **`app/page.js`** (dashboard) / **`app/watchlist/page.js`** — both render
  the shared `StocksView` component against their own stock slice.
- **`app/components/StocksView.js`** — search, period/interval dropdowns,
  quick filters (All/Buy signals/Oversold/Overbought/KSE-100), pagination.
- **`app/components/StocksTable.js`** — the table/cards, RSI meter cells,
  BUY tags, the dynamic per-row insight, star buttons.
- **`app/components/RSIChart.js`** — Recharts trend chart, fetched on
  demand per symbol+period+interval from `/api/history`.
- **`app/components/MarketSummary.js`** / **`TopBar.js`** — summary tiles
  + breadth bar; sticky nav with the Stocks/Watchlist tabs and Refresh.
- **`app/globals.css`** — the design-token system (light/dark surfaces, ink
  hierarchy, one accent hue, reserved status colors) everything else
  references by role, never raw hex.

### RSI periods & thresholds

| Period | Oversold | Overbought | Exit (recross) | Time-stop |
|---|---|---|---|---|
| RSI(14) standard | ≤ 30 | ≥ 70 | ~50 | ~10 candles |
| RSI(5) swing | ≤ 20 | ≥ 80 | ~60 | ~10 candles |
| RSI(2) Connors | ≤ 10 | ≥ 90 | ~65 | ~5 candles |

### Chart intervals

`1D · 2D · 3D · 1W · 2W · 1M · 3M · 6M · 12M` — no sub-daily options; PSX's
free feed has no intraday history to build them from.

## Environment variables

None are required — sensible defaults are baked in.

| Variable | Default | Purpose |
|---|---|---|
| `PSX_FETCH_CONCURRENCY` | `16` | Parallel history requests during a fetch pass. Lower to `4` (or less) on a foreign cloud IP PSX rate-limits. |
| `PSX_RETRY_CONCURRENCY` | `8` | Parallel requests during the retry pass. |
| `PSX_RETRY_DELAY_MS` | `5000` | Cool-down before retrying failed symbols. |
| `PSX_MIN_VOLUME` | `100000` | Liquidity floor, shares/day. See [Liquidity floor](#liquidity-floor). |

**Setting one requires a full server restart** — `lib/cache.js` reads these
via `process.env` in top-level `const`s evaluated once at process boot, and
`.env.local` is only picked up on startup, not hot-reloaded. It must also
live in the project root (next to `package.json`), not a subdirectory.

## Getting started

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

## Deploying on Render (free tier)

This app keeps its cache in the server process's memory, so it needs a
long-lived server — **not** a per-request serverless function (that's why
Vercel/Netlify don't fit without an external store). Render's Web Services
are a persistent container, which is exactly right.

**Pick the region carefully — this is the one thing that trips people up.**
PSX's feed (`dps.psx.com.pk`) is in Pakistan, so Singapore looks like the
obvious closest choice — but PSX **blocks Render's Singapore IP range**
outright (connections reset with `UND_ERR_SOCKET` and the app hangs forever
on "Fetching PSX symbol list…"). **Use Frankfurt** — it's the closest region
to Pakistan that PSX does *not* block. If Frankfurt ever starts getting
blocked too, a US region (Oregon/Ohio/Virginia) is the next thing to try.
Do **not** use Singapore.

Manual setup:

1. In the Render dashboard: **New +** → **Web Service**.
2. Connect this GitHub repo and pick the **`main`** branch.
3. **Region**: **Frankfurt (EU Central)** — see the warning above.
4. **Environment**: Node.
5. **Build Command**: `npm install && npm run build`
6. **Start Command**: `npm run start`
7. **Instance Type**: **Free**.
8. Environment variables are optional — see the table above.
9. Click **Create Web Service**.

A `render.yaml` (free plan, Frankfurt region) is also included if you'd
rather use Render's **Blueprint** flow instead of filling in the form by
hand.

**Free-tier note:** Render's free web services spin down after ~15 minutes
of inactivity. The next visit cold-starts the service, wiping the in-memory
cache and re-triggering the "loading stocks in the background" fill. The
first page or two of stocks still appear within ~10–15s while the rest
loads behind the progress bar.

**Diagnosing feed issues:** if the app hangs on "Fetching PSX symbol
list…", check the Render **Logs** tab for `[psx]`/`[cache]` lines.
`UND_ERR_SOCKET` / `other side closed` / repeated `503` means PSX is
blocking that region's IP (change region); other errors point at a genuine
transient feed problem.

## Project history & known gotchas

See **`docs/PROGRESS.md`** for a chronological log of every feature and bug
fix, including several non-obvious data-correctness issues (corporate-action
false positives, a single bad data row poisoning RSI for an entire stock,
tri-state volume tracking) worth reading before touching `lib/rsi.js` or
`lib/cache.js` — each one was found by comparing live output against
TradingView, not by inspection, and the fix's reasoning isn't obvious from
the code alone.
