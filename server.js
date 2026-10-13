// Moo Viewer — tiny zero-dependency server.
// Serves ./public and proxies Yahoo Finance so the browser avoids CORS and API keys.
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, "public");
const YF = "https://query1.finance.yahoo.com";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

// Small in-memory cache so a busy watchlist doesn't hammer Yahoo.
const cache = new Map();
async function cachedJson(url, ttlMs) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`Upstream ${res.status}`);
  const data = await res.json();
  cache.set(url, { at: Date.now(), data });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return data;
}

const VALID_RANGES = new Set(["1d", "5d", "1mo", "3mo", "6mo", "ytd", "1y", "5y", "max"]);
const DEFAULT_INTERVAL = {
  "1d": "5m", "5d": "15m", "1mo": "1h", "3mo": "1d", "6mo": "1d",
  ytd: "1d", "1y": "1d", "5y": "1wk", max: "1mo",
};
const SYMBOL_RE = /^[A-Za-z0-9.\-^=]{1,20}$/;

async function getChart(symbol, range) {
  const interval = DEFAULT_INTERVAL[range];
  const url = `${YF}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;
  const json = await cachedJson(url, range === "1d" ? 30_000 : 5 * 60_000);
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error(json?.chart?.error?.description || "No data");

  const m = result.meta;
  const q = result.indicators?.quote?.[0] || {};
  const ts = result.timestamp || [];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close?.[i] == null || q.open?.[i] == null) continue;
    candles.push({
      time: ts[i],
      open: q.open[i],
      high: q.high[i],
      low: q.low[i],
      close: q.close[i],
      volume: q.volume?.[i] ?? 0,
    });
  }
  const prevClose = m.previousClose ?? m.chartPreviousClose;
  const price = m.regularMarketPrice;
  return {
    symbol: m.symbol,
    name: m.longName || m.shortName || m.symbol,
    exchange: m.fullExchangeName || m.exchangeName,
    currency: m.currency,
    type: m.instrumentType,
    timezone: m.exchangeTimezoneName,
    gmtoffset: m.gmtoffset,
    marketTime: m.regularMarketTime,
    price,
    prevClose,
    rangeStartClose: m.chartPreviousClose,
    dayHigh: m.regularMarketDayHigh,
    dayLow: m.regularMarketDayLow,
    volume: m.regularMarketVolume,
    high52: m.fiftyTwoWeekHigh,
    low52: m.fiftyTwoWeekLow,
    priceHint: m.priceHint ?? 2,
    range,
    interval,
    candles,
  };
}

function quoteFromChart(c) {
  const change = c.price - c.prevClose;
  return {
    symbol: c.symbol,
    name: c.name,
    price: c.price,
    change,
    changePct: c.prevClose ? (change / c.prevClose) * 100 : 0,
    spark: c.candles.map((k) => k.close),
    prevClose: c.prevClose,
    currency: c.currency,
  };
}

async function handleApi(url, res) {
  const p = url.searchParams;
  try {
    if (url.pathname === "/api/chart") {
      const symbol = p.get("symbol") || "";
      const range = p.get("range") || "1d";
      if (!SYMBOL_RE.test(symbol)) return sendJson(res, 400, { error: "Bad symbol" });
      if (!VALID_RANGES.has(range)) return sendJson(res, 400, { error: "Bad range" });
      return sendJson(res, 200, await getChart(symbol, range));
    }

    if (url.pathname === "/api/quotes") {
      const symbols = (p.get("symbols") || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => SYMBOL_RE.test(s))
        .slice(0, 40);
      const results = await Promise.allSettled(symbols.map((s) => getChart(s, "1d")));
      const quotes = results.map((r, i) =>
        r.status === "fulfilled" ? quoteFromChart(r.value) : { symbol: symbols[i], error: true }
      );
      return sendJson(res, 200, { quotes });
    }

    if (url.pathname === "/api/search") {
      const q = (p.get("q") || "").slice(0, 50);
      if (!q) return sendJson(res, 200, { quotes: [], news: [] });
      const json = await cachedJson(
        `${YF}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=8`,
        60_000
      );
      return sendJson(res, 200, {
        quotes: (json.quotes || [])
          .filter((x) => x.symbol && x.quoteType !== "FUTURE")
          .map((x) => ({
            symbol: x.symbol,
            name: x.shortname || x.longname || x.symbol,
            exchange: x.exchDisp,
            type: x.typeDisp || x.quoteType,
          })),
        news: (json.news || []).map((n) => ({
          title: n.title,
          publisher: n.publisher,
          link: n.link,
          time: n.providerPublishTime,
          thumb: n.thumbnail?.resolutions?.find((r) => r.tag === "140x140")?.url || null,
        })),
      });
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 502, { error: err.message || "Upstream error" });
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function serveStatic(url, res) {
  const rel = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) return handleApi(url, res);
    serveStatic(url, res);
  })
  .listen(PORT, () => console.log(`🐮 Moo Viewer running at http://localhost:${PORT}`));
