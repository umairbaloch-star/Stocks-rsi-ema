#!/usr/bin/env node
/**
 * Feature-research tool for the RSI screener — replaces the old
 * `backtest-score.mjs` (see docs/PROGRESS.md items 13-15: that script's
 * four inputs — RSI depth, SMA trend, volume, MACD — all backtested to
 * near-zero correlation with actual outcomes, so nothing from it shipped).
 *
 * Rather than guess at another hand-picked composite, this computes several
 * CANDIDATE features at each historical `BUY_SIGNAL` entry and reports each
 * one's Pearson correlation with the trade's actual forward return, using
 * the app's own exit plan (RSI(14) re-crossing 50, +5% target, or a
 * 10-session time-stop). Nothing here is wired into the live app — it's
 * strictly a research tool. A feature only earns a place in the app once it
 * shows a real, consistent, positive correlation on a large sample here.
 *
 * MUST be run from a machine PSX doesn't block (your own machine, or the
 * Frankfurt Render deployment) — this dev sandbox's IP 403s on the EOD feed
 * (see AGENTS.md / docs/PROGRESS.md).
 *
 *   node scripts/backtest-features.mjs [--symbols OGDC,LUCK,...] [--limit 40] [--concurrency 6]
 *
 * Candidate features (all computed causally — index i only uses data up to
 * i, no look-ahead):
 *   - oversoldDepth14 / oversoldDepth2 — how far RSI(14)/RSI(2) are below
 *     their BUY_SIGNAL thresholds (raw depth, not the old 0-1 normalized
 *     score) — tests whether a MORE extreme oversold reading (not just
 *     crossing the fixed line) predicts a better bounce.
 *   - declineFrom20dHighPct — % drop from the trailing 20-day high to the
 *     entry price. Distinguishes "sharp recent drop" from "already been
 *     grinding down for a while."
 *   - distanceFrom252dLowPct — % above the trailing 252-day (~52-week) low.
 *     Tests whether being near a multi-month low is capitulation (good) or
 *     a falling knife (bad) for this strategy.
 *   - atrPct — the close-to-close ATR proxy as a % of price (relative
 *     volatility). Tests whether calmer or wilder names bounce better.
 *   - downStreakDays — consecutive prior down-closes into the entry day.
 *     Tests single-day RSI(2) spikes vs. a real multi-day capitulation.
 *   - persistentOversoldDays — how many of the last 3 days had RSI(2) ≤ 10.
 *     Tests a fresh dip vs. one that's been oversold for several sessions.
 *   - daysSinceLastSignal — sessions since this same symbol's last
 *     BUY_SIGNAL trade (null on a symbol's first signal in the sample).
 *     Tests "fresh dip" vs. "chronic decliner retriggering constantly."
 *
 * Also reports a fixed-horizon return table (3/5/10/15/20/30 sessions,
 * simple close-to-close, ignoring the exit plan) across every entry, in
 * case the 10-day/recross/+5% exit itself — not any of the above features
 * — is the part worth revisiting.
 */

import { fetchSymbols, fetchEodSeries, fetchMarketWatch } from "../lib/psx.js";
import { calculateRSISeries, adjustForCorporateActions, BUY_SIGNAL } from "../lib/rsi.js";
import { calculateCloseATR } from "../lib/indicators.js";

const HOLD_DAYS = 10; // matches RSI_PERIODS[14].holdCandles
const TARGET_GAIN = 0.05; // matches EXIT_PLAN's "+5-8% target" (lower bound)
const RSI_RECROSS = 50; // matches EXIT_PLAN's "RSI(14) back above ~50"
const MIN_HISTORY = 260; // 252-day low window + warm-up + a hold window
const HORIZONS = [3, 5, 10, 15, 20, 30];

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { limit: 40, concurrency: 6, symbols: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--symbols") opts.symbols = args[++i].split(",").map((s) => s.trim());
    else if (args[i] === "--limit") opts.limit = Number(args[++i]);
    else if (args[i] === "--concurrency") opts.concurrency = Number(args[++i]);
  }
  return opts;
}

async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  async function runNext() {
    const i = next++;
    if (i >= items.length) return;
    await worker(items[i], i);
    return runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

async function pickSymbols(opts) {
  if (opts.symbols) return opts.symbols;
  console.log("No --symbols given — pulling KSE-100 constituents from market-watch...");
  const [symbols, marketWatch] = await Promise.all([fetchSymbols(), fetchMarketWatch()]);
  const kse100 = symbols.filter((s) => marketWatch.get(s.symbol)?.isKse100).map((s) => s.symbol);
  const pool = kse100.length > 0 ? kse100 : symbols.map((s) => s.symbol);
  return pool.slice(0, opts.limit);
}

function rollingExtreme(closes, window, better) {
  const out = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (i < window - 1) continue;
    let best = closes[i - window + 1];
    for (let j = i - window + 2; j <= i; j++) {
      if (better(closes[j], best)) best = closes[j];
    }
    out[i] = best;
  }
  return out;
}

