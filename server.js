// server.js — arb bot engine + web server
// Polls Polymarket & Kalshi every 60s, finds cross-exchange arbs,
// broadcasts results live to dashboard via WebSocket

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');
const path = require('path');
const { matchMarkets } = require('./matcher');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Config (edit these) ───────────────────────────────────────────────────────
const CONFIG = {
  POLL_INTERVAL_MS: 60_000,       // how often to scan (60 seconds)
  MIN_NET_SPREAD: 0.03,           // 3% minimum spread after fees
  POLY_FEE: 0.02,                 // Polymarket taker fee (2%)
  KALSHI_FEE: 0.02,               // Kalshi taker fee (2%)
  KELLY_FRACTION: 0.25,           // quarter-Kelly for safety
  BANKROLL: 1000,                 // your starting bankroll in USD
  MATCH_THRESHOLD: 0.30,          // fuzzy match threshold (0–1)
  PORT: process.env.PORT || 3000,
};

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  lastScan: null,
  scanning: false,
  pairsFound: 0,
  arbsFound: 0,
  opportunities: [],
  logs: [],
  scanCount: 0,
  config: CONFIG,
};

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg, type = 'info') {
  const entry = { ts: new Date().toISOString(), msg, type };
  state.logs.unshift(entry);
  if (state.logs.length > 200) state.logs.pop();
  console.log(`[${entry.ts}] [${type.toUpperCase()}] ${msg}`);
  broadcast({ type: 'log', entry });
}

// ── WebSocket broadcast ───────────────────────────────────────────────────────
function broadcast(payload) {
  const data = JSON.stringify(payload);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) client.send(data);
  }
}

// ── API: Polymarket ───────────────────────────────────────────────────────────
async function fetchPolymarkets() {
  const url = 'https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100&order=volume&ascending=false';
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`Polymarket API returned ${res.status}`);
  return res.json();
}

// ── API: Kalshi ───────────────────────────────────────────────────────────────
async function fetchKalshiMarkets() {
  const url = 'https://trading-api.kalshi.com/trade-api/v2/markets?limit=100&status=open';
  const res = await fetch(url, { timeout: 10000 });
  if (!res.ok) throw new Error(`Kalshi API returned ${res.status}`);
  const data = await res.json();
  return data.markets || [];
}

// ── Price extraction ──────────────────────────────────────────────────────────
function getPolyYesPrice(market) {
  try {
    if (market.outcomePrices) {
      const arr = typeof market.outcomePrices === 'string'
        ? JSON.parse(market.outcomePrices)
        : market.outcomePrices;
      const p = parseFloat(arr[0]);
      return isNaN(p) ? null : p;
    }
    if (market.bestAsk != null) return parseFloat(market.bestAsk);
  } catch {}
  return null;
}

function getKalshiYesPrice(market) {
  // Kalshi prices are in cents (0–100), convert to decimal
  if (market.yes_ask != null) return market.yes_ask / 100;
  if (market.yes_bid != null && market.yes_ask != null) {
    return (market.yes_bid + market.yes_ask) / 200;
  }
  if (market.last_price != null) return market.last_price / 100;
  return null;
}

// ── Kelly sizing for arb ──────────────────────────────────────────────────────
function sizeArb(yesPrice, noPrice) {
  const totalCost = yesPrice + noPrice;
  const profit = 1 - totalCost;
  if (profit <= 0) return null;

  // Near-riskless so use conservative fixed fraction of profit/cost
  const returnPct = profit / totalCost;
  const betUnit = CONFIG.KELLY_FRACTION * CONFIG.BANKROLL * Math.min(returnPct * 4, 0.5);
  const ev = profit * betUnit;

  return {
    totalCost: +totalCost.toFixed(4),
    profit: +profit.toFixed(4),
    returnPct: +(returnPct * 100).toFixed(2),
    betPerLeg: +betUnit.toFixed(2),
    ev: +ev.toFixed(2),
  };
}

