"use client";

import { useState } from "react";
import TopBar from "./components/TopBar";
import StocksView from "./components/StocksView";
import VolumeFilter from "./components/VolumeFilter";
import { useStocks, useWatchlist } from "./hooks";

export default function Home() {
  const { symbols: watchlist, toggle: toggleWatch } = useWatchlist();
  const [minVolume, setMinVolume] = useState(0);
  const [search, setSearch] = useState("");
  const {
    stocks,
    updatedAt,
    loadedCount,
    totalCount,
    failedSymbols,
    scope,
    hasMore,
    restTotal,
    usingFallback,
    baseMinVolume,
    minVolume: effectiveMinVolume,
    lowVolumeHidden,
    extraHidden,
    loading,
    error,
    loadMore,
    refresh,
  } = useStocks(watchlist, minVolume, search);

  const stillFilling = totalCount === 0 || loadedCount < totalCount;
  const fillPercent = totalCount > 0 ? Math.round((loadedCount / totalCount) * 100) : 0;
  const scopeLabel =
    scope === "all" ? "all PSX stocks" : usingFallback ? "top stocks" : "KSE-100 stocks";
  const contextLabel = scope === "all" ? "all PSX" : usingFallback ? "top 100" : "KSE-100";

  return (
    <div className="min-h-screen bg-page">
      <TopBar
        page="dashboard"
        subtitle="RSI(14) at your chart interval — matches TradingView"
        updatedAt={updatedAt}
        loading={loading}
        onRefresh={refresh}
        watchlistCount={watchlist.length}
      />

      <main className="mx-auto w-full max-w-[1600px] space-y-4 px-3 py-4 sm:px-6">
        {stillFilling && (
          <div className="rounded-xl border border-hairline bg-surface px-4 py-2.5 shadow-sm">
            <div className="mb-1.5 flex items-center justify-between text-xs text-ink-2 sm:text-sm">
              <span>
                {totalCount === 0
                  ? "Fetching PSX symbol list…"
                  : `Loading ${scopeLabel} in the background — ${loadedCount} of ${totalCount} (${fillPercent}%)`}
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent transition-all duration-500"
                style={{ width: `${totalCount === 0 ? 5 : fillPercent}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <p
            className="rounded-xl border px-4 py-2.5 text-sm"
            style={{
              borderColor: "color-mix(in srgb, var(--down) 30%, transparent)",
              backgroundColor: "color-mix(in srgb, var(--down) 8%, var(--surface))",
              color: "var(--down)",
            }}
          >
            {error}
          </p>
        )}

        <VolumeFilter
          value={minVolume}
          onChange={setMinVolume}
          baseMinVolume={baseMinVolume}
        />

        <StocksView
          stocks={stocks}
          loading={loading}
          contextLabel={contextLabel}
          usingFallback={usingFallback}
          watchlist={watchlist}
          onToggleWatch={toggleWatch}
          search={search}
          onSearchChange={setSearch}
        />

        {hasMore && (
          <div className="flex justify-center">
            <button
              onClick={loadMore}
              className="rounded-lg border border-accent/30 bg-accent-soft px-4 py-2 text-sm font-medium text-accent transition-colors hover:border-accent/50"
            >
              Load all other PSX stocks ({restTotal} more)
            </button>
          </div>
        )}

        {!stillFilling && failedSymbols > 0 && (
          <p className="pb-1 text-xs sm:text-sm" style={{ color: "var(--warning)" }}>
            {failedSymbols} symbol{failedSymbols === 1 ? "" : "s"} unavailable (PSX feed
            error) — will retry on next refresh
          </p>
        )}

        {(lowVolumeHidden > 0 || extraHidden > 0) && (
          <div className="space-y-0.5 pb-4 text-xs text-ink-3 sm:text-sm">
            {lowVolumeHidden > 0 && (
              <p>
                {lowVolumeHidden} illiquid stock{lowVolumeHidden === 1 ? "" : "s"} hidden —
                trading under {baseMinVolume.toLocaleString()} shares today
              </p>
            )}
            {extraHidden > 0 && (
              <p>
                {extraHidden} more stock{extraHidden === 1 ? "" : "s"} hidden by your{" "}
                {effectiveMinVolume.toLocaleString()}-share volume filter
              </p>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