/** Simulates one BUY_SIGNAL trade opened at index `entryIdx` on the app's stated exit plan. */
function simulateTrade(closes, rsi14, entryIdx) {
  const entryPrice = closes[entryIdx];
  const maxExit = Math.min(closes.length - 1, entryIdx + HOLD_DAYS);
  for (let i = entryIdx + 1; i <= maxExit; i++) {
    const ret = closes[i] / entryPrice - 1;
    if (ret >= TARGET_GAIN) return { return: ret, reason: "target" };
    if (rsi14[i] !== null && rsi14[i] >= RSI_RECROSS) return { return: ret, reason: "rsi-recross" };
  }
  return { return: closes[maxExit] / entryPrice - 1, reason: "time-stop" };
}

/** Simple fixed-horizon forward return, ignoring the exit plan (for the horizon table). */
function fixedHorizonReturn(closes, entryIdx, days) {
  const exitIdx = entryIdx + days;
  if (exitIdx >= closes.length) return null;
  return closes[exitIdx] / closes[entryIdx] - 1;
}

async function backtestSymbol(symbol, results, horizonResults) {
  let series;
  try {
    series = await fetchEodSeries(symbol);
  } catch (err) {
    console.warn(`  [skip] ${symbol}: ${err.message}`);
    return;
  }
  if (series.length < MIN_HISTORY) return;

  const adjusted = adjustForCorporateActions(series);
  const closes = adjusted.map((p) => p.close);

  const rsi14 = calculateRSISeries(closes, 14);
  const rsi2 = calculateRSISeries(closes, 2);
  const atr14 = calculateCloseATR(closes, 14);
  const high20 = rollingExtreme(closes, 20, (a, b) => a > b);
  const low252 = rollingExtreme(closes, 252, (a, b) => a < b);

  let lastSignalIdx = null;

  for (let i = 252; i < closes.length - 1; i++) {
    const r14 = rsi14[i];
    const r2 = rsi2[i];
    if (r14 === null || r2 === null) continue;
    if (!(r14 <= BUY_SIGNAL.rsi14Max && r2 <= BUY_SIGNAL.rsi2Max)) continue;

    let downStreakDays = 0;
    for (let j = i; j > 0 && closes[j] < closes[j - 1]; j--) downStreakDays++;

    let persistentOversoldDays = 0;
    for (let j = Math.max(0, i - 2); j <= i; j++) {
      if (rsi2[j] !== null && rsi2[j] <= BUY_SIGNAL.rsi2Max) persistentOversoldDays++;
    }

    const features = {
      oversoldDepth14: BUY_SIGNAL.rsi14Max - r14,
      oversoldDepth2: BUY_SIGNAL.rsi2Max - r2,
      declineFrom20dHighPct: high20[i] ? ((high20[i] - closes[i]) / high20[i]) * 100 : null,
      distanceFrom252dLowPct: low252[i] ? ((closes[i] - low252[i]) / low252[i]) * 100 : null,
      atrPct: atr14[i] !== null ? (atr14[i] / closes[i]) * 100 : null,
      downStreakDays,
      persistentOversoldDays,
      daysSinceLastSignal: lastSignalIdx !== null ? i - lastSignalIdx : null,
    };
    lastSignalIdx = i;

    const trade = simulateTrade(closes, rsi14, i);
    results.push({ symbol, features, ...trade });

    for (const h of HORIZONS) {
      const ret = fixedHorizonReturn(closes, i, h);
      if (ret !== null) horizonResults.push({ horizon: h, return: ret });
    }
  }
}

