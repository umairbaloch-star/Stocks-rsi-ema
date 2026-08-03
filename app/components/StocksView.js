"use client";

import { useMemo, useState } from "react";
import StocksTable from "./StocksTable";
import MarketSummary from "./MarketSummary";
import { RSI_INTERVALS, RSI_PERIODS, BUY_SIGNAL } from "@/lib/rsi";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];
const DEFAULT_PAGE_SIZE = 25;
const DEFAULT_INTERVAL = "1D";
const DEFAULT_PERIOD = 14;

const FILTERS = [
  { key: "all", label: "All" },
  { key: "signals", label: "Buy signals" },
  { key: "oversold", label: "Oversold" },
  { key: "overbought", label: "Overbought" },
  { key: "kse100", label: "KSE-100" },
];

const INTERVAL_GROUPS = [...new Set(RSI_INTERVALS.map((iv) => iv.group))];

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.2" y2="16.2" />
    </svg>
  );
}

function ThresholdLegend({ thresholds }) {
  return (
    <div className="hidden items-center gap-3 text-[11px] text-ink-3 lg:flex">
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "var(--up)" }} />
        ≤ {thresholds.oversold} oversold
      </span>
      <span className="flex items-center gap-1.5">
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: "var(--down)" }} />
        ≥ {thresholds.overbought} overbought
      </span>
    </div>
  );
}

/**
 * The shared stock-list view: market summary, search + interval + quick
 * filters, the table, and pagination. Both the dashboard (all loaded
 * stocks) and the watchlist page (starred stocks only) render this against
 * their own slice. `contextLabel` names the slice in the footer.
 */
