"use client";

import { Fragment, useEffect, useState } from "react";
import RSIChart from "./RSIChart";
import { StarIcon } from "./TopBar";
import { RSI_PERIODS } from "@/lib/rsi";
function tradingViewUrl(symbol) {
  return `https://www.tradingview.com/chart/?symbol=PSX:${encodeURIComponent(symbol)}`;
}

// star, symbol, name, price, RSI, volume, entry, exit-today, exit-1to3w,
// confidence, EMA trend, MACD, Signal
const COLUMN_COUNT = 13;

// A value's zone decides the meter-fill color: the two extremes wear the
// reserved status hues (oversold = green "buy" signal, overbought = red),
// everything in between the neutral accent. The number itself always stays
// in ink — the colored meter beside it carries the signal, and the fill's
// *position* on the 0–100 track repeats it spatially, so color is never the
// only channel. Thresholds follow the selected look-back period (30/70 for
// RSI(14), 10/90 for RSI(2)).
function rsiZone(value, thresholds) {
  if (value >= thresholds.overbought) return "overbought";
  if (value <= thresholds.oversold) return "oversold";
  return "neutral";
}

const ZONE_FILL = {
  overbought: "var(--down)",
  oversold: "var(--up)",
  neutral: "var(--accent)",
};

function RSICell({ value, thresholds, align = "center" }) {
  if (value === null || value === undefined) {
    return <span className="text-sm text-ink-3">—</span>;
  }
  const zone = rsiZone(value, thresholds);
  const extreme = zone !== "neutral";
  return (
    <span
      className={`inline-flex w-20 flex-col gap-[5px] ${
        align === "center" ? "items-center" : "items-end"
      }`}
      title={zone === "neutral" ? undefined : zone}
    >
      <span
        className={`font-mono text-[13px] leading-none tabular-nums text-ink ${
          extreme ? "font-semibold" : ""
        }`}
      >
        {Number(value).toFixed(1)}
      </span>
      <span className="relative block h-[3px] w-full rounded-full bg-surface-2">
        <span
          className="absolute left-0 top-0 h-full rounded-full"
          style={{
            width: `${Math.max(3, Math.min(100, value))}%`,
            backgroundColor: ZONE_FILL[zone],
          }}
        />
        {/* oversold / overbought threshold ticks over the track */}
        <span
          className="absolute top-[-2px] h-[7px] w-px bg-ink/20"
          style={{ left: `${thresholds.oversold}%` }}
        />
        <span
          className="absolute top-[-2px] h-[7px] w-px bg-ink/20"
          style={{ left: `${thresholds.overbought}%` }}
        />
      </span>
    </span>
  );
}

