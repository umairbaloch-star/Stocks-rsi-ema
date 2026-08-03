"use client";

import { BUY_SIGNAL } from "@/lib/rsi";

function Stat({ label, value, dot, hint }) {
  return (
    <div className="flex-1 min-w-[8rem] px-4 py-3 sm:px-5">
      <div className="flex items-center gap-1.5">
        {dot && (
          <span
            aria-hidden
            className="h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: dot }}
          />
        )}
        <span className="text-[10px] font-medium uppercase tracking-[0.12em] text-ink-3">
          {label}
        </span>
      </div>
      <div className="mt-1 text-[22px] font-semibold leading-none text-ink">
        {value}
      </div>
      {hint && <div className="mt-1 text-[11px] text-ink-3">{hint}</div>}
    </div>
  );
}

/**
 * Market-breadth summary computed from every currently-loaded stock (not
 * just the visible page), at the currently-selected chart interval. The
 * distribution bar below the stats mirrors the RSI axis: oversold (low) on
 * the left, overbought (high) on the right.
 */
export default function MarketSummary({ stocks, period, interval, thresholds }) {
  const value = (s) => s.rsi?.[period]?.[interval.key];
  const withRsi = stocks.filter((s) => value(s) !== null && value(s) !== undefined);
  const overbought = withRsi.filter((s) => value(s) >= thresholds.overbought).length;
  const oversold = withRsi.filter((s) => value(s) <= thresholds.oversold).length;
  const neutral = withRsi.length - overbought - oversold;
  const signals = stocks.filter((s) => s.buySignal).length;

  const denom = oversold + neutral + overbought;
  const segments = [
    { key: "oversold", count: oversold, color: "var(--up)" },
    // Neutral is deliberately quiet but must still read as part of the bar —
    // half-strength muted ink stays visible on both the light and dark surface.
    { key: "neutral", count: neutral, color: "color-mix(in srgb, var(--ink-3) 45%, transparent)" },
    { key: "overbought", count: overbought, color: "var(--down)" },
  ].filter((seg) => seg.count > 0);

  return (
    <section className="overflow-hidden rounded-xl border border-hairline bg-surface shadow-sm">
      <div className="flex flex-wrap divide-x divide-hairline">
        <Stat label="Tracked" value={stocks.length} />
        <Stat
          label="Buy signals"
          value={signals}
          dot="var(--accent)"
          hint={`RSI(14) ≤ ${BUY_SIGNAL.rsi14Max} & RSI(2) ≤ ${BUY_SIGNAL.rsi2Max} · daily`}
        />
        <Stat
          label="Oversold"
          value={oversold}
          dot="var(--up)"
          hint={`RSI(${period}) ≤ ${thresholds.oversold} · ${interval.label}`}
        />
        <Stat
          label="Overbought"
          value={overbought}
          dot="var(--down)"
          hint={`RSI(${period}) ≥ ${thresholds.overbought} · ${interval.label}`}
        />
        <Stat label="Neutral" value={neutral} />
      </div>
      {denom > 0 && (
        <div className="border-t border-hairline px-4 py-2.5 sm:px-5">
          <div
            className="flex h-1.5 gap-[2px]"
            role="img"
            aria-label={`Market breadth: ${oversold} oversold, ${neutral} neutral, ${overbought} overbought`}
          >
            {segments.map((seg) => (
              <span
                key={seg.key}
                className="rounded-full"
                style={{
                  width: `${(seg.count / denom) * 100}%`,
                  backgroundColor: seg.color,
                }}
              />
            ))}
          </div>
          <div className="mt-1.5 flex justify-between text-[10px] text-ink-3">
            <span>← Oversold</span>
            <span>Overbought →</span>
          </div>
        </div>
      )}
    </section>
  );
}
