import { NextResponse } from "next/server";
import { fetchSymbols, fetchMarketWatch, fetchEodSeries } from "@/lib/psx";
import { calculateRSISeries, adjustForCorporateActions } from "@/lib/rsi";
import { computeSimpleSignal } from "@/lib/technicals";

const CONCURRENCY = 6; // gentler than the main cache's fetch — this is an on-demand, ad-hoc run
const DEFAULT_HOLD_DAYS = [5, 10, 15]; // ~1, 2, 3 trading weeks
const DEFAULT_LIMIT = 40;
// EMA50 + MACD(26,9) both need real runway before their reads are
// meaningful — matches MIN_HISTORY in lib/technicals.js, with a little
// extra so the earliest backtested day isn't right at that edge.
const WARMUP_DAYS = 60;

async function runWithConcurrency(items, limit, worker) {
  let next = 0;
  async function runNext() {
    const i = next++;
    if (i >= items.length) return;
    await worker(items[i]);
    return runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}

function emptyBucket() {
  return { total: 0, valid: 0, returnSum: 0 };
}

function recordOutcome(bucketsByCall, callType, holdKey, ret) {
  if (callType !== "Buy" && callType !== "Sell") return; // Watch has no directional claim to grade
  bucketsByCall[callType] ??= {};
  bucketsByCall[callType][holdKey] ??= emptyBucket();
  const b = bucketsByCall[callType][holdKey];
  b.total++;
  b.returnSum += ret;
  const valid = callType === "Buy" ? ret > 0 : ret < 0;
  if (valid) b.valid++;
}

function summarize(bucketsByCall) {
  const out = {};
  for (const [callType, byHold] of Object.entries(bucketsByCall)) {
    out[callType] = {};
    for (const [holdKey, b] of Object.entries(byHold)) {
      out[callType][holdKey] = {
        total: b.total,
        validPct: b.total ? Number(((b.valid / b.total) * 100).toFixed(1)) : null,
        avgReturnPct: b.total ? Number(((b.returnSum / b.total) * 100).toFixed(2)) : null,
      };
    }
  }
  return out;
}

/**
 * Backtests the live Buy/Sell/Watch rule (computeSimpleSignal in
 * lib/technicals.js) against real historical closes: at every past trading
 * day, recomputes the signal using ONLY data up through that day (RSI, EMA,
 * and MACD are all causal/rolling, so slicing the series at day i and
 * recomputing never looks ahead), then checks whether price actually moved
 * the called direction 1/2/3 trading weeks later.
 *
 * Also reports `baseline` — what the call would have been before the
 * RSI(5)-extended chase guard (see preExtendedSignal in computeSimpleSignal)
 * — so the fix's effect is directly visible: current vs. baseline validity
 * on the same historical days.
 *
 * Query params:
 *   symbols   comma-separated list, overrides scope (e.g. ?symbols=FFC,IMAGE,PRL)
 *   scope     "core" (KSE-100, default) | "all" (every equity — slow)
 *   limit     max symbols to test (default 40, ignored when `symbols` is set)
 *   hold      comma-separated trading-day windows (default "5,10,15" ~ 1-3 weeks)
 */
export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    const holdDays = (params.get("hold") || DEFAULT_HOLD_DAYS.join(","))
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (holdDays.length === 0) holdDays.push(...DEFAULT_HOLD_DAYS);
    const maxHold = Math.max(...holdDays);
    const limit = Number(params.get("limit")) > 0 ? Number(params.get("limit")) : DEFAULT_LIMIT;

    let symbols;
    const symbolsParam = params.get("symbols");
    if (symbolsParam) {
      symbols = symbolsParam
        .split(",")
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
    } else {
      const allSymbols = await fetchSymbols();
      const scope = params.get("scope") === "all" ? "all" : "core";
      if (scope === "all") {
        symbols = allSymbols.map((s) => s.symbol).slice(0, limit);
      } else {
        const marketWatch = await fetchMarketWatch();
        const core = allSymbols.filter((s) => marketWatch.get(s.symbol)?.isKse100);
        symbols = (core.length > 0 ? core : allSymbols).map((s) => s.symbol).slice(0, limit);
      }
    }

    const current = {};
    const baseline = {};
    const perSymbol = [];
    let failedSymbols = 0;

    await runWithConcurrency(symbols, CONCURRENCY, async (symbol) => {
      let series;
      try {
        series = await fetchEodSeries(symbol);
      } catch {
        failedSymbols++;
        return;
      }
      if (series.length < WARMUP_DAYS + maxHold + 1) return; // not enough history to backtest at all

      const adjusted = adjustForCorporateActions(series);
      const closes = adjusted.map((p) => p.close);
      const rsi14Series = calculateRSISeries(closes, 14);
      const rsi5Series = calculateRSISeries(closes, 5);

      let symbolSignals = 0;
      for (let i = WARMUP_DAYS; i < adjusted.length - maxHold; i++) {
        const r14 = rsi14Series[i];
        const r5 = rsi5Series[i];
        if (r14 === null || r5 === null) continue;

        const sub = adjusted.slice(0, i + 1);
        const sig = computeSimpleSignal(sub, r14, r5);
        if (!sig) continue;
        if (sig.signal === "Watch" && sig.preExtendedSignal === "Watch") continue;

        const entryPrice = adjusted[i].close;
        symbolSignals++;
        for (const hold of holdDays) {
          const holdKey = `${hold}d`;
          const futurePrice = adjusted[i + hold].close;
          const ret = (futurePrice - entryPrice) / entryPrice;
          recordOutcome(current, sig.signal, holdKey, ret);
          recordOutcome(baseline, sig.preExtendedSignal, holdKey, ret);
        }
      }
      perSymbol.push({ symbol, daysTested: adjusted.length - maxHold - WARMUP_DAYS, signalDays: symbolSignals });
    });

    return NextResponse.json({
      symbolsRequested: symbols.length,
      symbolsTested: perSymbol.length,
      failedSymbols,
      holdDays,
      // "current" = today's rule, including the RSI(5)-extended chase guard.
      current: summarize(current),
      // "baseline" = the rule as it stood before that guard — same historical
      // days, so the two summaries are a direct before/after comparison.
      baseline: summarize(baseline),
      perSymbol,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Backtest failed" },
      { status: 500 }
    );
  }
}
