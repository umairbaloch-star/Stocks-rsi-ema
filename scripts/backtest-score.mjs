#!/usr/bin/env node
/**
 * Backtests the composite confidence score (lib/indicators.js) and the
 * fixed BUY_SIGNAL screener (lib/rsi.js) against PSX's own historical EOD
 * data — reusing the *actual* production functions, not a re-implementation,
 * so this measures what the app really computes.
 *
 * MUST be run from a machine PSX doesn't block (your own machine, or the
 * Frankfurt Render deployment) — this dev sandbox's IP 403s on the EOD feed
 * (see AGENTS.md / docs/PROGRESS.md). Run with:
 *
 *   node scripts/backtest-score.mjs [--symbols OGDC,LUCK,...] [--limit 40] [--concurrency 6]
 *
 * With no --symbols, it pulls the KSE-100 constituent list from market-watch
 * and backtests up to --limit of them (default 40) to keep the run quick.
 *
 * Methodology (no look-ahead):
 *   - RSI(14)/RSI(2), 200-day SMA, MACD(12,26,9) histogram, and 20-day average
 *     volume are computed with the same whole-series functions cache.js uses
 *     in production; each is causal (index i only depends on data up to i).
 *   - A "trade" opens on any day the fixed BUY_SIGNAL rule fires (daily
 *     RSI(14) <= 35 and RSI(2) <= 10), independent of confidence score.
 *   - Each trade is closed by the app's own stated exit plan: RSI(14)
 *     re-crossing above 50, a +5% gain, or 10 sessions — whichever comes
 *     first — and the resulting return is bucketed by the confidence score
 *     that was showing on the entry day. This directly tests whether a
 *     higher score at entry actually correlates with a better outcome.
 */

import { fetchSymbols, fetchEodSeries, fetchMarketWatch } from "../lib/psx.js";
import {
  calculateRSISeries,
  adjustForCorporateActions,
  BUY_SIGNAL,
} from "../lib/rsi.js";
import { calculateSMA, calculateMACD, computeCompositeScore } from "../lib/indicators.js";

const HOLD_DAYS = 10; // matches RSI_PERIODS[14].holdCandles
const TARGET_GAIN = 0.05; // matches EXIT_PLAN's "+5-8% target" (lower bound)
const RSI_RECROSS = 50; // matches EXIT_PLAN's "RSI(14) back above ~50"

const SCORE_BUCKETS = [
  { label: "no score (missing history)", test: (s) => s === null },
  { label: "0-29 (weak)", test: (s) => s !== null && s < 30 },
  { label: "30-49 (low)", test: (s) => s !== null && s >= 30 && s < 50 },
  { label: "50-69 (moderate)", test: (s) => s !== null && s >= 50 && s < 70 },
  { label: "70-100 (strong)", test: (s) => s !== null && s >= 70 },
];

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
  const kse100 = symbols
    .filter((s) => marketWatch.get(s.symbol)?.isKse100)
    .map((s) => s.symbol);
  const pool = kse100.length > 0 ? kse100 : symbols.map((s) => s.symbol);
  return pool.slice(0, opts.limit);
}

/**
 * Simulates one BUY_SIGNAL trade opened at index `entryIdx`, closing on the
 * app's stated exit plan. Returns the trade's return (fractional) and how
 * many sessions it held.
 */
function simulateTrade(closes, rsi14, entryIdx) {
  const entryPrice = closes[entryIdx];
  const maxExit = Math.min(closes.length - 1, entryIdx + HOLD_DAYS);
  for (let i = entryIdx + 1; i <= maxExit; i++) {
    const ret = closes[i] / entryPrice - 1;
    if (ret >= TARGET_GAIN) return { return: ret, days: i - entryIdx, reason: "target" };
    if (rsi14[i] !== null && rsi14[i] >= RSI_RECROSS) {
      return { return: ret, days: i - entryIdx, reason: "rsi-recross" };
    }
  }
  return { return: closes[maxExit] / entryPrice - 1, days: maxExit - entryIdx, reason: "time-stop" };
}

