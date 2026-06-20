'use strict';

const fs = require('fs');
const path = require('path');

// ── Config ──
const INITIAL_CAPITAL = 10000;
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const STATE_FILE = path.join(__dirname, 'state.json');
const STATE_VERSION = 9;

// Strategy params
const BASE_SHARES = 500;           // 500 UP + 500 DOWN at entry per market
const SCALP_SIZE = 10;             // 10 shares per scalp order
const SCALP_OFFSET = 0.02;         // place at bid-0.02 / ask+0.02
const TP_PRICE = 0.99;             // sell limit at 0.99 in endgame
const SCALP_END_MINUTES = 4;       // scalp for 4 minutes (out of 5)
const MARKET_TAKER_FEE = 0.007;    // 0.7% taker fee (market entry)

// ── State ──
let balance = INITIAL_CAPITAL;
let totalRealizedPnl = 0;
let totalFees = 0;
let wins = 0;
let losses = 0;
let trades = [];
let marketCache = {};
let strategyState = {};   // slug -> strategy state for that window
let initialEquity = INITIAL_CAPITAL;
let equityHistory = [];
let emitFn = () => {};
let logFn = () => {};
let startTime = Date.now();
let discoveryCount = 0;
let tickCount = 0;

function fl2(v) { return Math.round((v || 0) * 100) / 100; }
function fl4(v) { return Math.round((v || 0) * 10000) / 10000; }
function id8() { return Date.now().toString(36) + Math.random().toString(36).substring(2, 6); }

async function getJson(url) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

// ── Market Discovery ──
function windowEpochs() {
  const now = Math.floor(Date.now() / 1000);
  const ws = 900; const cw = Math.floor(now / ws) * ws;
  const ws5 = 300; const cw5 = Math.floor(now / ws5) * ws5;
  return [
    { asset: 'btc', slug: 'btc-updown-5m-' + (cw5 - 600), epoch: cw5 - 600, windowS: 300, windowType: '5m' },
    { asset: 'btc', slug: 'btc-updown-5m-' + (cw5 - 300), epoch: cw5 - 300, windowS: 300, windowType: '5m' },
    { asset: 'btc', slug: 'btc-updown-5m-' + cw5, epoch: cw5, windowS: 300, windowType: '5m' },
    { asset: 'btc', slug: 'btc-updown-5m-' + (cw5 + 300), epoch: cw5 + 300, windowS: 300, windowType: '5m' },
    { asset: 'btc', slug: 'btc-updown-5m-' + (cw5 + 600), epoch: cw5 + 600, windowS: 300, windowType: '5m' },
    { asset: 'eth', slug: 'eth-updown-5m-' + (cw5 - 600), epoch: cw5 - 600, windowS: 300, windowType: '5m' },
    { asset: 'eth', slug: 'eth-updown-5m-' + (cw5 - 300), epoch: cw5 - 300, windowS: 300, windowType: '5m' },
    { asset: 'eth', slug: 'eth-updown-5m-' + cw5, epoch: cw5, windowS: 300, windowType: '5m' },
    { asset: 'eth', slug: 'eth-updown-5m-' + (cw5 + 300), epoch: cw5 + 300, windowS: 300, windowType: '5m' },
    { asset: 'eth', slug: 'eth-updown-5m-' + (cw5 + 600), epoch: cw5 + 600, windowS: 300, windowType: '5m' },
    { asset: 'sol', slug: 'sol-updown-5m-' + (cw5 - 600), epoch: cw5 - 600, windowS: 300, windowType: '5m' },
    { asset: 'sol', slug: 'sol-updown-5m-' + (cw5 - 300), epoch: cw5 - 300, windowS: 300, windowType: '5m' },
    { asset: 'sol', slug: 'sol-updown-5m-' + cw5, epoch: cw5, windowS: 300, windowType: '5m' },
    { asset: 'sol', slug: 'sol-updown-5m-' + (cw5 + 300), epoch: cw5 + 300, windowS: 300, windowType: '5m' },
    { asset: 'sol', slug: 'sol-updown-5m-' + (cw5 + 600), epoch: cw5 + 600, windowS: 300, windowType: '5m' },
    // 15m windows (same strategy, proportionally timed)
    { asset: 'btc', slug: 'btc-updown-15m-' + cw, epoch: cw, windowS: 900, windowType: '15m' },
    { asset: 'eth', slug: 'eth-updown-15m-' + cw, epoch: cw, windowS: 900, windowType: '15m' },
    { asset: 'sol', slug: 'sol-updown-15m-' + cw, epoch: cw, windowS: 900, windowType: '15m' },
    { asset: 'btc', slug: 'btc-updown-15m-' + (cw + 900), epoch: cw + 900, windowS: 900, windowType: '15m' },
    { asset: 'eth', slug: 'eth-updown-15m-' + (cw + 900), epoch: cw + 900, windowS: 900, windowType: '15m' },
    { asset: 'sol', slug: 'sol-updown-15m-' + (cw + 900), epoch: cw + 900, windowS: 900, windowType: '15m' },
  ];
}

