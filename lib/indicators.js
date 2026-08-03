/**
 * Trend/volume/momentum indicators layered on top of the RSI screener, all
 * computed on DAILY candles only — same reasoning as `BUY_SIGNAL` in
 * `lib/rsi.js`: mixing in the user's period/interval selection here would
 * reproduce the exact "signal changes when I change the dropdown" confusion
 * that item 9 in `docs/PROGRESS.md` already fixed once for the RSI screener.
 *
 * PSX's free EOD feed is `[timestamp, open, volume, close]` — no high/low
 * (see `fetchEodSeries` in `lib/psx.js`) — so a textbook true-range ATR isn't
 * possible. `calculateCloseATR` substitutes the average absolute close-to-
 * close move, which is a documented proxy, not real ATR; it's exposed as
 * `atr14` with that caveat and used only for a relative volatility read, not
 * as an authoritative stop-loss distance.
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
 * (line − signal) is what actually drives the composite score below — a
 * rising, positive histogram is standard confirmation that a bounce has
 * real momentum behind it, not just an oversold RSI reading.
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

/**
 * The weighted inputs to the composite score, in the order the user asked
 * for them ("RSI, trend, volume, momentum — weighted"). Kept as named
 * exports so the UI can render the same breakdown it scored with, rather
 * than a black-box number.
 */
export const SCORE_WEIGHTS = {
  rsi: 35, // daily RSI(14)+RSI(2) oversold depth — same pair as BUY_SIGNAL
  trend: 25, // price vs 200-day SMA — see note on computeCompositeScore below
  volume: 20, // today's volume vs its 20-day average — confirms real interest
  macd: 20, // MACD(12,26,9) histogram sign/slope — momentum confirmation
};

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

/**
 * A 0–100 confidence score for how well an oversold reading is confirmed by
 * trend, volume, and momentum — separate from, and never a replacement for,
 * the fixed `BUY_SIGNAL` screener rule. Each sub-score is 0–1 "how bullish,"
 * multiplied by its weight in `SCORE_WEIGHTS`. Any missing input (not enough
 * history yet) drops its own weight from both the numerator and the
 * denominator instead of guessing, so a young listing scores on what's
 * actually known rather than being penalized for missing data.
 *
 * The trend input is checked against the 200-day SMA, not a shorter one —
 * see `docs/PROGRESS.md` item 14. A backtest of the first version (50-day
 * SMA) against real PSX history found every single BUY_SIGNAL trade scored
 * under 50/100, because a stock deep enough into RSI(2) ≤ 10 to trigger the
 * screener is almost never above its own 50-day average — that's normal for
 * a short-term dip, not a red flag, so the 50-day test fought the strategy
 * it was meant to support and (on the largest sample) was mildly
 * *anti*-correlated with the trade's actual outcome. The 200-day SMA instead
 * asks the coarser, more useful question — "is this a genuine multi-month
 * structural decline, or a dip inside a longer uptrend?" — and gives partial
 * credit across a wide ±15% band instead of an all-or-nothing cutoff, so a
 * normal short-term dip isn't zeroed out by construction.
 */
export function computeCompositeScore({ r14, r2, price, sma200, currentVolume, avgVolume20, macdHistogram, prevMacdHistogram }) {
  const parts = [];

  if (r14 !== null && r14 !== undefined && r2 !== null && r2 !== undefined) {
    // Full credit once RSI(14) ≤ 35 and RSI(2) ≤ 10 (the BUY_SIGNAL levels);
    // partial credit scales down linearly as either reading is further from
    // oversold, so a "close but not quite" stock still shows some score.
    const r14Score = clamp01((35 - r14) / 35);
    const r2Score = clamp01((10 - r2) / 10);
    parts.push({ key: "rsi", value: (r14Score + r2Score) / 2, weight: SCORE_WEIGHTS.rsi });
  }

  if (price !== null && price !== undefined && sma200 !== null && sma200 !== undefined && sma200 > 0) {
    // At/above the 200-day average = full credit; up to 15% below it still
    // earns partial credit (a pullback inside a longer uptrend, which is
    // exactly what this strategy is supposed to buy); only a deeper,
    // structural decline scores near 0.
    const gapPct = (price - sma200) / sma200;
    parts.push({ key: "trend", value: clamp01(0.5 + gapPct / 0.3), weight: SCORE_WEIGHTS.trend });
  }

  if (
    currentVolume !== null &&
    currentVolume !== undefined &&
    avgVolume20 !== null &&
    avgVolume20 !== undefined &&
    avgVolume20 > 0
  ) {
    // 1x the 20-day average volume = no confirmation (0); 2x or more = full
    // credit. Below-average volume on a "bounce" is exactly the low-
    // conviction move the liquidity floor elsewhere in this app already
    // warns about.
    const ratio = currentVolume / avgVolume20;
    parts.push({ key: "volume", value: clamp01(ratio - 1), weight: SCORE_WEIGHTS.volume });
  }

  if (macdHistogram !== null && macdHistogram !== undefined) {
    const rising =
      prevMacdHistogram !== null && prevMacdHistogram !== undefined
        ? macdHistogram > prevMacdHistogram
        : false;
    const value = macdHistogram > 0 ? (rising ? 1 : 0.6) : rising ? 0.3 : 0;
    parts.push({ key: "macd", value, weight: SCORE_WEIGHTS.macd });
  }

  const totalWeight = parts.reduce((sum, p) => sum + p.weight, 0);
  if (totalWeight === 0) return null;

  const weightedSum = parts.reduce((sum, p) => sum + p.value * p.weight, 0);
  const score = Math.round((weightedSum / totalWeight) * 100);
  const breakdown = {};
  for (const p of parts) breakdown[p.key] = Math.round(p.value * 100);
  return { score, breakdown };
}