async function backtestSymbol(symbol, results) {
  let series;
  try {
    series = await fetchEodSeries(symbol);
  } catch (err) {
    console.warn(`  [skip] ${symbol}: ${err.message}`);
    return;
  }
  if (series.length < 220) return; // not enough history for SMA200 + MACD warm-up + a hold window

  const adjusted = adjustForCorporateActions(series);
  const closes = adjusted.map((p) => p.close);
  const volumes = adjusted.map((p) => p.volume);

  const rsi14 = calculateRSISeries(closes, 14);
  const rsi2 = calculateRSISeries(closes, 2);
  const sma200 = calculateSMA(closes, 200);
  const macd = calculateMACD(closes);

  for (let i = 200; i < closes.length - 1; i++) {
    const r14 = rsi14[i];
    const r2 = rsi2[i];
    if (r14 === null || r2 === null) continue;
    const buySignal = r14 <= BUY_SIGNAL.rsi14Max && r2 <= BUY_SIGNAL.rsi2Max;
    if (!buySignal) continue;

    const priorVolumes = volumes.slice(Math.max(0, i - 20), i).filter((v) => Number.isFinite(v) && v > 0);
    const avgVolume20 = priorVolumes.length > 0 ? priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length : null;

    const composite = computeCompositeScore({
      r14,
      r2,
      price: closes[i],
      sma200: sma200[i],
      currentVolume: volumes[i],
      avgVolume20,
      macdHistogram: macd.histogram[i],
      prevMacdHistogram: macd.histogram[i - 1],
    });
    const score = composite ? composite.score : null;
    const breakdown = composite ? composite.breakdown : {};

    const trade = simulateTrade(closes, rsi14, i);
    results.push({ symbol, score, breakdown, ...trade });
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

/**
 * Correlates the overall score and each of its four components against the
 * trade's actual forward return, across every trade that has that
 * component. A component with a correlation near 0 is carrying no real
 * signal and is just adding noise to the weighted total; only a
 * consistently positive correlation across a decent sample justifies its
 * weight in SCORE_WEIGHTS.
 */
function reportCorrelations(results) {
  console.log("\n== Correlation of score / component vs. actual forward return ==");
  const withScore = results.filter((r) => r.score !== null);
  const scoreCorr = correlation(
    withScore.map((r) => r.score),
    withScore.map((r) => r.return)
  );
  console.log(
    `${"overall score".padEnd(16)} n=${String(withScore.length).padEnd(5)} r=${scoreCorr === null ? "n/a" : scoreCorr.toFixed(3)}`
  );

  for (const key of ["rsi", "trend", "volume", "macd"]) {
    const withKey = results.filter((r) => r.breakdown && r.breakdown[key] !== undefined);
    const corr = correlation(
      withKey.map((r) => r.breakdown[key]),
      withKey.map((r) => r.return)
    );
    console.log(
      `${key.padEnd(16)} n=${String(withKey.length).padEnd(5)} r=${corr === null ? "n/a" : corr.toFixed(3)}`
    );
  }
  console.log(
    "\nPearson r ranges -1..+1. Near 0 = no linear relationship with forward return\n" +
      "(the component isn't predictive here); positive = higher component score tends\n" +
      "to precede better returns; negative = the opposite of what's intended. A weight\n" +
      "in SCORE_WEIGHTS is only justified by a consistently positive r on a large sample."
  );
}

function summarize(results) {
  console.log(`\n${results.length} BUY_SIGNAL trades simulated across all symbols.\n`);

  function report(label, rows) {
    if (rows.length === 0) {
      console.log(`${label.padEnd(28)} n=0`);
      return;
    }
    const wins = rows.filter((r) => r.return > 0).length;
    const winRate = ((wins / rows.length) * 100).toFixed(1);
    const avgReturn = ((rows.reduce((a, r) => a + r.return, 0) / rows.length) * 100).toFixed(2);
    const medianReturn =
      (
        [...rows].sort((a, b) => a.return - b.return)[Math.floor(rows.length / 2)].return * 100
      ).toFixed(2);
    console.log(
      `${label.padEnd(28)} n=${String(rows.length).padEnd(5)} win-rate=${winRate.padStart(5)}%  avg-return=${avgReturn.padStart(6)}%  median-return=${medianReturn.padStart(6)}%`
    );
  }

  console.log("== All BUY_SIGNAL trades, regardless of score ==");
  report("all trades", results);

  console.log("\n== BUY_SIGNAL trades, broken down by confidence score at entry ==");
  for (const bucket of SCORE_BUCKETS) {
    report(bucket.label, results.filter((r) => bucket.test(r.score)));
  }

  console.log(
    "\nIf the score is doing its job, win-rate/avg-return should trend upward from the\n" +
      "\"weak\" bucket to the \"strong\" bucket. If they're flat or inverted across a large\n" +
      "enough sample, the score isn't adding predictive value beyond the RSI screener\n" +
      "alone, and the weights (lib/indicators.js SCORE_WEIGHTS) should be revisited."
  );

  reportCorrelations(results);
}

async function main() {
  const opts = parseArgs();
  const symbols = await pickSymbols(opts);
  console.log(`Backtesting ${symbols.length} symbol(s): ${symbols.join(", ")}\n`);

  const results = [];
  let done = 0;
  await runWithConcurrency(symbols, opts.concurrency, async (symbol) => {
    await backtestSymbol(symbol, results);
    done++;
    process.stdout.write(`\rFetched ${done}/${symbols.length} symbols...`);
  });
  console.log("");

  summarize(results);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