async function discoverMarkets() {
  const candidates = windowEpochs();
  let found = 0;
  const now = Date.now();
  for (const c of candidates) {
    if (marketCache[c.slug] && marketCache[c.slug].resolved) continue;
    const d = await getJson(`${GAMMA}/events?slug=${c.slug}`);
    if (!Array.isArray(d) || d.length === 0) continue;
    const ev = d[0];
    if (!ev.markets || ev.markets.length === 0) continue;
    const m = ev.markets[0];
    if (!m.clobTokenIds || !m.outcomePrices) continue;
    let tokenIds, prices, outcomes;
    try { tokenIds = JSON.parse(m.clobTokenIds); } catch(e) { continue; }
    try { prices = JSON.parse(m.outcomePrices).map(parseFloat); } catch(e) { continue; }
    try { outcomes = JSON.parse(m.outcomes); } catch(e) { continue; }
    if (tokenIds.length < 2 || prices.length < 2) continue;

    const endMs = new Date(ev.endDate || m.endDate || ((c.epoch + c.windowS) * 1000)).getTime();
    const secs = Math.floor((endMs - now) / 1000);
    const active = secs > 0 && secs <= c.windowS && prices[0] > 0.01 && prices[0] < 0.99;

    marketCache[c.slug] = {
      slug: c.slug, asset: c.asset, eventTitle: ev.title || c.slug,
      endTime: endMs, secondsToEnd: secs, active, resolved: false,
      upTokenId: tokenIds[0], upPrice: prices[0], upOutcome: outcomes[0],
      downTokenId: tokenIds[1], downPrice: prices[1], downOutcome: outcomes[1],
      upMid: prices[0], downMid: prices[1],
      windowType: c.windowType || '5m',
    };
    if (!strategyState[c.slug]) {
      strategyState[c.slug] = {
        entered: false, entryTime: 0, phase: 'idle',
        upShares: 0, downShares: 0,
        upSellOrder: null, upBuyOrder: null,
        downSellOrder: null, downBuyOrder: null,
        scalpPnl: 0, scalpCount: 0, entryCost: 0,
      };
    }
    found++;
  }
  if (found > 0) {
    discoveryCount++;
    const ac = Object.values(marketCache).filter(x => x.active).length;
    logFn(`📡 ${found} mkts (${ac} active)`);
  }
}

async function fetchClob() {
  const active = Object.values(marketCache).filter(m => m.active);
  for (const m of active) {
    try {
      const up = await getJson(`${CLOB}/midpoint?token_id=${m.upTokenId}`);
      if (up && up.mid) m.upMid = parseFloat(up.mid);
      const dn = await getJson(`${CLOB}/midpoint?token_id=${m.downTokenId}`);
      if (dn && dn.mid) m.downMid = parseFloat(dn.mid);
      m.secondsToEnd = Math.floor((m.endTime - Date.now()) / 1000);
    } catch(e) {}
  }
}

// ── Helper: get bid/ask from midpoint ──
function book(m) {
  const midUp = m.upMid || m.upPrice || 0.50;
  const midDown = m.downMid || m.downPrice || 0.50;
  return {
    upBid: fl4(midUp - 0.005), upAsk: fl4(midUp + 0.005),
    downBid: fl4(midDown - 0.005), downAsk: fl4(midDown + 0.005),
    upMid: midUp, downMid: midDown,
  };
}

