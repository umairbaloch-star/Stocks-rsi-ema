import { fetchSymbols, fetchEodSeries, fetchMarketWatch } from "./psx";
import {
  calculateRSISeries,
  lastRSIValue,
  resampleSeries,
  adjustForCorporateActions,
  RSI_INTERVALS,
  RSI_PERIODS,
  BUY_SIGNAL,
} from "./rsi";

const TTL_MS = 15 * 60 * 1000; // 15 minutes
// From a non-blocked IP (localhost in Pakistan, or a Pakistan-based VPS) PSX
// serves requests fine and tolerates plenty of parallelism, so the default is
// tuned for a fast fill. Foreign cloud IPs (Render, etc.) get their
// connections reset (UND_ERR_SOCKET) under load — if you must run there, set
// PSX_FETCH_CONCURRENCY=4 (or lower) to avoid tripping PSX's rate limiter.
const CONCURRENCY = Number(process.env.PSX_FETCH_CONCURRENCY) || 16;
const RETRY_CONCURRENCY = Number(process.env.PSX_RETRY_CONCURRENCY) || 8;
const RETRY_PASS_DELAY_MS = Number(process.env.PSX_RETRY_DELAY_MS) || 5000; // cool-down before retrying
const FALLBACK_CORE_SIZE = 100; // if KSE-100 can't be identified, use the first N symbols
// A stock trading under this many shares today is too illiquid for a swing
// hold — a compelling RSI dip can just mean nobody's trading it, and thin
// volume makes both entry and the required exit within 1-2 weeks unreliable
// (wide spreads, no counterparty to sell to). Volume comes from the single
// market-watch page already fetched for every symbol, so low-volume stocks
// are skipped BEFORE their per-symbol history fetch — filtering here saves
// the request too, not just hides the result.
const MIN_DAILY_VOLUME = Number(process.env.PSX_MIN_VOLUME) || 100_000;

// Two-phase, in-memory cache. "Core" = the KSE-100 index stocks, fetched up
// front so the meaningful ~100 stocks appear fast without hammering PSX with
// all ~750 requests at once. "Rest" = every other equity, fetched only once
// the user asks for it via the "Load more" button. Both phases merge records
// in one symbol at a time so the API never blocks on a full fetch. Because
// this lives in the server process's memory, it needs a long-lived server.
const state = {
  bySymbol: new Map(), // all loaded records, keyed by symbol (core + rest)
  seriesBySymbol: new Map(), // adjusted daily {date, close} series, server-side only (for /api/history)
  lowVolumeSymbols: new Set(), // symbols currently hidden for trading under MIN_DAILY_VOLUME
  watchedSymbols: new Set(), // client's current watchlist — exempt from the volume floor
  coreSymbols: [], // KSE-100 metas (or the fallback first-N)
  restSymbols: [], // every other equity meta
  partitionReady: false, // symbol list + KSE-100 set fetched, partition known
  usingFallback: false, // KSE-100 couldn't be identified; core = first N symbols

  coreStarted: false,
  coreLoaded: 0,
  coreTotal: 0,
  coreDone: false,
  coreFailed: 0,

  restRequested: false, // user clicked "Load more" at least once
  restStarted: false,
  restLoaded: 0,
  restTotal: 0,
  restDone: false,
  restFailed: 0,

  updatedAt: null, // set whenever a phase finishes a full pass
  liveUpdatedAt: null, // set whenever a live-price refresh completes
};

let coreRefreshing = false;
let restRefreshing = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runWithConcurrency(items, limit, worker) {
  let nextIndex = 0;

  async function runNext() {
    const current = nextIndex++;
    if (current >= items.length) return;
    await worker(items[current], current);
    return runNext();
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, runNext);
  await Promise.all(runners);
}