function formatPrice(value) {
  if (value === null || value === undefined) return "—";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatVolume(value) {
  if (value === null || value === undefined) return "—";
  if (value >= 1e9) return (value / 1e9).toFixed(2) + "B";
  if (value >= 1e6) return (value / 1e6).toFixed(2) + "M";
  if (value >= 1e3) return (value / 1e3).toFixed(1) + "K";
  return String(value);
}

const CONFIDENCE_STYLE = {
  High: { color: "var(--up-text)", bg: "var(--up)" },
  Medium: { color: "#8a6400", bg: "var(--warning)" },
  Low: { color: "var(--ink-3)", bg: "var(--ink-3)" },
};

/**
 * Plain-language readout of the factors behind an entry/exit/confidence
 * call — used as the badge's tooltip and repeated in the expanded row so
 * the "why" is never more than a click away.
 */
function analysisSummary(a) {
  if (!a) return "Not enough price history yet for a technical read (needs 30+ trading days).";
  const f = a.factors;
  const parts = [
    `RSI(14) ${f.rsi14 ?? "—"}, RSI(5) ${f.rsi5 ?? "—"}`,
    `MACD histogram ${f.macdHist ?? "—"} (${f.macdHist > 0 ? "bullish" : f.macdHist < 0 ? "bearish" : "flat"})`,
    `MAs: 20d ${f.sma20 ?? "—"}, 50d ${f.sma50 ?? "n/a"}, 200d ${f.sma200 ?? "n/a"}`,
    `Volume ${f.volumeRatio !== null ? `${f.volumeRatio}× the 20-day average` : "n/a"}`,
    `Support ~${f.support}, resistance ~${f.resistance} (approximated from closing prices — PSX's feed has no intraday high/low)`,
    `Trend ${f.trend}`,
    `${f.breakout === "none" ? "No breakout/breakdown confirmed" : f.breakout === "breakout" ? "Breakout above resistance, volume-confirmed" : "Breakdown below support, volume-confirmed"}`,
    f.candlestick ? `${f.candlestick} on the last candle` : "No notable candlestick pattern",
  ];
  return parts.join(" · ");
}

/**
 * Plain-language readout of the simple RSI+EMA+MACD+volume signal — the
 * expanded-row counterpart to analysisSummary above, which stays scoped to
 * the original Entry/Exit/Confidence factors.
 */
function signalSummary(s) {
  const parts = [
    `RSI(14) ${s.rsi14 ?? "—"}`,
    `EMA trend ${s.emaTrend ?? "n/a"} (EMA20 ${s.ema20 ?? "n/a"}, EMA50 ${s.ema50 ?? "n/a"})`,
    `MACD ${s.macdStatus ?? "n/a"} (histogram ${s.macdHist ?? "n/a"})`,
    `Volume ${s.volumeRatio !== null ? `${s.volumeRatio}× the 20-day average` : "n/a"}${
      s.thinVolume ? " — thin, downgrades a would-be Buy/Sell to Watch" : ""
    }`,
  ];
  return parts.join(" · ");
}

function EntryExitCell({ value }) {
  if (value === null || value === undefined) {
    return <span className="text-sm text-ink-3">—</span>;
  }
  return (
    <span className="font-mono text-[13px] tabular-nums text-ink">
      {formatPrice(value)}
    </span>
  );
}

function ConfidenceBadge({ analysis }) {
  if (!analysis) {
    return (
      <span className="text-xs text-ink-3" title={analysisSummary(null)}>
        —
      </span>
    );
  }
  const style = CONFIDENCE_STYLE[analysis.confidence] ?? CONFIDENCE_STYLE.Low;
  return (
    <span
      title={analysisSummary(analysis)}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide"
      style={{
        color: style.color,
        backgroundColor: `color-mix(in srgb, ${style.bg} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${style.bg} 40%, transparent)`,
      }}
    >
      {analysis.confidence}
    </span>
  );
}

// Green = bullish/buy, orange = watch/neutral, red = bearish/sell — the
// consistent three-way color language for every badge on this simple
// RSI+EMA+MACD+Volume read (separate from the Confidence badge above).
const CALL_STYLE = {
  Bullish: { color: "var(--up-text)", bg: "var(--up)" },
  Buy: { color: "var(--up-text)", bg: "var(--up)" },
  Neutral: { color: "#8a6400", bg: "var(--warning)" },
  Watch: { color: "#8a6400", bg: "var(--warning)" },
  Bearish: { color: "var(--down)", bg: "var(--down)" },
  Sell: { color: "var(--down)", bg: "var(--down)" },
};

function CallBadge({ label, title }) {
  if (!label) return <span className="text-xs text-ink-3">—</span>;
  const style = CALL_STYLE[label] ?? CALL_STYLE.Neutral;
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide"
      style={{
        color: style.color,
        backgroundColor: `color-mix(in srgb, ${style.bg} 16%, transparent)`,
        border: `1px solid color-mix(in srgb, ${style.bg} 40%, transparent)`,
      }}
    >
      {label}
    </span>
  );
}

/** EMA(20/50) trend: price and EMA20 and EMA50 all sloping the same way. */
function EmaBadge({ signal }) {
  if (!signal || !signal.emaTrend) return <span className="text-xs text-ink-3">—</span>;
  return (
    <CallBadge
      label={signal.emaTrend}
      title={`EMA20 ${signal.ema20 ?? "n/a"} · EMA50 ${signal.ema50 ?? "n/a"}`}
    />
  );
}

/** MACD(12,26,9) histogram sign. */
function MacdBadge({ signal }) {
  if (!signal || !signal.macdStatus) return <span className="text-xs text-ink-3">—</span>;
  return <CallBadge label={signal.macdStatus} title={`MACD histogram ${signal.macdHist}`} />;
}

/**
 * The Buy/Sell/Watch call: RSI(14) + EMA trend + MACD vote bullish/bearish/
 * neutral, volume confirms (or, if thin, downgrades a would-be call to
 * Watch) — see computeSimpleSignal in lib/technicals.js for the exact rule.
 */
