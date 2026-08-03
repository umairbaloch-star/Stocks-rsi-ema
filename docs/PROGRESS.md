# Project progress & decisions log

Context for a new agent session (or a human) picking this project up cold.
Read this before re-deriving anything below from scratch — several of these
were found by comparing live output against TradingView, not by code
inspection, and the fix isn't obvious without the story behind it.

For what the app currently does and how it's built, see `README.md` — this
file is the *history and reasoning*, not the current-state reference.

## The product

A PSX (Pakistan Stock Exchange) dashboard for one specific trading style:
**buy a stock when it's oversold, sell within 1–2 weeks.** Every feature
decision traces back to that — e.g. RSI(5)/RSI(2) exist because RSI(14) can
take months to round-trip 30→70, which doesn't match a 1–2 week hold.

## Chronological build log

1. **Core dashboard.** RSI(14) on daily/weekly/monthly candles for every PSX
   equity, matching TradingView. Two-phase fetch (KSE-100 first, "Load more"
   for the rest) to avoid hammering PSX with ~750 requests up front.

2. **Deployment: Vercel → Render, Singapore → Frankfurt.** Vercel's
   serverless model doesn't fit (in-memory cache needs a long-lived
   process). Render works, but **PSX blocks Render's Singapore IP range**
   outright — Frankfurt is the closest region PSX doesn't block. This cost a
   full round of debugging; don't re-try Singapore.

3. **Live price override.** The EOD feed's latest "close" lags during a live
   session. Fixed by overriding the last bar's close with the market-watch
   page's live CURRENT price before computing RSI — this is what makes daily
   RSI match TradingView's live value instead of yesterday's.

4. **Corporate-action back-adjustment (MTL bug).** MTL had a 1:1 bonus that
   halved its price overnight; unadjusted, that reads as an artificial -50%
   crash and poisons RSI for weeks. Fixed with `adjustForCorporateActions()`
   — detects a large single-day gap and scales all earlier prices by the
   ratio, same as TradingView's split/bonus-adjusted prices.

5. **PKGS bug: one bad data row poisoning an entire stock's RSI.** PKGS had
   a single `close: 0` row from a feed glitch. Wilder's RSI smooths
   recursively over the *entire* history, so one bad point corrupts every
   value computed afterward into `NaN`; worse, `adjustForCorporateActions`
   dividing by that zero produced `Infinity`, which then scaled every
   earlier price to `Infinity` too. Two-layer fix: `fetchEodSeries()` now
   filters out `close <= 0`/non-finite rows before they enter the pipeline,
   and `adjustForCorporateActions()` added an explicit `Number.isFinite`
   guard so a bad value can never poison the scaling factor even if one
   sneaks through some other way. **Lesson: always sanity-check RSI inputs,
   never trust a "clean" JSON feed.**

6. **Full UI redesign.** Ad-hoc Tailwind zinc/blue styling replaced with a
   proper design-token system (`app/globals.css`): warm-neutral surfaces, a
   three-step ink hierarchy, one accent hue, reserved status colors
   (green=oversold/bullish, red=overbought/bearish). RSI cells became an
   ink-colored figure over a micro-meter (0–100 track, threshold ticks, fill
   position + color both carry the signal — so it survives colorblindness).
   Market summary became one card with a breadth distribution bar.

7. **RSI period selector added, later made essential.** User's actual
   strategy is a 1–2 week swing hold; RSI(14) alone doesn't suit that (too
   slow). Added RSI(14)/RSI(9)/RSI(5)/RSI(2), later trimmed to just
   **RSI(14)/RSI(5)/RSI(2)**, each with period-appropriate thresholds
   (30/70, 20/80, 10/90) — see the table in README.md.

8. **Watchlist + TradingView-style interval selector.** Star a stock →
   localStorage-backed watchlist with its own `/watchlist` page (no
   accounts, so this is inherently per-browser). The three fixed
   Daily/Weekly/Monthly RSI columns were replaced by **one RSI(14) column
   driven by a chart-interval dropdown** (1D/2D/3D, 1W/2W, 1M/3M/6M/12M) —
   matching TradingView's own interval menu, capped at "1 day" since PSX's
   free feed has no intraday history for anything shorter. This also
   shrank the main payload: chart history moved out of `/api/stocks`
   into an on-demand `/api/history?symbol=&interval=&period=` endpoint.