async function buildStockRecord(meta) {
  // The volume floor only applies to the "rest" of the market — every
  // KSE-100 constituent always shows regardless of its volume (it's the
  // core index, not a filtered-for-liquidity list), and a symbol the user
  // has starred stays visible even if it's since gone thin, so a stock
  // doesn't vanish out from under a position they're already holding.
  const exempt = meta.isKse100 || state.watchedSymbols.has(meta.symbol);

  // Skip the history fetch entirely for illiquid symbols — volume is already
  // known from market-watch, so there's no need to spend a request on them.
  // `null` = confirmed zero trades today; a number below the floor is thin
  // trading either way. `undefined` (no market-watch data at all) is left
  // alone — unknown liquidity is never treated as low liquidity.
  if (
    !exempt &&
    (meta.volume === null || (typeof meta.volume === "number" && meta.volume < MIN_DAILY_VOLUME))
  ) {
    state.lowVolumeSymbols.add(meta.symbol);
    return null;
  }
  state.lowVolumeSymbols.delete(meta.symbol);

  // Network/feed errors propagate to the caller so a transient failure
  // (connection reset, 503 under load) can be distinguished from a
  // symbol that's intentionally excluded (returns null below).
  const series = await fetchEodSeries(meta.symbol);
  if (series.length < 20) return null; // not enough history to be meaningful

  const latest = series[series.length - 1];
  if (!latest.close) return null; // suspended/inactive symbol — feed reports 0 for every close

  // Back-adjust for splits/bonuses so an artificial price jump (e.g. a 1:1
  // bonus halving the price) doesn't poison RSI for weeks — matches how
  // TradingView shows adjusted prices. Newest bars keep their scale.
  const adjustedSeries = adjustForCorporateActions(series);

  // The timeseries/eod feed's most recent "close" is stale during a live
  // session (it lags the current price), which throws the latest RSI off vs
  // TradingView. Overwrite the last bar's close with the live market-watch
  // current price (same scale as the newest, unadjusted bars).
  const price = meta.currentPrice != null && meta.currentPrice > 0 ? meta.currentPrice : latest.close;
  const adjusted = adjustedSeries.slice();
  adjusted[adjusted.length - 1] = { ...adjusted[adjusted.length - 1], close: price };

  const record = {
    symbol: meta.symbol,
    name: meta.name,
    sector: meta.sector,
    isETF: meta.isETF,
    isKse100: Boolean(meta.isKse100),
    price,
    volume: meta.volume ?? null,
    asOf: latest.date,
    ...computeRsiFields(adjusted),
  };

  state.seriesBySymbol.set(meta.symbol, adjusted);
  return record;
}

/**
 * The latest RSI at every look-back period × chart interval, computed on
 * candles resampled from the full daily history — matches TradingView's RSI
 * at that period and chart interval — plus the daily-candle swing-entry
 * signal (see BUY_SIGNAL in lib/rsi.js). The whole grid shares the same
 * closes, so it's nearly free to compute and the frontend switches
 * period/interval instantly without refetching. Chart history is NOT
 * shipped with a record — the /api/history endpoint computes it on demand
 * from `seriesBySymbol`, which keeps the main payload small.
 */
function computeRsiFields(adjusted) {
  const rsi = {};
  for (const { period } of RSI_PERIODS) rsi[period] = {};
  for (const interval of RSI_INTERVALS) {
    const closes = resampleSeries(adjusted, interval).map((p) => p.close);
    for (const { period } of RSI_PERIODS) {
      rsi[period][interval.key] = lastRSIValue(calculateRSISeries(closes, period));
    }
  }
  const r14 = rsi[14]["1D"];
  const r2 = rsi[2]["1D"];
  const buySignal =
    r14 !== null && r2 !== null && r14 <= BUY_SIGNAL.rsi14Max && r2 <= BUY_SIGNAL.rsi2Max;
  return { rsi, buySignal };
}

async function processSymbol(meta) {
  try {
    return { record: await buildStockRecord(meta), failed: false };
  } catch {
    return { record: null, failed: true };
  }
}

/**
 * Fetches RSI for a group of symbols with limited concurrency, retrying
 * symbols that fail transiently once after a cool-down. `bumpLoaded` and
 * `bumpTotal` update the relevant phase's progress counters. Returns the
 * count still failing after the retry pass.
 */
async function fetchGroup(symbols, bumpLoaded, bumpTotal) {
  const retryQueue = [];

  await runWithConcurrency(symbols, CONCURRENCY, async (meta) => {
    const { record, failed } = await processSymbol(meta);
    bumpLoaded();
    if (record) state.bySymbol.set(meta.symbol, record);
    else if (failed) retryQueue.push(meta);
    // record === null && !failed means intentionally excluded — not retried
  });

  if (retryQueue.length === 0) return 0;

  // Grow the phase total to include the retry pass so the frontend keeps
  // showing progress (and polling quickly) until the retries finish.
  bumpTotal(retryQueue.length);
  await sleep(RETRY_PASS_DELAY_MS);

  let stillFailed = 0;
  await runWithConcurrency(retryQueue, RETRY_CONCURRENCY, async (meta) => {
    const { record, failed } = await processSymbol(meta);
    bumpLoaded();
    if (record) state.bySymbol.set(meta.symbol, record);
    else if (failed) stillFailed++;
  });
  return stillFailed;
}

