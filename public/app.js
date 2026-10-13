// Moo Viewer — frontend
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const LS_WATCH = "moo.watchlist";
  const LS_REDUP = "moo.redUp";
  const LS_TYPE = "moo.chartType";
  const DEFAULT_WATCHLIST = ["AAPL", "NVDA", "TSLA", "MSFT", "AMZN", "GOOGL", "META", "AMD", "SPY", "BTC-USD"];
  const INDICES = [
    ["^GSPC", "S&P 500"],
    ["^IXIC", "Nasdaq"],
    ["^DJI", "Dow"],
    ["^RUT", "Russell 2K"],
    ["^VIX", "VIX"],
    ["BTC-USD", "Bitcoin"],
    ["GC=F", "Gold"],
    ["CL=F", "Crude Oil"],
  ];
  const RANGE_LABEL = { "1d": "1D", "5d": "5D", "1mo": "1M", "3mo": "3M", "6mo": "6M", ytd: "YTD", "1y": "1Y", "5y": "5Y", max: "All" };
  const REFRESH_MS = 30_000;

  // ---------- storage (best effort) ----------
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v == null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
    },
  };

  const state = {
    symbol: null,
    range: "1d",
    type: store.get(LS_TYPE, "line"),
    watchlist: store.get(LS_WATCH, DEFAULT_WATCHLIST),
    redUp: store.get(LS_REDUP, false),
    header: null, // 1d data for current symbol
    chartData: null, // data for current range
    loadToken: 0,
  };

  // ---------- formatting ----------
  const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 });
  function decimalsFor(v, hint = 2) {
    const a = Math.abs(v);
    if (a > 0 && a < 1) return Math.max(hint, 4);
    return Math.min(Math.max(hint, 2), 4);
  }
  function fmtPrice(v, hint) {
    if (v == null || !isFinite(v)) return "—";
    const d = decimalsFor(v, hint);
    return v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  // Uses the price's precision so a small move on a $200 stock reads −0.37, not −0.3650
  function fmtChange(v, hint, ref) {
    if (v == null || !isFinite(v)) return "—";
    const d = decimalsFor(ref ?? v, hint);
    return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function fmtPct(v) {
    if (v == null || !isFinite(v)) return "—";
    return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(2) + "%";
  }
  const dirClass = (v) => (v > 0 ? "up" : v < 0 ? "down" : "flat");
  function timeAgo(sec) {
    const s = Math.max(0, Date.now() / 1000 - sec);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return Math.floor(s / 86400) + "d ago";
  }
  function esc(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }
  const cssVar = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
  function hexA(hex, a) {
    const n = parseInt(hex.replace("#", ""), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  // ---------- api ----------
  async function api(path) {
    const res = await fetch(path);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }
  const getChart = (symbol, range) => api(`/api/chart?symbol=${encodeURIComponent(symbol)}&range=${range}`);
  const getQuotes = (symbols) => api(`/api/quotes?symbols=${symbols.map(encodeURIComponent).join(",")}`);
  const search = (q) => api(`/api/search?q=${encodeURIComponent(q)}`);

  // ---------- chart ----------
  const chartEl = $("#chart");
  const chart = LightweightCharts.createChart(chartEl, {
    autoSize: true,
    layout: {
      background: { type: "solid", color: "transparent" },
      textColor: "#8b929e",
      fontFamily: "JetBrains Mono, monospace",
      fontSize: 11,
    },
    grid: {
      vertLines: { color: "rgba(255,255,255,0.04)" },
      horzLines: { color: "rgba(255,255,255,0.04)" },
    },
    rightPriceScale: { borderColor: "#232832", scaleMargins: { top: 0.12, bottom: 0.24 } },
    timeScale: { borderColor: "#232832", timeVisible: true, secondsVisible: false },
    crosshair: {
      mode: LightweightCharts.CrosshairMode.Normal,
      vertLine: { color: "#ff7a1a", labelBackgroundColor: "#ff7a1a", width: 1, style: 2 },
      horzLine: { color: "#ff7a1a", labelBackgroundColor: "#ff7a1a", width: 1, style: 2 },
    },
    handleScale: { axisPressedMouseMove: true },
  });
  let mainSeries = null;
  let volSeries = null;

  function drawChart(data, { fit = true } = {}) {
    const up = cssVar("--up");
    const down = cssVar("--down");
    const off = data.gmtoffset || 0;
    const candles = data.candles.map((c) => ({ ...c, time: c.time + off }));

    if (mainSeries) chart.removeSeries(mainSeries);
    if (volSeries) chart.removeSeries(volSeries);
    mainSeries = volSeries = null;

    const priceFormat = { type: "price", precision: decimalsFor(data.price, data.priceHint), minMove: 1 / 10 ** decimalsFor(data.price, data.priceHint) };

    if (state.type === "candle") {
      mainSeries = chart.addCandlestickSeries({
        upColor: up, downColor: down, wickUpColor: up, wickDownColor: down, borderVisible: false, priceFormat,
      });
      mainSeries.setData(candles.map(({ time, open, high, low, close }) => ({ time, open, high, low, close })));
    } else {
      const base = baseFor(data);
      mainSeries = chart.addBaselineSeries({
        baseValue: { type: "price", price: base },
        topLineColor: up,
        topFillColor1: hexA(up, 0.28),
        topFillColor2: hexA(up, 0.02),
        bottomLineColor: down,
        bottomFillColor1: hexA(down, 0.02),
        bottomFillColor2: hexA(down, 0.28),
        lineWidth: 2,
        priceFormat,
        crosshairMarkerBorderColor: "#0b0d11",
      });
      mainSeries.setData(candles.map(({ time, close }) => ({ time, value: close })));
      if (base != null) {
        mainSeries.createPriceLine({
          price: base, color: "#5c636f", lineWidth: 1, lineStyle: 2, axisLabelVisible: false,
          title: data.range === "1d" ? "Prev close" : "",
        });
      }
    }

    volSeries = chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volSeries.setData(
      candles.map((c) => ({ time: c.time, value: c.volume, color: hexA(c.close >= c.open ? up : down, 0.45) }))
    );

    chart.applyOptions({ timeScale: { timeVisible: ["1d", "5d", "1mo"].includes(data.range) } });
    if (fit) chart.timeScale().fitContent();
    setLegend(null);
  }

  function baseFor(data) {
    if (data.range === "1d") return data.prevClose;
    return data.rangeStartClose ?? data.candles[0]?.close;
  }

  function setLegend(point) {
    const el = $("#legend");
    const d = state.chartData;
    if (!d || !d.candles.length) { el.innerHTML = ""; return; }
    const hint = d.priceHint;
    if (point) {
      const vol = compact.format(point.volume || 0);
      if (state.type === "candle") {
        const cls = dirClass(point.close - point.open);
        el.innerHTML = `<span>O <b class="${cls}">${fmtPrice(point.open, hint)}</b></span><span>H <b class="${cls}">${fmtPrice(point.high, hint)}</b></span><span>L <b class="${cls}">${fmtPrice(point.low, hint)}</b></span><span>C <b class="${cls}">${fmtPrice(point.close, hint)}</b></span><span>Vol <b>${vol}</b></span>`;
      } else {
        const base = baseFor(d);
        const chg = base ? ((point.close - base) / base) * 100 : 0;
        el.innerHTML = `<span><b>${fmtPrice(point.close, hint)}</b></span><span class="${dirClass(chg)}">${fmtPct(chg)}</span><span>Vol <b>${vol}</b></span>`;
      }
      return;
    }
    const base = baseFor(d);
    const last = d.candles[d.candles.length - 1].close;
    const pct = base ? ((last - base) / base) * 100 : 0;
    el.innerHTML = `<span>${RANGE_LABEL[d.range]} <b class="${dirClass(pct)}">${fmtPct(pct)}</b></span><span>${esc(d.interval)} bars</span>`;
  }

  chart.subscribeCrosshairMove((param) => {
    if (!param.time || !state.chartData || !param.point) return setLegend(null);
    const off = state.chartData.gmtoffset || 0;
    const point = state.chartData.candles.find((c) => c.time + off === param.time);
    setLegend(point || null);
  });

  function chartMessage(msg) {
    const el = $("#chart-msg");
    el.hidden = !msg;
    el.textContent = msg || "";
  }

  // ---------- quote header & stats ----------
  function renderHeader(d) {
    $("#q-symbol").textContent = d.symbol;
    $("#q-name").textContent = d.name;
    $("#q-exchange").textContent = d.exchange || "";
    document.title = `${d.symbol} ${fmtPrice(d.price, d.priceHint)} · Moo Viewer`;

    const change = d.price - d.prevClose;
    const pct = d.prevClose ? (change / d.prevClose) * 100 : 0;
    const priceEl = $("#q-price");
    const prev = parseFloat(priceEl.dataset.v);
    priceEl.textContent = fmtPrice(d.price, d.priceHint);
    priceEl.className = `price mono ${dirClass(change)}`;
    if (priceEl.dataset.sym === d.symbol && isFinite(prev) && prev !== d.price) flash(priceEl, d.price > prev);
    priceEl.dataset.v = d.price;
    priceEl.dataset.sym = d.symbol;

    const chEl = $("#q-change");
    chEl.textContent = `${fmtChange(change, d.priceHint, d.price)}  ${fmtPct(pct)}`;
    chEl.className = `change mono ${dirClass(change)}`;

    const t = new Date(d.marketTime * 1000);
    $("#q-time").textContent = `${d.currency || ""} · as of ${t.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: d.timezone, timeZoneName: "short",
    })}`;
    updateStar();

    const open = d.candles[0]?.open;
    const rangeBar = (lo, hi, v) => {
      if (![lo, hi, v].every(isFinite) || hi <= lo) return "";
      const p = Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
      return `<div class="range-bar"><i style="left:calc(${p}% - 1px)"></i></div>`;
    };
    const tiles = [
      ["Open", fmtPrice(open, d.priceHint)],
      ["Prev Close", fmtPrice(d.prevClose, d.priceHint)],
      ["Volume", d.volume ? compact.format(d.volume) : "—"],
      ["52W High", fmtPrice(d.high52, d.priceHint)],
      ["Day Range", `${fmtPrice(d.dayLow, d.priceHint)} – ${fmtPrice(d.dayHigh, d.priceHint)}`, rangeBar(d.dayLow, d.dayHigh, d.price)],
      ["52W Range", `${fmtPrice(d.low52, d.priceHint)} – ${fmtPrice(d.high52, d.priceHint)}`, rangeBar(d.low52, d.high52, d.price)],
      ["52W Low", fmtPrice(d.low52, d.priceHint)],
      ["Off 52W High", d.high52 ? fmtPct(((d.price - d.high52) / d.high52) * 100) : "—"],
    ];
    $("#stats").innerHTML = tiles
      .map(([label, value, extra = ""]) => `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div>${extra}</div>`)
      .join("");
  }

  function flash(el, up) {
    el.classList.remove("flash-up", "flash-down");
    void el.offsetWidth;
    el.classList.add(up ? "flash-up" : "flash-down");
  }

  function headerLoading(symbol) {
    $("#q-symbol").textContent = symbol;
    $("#q-name").innerHTML = '<span class="skeleton">Loading company name</span>';
    $("#q-price").innerHTML = '<span class="skeleton">000.00</span>';
    $("#q-change").innerHTML = '<span class="skeleton">+0.00 +0.00%</span>';
    $("#q-time").textContent = "";
    $("#q-exchange").textContent = "";
  }

  // ---------- news ----------
  async function loadNews(symbol) {
    const list = $("#news");
    list.innerHTML = `<li class="news-empty">Loading…</li>`;
    try {
      const { news } = await search(symbol);
      if (state.symbol !== symbol) return;
      const safe = news.filter((n) => /^https?:\/\//.test(n.link || ""));
      if (!safe.length) { list.innerHTML = `<li class="news-empty">No recent news. Quiet pasture 🐄</li>`; return; }
      list.innerHTML = safe
        .map((n) => {
          const thumb = n.thumb && /^https?:\/\//.test(n.thumb) ? `<img src="${esc(n.thumb)}" alt="" loading="lazy" />` : "";
          return `<li><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer" class="${thumb ? "" : "no-thumb"}">
            <div><div class="news-title">${esc(n.title)}</div><div class="news-meta">${esc(n.publisher)} · ${timeAgo(n.time)}</div></div>${thumb}</a></li>`;
        })
        .join("");
    } catch {
      if (state.symbol === symbol) list.innerHTML = `<li class="news-empty">Couldn't load news.</li>`;
    }
  }

  // ---------- symbol loading ----------
  async function loadSymbol(symbol, { range = state.range } = {}) {
    symbol = symbol.toUpperCase();
    const token = ++state.loadToken;
    const symbolChanged = symbol !== state.symbol;
    state.symbol = symbol;
    state.range = range;
    document.querySelectorAll("#ranges button").forEach((b) => b.classList.toggle("active", b.dataset.range === range));
    if (location.hash.slice(1) !== symbol) history.replaceState(null, "", "#" + encodeURIComponent(symbol));
    markActiveWatch();

    if (symbolChanged) {
      headerLoading(symbol);
      loadNews(symbol);
    }
    chartMessage("Loading chart…");

    const headerP = getChart(symbol, "1d");
    const chartP = range === "1d" ? headerP : getChart(symbol, range);

    try {
      const header = await headerP;
      if (token !== state.loadToken) return;
      state.header = header;
      renderHeader(header);
    } catch (err) {
      if (token !== state.loadToken) return;
      $("#q-name").textContent = "Symbol not found";
      $("#q-price").textContent = "—";
      $("#q-change").textContent = "";
      $("#stats").innerHTML = "";
    }

    try {
      const data = await chartP;
      if (token !== state.loadToken) return;
      state.chartData = data;
      if (!data.candles.length) {
        chartMessage("No chart data for this range.");
        return;
      }
      chartMessage(null);
      drawChart(data);
    } catch (err) {
      if (token !== state.loadToken) return;
      state.chartData = null;
      chartMessage(`Couldn't load ${symbol}: ${err.message}`);
    }
  }

  // ---------- watchlist ----------
  function saveWatchlist() { store.set(LS_WATCH, state.watchlist); }

  function sparkSvg(values, up) {
    if (!values || values.length < 2) return '<svg class="wl-spark"></svg>';
    const min = Math.min(...values), max = Math.max(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => `${((i / (values.length - 1)) * 64).toFixed(1)},${(26 - ((v - min) / span) * 24).toFixed(1)}`).join(" ");
    return `<svg class="wl-spark" viewBox="0 0 64 28" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(${up ? "--up" : "--down"})" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function renderWatchlist(quotes = {}) {
    const ul = $("#watchlist");
    if (!state.watchlist.length) {
      ul.innerHTML = `<li class="wl-empty">Your pasture is empty.<br/>Search a symbol and hit ★</li>`;
      return;
    }
    ul.innerHTML = state.watchlist
      .map((sym) => {
        const q = quotes[sym];
        const ok = q && !q.error;
        return `<li class="wl-item" data-sym="${esc(sym)}">
          <div><div class="wl-sym">${esc(sym)}</div><div class="wl-name">${ok ? esc(q.name) : q?.error ? "Unavailable" : "…"}</div></div>
          ${ok ? sparkSvg(q.spark, q.change >= 0) : '<svg class="wl-spark"></svg>'}
          <div class="wl-right"><div class="wl-price" data-price>${ok ? fmtPrice(q.price) : "—"}</div>
          <div class="wl-pct ${ok ? dirClass(q.change) : ""}">${ok ? fmtPct(q.changePct) : ""}</div></div>
          <button class="wl-remove" title="Remove" data-remove="${esc(sym)}">×</button>
        </li>`;
      })
      .join("");
    markActiveWatch();
  }

  function markActiveWatch() {
    document.querySelectorAll(".wl-item").forEach((li) => li.classList.toggle("active", li.dataset.sym === state.symbol));
  }

  function updateStar() {
    const on = state.watchlist.includes(state.symbol);
    const star = $("#star");
    star.setAttribute("aria-pressed", String(on));
    star.title = on ? "Remove from watchlist" : "Add to watchlist";
  }

  function toggleWatch(sym) {
    if (!sym) return;
    const i = state.watchlist.indexOf(sym);
    if (i >= 0) state.watchlist.splice(i, 1);
    else state.watchlist.unshift(sym);
    saveWatchlist();
    updateStar();
    refreshQuotes();
  }

  $("#watchlist").addEventListener("click", (e) => {
    const rm = e.target.closest("[data-remove]");
    if (rm) { e.stopPropagation(); toggleWatch(rm.dataset.remove); return; }
    const li = e.target.closest(".wl-item");
    if (li) loadSymbol(li.dataset.sym);
  });
  $("#star").addEventListener("click", () => toggleWatch(state.symbol));
  $("#add-current").addEventListener("click", () => {
    if (state.symbol && !state.watchlist.includes(state.symbol)) toggleWatch(state.symbol);
    else $("#search").focus();
  });

  // ---------- indices + quote refresh ----------
  let lastQuotes = {};
  async function refreshQuotes() {
    const syms = [...new Set([...state.watchlist, ...INDICES.map((x) => x[0])])];
    renderWatchlist(lastQuotes);
    try {
      const { quotes } = await getQuotes(syms);
      const map = {};
      quotes.forEach((q) => (map[q.symbol.toUpperCase()] = q));
      // Yahoo may normalise symbols; key by requested symbol too
      syms.forEach((s, i) => { if (!map[s] && quotes[i]) map[s] = quotes[i]; });
      const prev = lastQuotes;
      lastQuotes = map;
      renderWatchlist(map);
      renderIndices(map);
      // flash changed prices
      document.querySelectorAll(".wl-item").forEach((li) => {
        const s = li.dataset.sym;
        if (prev[s] && map[s] && !map[s].error && prev[s].price !== map[s].price) flash(li, map[s].price > prev[s].price);
      });
    } catch { /* keep stale */ }
  }

  function renderIndices(map) {
    $("#indices").innerHTML = INDICES.map(([sym, name]) => {
      const q = map[sym];
      if (!q || q.error) return "";
      return `<div class="idx" data-sym="${esc(sym)}"><span class="idx-name">${esc(name)}</span><span class="mono">${fmtPrice(q.price)}</span><span class="idx-pct mono ${dirClass(q.change)}">${fmtPct(q.changePct)}</span></div>`;
    }).join("");
  }
  $("#indices").addEventListener("click", (e) => {
    const el = e.target.closest(".idx");
    if (el) loadSymbol(el.dataset.sym);
  });

  // ---------- toolbar ----------
  $("#ranges").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-range]");
    if (b && state.symbol) loadSymbol(state.symbol, { range: b.dataset.range });
  });
  function syncTypeTabs() {
    document.querySelectorAll("#chart-type button").forEach((b) => b.classList.toggle("active", b.dataset.type === state.type));
  }
  $("#chart-type").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-type]");
    if (!b || b.dataset.type === state.type) return;
    state.type = b.dataset.type;
    store.set(LS_TYPE, state.type);
    syncTypeTabs();
    if (state.chartData?.candles.length) drawChart(state.chartData);
  });

  function applyColorMode() {
    document.body.classList.toggle("red-up", state.redUp);
    $("#color-toggle").title = state.redUp ? "Red = up (tap for green = up)" : "Green = up (tap for red = up)";
  }
  $("#color-toggle").addEventListener("click", () => {
    state.redUp = !state.redUp;
    store.set(LS_REDUP, state.redUp);
    applyColorMode();
    if (state.chartData?.candles.length) drawChart(state.chartData, { fit: false });
  });

  // ---------- search ----------
  const input = $("#search");
  const results = $("#search-results");
  let searchTimer = null;
  let searchItems = [];
  let activeIdx = -1;

  function closeSearch() { results.hidden = true; activeIdx = -1; }
  function renderSearch() {
    if (!searchItems.length) {
      results.innerHTML = `<li class="sr-empty">No matches. Press Enter to try “${esc(input.value.trim().toUpperCase())}”</li>`;
    } else {
      results.innerHTML = searchItems
        .map((q, i) => `<li data-i="${i}" class="${i === activeIdx ? "active" : ""}"><span class="sr-sym">${esc(q.symbol)}</span><span class="sr-name">${esc(q.name)}</span><span class="sr-ex">${esc(q.exchange || "")} ${esc(q.type || "")}</span></li>`)
        .join("");
    }
    results.hidden = false;
  }
  function pick(sym) {
    input.value = "";
    closeSearch();
    input.blur();
    loadSymbol(sym);
  }

  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) { closeSearch(); return; }
    searchTimer = setTimeout(async () => {
      try {
        const { quotes } = await search(q);
        if (input.value.trim() !== q) return;
        searchItems = quotes;
        activeIdx = quotes.length ? 0 : -1;
        renderSearch();
      } catch { /* ignore */ }
    }, 180);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!searchItems.length) return;
      e.preventDefault();
      activeIdx = (activeIdx + (e.key === "ArrowDown" ? 1 : -1) + searchItems.length) % searchItems.length;
      renderSearch();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      if (!results.hidden && searchItems[activeIdx]) pick(searchItems[activeIdx].symbol);
      else pick(q);
    } else if (e.key === "Escape") {
      closeSearch();
      input.blur();
    }
  });
  results.addEventListener("mousedown", (e) => {
    const li = e.target.closest("li[data-i]");
    if (li) { e.preventDefault(); pick(searchItems[+li.dataset.i].symbol); }
  });
  input.addEventListener("blur", () => setTimeout(closeSearch, 100));
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== input) { e.preventDefault(); input.focus(); }
  });

  // ---------- market status (US equities, ignores holidays) ----------
  function updateMarketStatus() {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
        .formatToParts(new Date())
        .map((p) => [p.type, p.value])
    );
    const mins = +parts.hour * 60 + +parts.minute;
    const weekday = !["Sat", "Sun"].includes(parts.weekday);
    let label = "US market closed";
    let open = false;
    if (weekday && mins >= 570 && mins < 960) { label = "US market open"; open = true; }
    else if (weekday && mins >= 240 && mins < 570) label = "Pre-market";
    else if (weekday && mins >= 960 && mins < 1200) label = "After hours";
    const el = $("#market-status");
    el.classList.toggle("open", open);
    el.querySelector("span").textContent = label;
  }

  // ---------- refresh loop ----------
  async function refreshCurrent() {
    if (!state.symbol) return;
    const sym = state.symbol, token = state.loadToken;
    try {
      const header = await getChart(sym, "1d");
      if (token !== state.loadToken) return;
      state.header = header;
      renderHeader(header);
      if (state.range === "1d" && header.candles.length) {
        state.chartData = header;
        drawChart(header, { fit: false });
      }
    } catch { /* keep stale */ }
  }

  setInterval(() => {
    updateMarketStatus();
    if (document.hidden) return;
    refreshQuotes();
    refreshCurrent();
  }, REFRESH_MS);

  // ---------- boot ----------
  window.addEventListener("hashchange", () => {
    const sym = decodeURIComponent(location.hash.slice(1));
    if (sym && sym.toUpperCase() !== state.symbol) loadSymbol(sym);
  });

  applyColorMode();
  syncTypeTabs();
  updateMarketStatus();
  refreshQuotes();
  loadSymbol(decodeURIComponent(location.hash.slice(1)) || state.watchlist[0] || "AAPL");
})();
