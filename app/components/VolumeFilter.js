"use client";

import { VOLUME_FILTER_PRESETS } from "@/lib/volume";

function formatShares(n) {
  if (n >= 1e6) return `${n / 1e6}M`;
  if (n >= 1e3) return `${n / 1e3}K`;
  return String(n);
}

/**
 * Lets the user tighten the volume floor beyond the server default
 * (`baseMinVolume`, from PSX_MIN_VOLUME) — e.g. only show stocks trading
 * above 1M shares/day. Selecting "Default" clears the override; anything
 * thinner than `baseMinVolume` was never fetched server-side, so a preset at
 * or below it wouldn't change what's shown, which is why the options start
 * above it.
 */
export default function VolumeFilter({ value, onChange, baseMinVolume }) {
  return (
    <label className="flex w-fit items-center gap-1.5 text-xs text-ink-3">
      Min volume:
      <select
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        title="Hide stocks trading under a chosen number of shares today, on top of the server's default liquidity floor"
        className="rounded-lg border border-hairline bg-surface px-2 py-1.5 text-xs font-medium text-ink shadow-sm outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/25"
      >
        <option value={0}>Default ({formatShares(baseMinVolume || 0)})</option>
        {VOLUME_FILTER_PRESETS.map((v) => (
          <option key={v} value={v}>
            {formatShares(v)}+
          </option>
        ))}
      </select>
    </label>
  );
}
