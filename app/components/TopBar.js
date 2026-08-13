"use client";

import Link from "next/link";

function BrandMark() {
  return (
    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-accent text-white shadow-sm">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="h-4 w-4"
        aria-hidden
      >
        <polyline points="2 12 6.5 12 9.5 5 14.5 19 17.5 12 22 12" />
      </svg>
    </div>
  );
}

function RefreshIcon({ spinning }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-3.5 w-3.5 ${spinning ? "animate-spin" : ""}`}
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

export function StarIcon({ filled, className = "h-4 w-4" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <polygon points="12 2.5 15.1 8.8 22 9.8 17 14.7 18.2 21.6 12 18.3 5.8 21.6 7 14.7 2 9.8 8.9 8.8" />
    </svg>
  );
}

function NavLink({ href, active, children }) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors sm:text-sm ${
        active ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink"
      }`}
    >
      {children}
    </Link>
  );
}

export default function TopBar({ page, subtitle, updatedAt, loading, onRefresh, watchlistCount }) {
  return (
    <header className="sticky top-0 z-20 border-b border-hairline bg-page/90 backdrop-blur supports-[backdrop-filter]:bg-page/75">
      <div className="mx-auto w-full max-w-[1600px] px-3 py-3 sm:px-6">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <BrandMark />
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold leading-tight text-ink sm:text-lg">
                stock-official(1-3weeks)03AUG2026
              </h1>
              {subtitle && (
                <p className="hidden truncate text-[11px] leading-tight text-ink-3 sm:block">
                  {subtitle}
                </p>
              )}
            </div>
            <nav className="ml-2 flex items-center gap-1 sm:ml-4">
              <NavLink href="/" active={page === "dashboard"}>
                Stocks
              </NavLink>
              <NavLink href="/watchlist" active={page === "watchlist"}>
                <StarIcon filled={page === "watchlist"} className="h-3.5 w-3.5" />
                Watchlist
                {watchlistCount > 0 && (
                  <span className="rounded-full bg-accent-soft px-1.5 text-[10px] font-semibold text-accent">
                    {watchlistCount}
                  </span>
                )}
              </NavLink>
            </nav>
          </div>
          <div className="flex shrink-0 items-center gap-3 text-xs text-ink-3 sm:text-sm">
            {updatedAt && (
              <span className="hidden items-center gap-1.5 whitespace-nowrap md:flex">
                <span
                  className="animate-live-pulse h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: "var(--up)" }}
                />
                Updated {new Date(updatedAt).toLocaleTimeString()}
              </span>
            )}
            <button
              onClick={onRefresh}
              className="flex items-center gap-1.5 rounded-lg border border-hairline bg-surface px-3 py-1.5 text-xs font-medium text-ink-2 shadow-sm transition-colors hover:bg-surface-2 hover:text-ink sm:text-sm"
            >
              <RefreshIcon spinning={loading} />
              Refresh
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}