export default function StocksView({
  stocks,
  loading,
  contextLabel,
  usingFallback = false,
  watchlist,
  onToggleWatch,
  emptyState = null,
}) {
  const [search, setSearch] = useState("");
  const [quickFilter, setQuickFilter] = useState("all");
  const [intervalKey, setIntervalKey] = useState(DEFAULT_INTERVAL);
  const [period, setPeriod] = useState(DEFAULT_PERIOD);
  const [sortKey, setSortKey] = useState("symbol");
  const [sortDir, setSortDir] = useState("asc");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [expandedSymbol, setExpandedSymbol] = useState(null);

  const interval =
    RSI_INTERVALS.find((iv) => iv.key === intervalKey) ?? RSI_INTERVALS[0];
  const periodConfig = RSI_PERIODS.find((p) => p.period === period) ?? RSI_PERIODS[0];
  const thresholds = {
    oversold: periodConfig.oversold,
    overbought: periodConfig.overbought,
  };

  function handleSort(key) {
    if (key === sortKey) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(1);
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return stocks.filter((s) => {
      if (q && !s.symbol.toLowerCase().includes(q) && !(s.name || "").toLowerCase().includes(q)) {
        return false;
      }
      const v = s.rsi?.[period]?.[interval.key];
      if (quickFilter === "signals") return Boolean(s.buySignal);
      if (quickFilter === "oversold")
        return v !== null && v !== undefined && v <= thresholds.oversold;
      if (quickFilter === "overbought")
        return v !== null && v !== undefined && v >= thresholds.overbought;
      if (quickFilter === "kse100") return s.isKse100;
      return true;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stocks, search, quickFilter, interval.key, period]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const av = sortKey === "rsi" ? (a.rsi?.[period]?.[interval.key] ?? null) : a[sortKey];
      const bv = sortKey === "rsi" ? (b.rsi?.[period]?.[interval.key] ?? null) : b[sortKey];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === "string") {
        return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      }
      return sortDir === "asc" ? av - bv : bv - av;
    });
    return copy;
  }, [filtered, sortKey, sortDir, interval.key, period]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageItems = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const visibleFilters = usingFallback ? FILTERS.filter((f) => f.key !== "kse100") : FILTERS;

  return (
    <>
      <MarketSummary
        stocks={stocks}
        period={period}
        interval={interval}
        thresholds={thresholds}
      />

      {/* Search + interval + quick filters + threshold legend */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
          <label className="relative block w-full sm:w-56">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3">
              <SearchIcon />
            </span>
            <input
              type="text"
              placeholder="Search symbol or name…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              className="w-full rounded-lg border border-hairline bg-surface py-1.5 pl-9 pr-3 text-sm text-ink shadow-sm outline-none placeholder:text-ink-3 focus:border-accent/50 focus:ring-2 focus:ring-accent/25"
            />
          </label>
          {/* RSI look-back period — shorter round-trips oversold→overbought
              in days instead of months, suiting 1–2 week holds. */}
          <label className="flex w-fit items-center gap-1.5 text-xs text-ink-3">
            RSI:
            <select
              value={period}
              onChange={(e) => {
                setPeriod(Number(e.target.value));
                setPage(1);
              }}
              title="RSI look-back period — shorter reacts faster (RSI(5)/RSI(2) suit 1–2 week swing holds)"
              className="rounded-lg border border-hairline bg-surface px-2 py-1.5 text-xs font-medium text-ink shadow-sm outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/25"
            >
              {RSI_PERIODS.map((p) => (
                <option key={p.period} value={p.period}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {/* Chart interval, TradingView-style day-and-up rows. Sub-daily
              intervals need intraday history, which PSX's free feed doesn't
              provide. */}
          <label className="flex w-fit items-center gap-1.5 text-xs text-ink-3">
            Interval:
            <select
              value={interval.key}
              onChange={(e) => {
                setIntervalKey(e.target.value);
                setPage(1);
              }}
              title="Candle interval for RSI(14) — like TradingView's interval menu (PSX's free feed is end-of-day, so intervals start at 1 day)"
              className="rounded-lg border border-hairline bg-surface px-2 py-1.5 text-xs font-medium text-ink shadow-sm outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/25"
            >
              {INTERVAL_GROUPS.map((group) => (
                <optgroup key={group} label={group}>
                  {RSI_INTERVALS.filter((iv) => iv.group === group).map((iv) => (
                    <option key={iv.key} value={iv.key}>
                      {iv.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <div className="flex w-fit gap-0.5 rounded-lg bg-surface-2 p-0.5">
            {visibleFilters.map((f) => {
              const hint =
                f.key === "signals"
                  ? `Swing-entry setups: daily RSI(14) ≤ ${BUY_SIGNAL.rsi14Max} and RSI(2) ≤ ${BUY_SIGNAL.rsi2Max}. Exit: RSI(14) back above ~50, +5–8%, or ~10 sessions.`
                  : f.key === "oversold"
                    ? `RSI(${period}) ≤ ${thresholds.oversold} on ${interval.label} candles`
                    : f.key === "overbought"
                      ? `RSI(${period}) ≥ ${thresholds.overbought} on ${interval.label} candles`
                      : undefined;
              const active = quickFilter === f.key;
              return (
                <button
                  key={f.key}
                  onClick={() => {
                    setQuickFilter(f.key);
                    setPage(1);
                  }}
                  title={hint}
                  className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                    active ? "bg-surface text-ink shadow-sm" : "text-ink-3 hover:text-ink-2"
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>
        </div>
        <ThresholdLegend thresholds={thresholds} />
      </div>

      {loading ? (
        <p className="py-8 text-center text-sm text-ink-3">Loading…</p>
      ) : stocks.length === 0 && emptyState ? (
        emptyState
      ) : (
        <StocksTable
          stocks={pageItems}
          interval={interval}
          period={period}
          thresholds={thresholds}
          sortKey={sortKey}
          sortDir={sortDir}
          onSort={handleSort}
          expandedSymbol={expandedSymbol}
          onToggleExpand={(symbol) =>
            setExpandedSymbol((cur) => (cur === symbol ? null : symbol))
          }
          watchlist={watchlist}
          onToggleWatch={onToggleWatch}
        />
      )}

      <div className="flex flex-col gap-2 text-xs text-ink-3 sm:flex-row sm:items-center sm:justify-between sm:text-sm">
        <span>
          {sorted.length} stocks ({contextLabel}) — page {currentPage} of {totalPages}
        </span>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5">
            Rows:
            <select
              value={pageSize}
              onChange={(e) => {
                setPageSize(Number(e.target.value));
                setPage(1);
              }}
              className="rounded-md border border-hairline bg-surface px-2 py-1 text-ink-2"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
          <div className="flex gap-2">
            <button
              disabled={currentPage <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="rounded-md border border-hairline bg-surface px-3 py-1 text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-surface"
            >
              Previous
            </button>
            <button
              disabled={currentPage >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-md border border-hairline bg-surface px-3 py-1 text-ink-2 transition-colors hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-surface"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