// ── Check if we should enter a window ──
function tryEnter(m) {
  const ss = strategyState[m.slug];
  if (!ss || ss.entered) return;
  const secs = m.secondsToEnd;
  // Enter if window just started (secs close to windowS) and prices reasonable
  if (secs < m.windowS - 5 || secs > m.windowS + 5) return;
  if (secs <= 0) return;
  const b = book(m);
  const upAsk = b.upAsk;
  const downAsk = b.downAsk;
  if (upAsk >= 0.97 || upAsk <= 0.03 || downAsk >= 0.97 || downAsk <= 0.03) return;

  const upCost = fl2(BASE_SHARES * upAsk);
  const downCost = fl2(BASE_SHARES * downAsk);
  const totalCost = upCost + downCost;
  if (totalCost < 5 || totalCost > balance * 0.6) return;  // max 60% per window

  // Market buy UP
  const upFee = fl2(upCost * MARKET_TAKER_FEE);
  balance = fl2(balance - upCost - upFee);
  totalFees = fl4(totalFees + upFee);

  // Market buy DOWN
  const downFee = fl2(downCost * MARKET_TAKER_FEE);
  balance = fl2(balance - downCost - downFee);
  totalFees = fl4(totalFees + downFee);

  ss.entered = true;
  ss.entryTime = Date.now();
  ss.phase = 'scalp';
  ss.upShares = BASE_SHARES;
  ss.downShares = BASE_SHARES;
  ss.scalpPnl = 0;
  ss.scalpCount = 0;
  ss.entryCost = totalCost + upFee + downFee;

  logFn(`🎯 ENTRY ${m.asset.toUpperCase()} ${m.windowType} ${BASE_SHARES}UP @ $${upAsk} + ${BASE_SHARES}DN @ $${downAsk} = $${fl2(totalCost)} (fees:$${fl2(upFee+downFee)})`);
}

