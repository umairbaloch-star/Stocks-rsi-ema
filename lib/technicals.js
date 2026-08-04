/**
 * Multi-indicator swing-trade analysis: an ideal entry price, two exit
 * targets (same-day scalp and a 1-3 week swing target), and a High/Medium/
 * Low confidence read — built from RSI(5)/RSI(14), MACD, moving averages
 * (20/50/200), volume, approximate support/resistance, trend direction, a
 * breakout/breakdown check, and a couple of open/close candlestick reads.
 *
 * PSX's free EOD feed has no daily high/low, only open/close/volume (see
 * fetchEodSeries in lib/psx.js) — so support/resistance and candlestick
 * patterns below are approximated from closing (and opening) prices rather
 * than true intraday range/wick data. That's a real accuracy trade-off, not
 * a bug: this analysis should be read as a same-inputs-every-time screener
 * heuristic, not a substitute for looking at an actual candlestick chart.
 */

const MIN_HISTORY = 30; // below this, the analysis is too noisy to be useful

// The time-stop leg of the app's standing swing exit plan (see EXIT_PLAN in
// app/components/StocksTable.js and holdCandles for RSI(14) in lib/rsi.js):
// "RSI(14) back above ~50, +5-8% target, or ~10 sessions — whichever first."
// Used below to turn that "~10 sessions" into an actual calendar date.
const EXIT_HOLD_SESSIONS = 10;

// Advances a date by `sessions` PSX trading days (Mon-Fri only) — an
// approximation, since a plain daily-close feed carries no holiday calendar
// to skip market closures beyond weekends. Read the resulting date as "by
// around here," not a guaranteed trading day.
function addTradingDays(dateMs, sessions) {
  const d = new Date(dateMs);
  let added = 0;
  while (added < sessions) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) added++;
  }
  return d.getTime();
}

