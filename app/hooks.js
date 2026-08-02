"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const IDLE_POLL_MS = 5 * 60 * 1000;
const LOADING_POLL_MS = 2000;

/**
 * Fetches /api/stocks and keeps polling — fast while the server-side cache
 * is still filling, slow once idle. Shared by the dashboard and watchlist
 * pages so both stay live against the same server cache. `wantAll` starts
 * the full-universe fetch (the "Load more" phases) when true.
 *
 * `watchSymbols` (the current watchlist) rides along on every request so the
 * server can exempt starred stocks from its volume floor — otherwise a
 * position the user is tracking could silently vanish if its liquidity
 * drops, since that filter runs server-side and the watchlist only lives in
 * this browser's localStorage.
 *
 * `minVolume` optionally tightens the server's default volume floor (see
 * VOLUME_FILTER_PRESETS in lib/cache.js) — 0 or omitted just uses the
 * server default. Changing it triggers an immediate re-fetch instead of
 * waiting for the next poll.
 *
 * `search` (the search box's current text) rides along too so the server
 * can exempt an exact symbol match from the volume floor and fetch it on
 * demand if it isn't loaded yet (see ensureSearchSymbol in lib/cache.js) —
 * changing it triggers a debounced re-fetch rather than one per keystroke.
 */
export function useStocks(watchSymbols = [], minVolume = 0, search = "") {
  const [data, setData] = useState({
    stocks: [],
    updatedAt: null,
    loadedCount: 0,
    totalCount: 0,
    failedSymbols: 0,
    scope: "core",
    hasMore: false,
    restTotal: 0,
    usingFallback: false,
    baseMinVolume: 0,
    minVolume: 0,
    lowVolumeHidden: 0,
    extraHidden: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Read by the polling loop (whose closure is fixed on first render), so
  // clicking "Load more" switches every subsequent poll to the full scope.
  const wantAllRef = useRef(false);
  const watchSymbolsRef = useRef(watchSymbols);
  watchSymbolsRef.current = watchSymbols;
  const minVolumeRef = useRef(minVolume);
  minVolumeRef.current = minVolume;
  const searchRef = useRef(search);
  searchRef.current = search;
  const timerRef = useRef(null);
  const cancelledRef = useRef(false);

  const load = useCallback(async (force = false) => {
    try {
      const params = new URLSearchParams();
      if (wantAllRef.current) params.set("scope", "all");
      params.set("watch", watchSymbolsRef.current.join(","));
      if (minVolumeRef.current > 0) params.set("minVolume", String(minVolumeRef.current));
      if (searchRef.current.trim()) params.set("search", searchRef.current.trim());
      // force = the user pressed Refresh: the server re-fetches live prices
      // from PSX's market-watch page and recomputes RSI before answering.
      if (force) params.set("refresh", "1");
      const qs = params.toString();
      const res = await fetch(`/api/stocks${qs ? `?${qs}` : ""}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed to load data");
      setData(json);
      setError(null);
      return json;
    } catch (err) {
      setError(err.message);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const runPoll = useCallback(async () => {
    if (cancelledRef.current) return;
    const result = await load();
    if (cancelledRef.current) return;
    const stillFilling =
      !result || result.totalCount === 0 || result.loadedCount < result.totalCount;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(runPoll, stillFilling ? LOADING_POLL_MS : IDLE_POLL_MS);
  }, [load]);

  useEffect(() => {
    cancelledRef.current = false;
    runPoll();
    return () => {
      cancelledRef.current = true;
      clearTimeout(timerRef.current);
    };
  }, [runPoll]);

  // Re-fetch immediately when the caller changes the volume filter, instead
  // of waiting out the (possibly 5-minute idle) poll interval. Skips the
  // mount render — the effect above already fetches with the initial value.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    clearTimeout(timerRef.current);
    runPoll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minVolume]);

  // Same immediate re-fetch on a search-box change, but debounced — a
  // symbol paste (or fast typing) shouldn't fire one request per keystroke.
  const searchDebounceRef = useRef(null);
  const searchMountedRef = useRef(false);
  useEffect(() => {
    if (!searchMountedRef.current) {
      searchMountedRef.current = true;
      return;
    }
    clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      clearTimeout(timerRef.current);
      runPoll();
    }, 400);
    return () => clearTimeout(searchDebounceRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);

  const loadMore = useCallback(() => {
    wantAllRef.current = true;
    // Hide the button's state immediately client-side; the server confirms on
    // the next poll. Cancel any pending slow idle poll and resume fast
    // polling so the rest of the stocks visibly fill in.
    setData((d) => ({ ...d, hasMore: false }));
    clearTimeout(timerRef.current);
    runPoll();
  }, [runPoll]);

  const refresh = useCallback(() => {
    setLoading(true);
    load(true);
  }, [load]);

  return { ...data, loading, error, loadMore, refresh };
}

const WATCHLIST_KEY = "psx-rsi-watchlist";

/**
 * The user's watchlist, persisted in localStorage (the app has no accounts,
 * so the list is per-browser). Kept in sync across tabs via the `storage`
 * event.
 */
export function useWatchlist() {
  const [symbols, setSymbols] = useState([]);

  useEffect(() => {
    try {
      setSymbols(JSON.parse(localStorage.getItem(WATCHLIST_KEY) || "[]"));
    } catch {
      setSymbols([]);
    }
    const onStorage = (e) => {
      if (e.key !== WATCHLIST_KEY) return;
      try {
        setSymbols(JSON.parse(e.newValue || "[]"));
      } catch {}
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const toggle = useCallback((symbol) => {
    setSymbols((prev) => {
      const next = prev.includes(symbol)
        ? prev.filter((s) => s !== symbol)
        : [...prev, symbol];
      try {
        localStorage.setItem(WATCHLIST_KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);

  return { symbols, toggle };
}