9. **Period selector restored alongside the interval selector, plus a buy-
   signal screener.** The user's real ask ("RSI takes 3 months to go 30→70,
   I want to trade weekly") led to: (a) both dropdowns coexisting (period =
   *which* RSI, interval = *what candles*), and (b) a **fixed swing-entry
   rule**, independent of either dropdown: daily RSI(14) ≤ 35 **and** daily
   RSI(2) ≤ 10 → **BUY** tag. Exit plan (also fixed): daily RSI(14) recrosses
   ~50, or +5–8%, or ~10 sessions — whichever first. **Important:** this
   rule is deliberately NOT tied to the period/interval dropdowns — a user
   report ("I selected RSI(5) but the exit note says RSI(14)") turned out to
   be a **copy bug, not a logic bug**: the fixed rule was correct, the
   wording just didn't explain itself. Fixed by making the exit note say
   explicitly that it's a fixed rule, and by adding a *second*, genuinely
   dynamic insight line that reads whatever period/interval is currently
   selected and gives zone-appropriate advice for that live reading.
   **Lesson: when a fixed rule and a dynamic view coexist in the same UI,
   both need to say which one they are — a correct fixed rule reads as a
   bug next to an unlabeled dynamic control.**

10. **MDTL bug: corporate-action detector misreading real rallies as
    splits.** MDTL's RSI(5) came out as 7.0 vs TradingView's ~51 — not
    vendor noise, a real bug. MDTL (a thin PSX penny stock) had a genuine
    +27% single-day rally (a circuit-limit pileup releasing in one
    session). The corporate-action detector was **symmetric** — it treated
    any single-day move beyond ±25% as a split/bonus and rescaled history —
    so it "corrected away" a real rally, turning what should have been a
    strong RSI reading into a near-zero one. **The fix, and the insight
    behind it: a bonus/split/rights issue always DILUTES the share count,
    so it can only ever show up as a price DROP, never a rise.** The
    detector now only fires on single-day drops beyond -20%; upward moves,
    however large, are left alone as real trading. Verified against MDTL's
    live PSX data before shipping (RSI(5): 7.0 → 49.14, TradingView 51.27).
    **This was a real regression risk for every thin/volatile PSX stock,
    not just MDTL** — any stock with a genuine sharp rally was previously
    having that rally erased from its RSI(5)/RSI(2) history.

11. **Live refresh, decoupled from the history crawl.** User wanted "fresh
    data on every Refresh click" without re-triggering PSX's rate limiter.
    Insight: PSX's *historical* bars only change once a day; the *only*
    thing that changes intraday is price, which market-watch already
    serves in one request. So Refresh now re-fetches just that one page,
    swaps each stock's last close, and recomputes the RSI grid from cached
    history — pure CPU, near-instant, no extra PSX load. The 15-minute
    history-crawl TTL is untouched and separate.

12. **Liquidity floor.** A user question ("what min volume makes a good
    stock?") turned into a feature: stocks trading under `PSX_MIN_VOLUME`
    shares/day (default 100,000) are excluded — and since volume is known
    from market-watch *before* the per-symbol history fetch, thin stocks
    never get that fetch at all (saves the request, not just hides the
    result). Two follow-up bugs found and fixed in the same session:
    - **Tri-state volume, not boolean.** A market-watch row that's *present*
      with a blank volume cell (confirmed zero trades) must be excluded, but
      a symbol *missing from the table entirely* needs to be split into two
      further cases: missing because the market-watch fetch **succeeded but
      that symbol just isn't in it** (excluded — it's not trading today,
      same conclusion as a blank cell) vs. missing because the **whole
      market-watch fetch failed** (an outage — left alone, `undefined`,
      since unknown liquidity must never be treated as low liquidity, or a
      transient network blip would empty the entire dashboard). Two rounds
      of user bug reports ("some stocks still show volume `-`") were needed
      to find both halves of this distinction — see `lib/cache.js`'s
      `loadPartition()` for the exact tri-state logic and comments.
    - **KSE-100 and watchlist exemptions.** The floor should only ever apply
      to the "rest" of the market, not the KSE-100 constituents, and a
      stock the user has already starred should never disappear mid-hold
      just because its volume thinned out. Since the watchlist only lives
      in browser localStorage, the client now sends it on every
      `/api/stocks` request (`?watch=SYM1,SYM2`) so the server-side filter
      can exempt exactly those symbols.

