# 🐮 Moo Viewer

A dark, moomoo-inspired stock viewer. Search any ticker and get live quotes, interactive charts, a watchlist and headlines.

## Features

- **Search**: type a company or ticker (press `/` to focus), use the arrow keys and Enter to pick one
- **Charts**: 1D through All-time ranges, line or candlestick, with volume bars and an OHLC crosshair readout
- **Watchlist**: sparklines and day change for each symbol, saved in your browser. Use ★ to add or remove
- **Market strip**: S&P 500, Nasdaq, Dow, Russell 2000, VIX, Bitcoin, Gold, Crude
- **Key stats**: open, previous close, volume, day range and 52-week range
- **News** for the selected symbol
- **Up/down colour swap**: green-up (US) or red-up (Asia), toggled from the top right
- Refreshes every 30 seconds. Deep links work, e.g. `http://localhost:3000/#NVDA`

## Run it

Requires Node.js 18 or newer. There are no dependencies to install.

```bash
npm start
# open http://localhost:3000
```

Set `PORT` to use a different port.

## How it works

`server.js` is a small Node HTTP server with no dependencies. It serves `public/` and proxies Yahoo Finance's public chart and search endpoints, so the browser doesn't run into CORS and no API key is needed. Responses are cached in memory for a short time.

| Endpoint | Description |
| --- | --- |
| `GET /api/chart?symbol=AAPL&range=1d` | Quote metadata and OHLCV candles. Ranges: `1d 5d 1mo 3mo 6mo ytd 1y 5y max` |
| `GET /api/quotes?symbols=AAPL,TSLA` | Batch day quotes with sparkline data |
| `GET /api/search?q=tesla` | Symbol matches and news |

The frontend is plain HTML, CSS and JS. Charts are drawn with [TradingView Lightweight Charts](https://github.com/tradingview/lightweight-charts).

---

Data comes from Yahoo Finance and may be delayed. This is not investment advice. Not affiliated with moomoo or Futu.