// ── Scalp loop ──
function runScalp(m) {
  const ss = strategyState[m.slug];
  if (!ss || !ss.entered || ss.phase !== 'scalp') return;
  const secs = m.secondsToEnd;
  if (secs <= 0) return;

  // Check if scalp phase should end
  const scalpEndSecs = m.windowType === '5m' ? (m.windowS - 60) : (m.windowS - 180);
  if (secs <= m.windowS - scalpEndSecs) {
    // Actually: scalp for 4 minutes on 5m window (240s), i.e. stop when 60s remain
    if (secs <= 60 && m.windowType === '5m') {
      endScalpPhase(m, ss);
      return;
    }
    if (secs <= 180 && m.windowType === '15m') {
      endScalpPhase(m, ss);
      return;
    }
  }

  const b = book(m);

  // --- UP side ---
  // Sell limit: 10 shares at ask + 0.02
  if (!ss.upSellOrder && ss.upShares > SCALP_SIZE) {
    const price = fl4(b.upAsk + SCALP_OFFSET);
    if (price < 0.99) {
      const id = id8();
      ss.upSellOrder = { id, price, shares: SCALP_SIZE };
    }
  }
  // Buy limit: 10 shares at bid - 0.02
  if (!ss.upBuyOrder) {
    const price = fl4(b.upBid - SCALP_OFFSET);
    if (price > 0.01) {
      const id = id8();
      ss.upBuyOrder = { id, price, shares: SCALP_SIZE };
    }
  }

  // --- DOWN side ---
  if (!ss.downSellOrder && ss.downShares > SCALP_SIZE) {
    const price = fl4(b.downAsk + SCALP_OFFSET);
    if (price < 0.99) {
      const id = id8();
      ss.downSellOrder = { id, price, shares: SCALP_SIZE };
    }
  }
  if (!ss.downBuyOrder) {
    const price = fl4(b.downBid - SCALP_OFFSET);
    if (price > 0.01) {
      const id = id8();
      ss.downBuyOrder = { id, price, shares: SCALP_SIZE };
    }
  }

  // --- Simulate fills for scalp orders ---
  // Sell fills: simulated price spiked to our ask+0.02 level
  if (ss.upSellOrder) {
    const cur = b.upMid;
    const spikeProb = Math.max(0, (cur - ss.upSellOrder.price + 0.03) * 3);
    if (cur >= ss.upSellOrder.price - 0.001 || Math.random() < spikeProb * 0.02) {
      // Sell filled
      const proceeds = fl2(ss.upSellOrder.shares * ss.upSellOrder.price);
      balance = fl2(balance + proceeds);
      ss.upShares -= ss.upSellOrder.shares;
      ss.scalpPnl = fl2(ss.scalpPnl + proceeds);
      ss.scalpCount++;
      logFn(`💹 SELL ${m.asset.toUpperCase()} UP ${ss.upSellOrder.shares}sh @ $${ss.upSellOrder.price}`);
      ss.upSellOrder = null;
    }
  }
  if (ss.upBuyOrder) {
    const cur = b.upMid;
    if (cur <= ss.upBuyOrder.price + 0.001 || Math.random() < 0.01) {
      // Buy filled
      const cost = fl2(ss.upBuyOrder.shares * ss.upBuyOrder.price);
      balance = fl2(balance - cost);
      ss.upShares += ss.upBuyOrder.shares;
      ss.scalpPnl = fl2(ss.scalpPnl - cost);
      ss.scalpCount++;
      logFn(`💹 BUY ${m.asset.toUpperCase()} UP ${ss.upBuyOrder.shares}sh @ $${ss.upBuyOrder.price}`);
      ss.upBuyOrder = null;
    }
  }
  if (ss.downSellOrder) {
    const cur = b.downMid;
    if (cur >= ss.downSellOrder.price - 0.001 || Math.random() < 0.02) {
      const proceeds = fl2(ss.downSellOrder.shares * ss.downSellOrder.price);
      balance = fl2(balance + proceeds);
      ss.downShares -= ss.downSellOrder.shares;
      ss.scalpPnl = fl2(ss.scalpPnl + proceeds);
      ss.scalpCount++;
      logFn(`💹 SELL ${m.asset.toUpperCase()} DN ${ss.downSellOrder.shares}sh @ $${ss.downSellOrder.price}`);
      ss.downSellOrder = null;
    }
  }
  if (ss.downBuyOrder) {
    const cur = b.downMid;
    if (cur <= ss.downBuyOrder.price + 0.001 || Math.random() < 0.01) {
      const cost = fl2(ss.downBuyOrder.shares * ss.downBuyOrder.price);
      balance = fl2(balance - cost);
      ss.downShares += ss.downBuyOrder.shares;
      ss.scalpPnl = fl2(ss.scalpPnl - cost);
      ss.scalpCount++;
      logFn(`💹 BUY ${m.asset.toUpperCase()} DN ${ss.downBuyOrder.shares}sh @ $${ss.downBuyOrder.price}`);
      ss.downBuyOrder = null;
    }
  }
}

function endScalpPhase(m, ss) {
  ss.phase = 'endgame';
  ss.upSellOrder = null;
  ss.upBuyOrder = null;
  ss.downSellOrder = null;
  ss.downBuyOrder = null;
  logFn(`🛑 ENDGAME ${m.asset.toUpperCase()} ${m.windowType} — placing TP at $${TP_PRICE} (UP:${ss.upShares}sh DN:${ss.downShares}sh)`);
}