export function calculateSMA(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function calculateEMA(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  // Seed with the SMA of the first `period` values, standard EMA practice.
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  let prev = seed;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Standard 12/26/9 MACD. Returns aligned arrays; entries are null until enough history. */
export function calculateMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = calculateEMA(closes, fast);
  const emaSlow = calculateEMA(closes, slow);
  const macdLine = closes.map((_, i) =>
    emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
  );
  // The signal line is an EMA of the MACD line itself, computed only over
  // the stretch where macdLine is non-null (i.e. once the slow EMA exists).
  const firstValid = macdLine.findIndex((v) => v !== null);
  const signalLine = new Array(closes.length).fill(null);
  if (firstValid !== -1) {
    const macdTail = macdLine.slice(firstValid);
    const signalTail = calculateEMA(macdTail, signalPeriod);
    signalTail.forEach((v, i) => {
      signalLine[firstValid + i] = v;
    });
  }
  const histogram = closes.map((_, i) =>
    macdLine[i] !== null && signalLine[i] !== null ? macdLine[i] - signalLine[i] : null
  );
  return { macdLine, signalLine, histogram };
}

/**
 * Approximate support/resistance: a "pivot" day is a local extreme — its
 * close is the highest (or lowest) within `window` days on both sides.
 * Support = the nearest pivot low at or below the current price; resistance
 * = the nearest pivot high at or above it. Falls back to the lookback
 * window's plain min/max when no clean pivot exists (e.g. a straight trend
 * with no local turning point).
 */
export function findSupportResistance(closes, price, lookback = 90, window = 4) {
  const start = Math.max(0, closes.length - lookback);
  const slice = closes.slice(start);
  const pivotHighs = [];
  const pivotLows = [];
  for (let i = window; i < slice.length - window; i++) {
    const around = slice.slice(i - window, i + window + 1);
    const v = slice[i];
    if (v === Math.max(...around)) pivotHighs.push(v);
    if (v === Math.min(...around)) pivotLows.push(v);
  }

  const supports = pivotLows.filter((v) => v <= price);
  const resistances = pivotHighs.filter((v) => v >= price);

  const support = supports.length ? Math.max(...supports) : Math.min(...slice);
  const resistance = resistances.length ? Math.min(...resistances) : Math.max(...slice);
  return { support, resistance };
}

/** Trend by price vs. the moving averages that are actually available. */
function trendDirection(price, sma20, sma50, sma200) {
  let score = 0;
  let applicable = 0;
  for (const ma of [sma20, sma50, sma200]) {
    if (ma === null) continue;
    applicable++;
    score += price >= ma ? 1 : -1;
  }
  if (applicable === 0) return "sideways";
  if (score >= Math.ceil(applicable * 0.6)) return "up";
  if (score <= -Math.ceil(applicable * 0.6)) return "down";
  return "sideways";
}

/**
 * A "confirmed" breakout/breakdown needs both a close beyond the level AND
 * above-average volume — a level crossed on thin volume is easily reversed
 * and shouldn't be read as confirmed (same liquidity-matters philosophy as
 * the volume floor elsewhere in this app).
 */
function breakoutState(price, support, resistance, volumeRatio) {
  const confirmedVolume = volumeRatio !== null && volumeRatio >= 1.2;
  if (price > resistance * 1.001 && confirmedVolume) return "breakout";
  if (price < support * 0.999 && confirmedVolume) return "breakdown";
  return "none";
}

/**
 * Open/close-only candlestick reads (no high/low in the feed — see the file
 * header). Engulfing patterns only need open/close, so they carry over
 * faithfully; anything wick-dependent (hammer, shooting star, doji's usual
 * definition) is out of reach here and deliberately not attempted.
 */
function candlestickPattern(days) {
  if (days.length < 2) return null;
  const prev = days[days.length - 2];
  const today = days[days.length - 1];
  if (prev.open == null || today.open == null) return null;

  const prevBearish = prev.close < prev.open;
  const prevBullish = prev.close > prev.open;
  const todayBullish = today.close > today.open;
  const todayBearish = today.close < today.open;

  if (
    prevBearish &&
    todayBullish &&
    today.open <= prev.close &&
    today.close >= prev.open
  ) {
    return { name: "Bullish engulfing", bias: "bullish" };
  }
  if (
    prevBullish &&
    todayBearish &&
    today.open >= prev.close &&
    today.close <= prev.open
  ) {
    return { name: "Bearish engulfing", bias: "bearish" };
  }
  return null;
}

/**
 * Confidence is a fixed-weight blend of six factors, each contributing a
 * -1 (bearish) .. +1 (bullish) vote — MACD is the one continuous vote
 * (its score/40), so a fresh crossover (±40) outweighs an already-
 * established gap (±25) within that factor's own share; every other
 * factor is a discrete -1/0/+1 threshold read. The level reflects how
 * strongly the *applicable* votes lean one way, not which way — a stock
 * screaming "sell" across the board is just as high-confidence a read as
 * one screaming "buy," it just means the entry/exit numbers aren't a good
 * idea to act on right now. A factor with no data (e.g. EMA50 before 50
 * days of history) is dropped and the remaining weights re-normalize.
 */
export const CONFIDENCE_WEIGHTS = {
  rsi5: 20,
  volume: 18,
  priceToEntryDelta: 17,
  ema20: 16.5,
  macd: 16,
  ema50: 12.5,
};

const CONFIDENCE_LABELS = {
  rsi5: "RSI(5) · 1D",
  volume: "Traded Volume",
  priceToEntryDelta: "Price-to-Entry Delta",
  ema20: "EMA20 State",
  macd: "MACD State & Value",
  ema50: "EMA50 State",
};

function computeConfidenceLevel({ rsi5, volumeRatio, priceChange, price, ema20, ema50, macdScore, priceToEntryDelta }) {
  const rawVotes = {
    rsi5: rsi5 === null || rsi5 === undefined ? null : rsi5 <= 20 ? 1 : rsi5 >= 80 ? -1 : 0,
    // High volume confirms whichever way price actually moved that day;
    // average/thin volume has nothing to confirm, so it's a non-vote.
    volume:
      volumeRatio === null || priceChange === null
        ? null
        : volumeRatio < 1.3
          ? 0
          : priceChange > 0
            ? 1
            : priceChange < 0
              ? -1
              : 0,
    // Price sitting right at the ideal dip-entry is the bullish case;
    // price that's already run away from it is chasing, not buying.
    priceToEntryDelta:
      priceToEntryDelta === null
        ? null
        : priceToEntryDelta <= 0.01
          ? 1
          : priceToEntryDelta <= 0.03
            ? 0
            : -1,
    ema20: ema20 === null || ema20 === undefined ? null : price > ema20 ? 1 : price < ema20 ? -1 : 0,
    macd: macdScore === null || macdScore === undefined ? null : macdScore / 40,
    ema50: ema50 === null || ema50 === undefined ? null : price > ema50 ? 1 : price < ema50 ? -1 : 0,
  };

  const breakdown = Object.entries(CONFIDENCE_WEIGHTS).map(([key, weight]) => ({
    key,
    label: CONFIDENCE_LABELS[key],
    weight,
    vote: rawVotes[key],
  }));

  const applicable = breakdown.filter((f) => f.vote !== null);
  const totalWeight = applicable.reduce((sum, f) => sum + f.weight, 0);
  const score = totalWeight
    ? applicable.reduce((sum, f) => sum + f.vote * f.weight, 0) / totalWeight
    : 0;
  const strength = Math.abs(score);
  const level = strength >= 0.65 ? "High" : strength >= 0.4 ? "Medium" : "Low";

  return { level, score: Number(score.toFixed(2)), breakdown };
}

/**
 * The main entry point: given a symbol's adjusted daily series
 * (`[{ date, open, close, volume }]`, ascending) and its already-computed
 * daily RSI(5)/RSI(14), returns the entry/exit/confidence read, or `null`
 * when there isn't enough history yet (MIN_HISTORY days).
 */
export function computeTradeAnalysis(series, rsi14, rsi5) {
  if (!series || series.length < MIN_HISTORY) return null;

  const closes = series.map((p) => p.close);
  const volumes = series.map((p) => p.volume).filter((v) => typeof v === "number");
  const price = closes[closes.length - 1];

  const sma20 = calculateSMA(closes, 20).at(-1);
  const sma50 = closes.length >= 50 ? calculateSMA(closes, 50).at(-1) : null;
  const sma200 = closes.length >= 200 ? calculateSMA(closes, 200).at(-1) : null;
  const ema20 = calculateEMA(closes, 20).at(-1) ?? null;
  const ema50 = closes.length >= 50 ? calculateEMA(closes, 50).at(-1) : null;
  const { macdLine, signalLine, histogram } = calculateMACD(closes);
  const macdHist = histogram.at(-1);
  const macd = macdSignalRead(macdLine, signalLine);

  const volAvg20 =
    volumes.length >= 20 ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
  const latestVolume = volumes.at(-1) ?? null;
  const volumeRatio = volAvg20 && latestVolume !== null ? latestVolume / volAvg20 : null;
  const priceChange = closes.length >= 2 ? price - closes[closes.length - 2] : null;

  const { support, resistance } = findSupportResistance(closes, price);
  const trend = trendDirection(price, sma20, sma50, sma200);
  const breakout = breakoutState(price, support, resistance, volumeRatio);
  const candle = candlestickPattern(series.slice(-3));

  // Entry: a realistic near-term dip-buy level — the approximate support,
  // but clamped to within 5% of price so a stale/far-away pivot never gets
  // suggested as "the" entry (and never above the current price).
  const entry = Math.min(price, Math.max(support, price * 0.95));
  // Same-day exit: a quick +2% scalp, pulled in to the nearest resistance
  // if that's closer than the +2% target.
  const exitSameDay = Math.max(
    entry * 1.01,
    resistance < entry * 1.02 && resistance > entry ? resistance : entry * 1.02
  );
  // Short-term (1-3 week) exit: the resistance level if it's a meaningfully
  // bigger move than the same-day target, else the ~6.5% midpoint of this
  // app's standing +5-8% swing exit plan (see BUY_SIGNAL/EXIT_PLAN).
  const exitShortTerm = Math.max(
    exitSameDay * 1.02,
    resistance > entry * 1.03 ? resistance : entry * 1.065
  );

  const priceToEntryDelta = entry > 0 ? (price - entry) / entry : null;
  const { level: confidence, score: confidenceScore, breakdown: confidenceBreakdown } =
    computeConfidenceLevel({
      rsi5: rsi5 ?? null,
      volumeRatio,
      priceChange,
      price,
      ema20,
      ema50,
      macdScore: macd?.score ?? null,
      priceToEntryDelta,
    });

  // The swing exit plan's price target (exitShortTerm) paired with the date
  // its ~10-session time-stop leg falls on — "sell here, or by here,
  // whichever comes first" made concrete instead of just "~10 sessions."
  const exitTargetDate = addTradingDays(series[series.length - 1].date, EXIT_HOLD_SESSIONS);
  const exitProfitPercent = entry > 0 ? ((exitShortTerm - entry) / entry) * 100 : null;

  return {
    entry: Number(entry.toFixed(2)),
    exitSameDay: Number(exitSameDay.toFixed(2)),
    exitShortTerm: Number(exitShortTerm.toFixed(2)),
    exitTargetDate,
    exitProfitPercent: exitProfitPercent !== null ? Number(exitProfitPercent.toFixed(2)) : null,
    confidence,
    confidenceScore,
    confidenceBreakdown,
    factors: {
      rsi14: rsi14 ?? null,
      rsi5: rsi5 ?? null,
      macdHist: macdHist !== null ? Number(macdHist.toFixed(3)) : null,
      macdLabel: macd?.label ?? null,
      macdScore: macd?.score ?? null,
      sma20: sma20 !== null ? Number(sma20.toFixed(2)) : null,
      sma50: sma50 !== null ? Number(sma50.toFixed(2)) : null,
      sma200: sma200 !== null ? Number(sma200.toFixed(2)) : null,
      ema20: ema20 !== null ? Number(ema20.toFixed(2)) : null,
      ema50: ema50 !== null ? Number(ema50.toFixed(2)) : null,
      volumeRatio: volumeRatio !== null ? Number(volumeRatio.toFixed(2)) : null,
      support: Number(support.toFixed(2)),
      resistance: Number(resistance.toFixed(2)),
      priceToEntryDelta: priceToEntryDelta !== null ? Number(priceToEntryDelta.toFixed(4)) : null,
      trend,
      breakout,
      candlestick: candle?.name ?? null,
    },
  };
}

/**
 * MACD-vs-Signal-line read, scored on a fixed 5-rung scale rather than just
 * the histogram's sign — a fresh crossover carries more weight than an
 * already-established gap:
 *
 *   MACD crosses above Signal   +40  Strong Buy
 *   MACD above Signal           +25  Bullish
 *   MACD equals Signal            0  Neutral
 *   MACD below Signal           -25  Bearish
 *   MACD crosses below Signal   -40  Strong Sell
 *
 * A "cross" needs yesterday's MACD-minus-Signal on the opposite side of
 * zero from today's; with fewer than two valid days it can only be
 * above/below/equal, never a cross.
 */
function macdSignalRead(macdLine, signalLine) {
  const macd = macdLine.at(-1);
  const sig = signalLine.at(-1);
  if (macd === null || sig === null || macd === undefined || sig === undefined) return null;

  const prevMacd = macdLine.at(-2);
  const prevSig = signalLine.at(-2);
  const diff = macd - sig;
  const prevDiff =
    prevMacd !== null && prevMacd !== undefined && prevSig !== null && prevSig !== undefined
      ? prevMacd - prevSig
      : null;
  const crossedAbove = prevDiff !== null && prevDiff <= 0 && diff > 0;
  const crossedBelow = prevDiff !== null && prevDiff >= 0 && diff < 0;

  let label;
  let score;
  if (crossedAbove) {
    label = "Strong Buy";
    score = 40;
  } else if (crossedBelow) {
    label = "Strong Sell";
    score = -40;
  } else if (diff > 0) {
    label = "Bullish";
    score = 25;
  } else if (diff < 0) {
    label = "Bearish";
    score = -25;
  } else {
    label = "Neutral";
    score = 0;
  }

  return {
    macdLine: Number(macd.toFixed(3)),
    macdSignalLine: Number(sig.toFixed(3)),
    label,
    score,
  };
}

// A single weighted verdict that reconciles this file's other reads (Signal,
// MACD, EMA20/50, RSI14) into one call, so a user isn't left eyeballing
// several columns that can legitimately disagree. Deliberately scoped to
// this app's existing 1-3 week swing horizon (Signal's own EXIT_PLAN is a
// ~10-session/+5-8% target) — there is no next-day price-projection factor
// here; a single next session's move isn't this app's trading horizon, and
// isn't something a technical read can honestly claim to forecast. Signal
// gets the heaviest weight since it's already itself a multi-factor read
// (RSI14 + EMA trend + MACD + volume); the raw single-indicator factors
// (MACD/EMA20/EMA50/RSI14) are included too, at lower weight, mainly to keep
// one of Signal's own inputs from silently dominating by being counted twice
// at full strength.
export const STANCE_WEIGHTS = {
  signal: 45,
  macd: 20,
  ema20: 15,
  ema50: 15,
  rsi14: 5,
};

const STANCE_LABELS = {
  signal: "Signal (RSI+EMA+MACD+Volume)",
  macd: "MACD State & Value",
  ema20: "Price vs EMA20",
  ema50: "Price vs EMA50",
  rsi14: "RSI(14)",
};

/**
 * Combines `signal` (computeSimpleSignal) and the raw RSI14/EMA20/EMA50/MACD
 * reads into one -1..+1 weighted score and a single Strong Buy / Buy / Hold /
 * Sell / Strong Sell verdict, scoped to this app's 1-3 week swing horizon. A
 * factor with no data (e.g. EMA50 before 50 days of history) is dropped and
 * the remaining weights re-normalize, same pattern as computeConfidenceLevel
 * above.
 */
export function computeFinalStance({ signal, rsi14, ema20, ema50, price, macdScore }) {
  if (!signal) return null;

  const votes = {
    signal: signal.signal === "Buy" ? 1 : signal.signal === "Sell" ? -1 : 0,
    macd: macdScore === null || macdScore === undefined ? null : macdScore / 40,
    ema20: ema20 === null || ema20 === undefined ? null : price > ema20 ? 1 : price < ema20 ? -1 : 0,
    ema50: ema50 === null || ema50 === undefined ? null : price > ema50 ? 1 : price < ema50 ? -1 : 0,
    rsi14: rsi14 === null || rsi14 === undefined ? null : rsi14 <= 35 ? 1 : rsi14 >= 65 ? -1 : 0,
  };

  const breakdown = Object.entries(STANCE_WEIGHTS).map(([key, weight]) => ({
    key,
    label: STANCE_LABELS[key],
    weight,
    vote: votes[key],
  }));
  const applicable = breakdown.filter((f) => f.vote !== null);
  const totalWeight = applicable.reduce((sum, f) => sum + f.weight, 0);
  const score = totalWeight
    ? applicable.reduce((sum, f) => sum + f.vote * f.weight, 0) / totalWeight
    : 0;

  // How much the applicable factors actually agree with the final score's
  // own direction — separate from the score's strength, so a confident-
  // looking score built from wildly split votes still reads as contested.
  const sameDirection = applicable.filter(
    (f) => f.vote === 0 || score === 0 || Math.sign(f.vote) === Math.sign(score)
  ).length;
  const agreement = applicable.length ? sameDirection / applicable.length : 0;

  let stance;
  if (score >= 0.5) stance = "Strong Buy";
  else if (score >= 0.15) stance = "Buy";
  else if (score <= -0.5) stance = "Strong Sell";
  else if (score <= -0.15) stance = "Sell";
  else stance = "Hold";

  return {
    stance,
    score: Number(score.toFixed(2)),
    agreement: Number(agreement.toFixed(2)),
    breakdown,
  };
}

// Textbook RSI overbought/oversold (not this app's own faster RSI(5) chart
// bands, which run 20/80 — see RSI_PERIODS in lib/rsi.js). Used only as the
// "already extended" chase guard below: RSI(5) reacts fast enough that
// hitting the classic 70/30 line is a real sign a move has already run,
// even before this app's own wider RSI(5) overbought/oversold bands kick in.
const EXTENDED_OVERBOUGHT = 70;
const EXTENDED_OVERSOLD = 30;

/**
 * A deliberately simple, separate read: just RSI(14) + EMA(20/50) + MACD +
 * volume, combined into one Buy/Sell/Watch call — independent of (and much
 * smaller than) computeTradeAnalysis above, which stays exactly as it was
 * for the existing Entry/Exit/Confidence columns.
 *
 * RSI, EMA-trend, and MACD each vote -1 (bearish) / 0 (neutral) / +1
 * (bullish); volume is a confirmation gate, not a fourth vote — thin volume
 * (below 0.7x the 20-day average) downgrades an otherwise-qualifying call to
 * Watch, since a real move needs real participation, not just aligned
 * indicators on a quiet day. Buy/Sell need the three votes to agree on
 * direction (net +-2 or better out of 3); anything short of that is Watch.
 *
 * A second gate does the same for RSI(5): EMA trend + a fresh MACD crossover
 * can net +2 on their own — trend and momentum agreeing — even while RSI(14)
 * stays neutral, which lets Buy fire on a stock that's already run hard on a
 * short lookback (a classic chase-the-rally setup, not a dip entry). RSI(5)
 * at/beyond the textbook 70/30 line downgrades that call to Watch, same
 * reasoning as the volume gate: an aligned-but-already-extended read isn't
 * a safe entry.
 */
export function computeSimpleSignal(series, rsi14, rsi5) {
  if (!series || series.length < MIN_HISTORY) return null;

  const closes = series.map((p) => p.close);
  const volumes = series.map((p) => p.volume).filter((v) => typeof v === "number");
  const price = closes.at(-1);

  const ema20 = calculateEMA(closes, 20).at(-1) ?? null;
  const ema50 = closes.length >= 50 ? calculateEMA(closes, 50).at(-1) : null;
  let emaTrend = null;
  if (ema20 !== null && ema50 !== null) {
    emaTrend = price > ema20 && ema20 > ema50 ? "Bullish" : price < ema20 && ema20 < ema50 ? "Bearish" : "Neutral";
  }

  const { macdLine, signalLine, histogram } = calculateMACD(closes);
  const macdHist = histogram.at(-1);
  const macd = macdSignalRead(macdLine, signalLine);

  const volAvg20 =
    volumes.length >= 20 ? volumes.slice(-20).reduce((a, b) => a + b, 0) / 20 : null;
  const latestVolume = volumes.at(-1) ?? null;
  const volumeRatio = volAvg20 && latestVolume !== null ? latestVolume / volAvg20 : null;

  const votes = [];
  if (rsi14 !== null && rsi14 !== undefined) votes.push(rsi14 <= 35 ? 1 : rsi14 >= 65 ? -1 : 0);
  if (emaTrend !== null) votes.push(emaTrend === "Bullish" ? 1 : emaTrend === "Bearish" ? -1 : 0);
  if (macd !== null) votes.push(macd.score > 0 ? 1 : macd.score < 0 ? -1 : 0);

  const net = votes.reduce((a, b) => a + b, 0);
  const thinVolume = volumeRatio !== null && volumeRatio < 0.7;
  const extendedOverbought = rsi5 !== null && rsi5 !== undefined && rsi5 >= EXTENDED_OVERBOUGHT;
  const extendedOversold = rsi5 !== null && rsi5 !== undefined && rsi5 <= EXTENDED_OVERSOLD;

  // What the call would have been without the RSI(5)-extended gate — kept
  // only so a backtest can compare before/after that fix's effect; the app
  // itself only ever reads `signal` below.
  let preExtendedSignal = "Watch";
  if (net >= 2 && !thinVolume) preExtendedSignal = "Buy";
  else if (net <= -2 && !thinVolume) preExtendedSignal = "Sell";

  let signal = "Watch";
  if (net >= 2 && !thinVolume && !extendedOverbought) signal = "Buy";
  else if (net <= -2 && !thinVolume && !extendedOversold) signal = "Sell";

  return {
    rsi14: rsi14 ?? null,
    rsi5: rsi5 ?? null,
    ema20: ema20 !== null ? Number(ema20.toFixed(2)) : null,
    ema50: ema50 !== null ? Number(ema50.toFixed(2)) : null,
    emaTrend,
    macdHist: macdHist !== null ? Number(macdHist.toFixed(3)) : null,
    macdLine: macd?.macdLine ?? null,
    macdSignalLine: macd?.macdSignalLine ?? null,
    macdLabel: macd?.label ?? null,
    macdScore: macd?.score ?? null,
    volumeRatio: volumeRatio !== null ? Number(volumeRatio.toFixed(2)) : null,
    thinVolume,
    extendedOverbought,
    extendedOversold,
    signal,
    preExtendedSignal,
  };
}
