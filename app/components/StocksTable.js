"use client";

import { Fragment, useEffect, useState } from "react";
import RSIChart from "./RSIChart";
import { StarIcon } from "./TopBar";
import { RSI_PERIODS } from "@/lib/rsi";
function tradingViewUrl(symbol) {
  return `https://www.tradingview.com/chart/?symbol=PSX:${encodeURIComponent(symbol)}`;
}

// star, symbol, name, price, % chg (day), RSI, volume, entry,
// confidence, EMA20, EMA50, MACD, Final Stance
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

function formatDate(value) {
  if (value === null || value === undefined) return "—";
  return new Date(value).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatPercent(value) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/** Today's close-vs-previous-close % move, from PSX's market-watch feed. */
function DayChangeCell({ value, align = "end" }) {
  if (value === null || value === undefined) {
    return <span className="text-sm text-ink-3">—</span>;
  }
  const n = Number(value);
  const color = n > 0 ? "var(--up-text)" : n < 0 ? "var(--down)" : "var(--ink-3)";
  return (
    <span
      className={`font-mono text-[13px] font-semibold tabular-nums ${
        align === "end" ? "text-right" : "text-center"
      }`}
      style={{ color }}
    >
      {formatPercent(n)}
    </span>
  );
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
 * Plain-language readout of the weighted confidence blend — see
 * CONFIDENCE_WEIGHTS in lib/technicals.js for the six factors and their
 * fixed percentage weights (RSI(5) 20%, Volume 18%, Price-to-Entry Delta
 * 17%, EMA20 16.5%, MACD 16%, EMA50 12.5%). Each factor's vote runs -1
 * (bearish) to +1 (bullish); MACD's is continuous (its score/40), every
 * other factor is a discrete -1/0/+1 threshold read.
 */
function confidenceSummary(a) {
  if (!a || !a.confidenceBreakdown) return "";
  const parts = a.confidenceBreakdown.map((f) => {
    const voteText =
      f.vote === null || f.vote === undefined
        ? "n/a"
        : `${f.vote > 0 ? "+" : ""}${f.vote.toFixed(2)}`;
    return `${f.label} ${f.weight}% (${voteText})`;
  });
  return `Weighted score ${a.confidenceScore ?? "n/a"} → ${a.confidence} confidence. ${parts.join(" · ")}`;
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
    `MACD ${s.macdLine ?? "n/a"} vs Signal ${s.macdSignalLine ?? "n/a"} (histogram ${
      s.macdHist ?? "n/a"
    }) — ${s.macdLabel ?? "n/a"} (${s.macdScore !== null && s.macdScore !== undefined ? (s.macdScore > 0 ? "+" : "") + s.macdScore : "n/a"})`,
    `Volume ${s.volumeRatio !== null ? `${s.volumeRatio}× the 20-day average` : "n/a"}${
      s.thinVolume ? " — thin, downgrades a would-be Buy/Sell to Watch" : ""
    }`,
    `RSI(5) ${s.rsi5 ?? "n/a"}${
      s.extendedOverbought
        ? " — already extended (≥70), downgrades a would-be Buy to Watch"
        : s.extendedOversold
          ? " — already extended (≤30), downgrades a would-be Sell to Watch"
          : ""
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

function ConfidenceBadge({ analysis, align = "center" }) {
  if (!analysis) {
    return (
      <span className="text-xs text-ink-3" title={analysisSummary(null)}>
        —
      </span>
    );
  }
  const style = CONFIDENCE_STYLE[analysis.confidence] ?? CONFIDENCE_STYLE.Low;
  const title = `${confidenceSummary(analysis)}\n\n${analysisSummary(analysis)}`;
  const score = analysis.confidenceScore;
  return (
    <span
      title={title}
      className={`inline-flex flex-col gap-0.5 ${ALIGN_CLASS[align] ?? "items-center"}`}
    >
      {score !== null && score !== undefined && (
        <span className="font-mono text-[12px] tabular-nums text-ink">
          {score > 0 ? "+" : ""}
          {score}
        </span>
      )}
      <span
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold tracking-wide"
        style={{
          color: style.color,
          backgroundColor: `color-mix(in srgb, ${style.bg} 16%, transparent)`,
          border: `1px solid color-mix(in srgb, ${style.bg} 40%, transparent)`,
        }}
      >
        {analysis.confidence}
      </span>
    </span>
  );
}

// Green = bullish/buy, orange = watch/neutral, red = bearish/sell — the
// consistent three-way color language for every badge on this simple
// RSI+EMA+MACD+Volume read (separate from the Confidence badge above).
const CALL_STYLE = {
  "Strong Buy": { color: "var(--up-text)", bg: "var(--up)" },
  Bullish: { color: "var(--up-text)", bg: "var(--up)" },
  Buy: { color: "var(--up-text)", bg: "var(--up)" },
  Neutral: { color: "#8a6400", bg: "var(--warning)" },
  Watch: { color: "#8a6400", bg: "var(--warning)" },
  Hold: { color: "#8a6400", bg: "var(--warning)" },
  Bearish: { color: "var(--down)", bg: "var(--down)" },
  Sell: { color: "var(--down)", bg: "var(--down)" },
  "Strong Sell": { color: "var(--down)", bg: "var(--down)" },
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

/** Price vs. a single EMA: above = Bullish, below = Bearish, equal = Neutral. */
function emaSignalLabel(price, ema) {
  if (price === null || price === undefined || ema === null || ema === undefined) return null;
  if (price > ema) return "Bullish";
  if (price < ema) return "Bearish";
  return "Neutral";
}

const ALIGN_CLASS = { center: "items-center", end: "items-end", start: "items-start" };

/**
 * One EMA's value plus its own price-vs-EMA signal (independent of the
 * other EMA). `showLabel` prefixes "EMA20"/"EMA50" — used in the expanded
 * row's panel where the two EMAs sit side by side without a column header
 * to identify them.
 */
function EmaValueCell({ price, ema, period, align = "center", showLabel = false }) {
  if (ema === null || ema === undefined) return <span className="text-xs text-ink-3">—</span>;
  const label = emaSignalLabel(price, ema);
  const style = CALL_STYLE[label] ?? CALL_STYLE.Neutral;
  return (
    <span
      title={`EMA(${period}) ${ema} vs price ${price ?? "n/a"} — ${label ?? "n/a"}`}
      className={`inline-flex flex-col gap-0.5 ${ALIGN_CLASS[align] ?? "items-center"}`}
    >
      {showLabel && (
        <span className="text-[9px] font-semibold uppercase tracking-wide text-ink-3">
          EMA{period}
        </span>
      )}
      <span className="font-mono text-[12px] tabular-nums text-ink">{formatPrice(ema)}</span>
      <span
        className="rounded px-1 py-px text-[9px] font-semibold tracking-wide"
        style={{
          color: style.color,
          backgroundColor: `color-mix(in srgb, ${style.bg} 16%, transparent)`,
          border: `1px solid color-mix(in srgb, ${style.bg} 40%, transparent)`,
        }}
      >
        {label ?? "—"}
      </span>
    </span>
  );
}

/**
 * MACD(12,26,9) vs. its Signal line, scored on the fixed 5-rung scale (see
 * macdSignalRead in lib/technicals.js): a fresh crossover reads Strong
 * Buy/Sell (±40), an already-established gap reads Bullish/Bearish (±25),
 * and a flat MACD-equals-Signal reads Neutral (0). The score is shown
 * alongside the label rather than buried in a tooltip.
 */
function MacdCell({ signal, align = "center", showLabel = false }) {
  if (!signal || signal.macdScore === null || signal.macdScore === undefined) {
    return <span className="text-xs text-ink-3">—</span>;
  }
  const style = CALL_STYLE[signal.macdLabel] ?? CALL_STYLE.Neutral;
  const title = `MACD ${signal.macdLine ?? "n/a"} vs Signal ${
    signal.macdSignalLine ?? "n/a"
  } (histogram ${signal.macdHist ?? "n/a"})`;
  return (
    <span title={title} className={`inline-flex flex-col gap-0.5 ${ALIGN_CLASS[align] ?? "items-center"}`}>
      {showLabel && (
        <span className="text-[9px] font-semibold uppercase tracking-wide text-ink-3">MACD</span>
      )}
      <span className="font-mono text-[12px] tabular-nums text-ink">
        {signal.macdScore > 0 ? "+" : ""}
        {signal.macdScore}
      </span>
      <span
        className="rounded px-1 py-px text-[9px] font-semibold tracking-wide"
        style={{
          color: style.color,
          backgroundColor: `color-mix(in srgb, ${style.bg} 16%, transparent)`,
          border: `1px solid color-mix(in srgb, ${style.bg} 40%, transparent)`,
        }}
      >
        {signal.macdLabel}
      </span>
    </span>
  );
}

/**
 * The single reconciled verdict — a weighted blend of Signal, MACD,
 * EMA20/50, and RSI14 (see computeFinalStance in lib/technicals.js
 * for the weights and the exact vote per factor). Built so a user doesn't
 * have to eyeball several columns that can legitimately disagree; the
 * tooltip and expanded row spell out each factor's vote and weight, and how
 * much of the applicable weight actually agreed with the final call.
 */
function StanceBadge({ stance }) {
  if (!stance) return <span className="text-xs text-ink-3">—</span>;
  const votedParts = stance.breakdown
    .filter((f) => f.vote !== null)
    .map((f) => `${f.label} ${f.weight}% (${f.vote > 0 ? "+" : ""}${f.vote.toFixed(2)})`);
  const title = `Score ${stance.score > 0 ? "+" : ""}${stance.score} · ${Math.round(
    stance.agreement * 100
  )}% of applicable weight agrees with this call.\n${votedParts.join(" · ")}`;
  return <CallBadge label={stance.stance} title={title} />;
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
// Matches EXIT_HOLD_SESSIONS in lib/technicals.js, which is what
// analysis.exitTargetDate is computed from.
const EXIT_HOLD_SESSIONS_LABEL = "~10 trading sessions time-stop";

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
      {stock.finalStance && (
        <p className="mb-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-ink-3">
          <span className="font-semibold text-ink-2">Final stance:</span>
          <StanceBadge stance={stock.finalStance} />
          <span>
            (score {stock.finalStance.score > 0 ? "+" : ""}
            {stock.finalStance.score}, {Math.round(stock.finalStance.agreement * 100)}% of applicable
            weight agrees) —{" "}
            {stock.finalStance.breakdown
              .filter((f) => f.vote !== null)
              .map((f) => `${f.label} ${f.weight}%`)
              .join(" · ")}
            .
          </span>
        </p>
      )}
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
            Entry ~{formatPrice(stock.analysis.entry)} · {stock.analysis.confidence} confidence.
          </span>{" "}
          {analysisSummary(stock.analysis)}
        </p>
      )}
      {stock.analysis && (
        <p className="mb-1.5 text-[11px] text-ink-3">
          <span className="font-semibold text-ink-2">
            Exit ~{formatPrice(stock.analysis.exitShortTerm)} (
            {formatPercent(stock.analysis.exitProfitPercent)} from Entry) by ~
            {formatDate(stock.analysis.exitTargetDate)}.
          </span>{" "}
          Swing exit plan: sell at that price, or by that date ({EXIT_HOLD_SESSIONS_LABEL}), or when
          daily RSI(14) recrosses ~50 — whichever comes first. A same-day scalp exit sits closer, at
          ~{formatPrice(stock.analysis.exitSameDay)}.
        </p>
      )}
      {stock.signal && (
        <div className="mb-1.5 flex items-center gap-4">
          <EmaValueCell
            price={stock.price}
            ema={stock.signal.ema20}
            period={20}
            align="start"
            showLabel
          />
          <EmaValueCell
            price={stock.price}
            ema={stock.signal.ema50}
            period={50}
            align="start"
            showLabel
          />
          <MacdCell signal={stock.signal} align="start" showLabel />
        </div>
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
          <table className="w-full min-w-[1420px] table-fixed text-xs md:text-sm">
            <colgroup>
              <col style={{ width: "3%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "14%" }} />
              <col style={{ width: "7%" }} />
              <col style={{ width: "5%" }} />
              <col style={{ width: "7%" }} />
              <col style={{ width: "5%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "7%" }} />
              <col style={{ width: "7%" }} />
              <col style={{ width: "7%" }} />
              <col style={{ width: "6%" }} />
              <col style={{ width: "20%" }} />
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
                  onClick={() => onSort("dayChangePercent")}
                  title="Today's close vs. previous close, from PSX's market-watch feed"
                  className={`${sortableCell} text-right`}
                >
                  % Chg
                  <SortIndicator active={sortKey === "dayChangePercent"} dir={sortDir} />
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
                  onClick={() => onSort("confidence")}
                  title="How strongly RSI, MACD, moving averages, volume, support/resistance, trend, breakout, and candlestick reads agree — see the expanded row for the breakdown"
                  className={`${sortableCell} text-center`}
                >
                  Confidence
                  <SortIndicator active={sortKey === "confidence"} dir={sortDir} />
                </th>
                <th
                  onClick={() => onSort("ema20")}
                  title="EMA(20) value and price-vs-EMA20 signal"
                  className={`${sortableCell} text-center`}
                >
                  EMA20
                  <SortIndicator active={sortKey === "ema20"} dir={sortDir} />
                </th>
                <th
                  onClick={() => onSort("ema50")}
                  title="EMA(50) value and price-vs-EMA50 signal"
                  className={`${sortableCell} text-center`}
                >
                  EMA50
                  <SortIndicator active={sortKey === "ema50"} dir={sortDir} />
                </th>
                <th
                  onClick={() => onSort("macd")}
                  title="MACD(12,26,9) vs its Signal line: crossover ±40 (Strong Buy/Sell), above/below ±25 (Bullish/Bearish), equal 0 (Neutral)"
                  className={`${sortableCell} text-center`}
                >
                  MACD
                  <SortIndicator active={sortKey === "macd"} dir={sortDir} />
                </th>
                <th
                  onClick={() => onSort("finalStance")}
                  title="One weighted verdict from Signal, MACD, EMA20/50, and RSI(14) — see the expanded row for the weights and each factor's vote"
                  className={`${sortableCell} text-center`}
                >
                  Final Stance
                  <SortIndicator active={sortKey === "finalStance"} dir={sortDir} />
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
                    <td className="px-3 py-2.5 text-right">
                      <DayChangeCell value={stock.dayChangePercent} />
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
                    <td className="px-2 py-2.5 text-center">
                      <ConfidenceBadge analysis={stock.analysis} />
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      <EmaValueCell price={stock.price} ema={stock.signal?.ema20} period={20} />
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      <EmaValueCell price={stock.price} ema={stock.signal?.ema50} period={50} />
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      <MacdCell signal={stock.signal} />
                    </td>
                    <td className="px-2 py-2.5 text-center">
                      <StanceBadge stance={stock.finalStance} />
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
                  <DayChangeCell value={stock.dayChangePercent} />
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
              {stock.finalStance && (
                <div className="flex items-center justify-between gap-2 border-t border-hairline/60 px-3 py-2 text-xs">
                  <span className="text-ink-3">Final stance</span>
                  <StanceBadge stance={stock.finalStance} />
                </div>
              )}
              {stock.analysis && (
                <div className="flex items-center justify-between gap-2 border-t border-hairline/60 px-3 py-2 text-xs">
                  <span className="text-ink-3">
                    Entry <span className="font-mono text-ink-2">{formatPrice(stock.analysis.entry)}</span>
                  </span>
                  <ConfidenceBadge analysis={stock.analysis} />
                </div>
              )}
              {stock.signal && (
                <div className="flex items-center justify-between gap-1.5 border-t border-hairline/60 px-3 py-2 text-xs">
                  <span className="text-ink-3">EMA / MACD</span>
                  <span className="flex items-center gap-2.5">
                    <EmaValueCell price={stock.price} ema={stock.signal.ema20} period={20} align="end" />
                    <EmaValueCell price={stock.price} ema={stock.signal.ema50} period={50} align="end" />
                    <MacdCell signal={stock.signal} align="end" />
                  </span>
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