// Fetches the equity list and the market-watch data (KSE-100 membership +
// live current prices), attaches each symbol's current price to its meta, and
// splits the equities into core (KSE-100) and rest. Falls back to "first N
// symbols" as core if market-watch can't be reached, so the app still works.
async function loadPartition() {
  const symbols = await fetchSymbols();

  let marketWatch = new Map();
  try {
    marketWatch = await fetchMarketWatch();
  } catch (err) {
    console.error(`[cache] market-watch lookup failed: ${err.name}: ${err.message}`);
  }

  // A real fetch returns hundreds of rows; an empty map only happens when
  // the whole lookup failed (network error, or a markup change breaking the
  // parser) — that's the ONE case "no row for this symbol" should be read as
  // "unknown" rather than "not currently trading."
  const marketWatchOk = marketWatch.size > 0;

  for (const s of symbols) {
    const info = marketWatch.get(s.symbol);
    s.currentPrice = info && info.current != null ? info.current : undefined;
    // Tri-state, deliberately:
    //  - row present, volume cell blank (a real no-trade day) -> `null`,
    //    "known: zero trades."
    //  - no row at all, but market-watch itself loaded fine -> also `null`.
    //    A symbol missing from an otherwise-successful snapshot isn't
    //    actively trading today, same conclusion as a blank cell.
    //  - no row AND the market-watch fetch failed outright -> `undefined`,
    //    "unknown" — never excluded on missing data, only ever on a
    //    confirmed thin/no-trade day, so an outage can't empty the app.
    s.volume = info ? (info.volume ?? null) : marketWatchOk ? null : undefined;
    s.isKse100 = Boolean(info?.isKse100);
  }

  const kse100Count = [...marketWatch.values()].filter((v) => v.isKse100).length;
  if (kse100Count === 0) {
    state.usingFallback = true;
    state.coreSymbols = symbols.slice(0, FALLBACK_CORE_SIZE);
    state.restSymbols = symbols.slice(FALLBACK_CORE_SIZE);
  } else {
    state.usingFallback = false;
    state.coreSymbols = symbols.filter((s) => marketWatch.get(s.symbol)?.isKse100);
    state.restSymbols = symbols.filter((s) => !marketWatch.get(s.symbol)?.isKse100);
  }

  state.coreTotal = state.coreSymbols.length;
  state.restTotal = state.restSymbols.length;
  state.partitionReady = true;
}

async function refreshCore() {
  state.coreLoaded = 0;
  state.coreDone = false;
  try {
    await loadPartition();
  } catch (err) {
    console.error(`[cache] loadPartition failed after retries: ${err.name}: ${err.message}`);
    throw err;
  }
  state.coreFailed = await fetchGroup(
    state.coreSymbols,
    () => state.coreLoaded++,
    (n) => (state.coreTotal += n)
  );
  state.coreDone = true;
  state.updatedAt = Date.now();
}

async function refreshRest() {
  state.restLoaded = 0;
  state.restDone = false;
  state.restFailed = await fetchGroup(
    state.restSymbols,
    () => state.restLoaded++,
    (n) => (state.restTotal += n)
  );
  state.restDone = true;
  state.updatedAt = Date.now();
}

function triggerCore() {
  if (coreRefreshing) return;
  coreRefreshing = true;
  state.coreStarted = true;
  refreshCore()
    .catch(() => {})
    .finally(() => {
      coreRefreshing = false;
    });
}

function triggerRest() {
  if (restRefreshing || !state.partitionReady) return;
  restRefreshing = true;
  state.restStarted = true;
  refreshRest()
    .catch(() => {})
    .finally(() => {
      restRefreshing = false;
    });
}

/**
 * Returns whatever data is loaded right now without blocking. By default
 * only the KSE-100 "core" is fetched; pass `includeRest` (set once the user
 * clicks "Load more") to also fetch every other equity. `loadedCount` /
 * `totalCount` reflect the currently-active scope so the frontend's progress
 * bar works unchanged, and `hasMore` tells it when to show the button.
 */
// PSX's historical bars only change once per trading day — ALL intraday
// freshness lives in the current price, which the market-watch page serves
// in a single request. So a user-triggered refresh re-fetches just that one
// page, swaps every stock's last close for its live price, and recomputes
// the RSI grids from the cached history (pure CPU) — genuinely fresh RSI on
// every click without re-crawling ~750 history endpoints. A small floor
// keeps a click-happy user from hammering the market-watch page itself, and
// concurrent requests share one in-flight refresh.
const LIVE_REFRESH_MIN_MS = 10 * 1000;
let liveRefreshPromise = null;