// ── Endgame: TP at 0.99 ──
function runEndgame(m) {
  const ss = strategyState[m.slug];
  if (!ss || !ss.entered || ss.phase !== 'endgame') return;
  const secs = m.secondsToEnd;
  if (secs < -10) return; // window ended

  // Place TP sell orders at 0.99
  // UP side TP
  if (ss.upShares > 0 && !ss.upSellOrder) {
    ss.upSellOrder = { id: id8(), price: TP_PRICE, shares: ss.upShares };
  }
  // DOWN side TP
  if (ss.downShares > 0 && !ss.downSellOrder) {
    ss.downSellOrder = { id: id8(), price: TP_PRICE, shares: ss.downShares };
  }

  // Check if TP filled
  const b = book(m);
  // UP TP
  if (ss.upSellOrder) {
    if (b.upMid >= TP_PRICE - 0.005) {
      const proceeds = fl2(ss.upSellOrder.shares * TP_PRICE);
      balance = fl2(balance + proceeds);
      ss.upSellOrder = null;
      ss.upShares = 0;
      logFn(`💰 TP HIT ${m.asset.toUpperCase()} UP ${ss.upSellOrder ? '...' : 'all'}sh @ $${TP_PRICE}`);
    }
  }
  // DOWN TP
  if (ss.downSellOrder) {
    if (b.downMid >= TP_PRICE - 0.005) {
      const proceeds = fl2(ss.downSellOrder.shares * TP_PRICE);
      balance = fl2(balance + proceeds);
      ss.downSellOrder = null;
      ss.downShares = 0;
      logFn(`💰 TP HIT ${m.asset.toUpperCase()} DN allsh @ $${TP_PRICE}`);
    }
  }
}

// ── Resolution ──
function resolve(m) {
  const ss = strategyState[m.slug];
  if (!ss || !ss.entered || ss.phase === 'resolved') return;
  const secs = m.secondsToEnd;
  if (secs > -15) return; // wait 15s after end

  ss.phase = 'resolved';

  // Check which side won
  const upWon = (m.upMid || m.upPrice) >= 0.50;
  const b = book(m);

  // Remaining UP shares resolve
  let upPnl = 0;
  if (ss.upShares > 0) {
    const val = upWon ? 1.00 : 0.00;
    const proceeds = fl2(ss.upShares * val);
    balance = fl2(balance + proceeds);
    upPnl = fl2(proceeds - (ss.entryCost * (ss.upShares / (ss.upShares + ss.downShares || 1))));
  }

  // Remaining DOWN shares resolve
  let dnPnl = 0;
  if (ss.downShares > 0) {
    const val = upWon ? 0.00 : 1.00;
    const proceeds = fl2(ss.downShares * val);
    balance = fl2(balance + proceeds);
    dnPnl = fl2(proceeds - (ss.entryCost * (ss.downShares / (ss.upShares + ss.downShares || 1))));
  }

  const totalPnl = fl2(upPnl + dnPnl + ss.scalpPnl);
  totalRealizedPnl = fl4(totalRealizedPnl + totalPnl);
  if (totalPnl >= 0) wins++; else losses++;

  const scalpProfit = totalPnl; // simplified
  logFn(`${totalPnl>=0?'💰':'❌'} RESOLVED ${m.asset.toUpperCase()} ${m.windowType} | Scalps:${ss.scalpCount} | Remaining UP:${ss.upShares} DN:${ss.downShares} | PnL:$${fl2(totalPnl)}`);

  trades.push({
    slug: m.slug, asset: m.asset, windowType: m.windowType,
    entryCost: ss.entryCost, scalpCount: ss.scalpCount,
    upShares: ss.upShares, downShares: ss.downShares,
    pnl: totalPnl, reason: 'RESOLVED',
    time: ss.entryTime, exitTime: Date.now(),
  });
  if (trades.length > 500) trades = trades.slice(-500);

  // Clean up state
  delete strategyState[m.slug];
  m.resolved = true;
}

// ── Main Strategy Loop ──
function strategyTick() {
  const active = Object.values(marketCache).filter(m => m.active);
  if (active.length === 0 || balance < 10) return;

  for (const m of active) {
    const ss = strategyState[m.slug];
    if (!ss) continue;

    if (!ss.entered) {
      tryEnter(m);
    } else if (ss.phase === 'scalp') {
      runScalp(m);
    } else if (ss.phase === 'endgame') {
      runEndgame(m);
    }
    resolve(m);
  }
}