// ── Core scan ────────────────────────────────────────────────────────────────
async function scan() {
  if (state.scanning) return;
  state.scanning = true;
  state.scanCount++;
  broadcast({ type: 'scanning', value: true });
  log(`Scan #${state.scanCount} started`);

  let polyRaw = [], kalshiRaw = [];

  // Fetch both exchanges in parallel
  const [polyResult, kalshiResult] = await Promise.allSettled([
    fetchPolymarkets(),
    fetchKalshiMarkets(),
  ]);

  if (polyResult.status === 'fulfilled') {
    polyRaw = polyResult.value;
    log(`Polymarket: ${polyRaw.length} markets fetched`, 'ok');
  } else {
    log(`Polymarket fetch failed: ${polyResult.reason.message}`, 'warn');
  }

  if (kalshiResult.status === 'fulfilled') {
    kalshiRaw = kalshiResult.value;
    log(`Kalshi: ${kalshiRaw.length} markets fetched`, 'ok');
  } else {
    log(`Kalshi fetch failed: ${kalshiResult.reason.message}`, 'warn');
  }

  // Match markets
  const pairs = matchMarkets(polyRaw, kalshiRaw, CONFIG.MATCH_THRESHOLD);
  state.pairsFound = pairs.length;
  log(`Matched ${pairs.length} overlapping events`);

  // Find arbs
  const opps = [];
  const totalFees = CONFIG.POLY_FEE + CONFIG.KALSHI_FEE;

  for (const { polyMarket, kalshiMarket, polyTitle, kalshiTitle, matchScore } of pairs) {
    const polyYes = getPolyYesPrice(polyMarket);
    const kalshiYes = getKalshiYesPrice(kalshiMarket);

    if (!polyYes || !kalshiYes) continue;
    if (polyYes <= 0.01 || polyYes >= 0.99) continue;
    if (kalshiYes <= 0.01 || kalshiYes >= 0.99) continue;

    const rawSpread = Math.abs(polyYes - kalshiYes);
    const netSpread = rawSpread - totalFees;

    if (netSpread < CONFIG.MIN_NET_SPREAD) continue;

    // Direction: buy YES on cheaper side, NO on expensive side
    const polyIsCheaper = polyYes < kalshiYes;
    const buyYesOn    = polyIsCheaper ? 'Polymarket' : 'Kalshi';
    const buyNoOn     = polyIsCheaper ? 'Kalshi' : 'Polymarket';
    const buyYesPrice = polyIsCheaper ? polyYes : kalshiYes;
    const buyNoPrice  = polyIsCheaper ? (1 - kalshiYes) : (1 - polyYes);

    const sizing = sizeArb(buyYesPrice, buyNoPrice);
    if (!sizing) continue;

    opps.push({
      id: `${polyMarket.id || polyTitle.slice(0,20)}-${Date.now()}`,
      polyTitle,
      kalshiTitle,
      matchScore: +(matchScore * 100).toFixed(0),
      polyYes: +polyYes.toFixed(4),
      kalshiYes: +kalshiYes.toFixed(4),
      rawSpread: +(rawSpread * 100).toFixed(2),
      netSpread: +(netSpread * 100).toFixed(2),
      buyYesOn,
      buyNoOn,
      buyYesPrice: +buyYesPrice.toFixed(4),
      buyNoPrice: +buyNoPrice.toFixed(4),
      ...sizing,
      volume: parseFloat(polyMarket.volume) || 0,
      foundAt: new Date().toISOString(),
    });
  }

  opps.sort((a, b) => b.netSpread - a.netSpread);
  state.opportunities = opps;
  state.arbsFound = opps.length;
  state.lastScan = new Date().toISOString();
  state.scanning = false;

  if (opps.length > 0) {
    log(`🎯 Found ${opps.length} arb opportunities! Best: ${opps[0].netSpread}% net on "${opps[0].polyTitle.slice(0,50)}"`, 'arb');
  } else {
    log(`No arbs above ${(CONFIG.MIN_NET_SPREAD * 100).toFixed(1)}% threshold this scan`);
  }

  broadcast({ type: 'update', state: getPublicState() });
}

function getPublicState() {
  return {
    lastScan: state.lastScan,
    scanning: state.scanning,
    pairsFound: state.pairsFound,
    arbsFound: state.arbsFound,
    opportunities: state.opportunities,
    logs: state.logs.slice(0, 50),
    scanCount: state.scanCount,
    config: state.config,
  };
}

// ── Express routes ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// API endpoint — returns current state as JSON
app.get('/api/state', (req, res) => res.json(getPublicState()));

// Manual scan trigger
app.post('/api/scan', (req, res) => {
  scan();
  res.json({ ok: true, message: 'Scan triggered' });
});

// ── WebSocket: send full state on connect ─────────────────────────────────────
wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'init', state: getPublicState() }));
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'scan') scan();
      if (data.type === 'updateConfig') {
        Object.assign(CONFIG, data.config);
        state.config = CONFIG;
        log(`Config updated: ${JSON.stringify(data.config)}`);
      }
    } catch {}
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(CONFIG.PORT, () => {
  console.log(`\n🤖 ARB BOT running at http://localhost:${CONFIG.PORT}`);
  console.log(`📊 Dashboard: http://localhost:${CONFIG.PORT}`);
  console.log(`⏱  Scanning every ${CONFIG.POLL_INTERVAL_MS / 1000}s\n`);
});

// Initial scan on startup, then every 60s
scan();
setInterval(scan, CONFIG.POLL_INTERVAL_MS);