/** Pearson correlation coefficient between two equal-length numeric arrays. */
function correlation(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    const dy = ys[i] - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

function reportFeatureCorrelations(results) {
  console.log(`\n${results.length} BUY_SIGNAL trades simulated across all symbols.\n`);
  console.log("== Correlation of each candidate feature vs. actual forward return ==");
  const keys = Object.keys(results[0]?.features ?? {});
  for (const key of keys) {
    const withKey = results.filter((r) => r.features[key] !== null && r.features[key] !== undefined);
    const corr = correlation(
      withKey.map((r) => r.features[key]),
      withKey.map((r) => r.return)
    );
    console.log(
      `${key.padEnd(24)} n=${String(withKey.length).padEnd(5)} r=${corr === null ? "n/a" : corr.toFixed(3)}`
    );
  }
  console.log(
    "\nPearson r ranges -1..+1. Near 0 = no linear relationship with forward return (not\n" +
      "predictive here); a feature only deserves a place in the app if it shows a\n" +
      "consistently positive |r| meaningfully above ~0.1 on a large sample, ideally\n" +
      "confirmed across more than one run/symbol set."
  );
}

/**
 * Splits trades into `n` equal-sized buckets by a feature's value (low to
 * high) and reports win-rate/avg-return per bucket. A correlation
 * coefficient can be dragged around by a handful of outlier trades; a
 * roughly monotonic step-up in win-rate/avg-return across buckets is
 * stronger evidence that a feature is genuinely predictive than the
 * correlation number alone.
 */
function reportFeatureBuckets(results, key, n = 3) {
  const withKey = results.filter((r) => r.features[key] !== null && r.features[key] !== undefined);
  if (withKey.length < n * 10) {
    console.log(`\n${key}: not enough trades (n=${withKey.length}) for a ${n}-bucket breakdown.`);
    return;
  }
  const sorted = [...withKey].sort((a, b) => a.features[key] - b.features[key]);
  const bucketSize = Math.floor(sorted.length / n);

  console.log(`\n== ${key}, low → high tercile ==`);
  for (let b = 0; b < n; b++) {
    const start = b * bucketSize;
    const end = b === n - 1 ? sorted.length : start + bucketSize;
    const rows = sorted.slice(start, end);
    const wins = rows.filter((r) => r.return > 0).length;
    const winRate = ((wins / rows.length) * 100).toFixed(1);
    const avgReturn = ((rows.reduce((a, r) => a + r.return, 0) / rows.length) * 100).toFixed(2);
    const medianReturn = (
      [...rows].sort((a, b) => a.return - b.return)[Math.floor(rows.length / 2)].return * 100
    ).toFixed(2);
    const lo = rows[0].features[key].toFixed(2);
    const hi = rows[rows.length - 1].features[key].toFixed(2);
    console.log(
      `  bucket ${b + 1}/${n} [${lo}..${hi}]  n=${String(rows.length).padEnd(5)} win-rate=${winRate.padStart(5)}%  avg-return=${avgReturn.padStart(6)}%  median-return=${medianReturn.padStart(6)}%`
    );
  }
  console.log(
    "  (median close to avg = a broad effect across the bucket; median far below avg =\n" +
      "   a handful of outsized winners are inflating the average, not a broad edge.)"
  );
}

function reportHorizonTable(horizonResults) {
  console.log("\n== Fixed-horizon forward return, ignoring the exit plan (all entries) ==");
  for (const h of HORIZONS) {
    const rows = horizonResults.filter((r) => r.horizon === h);
    if (rows.length === 0) continue;
    const wins = rows.filter((r) => r.return > 0).length;
    const winRate = ((wins / rows.length) * 100).toFixed(1);
    const avgReturn = ((rows.reduce((a, r) => a + r.return, 0) / rows.length) * 100).toFixed(2);
    console.log(
      `${String(h).padStart(2)} sessions   n=${String(rows.length).padEnd(5)} win-rate=${winRate.padStart(5)}%  avg-return=${avgReturn.padStart(6)}%`
    );
  }
  console.log(
    "\nIf a different horizon clearly beats the app's current 10-session/+5%/RSI-recross\n" +
      "exit plan, that's worth a separate conversation before changing BUY_SIGNAL's\n" +
      "exit — this table alone isn't a reason to change it."
  );
}

async function main() {
  const opts = parseArgs();
  const symbols = await pickSymbols(opts);
  console.log(`Backtesting ${symbols.length} symbol(s): ${symbols.join(", ")}\n`);

  const results = [];
  const horizonResults = [];
  let done = 0;
  await runWithConcurrency(symbols, opts.concurrency, async (symbol) => {
    await backtestSymbol(symbol, results, horizonResults);
    done++;
    process.stdout.write(`\rFetched ${done}/${symbols.length} symbols...`);
  });
  console.log("");

  if (results.length === 0) {
    console.log("No BUY_SIGNAL trades found with enough history — try more/different symbols.");
    return;
  }

  reportFeatureCorrelations(results);
  // Bucket breakdowns for whichever features are worth a closer look — a
  // correlation coefficient alone can't tell you if the relationship is a
  // clean step-up or a couple of outlier trades. Edit this list as new
  // candidates clear the correlation bar in reportFeatureCorrelations.
  for (const key of ["atrPct", "declineFrom20dHighPct"]) {
    reportFeatureBuckets(results, key, 3);
  }
  reportHorizonTable(horizonResults);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