function SignalBadge({ signal }) {
  if (!signal) return <span className="text-xs text-ink-3">—</span>;
  const title = `RSI(14) ${
    signal.rsi14 ?? "n/a"
  } · EMA trend ${signal.emaTrend ?? "n/a"} · MACD ${signal.macdStatus ?? "n/a"} · Volume ${
    signal.volumeRatio !== null ? `${signal.volumeRatio}× the 20-day average` : "n/a"
  }${signal.thinVolume ? " (thin — downgrades Buy/Sell to Watch)" : ""}`;
  return <CallBadge label={signal.signal} title={title} />;
}

function SortIndicator({ active, dir }) {
  return (
    <span
      className={`ml-0.5 inline-block text-[9px] transition-opacity ${
        active ? "text-accent opacity-100" : "opacity-0"
      }`}
      aria-hidden
    >
      {dir === "asc" && active ? "▲" : "▼"}
    </span>
  );
}

function Kse100Tag() {
  return (
    <span className="ml-1.5 rounded border border-accent/30 bg-accent-soft px-1 py-px align-middle text-[9px] font-semibold tracking-wide text-accent">
      100
    </span>
  );
}

// The buy/sell rule is a FIXED strategy on daily candles — deliberately
// independent of whatever RSI period/interval the user is currently viewing,
// so entries and exits always follow the same rule.
const SIGNAL_RULE =
  "fixed rule on daily candles, independent of the RSI/Interval selected above";
const EXIT_PLAN = "Exit: daily RSI(14) back above ~50, +5–8% target, or ~10 sessions — whichever first";

/**
 * A reading of the RSI the user is CURRENTLY viewing (selected period ×
 * interval) for one stock — recomputed whenever either dropdown changes.
 * Complements the fixed screener rule rather than replacing it.
 */
function viewInsight(value, periodConfig, interval) {
  if (value === null || value === undefined) return null;
  const { period, oversold, overbought, exit, holdCandles } = periodConfig;
  const v = Number(value).toFixed(1);
  const name = `RSI(${period})`;
  const candles = `${interval.label} candles`;

  if (value <= oversold) {
    return {
      tone: "var(--up-text)",
      text: `${name} is ${v} on ${candles} — oversold (≤ ${oversold}). Dip-entry zone: exit when ${name} recovers above ~${exit}, on a +5–8% gain, or after ~${holdCandles} candles — whichever first.`,
    };
  }
  if (value <= oversold + 5) {
    return {
      tone: "var(--up-text)",
      text: `${name} is ${v} on ${candles} — approaching oversold (≤ ${oversold}). Watch for the dip to complete before entering.`,
    };
  }
  if (value >= overbought) {
    return {
      tone: "var(--down)",
      text: `${name} is ${v} on ${candles} — overbought (≥ ${overbought}). Take-profit zone; avoid fresh entries until it cools back under ~${exit}.`,
    };
  }
  if (value >= overbought - 5) {
    return {
      tone: "var(--down)",
      text: `${name} is ${v} on ${candles} — approaching overbought (≥ ${overbought}). If holding, tighten the exit.`,
    };
  }
  return {
    tone: "var(--ink-3)",
    text: `${name} is ${v} on ${candles} — neutral. No edge here; a dip entry wants ≤ ${oversold}.`,
  };
}

function BuySignalTag() {
  return (
    <span
      title={`Swing-entry setup (${SIGNAL_RULE}): daily RSI(14) ≤ 35 and RSI(2) ≤ 10. ${EXIT_PLAN}.`}
      className="ml-1.5 rounded px-1 py-px align-middle text-[9px] font-semibold tracking-wide"
      style={{
        color: "var(--up-text)",
        backgroundColor: "color-mix(in srgb, var(--up) 14%, transparent)",
        border: "1px solid color-mix(in srgb, var(--up) 35%, transparent)",
      }}
    >
      BUY
    </span>
  );
}

function SellSignalTag() {
  return (
    <span
      title={`Swing take-profit / avoid-entry setup (${SIGNAL_RULE}): daily RSI(14) ≥ 65 and RSI(2) ≥ 90.`}
      className="ml-1.5 rounded px-1 py-px align-middle text-[9px] font-semibold tracking-wide"
      style={{
        color: "var(--down)",
        backgroundColor: "color-mix(in srgb, var(--down) 14%, transparent)",
        border: "1px solid color-mix(in srgb, var(--down) 35%, transparent)",
      }}
    >
      SELL
    </span>
  );
}

