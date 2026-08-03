const RSI_PERIOD = 14;

/**
 * Computes Wilder's RSI(14) for a series of closing prices.
 * Returns an array the same length as `closes`, where entries before
 * enough history has accumulated are `null`.
 */
export function calculateRSISeries(closes, period = RSI_PERIOD) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change > 0) gainSum += change;
    else lossSum += -change;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  rsi[period] = toRSI(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = toRSI(avgGain, avgLoss);
  }

  return rsi;
}

function toRSI(avgGain, avgLoss) {
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Returns the most recent non-null RSI value in a series, rounded, or null. */
export function lastRSIValue(rsiSeries) {
  for (let i = rsiSeries.length - 1; i >= 0; i--) {
    const v = rsiSeries[i];
    if (v !== null && v !== undefined) return Number(v.toFixed(2));
  }
  return null;
}

/**
 * Resamples a daily price series (ascending by date, `[{ date, close }]`)
 * into candles of the given interval, keeping the last trading day's close
 * and date of each bucket — matching how TradingView builds day-and-up
 * candles. The current (still-forming) bucket is included with its latest
 * close, just like TradingView's live candle.
 *
 * Bucketing per unit:
 *  - day:   runs of `n` consecutive trading days (1D returns the series as-is)
 *  - week:  Monday-aligned calendar weeks, grouped `n` at a time
 *  - month: calendar months, grouped `n` at a time
 */
export function resampleSeries(series, { unit, n }) {
  if (unit === "day" && n === 1) return series;
  const buckets = new Map(); // bucket key -> last {date, close} seen (ascending)
  series.forEach((p, idx) => {
    let key;
    if (unit === "day") {
      key = Math.floor(idx / n);
    } else if (unit === "week") {
      const d = new Date(p.date);
      const days = Math.floor(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000
      );
      // Epoch day 0 was a Thursday; +3 shifts so weeks start on Monday.
      key = Math.floor(Math.floor((days + 3) / 7) / n);
    } else {
      const d = new Date(p.date);
      key = Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / n);
    }
    buckets.set(key, p);
  });
  return [...buckets.values()];
}

/**
 * Back-adjusts a daily series (ascending `[{ date, close }]`) for stock splits
 * and bonus issues. A bonus/split/rights issue dilutes the share count, so it
 * always shows up as a sudden DROP in the quoted price (e.g. a 1:1 bonus
 * halves it overnight) — never a jump up. So only single-day drops beyond
 * -20% are treated as a corporate action; all prices before such a day are
 * scaled by the gap ratio so the series is continuous, the same split/bonus-
 * adjusted prices TradingView shows. Without this, the artificial drop
 * poisons Wilder's RSI for weeks.
 *
 * A single-day RISE beyond +25%, however common on illiquid PSX penny
 * stocks (a circuit-limit pileup released in one session), is real trading,
 * never a corporate action — rescaling history for one would erase the very
 * rally that should be pushing RSI up (this was a real bug: MDTL's genuine
 * +27% day was misread as a split and its RSI(5) came out near 7 instead of
 * TradingView's ~51). Series with no detected drop are returned unchanged.
 */
export function adjustForCorporateActions(series) {
  const n = series.length;
  if (n < 2) return series;

  const factors = new Array(n).fill(1);
  let factor = 1;
  for (let i = n - 1; i >= 1; i--) {
    const ratio = series[i].close / series[i - 1].close;
    // Number.isFinite also rejects a zero/invalid close producing Infinity
    // or NaN here — such a ratio is a data glitch, not a real corporate
    // action, and must never be allowed to poison the scaling factor for
    // every earlier price in the series.
    if (Number.isFinite(ratio) && ratio > 0 && ratio < 0.8) {
      factor *= ratio;
    }
    factors[i - 1] = factor;
  }

  if (factor === 1) return series; // no corporate action detected
  return series.map((p, i) => ({ ...p, close: p.close * factors[i] }));
}

/**
 * The selectable RSI look-back periods. Shorter periods complete their
 * oversold→overbought cycle much faster — RSI(14) can take months to travel
 * 30→70, while RSI(5)/RSI(2) round-trip in days, matching a
 * buy-dip-sell-within-two-weeks swing window. The conventional signal
 * thresholds widen as the period shrinks because a short RSI swings harder.
 */
export const RSI_PERIODS = [
  // `exit` is the recross level where a dip-buy at that period takes profit
  // (waiting for the full overbought line means waiting out a whole new
  // uptrend), and `holdCandles` the time-stop in candles of the viewed
  // interval.
  { period: 14, label: "RSI(14) · standard", oversold: 30, overbought: 70, exit: 50, holdCandles: 10 },
  { period: 5, label: "RSI(5) · swing", oversold: 20, overbought: 80, exit: 60, holdCandles: 10 },
  { period: 2, label: "RSI(2) · Connors", oversold: 10, overbought: 90, exit: 65, holdCandles: 5 },
];

/**
 * The swing-entry signal computed on DAILY candles regardless of the view:
 * RSI(14) ≤ 35 says the stock is genuinely beaten down, RSI(2) ≤ 10 says the
 * short-term rubber band is stretched *right now* — together they time a
 * bounce entry for a roughly 3–10 session hold. The matching exit plan
 * (shown wherever a signal is flagged): sell when daily RSI(14) crosses back
 * above ~50, or at a +5–8% target, or after ~10 sessions, whichever first.
 */
export const BUY_SIGNAL = { rsi14Max: 35, rsi2Max: 10 };

/**
 * A backtested confirmation layer for BUY_SIGNAL, NOT part of the fixed
 * screener rule itself — see docs/PROGRESS.md items 13-17. ATR(14) as a %
 * of price (see `calculateCloseATR` in `lib/indicators.js`), at or above
 * this threshold, separated a 71-81% historical win-rate bucket from a
 * ~52% baseline across two independent real-data samples (n=1,079 and
 * n=2,701 BUY_SIGNAL trades, `scripts/backtest-features.mjs`) — a quiet,
 * low-volatility "oversold" reading is more often a stock that just isn't
 * trading much (echoing this app's liquidity floor) than a real dip worth
 * buying. Unlike the earlier "confidence score" (removed — items 13-15),
 * this one number was actually confirmed against real outcomes before
 * shipping, including a check that it isn't just riding on a redundant
 * correlated feature (item 17's quadrant analysis).
 */
export const VOL_CONFIRM = { atrPctMin: 2 };

/**
 * The selectable chart intervals — TradingView's day-and-up rows, grouped
 * the same way its interval menu is. Sub-daily intervals (minutes/hours)
 * are impossible here: PSX's free feed is end-of-day only, so there is no
 * intraday history to build such candles from. RSI(14) at each interval is
 * computed on candles resampled per `unit`/`n` above.
 */
export const RSI_INTERVALS = [
  { key: "1D", label: "1 day", group: "Days", unit: "day", n: 1 },
  { key: "2D", label: "2 days", group: "Days", unit: "day", n: 2 },
  { key: "3D", label: "3 days", group: "Days", unit: "day", n: 3 },
  { key: "1W", label: "1 week", group: "Weeks", unit: "week", n: 1 },
  { key: "2W", label: "2 weeks", group: "Weeks", unit: "week", n: 2 },
  { key: "1M", label: "1 month", group: "Months", unit: "month", n: 1 },
  { key: "3M", label: "3 months", group: "Months", unit: "month", n: 3 },
  { key: "6M", label: "6 months", group: "Months", unit: "month", n: 6 },
  { key: "12M", label: "12 months", group: "Months", unit: "month", n: 12 },
];
