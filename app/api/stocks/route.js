import { NextResponse } from "next/server";
import { getStockData, refreshLivePrices, setWatchedSymbols } from "@/lib/cache";

export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    // The client's watchlist (localStorage, so the server has no memory of
    // it otherwise) rides along on every request so starred stocks stay
    // exempt from the volume floor — see setWatchedSymbols in lib/cache.js.
    const watchParam = params.get("watch");
    setWatchedSymbols(watchParam ? watchParam.split(",").filter(Boolean) : []);
    // A user-pressed Refresh passes refresh=1: re-fetch live prices from the
    // single market-watch page and recompute RSI before answering (the heavy
    // per-symbol history crawl stays on its own TTL — intraday, history
    // bars don't change, only current prices do).
    if (params.get("refresh") === "1") {
      await refreshLivePrices();
    }
    // Optional client-chosen volume floor, tighter than the server default
    // (see VOLUME_FILTER_PRESETS / getStockData in lib/cache.js).
    const minVolume = Number(params.get("minVolume"));
    // The search box's current text — an exact symbol match is exempted
    // from the volume floor and fetched on demand if not already loaded
    // (see ensureSearchSymbol in lib/cache.js), so pasting any real PSX
    // symbol always finds it.
    const search = params.get("search") || "";
    const data = await getStockData(params.get("scope") === "all", minVolume, search);
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { error: err.message || "Failed to load stock data" },
      { status: 500 }
    );
  }
}