function StarButton({ starred, onToggle, symbol }) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onToggle(symbol);
      }}
      title={starred ? "Remove from watchlist" : "Add to watchlist"}
      aria-label={`${starred ? "Remove" : "Add"} ${symbol} ${starred ? "from" : "to"} watchlist`}
      className={`rounded-md p-1 transition-colors ${
        starred ? "text-warning" : "text-ink-3/50 hover:text-ink-2"
      }`}
    >
      <StarIcon filled={starred} />
    </button>
  );
}

// The chart series is fetched on demand per symbol + interval (the table
// payload doesn't carry chart history), so expanding a row shows a brief
// loading state, and switching interval refetches.
function ExpandedChart({ stock, interval, period, thresholds }) {
  const [history, setHistory] = useState(null);
  const [failed, setFailed] = useState(false);

  const periodConfig = RSI_PERIODS.find((p) => p.period === period) ?? RSI_PERIODS[0];
  const insight = viewInsight(stock.rsi?.[period]?.[interval.key], periodConfig, interval);

  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    setFailed(false);
    fetch(
      `/api/history?symbol=${encodeURIComponent(stock.symbol)}&interval=${interval.key}&period=${period}`
    )
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((json) => {
        if (!cancelled) setHistory(json.history);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [stock.symbol, interval.key, period]);

  return (
    <>
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs text-ink-3">
          {stock.sector} — RSI({period}) · {interval.label} candles ·{" "}
          <span className="font-medium text-ink-2">{stock.symbol}</span>
        </p>
        <a
          href={tradingViewUrl(stock.symbol)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="whitespace-nowrap text-xs font-medium text-accent hover:underline"
        >
          Open on TradingView ↗
        </a>
      </div>
      {insight && (
        <p className="mb-1 text-xs" style={{ color: insight.tone }}>
          {insight.text}
        </p>
      )}
      {stock.buySignal && (
        <p className="mb-1.5 text-[11px] text-ink-3">
          Screener buy signal also active ({SIGNAL_RULE}): entry daily RSI(14) ≤ 35 &amp;
          RSI(2) ≤ 10 · {EXIT_PLAN}.
        </p>
      )}
      {stock.sellSignal && (
        <p className="mb-1.5 text-[11px] text-ink-3">
          Screener sell signal also active ({SIGNAL_RULE}): daily RSI(14) ≥ 65 &amp;
          RSI(2) ≥ 90 · take-profit / avoid fresh entries.
        </p>
      )}
      {stock.analysis && (
        <p className="mb-1.5 text-[11px] text-ink-3">
          <span className="font-semibold text-ink-2">
            Entry ~{formatPrice(stock.analysis.entry)} · Exit today ~
            {formatPrice(stock.analysis.exitSameDay)} · Exit 1–3w ~
            {formatPrice(stock.analysis.exitShortTerm)} · {stock.analysis.confidence} confidence.
          </span>{" "}
          {analysisSummary(stock.analysis)}
        </p>
      )}
      {stock.signal && (
        <p className="mb-1.5 text-[11px] text-ink-3">
          <span className="font-semibold text-ink-2">Signal: {stock.signal.signal}.</span>{" "}
          {signalSummary(stock.signal)}
        </p>
      )}
      {failed ? (
        <p className="py-4 text-sm text-ink-3">Couldn&apos;t load the RSI trend — try again.</p>
      ) : history === null ? (
        <p className="py-4 text-sm text-ink-3">Loading RSI trend…</p>
      ) : (
        <RSIChart history={history} thresholds={thresholds} />
      )}
    </>
  );
}

const headerCell =
  "px-3 py-2.5 text-[10px] font-semibold uppercase tracking-[0.1em] text-ink-3 select-none";
const sortableCell = `${headerCell} cursor-pointer transition-colors hover:text-ink`;

export default function StocksTable({
  stocks,
  interval,
  period,
  thresholds,
  sortKey,
  sortDir,
  onSort,
  expandedSymbol,
  onToggleExpand,
  watchlist,
  onToggleWatch,
}) {
  const isStarred = (symbol) => watchlist.includes(symbol);

  return (
    <>
      {/* Desktop / tablet: fixed-width table, sized to never need horizontal
          scroll, with a sticky header inside a scrollable body so long pages
          (e.g. 100 rows) keep the column headers in view. */}
      {/* Ten columns no longer fit without horizontal scroll on anything
          narrower than a wide desktop, so the wrapper now scrolls on X too
          — the table gets a min-width and the sticky header scrolls with it
          (still sticky on Y within the same container). */}
      <div className="hidden overflow-hidden rounded-xl border border-hairline bg-surface shadow-sm sm:block">
        <div className="max-h-[70vh] overflow-auto">
          <table className="w-full min-w-[1180px] table-fixed text-xs md:text-sm">
            <colgroup>
              <col style={{ width: "3%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "17%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "10%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "7%" }} />
              <col style={{ width: "8%" }} />
              <col style={{ width: "7%" }} />
              <col style={{ width: "10%" }} />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85">
              <tr className="border-b border-grid">
                <th className={headerCell} aria-label="Watchlist" />
                <th onClick={() => onSort("symbol")} className={`${sortableCell} text-left`}>
                  Symbol
                  <SortIndicator active={sortKey === "symbol"} dir={sortDir} />
                </th>
                <th className={`${headerCell} text-left`}>Name</th>
                <th onClick={() => onSort("price")} className={`${sortableCell} text-right`}>
                  Price
                  <SortIndicator active={sortKey === "price"} dir={sortDir} />
                </th>
                <th
                  onClick={() => onSort("rsi")}
                  title={`RSI(${period}) on ${interval.label} candles`}
                  className={`${sortableCell} text-center`}
                >
                  RSI({period}) · {interval.key}
                  <SortIndicator active={sortKey === "rsi"} dir={sortDir} />
                </th>
                <th
                  onClick={() => onSort("volume")}
                  title="Shares traded today"
                  className={`${sortableCell} text-right`}
                >
                  Volume
                  <SortIndicator active={sortKey === "volume"} dir={sortDir} />
                </th>
                <th
                  onClick={() => onSort("entry")}
                  title="Ideal swing entry, from support/trend/RSI (see the expanded row for the full breakdown)"
                  className={`${sortableCell} text-right`}
                >
                  Entry
                  <SortIndicator active={sortKey === "entry"} dir={sortDir} />
                </th>
                <th
                  title="Same-day exit target"
                  className={`${headerCell} text-right`}
                >
                  Exit · today
                </th>
                <th
                  title="Short-term (1-3 week) swing exit target"
                  className={`${headerCell} text-right`}
                >
                  Exit · 1-3w
                </th>
                <th
                  onClick={() => onSort("confidence")}
                  title="How strongly RSI, MACD, moving averages, volume, support/resistance, trend, breakout, and candlestick reads agree — see the expanded row for the breakdown"
                  className={`${sortableCell} text-center`}
                >
                  Confidence
                  <SortIndicator active={sortKey === "confidence"} dir={sortDir} />
                </th>
                <th
                  onClick={() => onSort("emaTrend")}
                  title="EMA(20/50) trend — price and both EMAs sloping the same way"
                  className={`${sortableCell} text-center`}
                >
                  EMA
                  <SortIndicator active={sortKey === "emaTrend"} dir={sortDir} />
                </th>
                <th
                  onClick={() => onSort("macd")}
                  title="MACD(12,26,9) histogram sign"
                  className={`${sortableCell} text-center`}
                >
                  MACD
                  <SortIndicator active={sortKey === "macd"} dir={sortDir} />
                </th>
                <th
                  onClick={() => onSort("signal")}
                  title="RSI + EMA + MACD vote, volume confirms — see the expanded row for the breakdown"
                  className={`${sortableCell} text-center`}
                >
                  Signal
                  <SortIndicator active={sortKey === "signal"} dir={sortDir} />
                </th>
              </tr>
            </thead>
            <tbody>
              {stocks.map((stock) => (
                <Fragment key={stock.symbol}>
                  <tr
                    onClick={() => onToggleExpand(stock.symbol)}
                    className={`cursor-pointer border-t border-grid/60 transition-colors hover:bg-surface-2/60 ${
                      expandedSymbol === stock.symbol ? "bg-surface-2/60" : ""
                    }`}
                  >
                    <td className="px-2 py-2 text-center">
                      <StarButton
                        starred={isStarred(stock.symbol)}
                        onToggle={onToggleWatch}
                        symbol={stock.symbol}
                      />
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-[13px] font-semibold text-ink">
                      {stock.symbol}
                      {stock.isKse100 && <Kse100Tag />}
                      {stock.buySignal && <BuySignalTag />}
                      {stock.sellSignal && <SellSignalTag />}
                    </td>
                    <td
                      className="truncate px-3 py-2.5 text-ink-2"
                      title={`${stock.name} — ${stock.sector}`}
                    >
                      {stock.name}
                      <span className="hidden text-ink-3 md:inline"> · {stock.sector}</span>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[13px] tabular-nums text-ink">
                      {formatPrice(stock.price)}
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      <RSICell value={stock.rsi?.[period]?.[interval.key]} thresholds={thresholds} />
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[13px] tabular-nums text-ink-3">
                      {formatVolume(stock.volume)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <EntryExitCell value={stock.analysis?.entry} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <EntryExitCell value={stock.analysis?.exitSameDay} />
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <EntryExitCell value={stock.analysis?.exitShortTerm} />
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      <ConfidenceBadge analysis={stock.analysis} />
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      <EmaBadge signal={stock.signal} />
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      <MacdBadge signal={stock.signal} />
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      <SignalBadge signal={stock.signal} />
                    </td>
                  </tr>
                  {expandedSymbol === stock.symbol && (
                    <tr className="border-t border-grid/60 bg-page/60">
                      <td colSpan={COLUMN_COUNT} className="px-4 py-3">
                        <ExpandedChart
                          stock={stock}
                          interval={interval}
                          period={period}
                          thresholds={thresholds}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
              {stocks.length === 0 && (
                <tr>
                  <td colSpan={COLUMN_COUNT} className="px-3 py-12 text-center text-ink-3">
                    No stocks match your filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Mobile: stacked cards instead of a cramped scrolling table */}
      <div className="space-y-2 sm:hidden">
        {stocks.map((stock) => (
          <div
            key={stock.symbol}
            className="overflow-hidden rounded-xl border border-hairline bg-surface shadow-sm"
          >
            <div
              onClick={() => onToggleExpand(stock.symbol)}
              className="w-full cursor-pointer text-left active:bg-surface-2/60"
            >
              <div className="flex items-center justify-between gap-2 px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-1">
                  <StarButton
                    starred={isStarred(stock.symbol)}
                    onToggle={onToggleWatch}
                    symbol={stock.symbol}
                  />
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-ink">
                      {stock.symbol}
                      {stock.isKse100 && <Kse100Tag />}
                      {stock.buySignal && <BuySignalTag />}
                      {stock.sellSignal && <SellSignalTag />}{" "}
                      <span className="text-xs font-normal text-ink-3">{stock.name}</span>
                    </div>
                    <div className="truncate text-xs text-ink-3">{stock.sector}</div>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-sm tabular-nums text-ink">
                    {formatPrice(stock.price)}
                  </div>
                  <div className="text-xs text-ink-3">Vol {formatVolume(stock.volume)}</div>
                </div>
              </div>
              <div className="flex items-center justify-between px-3 pb-3">
                <span className="text-[10px] uppercase tracking-wider text-ink-3">
                  RSI({period}) · {interval.label}
                </span>
                <RSICell
                  value={stock.rsi?.[period]?.[interval.key]}
                  thresholds={thresholds}
                  align="end"
                />
              </div>
              {stock.analysis && (
                <div className="flex items-center justify-between gap-2 border-t border-hairline/60 px-3 py-2 text-xs">
                  <span className="text-ink-3">
                    Entry <span className="font-mono text-ink-2">{formatPrice(stock.analysis.entry)}</span>
                    {" · "}Exit{" "}
                    <span className="font-mono text-ink-2">
                      {formatPrice(stock.analysis.exitSameDay)}
                    </span>
                    {" / "}
                    <span className="font-mono text-ink-2">
                      {formatPrice(stock.analysis.exitShortTerm)}
                    </span>
                  </span>
                  <ConfidenceBadge analysis={stock.analysis} />
                </div>
              )}
              {stock.signal && (
                <div className="flex items-center justify-between gap-1.5 border-t border-hairline/60 px-3 py-2 text-xs">
                  <span className="flex items-center gap-1.5">
                    <EmaBadge signal={stock.signal} />
                    <MacdBadge signal={stock.signal} />
                  </span>
                  <SignalBadge signal={stock.signal} />
                </div>
              )}
            </div>
            {expandedSymbol === stock.symbol && (
              <div className="border-t border-hairline bg-page/60 px-3 py-2">
                <ExpandedChart
                  stock={stock}
                  interval={interval}
                  period={period}
                  thresholds={thresholds}
                />
              </div>
            )}
          </div>
        ))}
        {stocks.length === 0 && (
          <p className="py-12 text-center text-ink-3">No stocks match your filter.</p>
        )}
      </div>
    </>
  );
}
