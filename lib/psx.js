const BASE_URL = "https://dps.psx.com.pk";

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Referer: "https://dps.psx.com.pk/",
  Accept: "application/json, text/plain, */*",
};

const MAX_ATTEMPTS = 4;
const RETRY_DELAY_MS = 500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The unofficial PSX feed occasionally resets connections or returns
 * 503s under load, so transient failures are retried a few times
 * with a linear backoff before giving up. `parse` turns the response
 * into JSON (default) or text.
 */
async function fetchWithRetry(url, parse = (res) => res.json()) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: HEADERS,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        throw new Error(`Request to ${url} failed: ${res.status}`);
      }
      return await parse(res);
    } catch (err) {
      lastError = err;
      const cause = err.cause
        ? ` cause: ${err.cause.code || err.cause.name || ""} ${err.cause.message || err.cause}`
        : "";
      console.error(
        `[psx] attempt ${attempt}/${MAX_ATTEMPTS} failed for ${url}: ${err.name}: ${err.message}${cause}`
      );
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

const fetchJsonWithRetry = (url) => fetchWithRetry(url, (res) => res.json());
const fetchTextWithRetry = (url) => fetchWithRetry(url, (res) => res.text());

/**
 * Fetches the full list of instruments listed on PSX and returns only
 * ordinary equities/ETFs (excludes bonds, TFCs, sukuks and other debt
 * instruments, which don't have a meaningful RSI).
 */
export async function fetchSymbols() {
  const all = await fetchJsonWithRetry(`${BASE_URL}/symbols`);
  return all
    .filter((s) => !s.isDebt)
    .map((s) => ({
      symbol: s.symbol,
      name: s.name,
      sector: s.sectorName,
      isETF: Boolean(s.isETF),
    }));
}

/**
 * Parses the market-watch page into a `Map<symbol, { current, isKse100 }>`.
 *
 * `current` is the live CURRENT price (the market-watch table's fifth numeric
 * column: LDCP, OPEN, HIGH, LOW, CURRENT), which is what should be shown as
 * the price — the timeseries/eod feed's latest "close" is settled/stale
 * end-of-day data, not the live price. `isKse100` is true when the row's
 * "LISTED IN" cell contains "KSE100".
 *
 * Each row looks like:
 *   <td data-search="OGDC" ...><strong>OGDC</strong></td>  (symbol)
 *   <td>sector</td><td>ALLSHR KSE100 KMI30</td>            (listed)
 *   <td data-order="323.45">323.45</td> ...                (LDCP, then OPEN/HIGH/LOW/CURRENT)
 */
export async function fetchMarketWatch() {
  const html = await fetchTextWithRetry(`${BASE_URL}/market-watch`);
  const tbody = html.split("<tbody")[1] || html;
  const bySymbol = new Map();
  const rowRe = /<tr>(.*?)<\/tr>/gs;
  let match;
  while ((match = rowRe.exec(tbody)) !== null) {
    const row = match[1];
    const symMatch = /data-search="([^"]+)"/.exec(row);
    if (!symMatch) continue;
    const nums = [...row.matchAll(/data-order="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((v) => /^-?\d*\.?\d+$/.test(v))
      .map(Number);
    // Numeric columns in order: LDCP, OPEN, HIGH, LOW, CURRENT, CHANGE,
    // CHANGE%, VOLUME — so CURRENT is index 4 and VOLUME is index 7.
    bySymbol.set(symMatch[1], {
      current: nums.length >= 5 ? nums[4] : null,
      volume: nums.length >= 8 ? nums[7] : null,
      isKse100: row.includes("KSE100"),
    });
  }
  return bySymbol;
}

/**
 * Fetches the daily end-of-day price history for a single symbol.
 * Returns an ascending-by-date array of { date, close, volume } points.
 * `volume` is that day's traded shares — kept alongside `close` so
 * indicators that need a volume history (e.g. the 20-day average volume
 * behind the composite score's volume-confirmation term) don't need a
 * second fetch; there is no high/low in this feed, so true ATR isn't
 * possible from it (see `calculateCloseATR` in `lib/indicators.js`).
 */
export async function fetchEodSeries(symbol) {
  const json = await fetchJsonWithRetry(
    `${BASE_URL}/timeseries/eod/${encodeURIComponent(symbol)}`
  );
  const rows = Array.isArray(json?.data) ? json.data : [];
  // Each row: [unixTimestampSeconds, open, volume, close]
  return rows
    .map((row) => ({
      date: row[0] * 1000,
      close: row[3],
      volume: row[2],
    }))
    // Drop occasional feed glitches (e.g. a day reported with close=0 while
    // open/volume look normal — a data error, not a real price). Left in,
    // a single such row poisons every RSI value computed afterward: Wilder's
    // RSI smooths recursively over the whole history, and the corporate-
    // action adjustment step divides by the previous close, so a zero here
    // turns into Infinity that contaminates the entire series before it.
    .filter((p) => Number.isFinite(p.close) && p.close > 0)
    .sort((a, b) => a.date - b.date);
}