// ── State Persistence ──
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      stateVersion: STATE_VERSION, balance, totalRealizedPnl, totalFees,
      wins, losses, trades: trades.slice(-300), initialEquity,
    }, null, 2));
  } catch (_) {}
}
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (d.stateVersion === STATE_VERSION) {
        balance = d.balance || INITIAL_CAPITAL;
        totalRealizedPnl = d.totalRealizedPnl || 0;
        totalFees = d.totalFees || 0;
        wins = d.wins || 0;
        losses = d.losses || 0;
        trades = d.trades || [];
        initialEquity = d.initialEquity || INITIAL_CAPITAL;
      }
    }
  } catch (_) {}
}

// ── Snapshot ──
function buildSnapshot() {
  const now = Date.now();
  for (const m of Object.values(marketCache)) {
    if (m.active) {
      m.secondsToEnd = Math.floor((m.endTime - now) / 1000);
      if (m.secondsToEnd < -30) m.active = false;
    }
  }

  const active = Object.values(marketCache).filter(m => m.active);
  let totalUpShares = 0, totalDownShares = 0;

  const marketDisplay = active.map(m => {
    const b = book(m);
    const ss = strategyState[m.slug];
    const u = ss ? ss.upShares : 0;
    const d = ss ? ss.downShares : 0;
    totalUpShares += u; totalDownShares += d;
    return {
      slug: m.slug.substring(0, 22), asset: m.asset, windowType: m.windowType,
      upPrice: fl4(b.upMid), downPrice: fl4(b.downMid),
      upBid: fl4(b.upBid), upAsk: fl4(b.upAsk),
      downBid: fl4(b.downBid), downAsk: fl4(b.downAsk),
      secondsToEnd: m.secondsToEnd,
      entered: ss ? ss.entered : false, phase: ss ? ss.phase : 'idle',
      upShares: u, downShares: d,
      scalpCount: ss ? ss.scalpCount : 0,
      scalpPnl: ss ? fl2(ss.scalpPnl) : 0,
      hasUpSell: ss && ss.upSellOrder ? 1 : 0,
      hasUpBuy: ss && ss.upBuyOrder ? 1 : 0,
      hasDnSell: ss && ss.downSellOrder ? 1 : 0,
      hasDnBuy: ss && ss.downBuyOrder ? 1 : 0,
    };
  });

  return {
    balance: fl2(balance),
    equity: fl2(balance),
    initialEquity,
    totalPnl: fl4(totalRealizedPnl),
    totalRealizedPnl: fl4(totalRealizedPnl),
    totalFees: fl4(totalFees),
    wins, losses,
    totalTrades: wins + losses,
    winRate: wins + losses > 0 ? fl4(wins / (wins + losses) * 100) : 0,
    activeMarkets: active.length,
    totalUpShares, totalDownShares,
    shares15m: { up: 0, dn: 0 },
    shares5m: { up: totalUpShares, dn: totalDownShares },
    marketDisplay,
    trades: trades.slice(-20).reverse().map(t => ({
      asset: t.asset, windowType: t.windowType,
      scalpCount: t.scalpCount, pnl: t.pnl, reason: t.reason,
    })),
    uptime: Math.floor((now - startTime) / 1000),
    discoveryCount,
    connected: true,
    timestamp: now,
    note: `Strategy v${STATE_VERSION}: Buy 500/500 at open, scalp ±0.02 for 4min, TP at 0.99 last min. ${totalUpShares}UP/${totalDownShares}DN held.`,
  };
}

// ── Main Loop ──
async function tick() {
  try {
    tickCount++;
    if (discoveryCount === 0) { await discoverMarkets(); await fetchClob(); }
    else if (tickCount % 30 === 0) await discoverMarkets();
    await fetchClob();
    strategyTick();
    saveState();
    emitFn('snapshot', buildSnapshot());
  } catch (e) { logFn(`⚠️ ${e.message} ${e.stack}`); }
}

async function start(emit, logEmit) {
  emitFn = emit; logEmit = logEmit; startTime = Date.now();
  loadState();
  logFn(`✅ Strategy v${STATE_VERSION} | Capital: $${fl2(balance)}`);
  await discoverMarkets();
  await tick();
  setInterval(tick, 1000); // check every 1s
}

async function runBacktest() {
  return { overall: { trades: wins + losses, wins, losses, pnl: totalRealizedPnl, fees: totalFees } };
}

module.exports = { start, buildSnapshot, runBacktest };
