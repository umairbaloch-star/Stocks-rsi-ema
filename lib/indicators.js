/**
 * General-purpose daily-candle indicator building blocks (SMA/EMA/MACD, and
 * a close-to-close volatility proxy) — not tied to any specific strategy.
 * Used by `scripts/backtest-*.mjs` to test candidate signals against real
 * PSX history before anything is wired into the live app.
 *
 * PSX's free EOD feed is `[timestamp, open, volume, close]` — no high/low
 * (see `fetchEodSeries` in `lib/psx.js`) — so a textbook true-range ATR
 * isn't possible. `calculateCloseATR` substitutes the average absolute
 * close-to-close move, which is a documented proxy, not real ATR.
 *
 * History: this file used to also export a weighted "confidence score"
 * (RSI + 50-day-then-200-day SMA trend + volume + MACD) surfaced as a Score
 * column in the UI. A real backtest (`docs/PROGRESS.md` items 13-15) found
 * all four components had near-zero correlation (|r| < 0.03 on 1,187
 * real trades) with a trade's actual forward return — the score added no
 * predictive value, so it was removed rather than kept as a decorative
 * number. Any new candidate signal should be backtested the same way before
 * it's shown to a user as if it means something.
 */

/** Simple moving average, aligned to `closes` (null before enough history). */
export function calculateSMA(closes, period) {
  const sma = new Array(closes.length).fill(null);
  let sum = 0;
  for (let i = 0; i < closes.length; i++) {
    sum += closes[i];
    if (i >= period) sum -= closes[i - period];
    if (i >= period - 1) sma[i] = sum / period;
  }
  return sma;
}

/** Exponential moving average, aligned to `closes` (null before enough history). */
export function calculateEMA(closes, period) {
  const ema = new Array(closes.length).fill(null);
  if (closes.length < period) return ema;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += closes[i];
  ema[period - 1] = seed / period;
  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

/**
 * MACD(12,26,9): fast/slow EMA spread plus its own signal EMA. `histogram`
 * (line − signal) is the usual momentum read — positive and rising is
 * standard confirmation of a strengthening move.
 */
export function calculateMACD(closes, { fast = 12, slow = 26, signal = 9 } = {}) {
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);
  const line = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );

  const lineValues = line.filter((v) => v !== null);
  const firstLineIdx = line.findIndex((v) => v !== null);
  const signalOnValues = calculateEMA(lineValues, signal);

  const signalLine = new Array(closes.length).fill(null);
  const histogram = new Array(closes.length).fill(null);
  for (let i = 0; i < signalOnValues.length; i++) {
    const idx = firstLineIdx + i;
    signalLine[idx] = signalOnValues[i];
    histogram[idx] = signalOnValues[i] !== null ? line[idx] - signalOnValues[i] : null;
  }
  return { line, signal: signalLine, histogram };
}

/**
 * Close-to-close volatility proxy (see module note above — NOT true ATR,
 * which needs high/low that PSX's free feed doesn't provide).
 */
export function calculateCloseATR(closes, period = 14) {
  const atr = new Array(closes.length).fill(null);
  if (closes.length <= period) return atr;
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += Math.abs(closes[i] - closes[i - 1]);
  atr[period] = sum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const move = Math.abs(closes[i] - closes[i - 1]);
    atr[i] = (atr[i - 1] * (period - 1) + move) / period;
  }
  return atr;
}

/** Last non-null value in an aligned indicator array, or null. */
export function lastValue(series) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] !== null && series[i] !== undefined) return series[i];
  }
  return null;
}