async function applyLivePrices() {
  const marketWatch = await fetchMarketWatch();
  for (const [symbol, record] of state.bySymbol) {
    const info = marketWatch.get(symbol);
    const series = state.seriesBySymbol.get(symbol);
    if (!info || info.current == null || info.current <= 0 || !series || series.length === 0) {
      continue;
    }
    // Volume has fallen below the liquidity floor since it was loaded — drop
    // it from the results now, same as it would have been skipped on a
    // fresh fetch. It reappears if a later full refresh finds volume back up.
    // KSE-100 members and starred (watchlisted) symbols are exempt, same as
    // in buildStockRecord — a stock the user is tracking should never
    // disappear on them mid-hold just because it went quiet for a session.
    const exempt = record.isKse100 || state.watchedSymbols.has(symbol);
    if (!exempt && info.volume != null && info.volume < MIN_DAILY_VOLUME) {
      state.bySymbol.delete(symbol);
      state.seriesBySymbol.delete(symbol);
      state.lowVolumeSymbols.add(symbol);
      continue;
    }
    if (info.volume != null) record.volume = info.volume;
    if (record.price === info.current) continue; // unchanged — RSI grid still valid
    record.price = info.current;
    const updated = series.slice();
    updated[updated.length - 1] = { ...updated[updated.length - 1], close: info.current };
    state.seriesBySymbol.set(symbol, updated);
    Object.assign(record, computeRsiFields(updated));
  }
  state.liveUpdatedAt = Date.now();
}

export async function refreshLivePrices() {
  if (state.liveUpdatedAt && Date.now() - state.liveUpdatedAt < LIVE_REFRESH_MIN_MS) return;
  if (!liveRefreshPromise) {
    liveRefreshPromise = applyLivePrices()
      .catch((err) => {
        console.error(`[cache] live price refresh failed: ${err.name}: ${err.message}`);
      })
      .finally(() => {
        liveRefreshPromise = null;
      });
  }
  return liveRefreshPromise;
}

/**
 * Computes the RSI trend series for one symbol at one look-back period and
 * chart interval, on demand, from the server-side cached daily series.
 * Returns the last ~150 points as `[{ date, rsi }]`, or null when the
 * symbol isn't loaded yet or the period/interval is unknown.
 */
export function getRsiHistory(symbol, intervalKey, period = 14) {
  const interval = RSI_INTERVALS.find((iv) => iv.key === intervalKey);
  const knownPeriod = RSI_PERIODS.some((p) => p.period === period);
  const series = state.seriesBySymbol.get(symbol);
  if (!interval || !knownPeriod || !series) return null;

  const resampled = resampleSeries(series, interval);
  const rsiSeries = calculateRSISeries(resampled.map((p) => p.close), period);
  return resampled
    .map((p, i) => ({ date: p.date, rsi: rsiSeries[i] }))
    .filter((p) => p.rsi !== null && p.rsi !== undefined)
    .slice(-150)
    .map((p) => ({ date: p.date, rsi: Number(p.rsi.toFixed(2)) }));
}

/**
 * Registers the client's current watchlist so the volume floor exempts it —
 * a starred stock stays visible even if its liquidity has since dropped
 * below the threshold, instead of disappearing out from under a position
 * the user is tracking. The client sends its full current list on every
 * request, so this simply replaces the set (a symbol removed from the
 * watchlist loses its exemption on the next request, same as unstarring
 * anything else).
 */
export function setWatchedSymbols(symbols) {
  state.watchedSymbols = new Set(symbols || []);
}

export async function getStockData(includeRest = false) {
  const stale = !state.updatedAt || Date.now() - state.updatedAt > TTL_MS;

  if (!state.coreStarted || (stale && !coreRefreshing)) {
    triggerCore();
  }

  if (includeRest) state.restRequested = true;
  if (state.restRequested && state.partitionReady) {
    if (!state.restStarted || (stale && !restRefreshing)) {
      triggerRest();
    }
  }

  const showRest = state.restRequested;
  const loadedCount = showRest ? state.coreLoaded + state.restLoaded : state.coreLoaded;
  const totalCount = showRest ? state.coreTotal + state.restTotal : state.coreTotal;
  const failedSymbols = state.coreFailed + (showRest ? state.restFailed : 0);

  return {
    stocks: Array.from(state.bySymbol.values()),
    // The freshest of "last full history pass" and "last live-price refresh"
    // — what "Updated" in the UI should honestly show.
    updatedAt: Math.max(state.updatedAt ?? 0, state.liveUpdatedAt ?? 0) || null,
    loadedCount,
    totalCount,
    failedSymbols,
    scope: showRest ? "all" : "core",
    hasMore: state.coreDone && !state.restRequested && state.restTotal > 0,
    restTotal: state.restTotal,
    usingFallback: state.usingFallback,
    minVolume: MIN_DAILY_VOLUME,
    lowVolumeHidden: state.lowVolumeSymbols.size,
  };
}