13. **Composite confidence score (RSI + trend + volume + MACD, weighted).**
    User asked for "more reliable" indicators layered onto the RSI screener.
    Added `lib/indicators.js` — SMA/EMA, MACD(12,26,9), and a weighted 0–100
    score (RSI 35% / 50-day SMA trend 25% / volume-vs-20-day-average 20% /
    MACD histogram momentum 20%), shown as a new "Score" column next to RSI.
    Two things worth knowing before touching this:
    - **It's an additive confirmation layer, not a replacement for
      `BUY_SIGNAL`.** Per item 9/the fixed-screener gotcha below, the
      existing daily RSI(14)≤35 & RSI(2)≤10 rule stays untouched and
      independent of the viewed period/interval; the score is a *second*,
      separate field (`score`/`scoreBreakdown` on each stock record),
      always computed on daily candles for the same reason.
    - **No true ATR is possible.** PSX's EOD feed is `[timestamp, open,
      volume, close]` — no high/low — so `calculateCloseATR` is a
      close-to-close volatility proxy, not textbook ATR. It's exposed as
      `atr14` on each record but not yet wired into the score; don't present
      it as a real ATR-based stop distance without accounting for that gap.
    - Volume history had to be added to `fetchEodSeries` (previously
      returned only `{ date, close }`) so the 20-day average volume behind
      the score's volume term didn't need a second network round-trip.

14. **Score's trend input recalibrated: 50-day SMA → 200-day SMA, based on a
    real backtest, not theory.** User ran `scripts/backtest-score.mjs`
    (added alongside item 13) against 40 KSE-100 stocks' real EOD history
    from their own machine (this sandbox's IP is blocked by PSX, see
    gotchas below). Results on the item-13 version:
    - **Every one of 1,399 simulated `BUY_SIGNAL` trades scored under
      50/100** — none reached the "moderate" or "strong" buckets at all.
    - **On the larger sample (n=1,399), the score's ranking was inverted**:
      the 0–29 "weak" bucket had a *higher* win rate (60.0% vs 54.0%) and
      *better* avg return (1.10% vs 0.51%) than the 30–49 "low" bucket — the
      opposite of what a working score should show. (A 3-symbol spot-check,
      n=101, showed the right direction, but its 30–49 bucket was only 23
      trades — not enough to outweigh the 1,399-trade result.)
    - **Root cause**: `BUY_SIGNAL` requires RSI(2) ≤ 10 — a stock that
      oversold is almost never *also* trading above its 50-day average, since
      the recent decline that produced the RSI reading is exactly what pulls
      price below a short average. The 50-day trend test was penalizing the
      normal shape of the very setup the screener buys, not filtering out
      bad setups.
    - **Fix**: swapped the trend input to the 200-day SMA with a wider ±15%
      partial-credit band. This asks a coarser question — "genuine
      multi-month structural decline, or a dip inside a longer uptrend?" —
      instead of penalizing every short-term dip by construction. See item
      15 for what the re-run of this fix actually showed.

15. **Confidence score removed entirely — the 200-day SMA fix (item 14)
    still showed no predictive value, and reweighting wouldn't have fixed
    it.** User re-ran `scripts/backtest-score.mjs` after the item-14 fix
    (40 KSE-100 stocks, n=1,187 trades):
    - The outright inversion from item 14 was gone, but the relationship
      was still flat-to-declining: weak 61.8% win-rate/1.16% avg-return, low
      60.6%/1.25%, **moderate 55.3%/0.58% — the worst of the three** — and
      still **zero trades ever reached the 70–100 "strong" bucket**.
    - Rather than guess at a third reweighting, added Pearson correlation
      reporting (each component vs. the trade's actual forward return).
      Result: **all four inputs sat at |r| < 0.03** (rsi −0.024, trend
      −0.014, volume −0.003, macd +0.018) on n=1,187 — statistically
      indistinguishable from noise. You cannot build a predictive composite
      out of four independently-uncorrelated inputs by reweighting them;
      that would just rearrange noise.
    - One caveat worth remembering if this is ever revisited: the
      correlation is measured *only among trades that already passed
      `BUY_SIGNAL`* (RSI(14) ≤ 35 & RSI(2) ≤ 10), which restricts the range
      of the RSI component especially (everything in the sample is already
      deeply oversold). That's a real reason RSI's r looks weaker than it
      might unconditionally — but it doesn't change the practical
      conclusion, since the score's whole job was to discriminate *among*
      stocks that already triggered the screener, and it couldn't.
    - **Decision (user's call, not a unilateral revert): removed the Score
      column, `computeCompositeScore`/`SCORE_WEIGHTS` from
      `lib/indicators.js`, and the score fields from `lib/cache.js`
      records** — rather than ship something that looks authoritative but
      isn't backed by the data. `lib/indicators.js` still exports the
      generic SMA/EMA/MACD/ATR-proxy building blocks (unused by the live
      app now, but kept for backtest research). `fetchEodSeries` in
      `lib/psx.js` still returns `volume` — harmless, and still needed by
      the research tool below.
    - Renamed `scripts/backtest-score.mjs` → `scripts/backtest-features.mjs`
      and repurposed it: instead of scoring a fixed hand-picked composite,
      it now computes several candidate features (oversold depth, decline
      from a 20-day high, distance from a 252-day low, ATR-as-%-of-price,
      down-streak length, persistent-oversold-days, days-since-last-signal)
      at each historical `BUY_SIGNAL` entry and reports each one's
      correlation with the actual outcome individually, plus a fixed-horizon
      return table in case the exit plan itself (not any input) is the part
      worth revisiting. **None of these candidates have been run against
      real data yet** — that's the next step before anything new ships.

16. **First real backtest run of `scripts/backtest-features.mjs`: two
    features clear the bar, five don't.** User ran it against 40 KSE-100
    stocks (n=1,079 trades): `atrPct` (ATR(14) as a % of price) came back at
    r=0.201 and `declineFrom20dHighPct` at r=0.124 — both meaningfully above
    the noise floor. The other five (RSI depth ×2, distance from a 252-day
    low, down-streak days, persistent-oversold-days, days-since-last-signal)
    all sat at |r| < 0.06 — noise. Tercile-bucket breakdown for both
    promising features showed their averages weren't outlier-driven (median
    return was *higher* than the average in the top bucket for both,
    meaning a broad majority of trades did well, not a couple of huge
    winners skewing a mean) — `atrPct`'s top tercile: 70.6% win-rate,
    +2.97% avg, +5.57% median vs. ~52-56%/~0% for the rest.

17. **Confirmed on a second, larger, non-overlapping sample; quadrant
    analysis showed `declineFrom20dHighPct` is redundant, `atrPct` isn't.**
    Re-ran against 100 KSE-100 stocks (n=2,701 trades — 60 different names
    than item 16's run): `atrPct`'s numbers barely moved (r=0.205, top
    tercile 71.0% win-rate/+3.13% avg/+5.72% median) — the signature of a
    real effect, not a sample-specific fluke. `declineFrom20dHighPct` also
    improved to a clean monotonic bucket step-up (was non-monotonic on the
    smaller sample — that was noise). Added a 4-quadrant breakdown (each
    feature in its own top tercile or not) to check whether combining them
    beats either alone: **"atrPct only" (high ATR, NOT also a big 20-day
    decline) was the single best group of all** — 80.9% win-rate, +4.27%
    avg — beating "both high" (68.2%/2.80%). Conclusion: `declineFrom20dHighPct`
    was mostly riding on its overlap with `atrPct` (volatile stocks tend to
    have fallen further too); once isolated, it adds nothing and can
    slightly dilute `atrPct`'s signal. **Only `atrPct` is worth building on.**
    - **Shipped**: `VOL_CONFIRM = { atrPctMin: 2 }` in `lib/rsi.js`,
      `atrPct`/`volConfirmed` computed in `lib/cache.js`'s `computeRsiFields`
      (daily candles only, same as `BUY_SIGNAL` — never resampled to the
      viewed period/interval), and a "VOL" tag shown only alongside an
      active BUY tag in `StocksTable.js` (never on its own — it's a
      confirmation of `BUY_SIGNAL`, not an independent signal), plus a
      "Vol-confirmed" quick filter and a market-summary tile.
    - Unlike the item 13-15 confidence score, this one was verified against
      real outcomes on two independent samples, checked for outlier-driven
      skew (median vs. average), and checked for redundancy (quadrant
      analysis) before shipping — the discipline the first attempt skipped.
    - **Caveat carried forward, not yet closed**: every backtest so far used
      only KSE-100 constituents (large, liquid names). The live screener
      also flags non-KSE-100 stocks (subject to the liquidity floor). If
      this is revisited, testing `atrPct` against the non-KSE-100 universe
      (`--symbols` with a manually assembled list, or once
      `backtest-features.mjs` grows a way to target the "rest" partition)
      would close that gap.

## Standing gotchas (still true — don't rediscover these)

- **This dev sandbox's IP is rate-limited/blocked by PSX** (`503` on
  `/symbols` under sustained load). This is normal and expected — verify
  logic offline (small Node scripts against saved/curl'd fixture data, or
  Playwright screenshots against a mocked `/api/stocks` route) rather than
  hammering the live endpoint from here. The user's own machine and the
  Frankfurt Render deployment are not affected by this.
- **Env var changes require a full process restart** — `lib/cache.js`
  reads `process.env.*` in top-level `const`s evaluated once at boot.
  `.env.local` must be in the project root and is never hot-reloaded.
- **Never trust the PSX feed's numbers at face value** in `lib/rsi.js` /
  `lib/cache.js` — three separate real bugs (items 5, 9, 10 above) came
  from taking a "clean-looking" data point at face value. Any new
  price-derived logic should ask "what if this row is a glitch / a real
  bonus / a real rally?" before shipping.
- **The buy-signal rule (item 9) is intentionally fixed**, not
  parameterized by the period/interval dropdowns. Don't "simplify" it to
  follow the selected period — that was tried implicitly and confused the
  user; the dynamic per-row insight line exists specifically to cover the
  "what does my current view say" need instead.
