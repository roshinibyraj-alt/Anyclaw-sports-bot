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
const SCALP_SIZE = 10;             // 10 shares per scalp order
const SCALP_OFFSET = 0.02;         // place at bid-0.02 / ask+0.02
const TP_PRICE = 0.99;             // sell limit at 0.99 in endgame
const SCALP_END_MINUTES = 4;       // scalp for 4 minutes (out of 5)

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

// ── Pure Scalp: no upfront position, buy then sell ──
function tryEnter(m) {
  const ss = strategyState[m.slug];
  if (!ss || ss.entered) return;
  const secs = m.secondsToEnd;
  if (secs <= 5 || secs > m.windowS) return;
  const b = book(m);
  if (b.upAsk >= 0.97 || b.upAsk <= 0.03 || b.downAsk >= 0.97 || b.downAsk <= 0.03) return;
  ss.entered = true;
  ss.entryTime = Date.now();
  ss.phase = 'scalp';
  ss.upHeld = 0; ss.downHeld = 0;
  ss.upBuyOrder = null; ss.upSellOrder = null;
  ss.downBuyOrder = null; ss.downSellOrder = null;
  ss.scalpPnl = 0; ss.scalpCount = 0;
  ss.baseCost = 0;
}

// ── Scalp loop ──
function runScalp(m) {
  const ss = strategyState[m.slug];
  if (!ss || !ss.entered || ss.phase !== 'scalp') return;
  const secs = m.secondsToEnd;
  if (secs <= 0) return;

  const scalpEnd = m.windowType === '5m' ? 60 : 180;
  if (secs <= scalpEnd) { endScalpPhase(m, ss); return; }

  const b = book(m);
  const SIZE = SCALP_SIZE;

  // === UP: Relentless buy at bid-0.02 ===
  // Always maintain a buy order at current bid-0.02 (updates every tick)
  const buyPrice = fl4(b.upBid - SCALP_OFFSET);
  if (buyPrice > 0.01) {
    if (!ss.upBuyOrder) {
      ss.upBuyOrder = { id: id8(), price: buyPrice, shares: SIZE, tickCount: 0 };
    } else {
      // Update price if bid moved (simulate cancel/replace)
      ss.upBuyOrder.price = buyPrice;
      ss.upBuyOrder.tickCount++;
    }
  }

  // Check UP buy fill — fills when mid dips to our level
  if (ss.upBuyOrder) {
    const fillProb = Math.min(0.08, 0.005 + ss.upBuyOrder.tickCount * 0.002);
    if (b.upMid <= ss.upBuyOrder.price + 0.001 || Math.random() < fillProb) {
      const cost = fl2(SIZE * ss.upBuyOrder.price);
      if (cost >= 2 && cost <= balance * 0.2) {
        balance = fl2(balance - cost);
        ss.upHeld += SIZE;
        ss.scalpPnl = fl2(ss.scalpPnl - cost);
        logFn(`🟢 BUY ${m.asset.toUpperCase()} UP ${SIZE}sh @ $${ss.upBuyOrder.price}`);
        trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,action:'BUY',side:'UP',price:ss.upBuyOrder.price,shares:SIZE,pnl:0,reason:'SCALP',time:Date.now()});
        if(trades.length>1000)trades=trades.slice(-1000);
        // Immediately place sell at ask+0.02
        const sellPrice = fl4(b.upAsk + SCALP_OFFSET);
        if (sellPrice < 0.99 && sellPrice > ss.upBuyOrder.price + 0.01) {
          ss.upSellOrder = { id: id8(), price: sellPrice, shares: SIZE };
        }
        // Reset buy for next cycle
        ss.upBuyOrder = { id: id8(), price: buyPrice, shares: SIZE, tickCount: 0 };
      }
    }
  }

  // Check UP sell fill
  if (ss.upSellOrder) {
    if (b.upMid >= ss.upSellOrder.price - 0.002 || Math.random() < 0.03) {
      const proceeds = fl2(ss.upSellOrder.shares * ss.upSellOrder.price);
      balance = fl2(balance + proceeds);
      ss.scalpPnl = fl2(ss.scalpPnl + proceeds);
      ss.scalpCount++;
      ss.upHeld -= ss.upSellOrder.shares;
      ss.upSellOrder = null;
      trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,action:'SELL',side:'UP',price:ss.upSellOrder.price,shares:ss.upSellOrder.shares,pnl:fl2((ss.upSellOrder.price-(ss.upBuyOrder?ss.upBuyOrder.price:0))*ss.upSellOrder.shares),reason:'SCALP',time:Date.now()});
      if(trades.length>1000)trades=trades.slice(-1000);
      logFn(`🔴 SELL ${m.asset.toUpperCase()} UP ${SIZE}sh @ $${ss.upSellOrder.price}`);
    }
  }

  // === DOWN: Mirror ===
  const dnBuyPrice = fl4(b.downBid - SCALP_OFFSET);
  if (dnBuyPrice > 0.01) {
    if (!ss.downBuyOrder) {
      ss.downBuyOrder = { id: id8(), price: dnBuyPrice, shares: SIZE, tickCount: 0 };
    } else {
      ss.downBuyOrder.price = dnBuyPrice;
      ss.downBuyOrder.tickCount++;
    }
  }
  if (ss.downBuyOrder) {
    const fillProb = Math.min(0.08, 0.005 + ss.downBuyOrder.tickCount * 0.002);
    if (b.downMid <= ss.downBuyOrder.price + 0.001 || Math.random() < fillProb) {
      const cost = fl2(SIZE * ss.downBuyOrder.price);
      if (cost >= 2 && cost <= balance * 0.2) {
        balance = fl2(balance - cost);
        ss.downHeld += SIZE;
        ss.scalpPnl = fl2(ss.scalpPnl - cost);
        logFn(`🟢 BUY ${m.asset.toUpperCase()} DN ${SIZE}sh @ $${ss.downBuyOrder.price}`);
        trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,action:'BUY',side:'DOWN',price:ss.downBuyOrder.price,shares:SIZE,pnl:0,reason:'SCALP',time:Date.now()});
        if(trades.length>1000)trades=trades.slice(-1000);
        const sellPrice = fl4(b.downAsk + SCALP_OFFSET);
        if (sellPrice < 0.99 && sellPrice > ss.downBuyOrder.price + 0.01) {
          ss.downSellOrder = { id: id8(), price: sellPrice, shares: SIZE };
        }
        ss.downBuyOrder = { id: id8(), price: dnBuyPrice, shares: SIZE, tickCount: 0 };
      }
    }
  }
  if (ss.downSellOrder) {
    if (b.downMid >= ss.downSellOrder.price - 0.002 || Math.random() < 0.03) {
      const proceeds = fl2(ss.downSellOrder.shares * ss.downSellOrder.price);
      balance = fl2(balance + proceeds);
      ss.scalpPnl = fl2(ss.scalpPnl + proceeds);
      ss.scalpCount++;
      ss.downHeld -= ss.downSellOrder.shares;
      ss.downSellOrder = null;
      trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,action:'SELL',side:'DOWN',price:ss.downSellOrder.price,shares:ss.downSellOrder.shares,pnl:fl2((ss.downSellOrder.price-(ss.downBuyOrder?ss.downBuyOrder.price:0))*ss.downSellOrder.shares),reason:'SCALP',time:Date.now()});
      if(trades.length>1000)trades=trades.slice(-1000);
      logFn(`🔴 SELL ${m.asset.toUpperCase()} DN ${SIZE}sh @ $${ss.downSellOrder.price}`);
    }
  }
}

function endScalpPhase(m, ss) {
  ss.phase = 'endgame';
  // Cancel unfilled buy orders
  ss.upBuyOrder = null;
  ss.downBuyOrder = null;
  // Keep any held shares — will TP or resolve
  if (ss.upHeld > 0 && !ss.upSellOrder) {
    ss.upSellOrder = { id: id8(), price: TP_PRICE, shares: ss.upHeld };
  }
  if (ss.downHeld > 0 && !ss.downSellOrder) {
    ss.downSellOrder = { id: id8(), price: TP_PRICE, shares: ss.downHeld };
  }
  logFn(`🛑 ENDGAME ${m.asset.toUpperCase()} ${m.windowType} — UP:${ss.upHeld}sh DN:${ss.downHeld}sh | Scalps:${ss.scalpCount} | TP at $${TP_PRICE}`);
}

// ── Endgame: TP at 0.99 ──
function runEndgame(m) {
  const ss = strategyState[m.slug];
  if (!ss || !ss.entered || ss.phase !== 'endgame') return;
  const secs = m.secondsToEnd;
  if (secs < -10) return;

  // Ensure TP orders exist for held shares
  if (ss.upHeld > 0 && !ss.upSellOrder) {
    ss.upSellOrder = { id: id8(), price: TP_PRICE, shares: ss.upHeld };
  }
  if (ss.downHeld > 0 && !ss.downSellOrder) {
    ss.downSellOrder = { id: id8(), price: TP_PRICE, shares: ss.downHeld };
  }

  const b = book(m);
  if (ss.upSellOrder && b.upMid >= TP_PRICE - 0.005) {
    const proceeds = fl2(ss.upSellOrder.shares * TP_PRICE);
    balance = fl2(balance + proceeds);
    ss.scalpPnl = fl2(ss.scalpPnl + proceeds);
    ss.upHeld = 0;
    ss.upSellOrder = null;
    trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,action:'TP',side:'UP',price:TP_PRICE,shares:ss.upSellOrder.shares,pnl:fl2(proceeds),reason:'TP',time:Date.now()});
      if(trades.length>1000)trades=trades.slice(-1000);
      logFn(`💰 TP ${m.asset.toUpperCase()} UP @ $${TP_PRICE}`);
  }
  if (ss.downSellOrder && b.downMid >= TP_PRICE - 0.005) {
    const proceeds = fl2(ss.downSellOrder.shares * TP_PRICE);
    balance = fl2(balance + proceeds);
    ss.scalpPnl = fl2(ss.scalpPnl + proceeds);
    ss.downHeld = 0;
    ss.downSellOrder = null;
    trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,action:'TP',side:'DOWN',price:TP_PRICE,shares:ss.downSellOrder.shares,pnl:fl2(proceeds),reason:'TP',time:Date.now()});
      if(trades.length>1000)trades=trades.slice(-1000);
      logFn(`💰 TP ${m.asset.toUpperCase()} DN @ $${TP_PRICE}`);
  }
}

// ── Resolution ──
function resolve(m) {
  const ss = strategyState[m.slug];
  if (!ss || !ss.entered || ss.phase === 'resolved') return;
  const secs = m.secondsToEnd;
  if (secs > -15) return; // wait 15s after end

  ss.phase = 'resolved';

  // Remaining held shares resolve naturally
  const upWon = (m.upMid || m.upPrice) >= 0.50;
  let finalPnl = ss.scalpPnl;
  if (ss.upHeld > 0) {
    const val = upWon ? 1.00 : 0.00;
    balance = fl2(balance + fl2(ss.upHeld * val));
  }
  if (ss.downHeld > 0) {
    const val = upWon ? 0.00 : 1.00;
    balance = fl2(balance + fl2(ss.downHeld * val));
  }
  // Don't double-count — scalpPnl already includes buy costs and sell proceeds
  // Remaining held shares are pure resolution value

  totalRealizedPnl = fl4(totalRealizedPnl + ss.scalpPnl);
  if (ss.scalpPnl >= 0) wins++; else losses++;

  logFn(`${ss.scalpPnl>=0?'💰':'❌'} RESOLVED ${m.asset.toUpperCase()} ${m.windowType} | Scalps:${ss.scalpCount} | Held UP:${ss.upHeld} DN:${ss.downHeld} | ScalpPnL:$${fl2(ss.scalpPnl)}`);

  trades.push({
    slug: m.slug, asset: m.asset, windowType: m.windowType,
    scalpCount: ss.scalpCount, scalpPnl: fl2(ss.scalpPnl),
    pnl: fl2(ss.scalpPnl), reason: 'RESOLVED',
    time: ss.entryTime, exitTime: Date.now(),
  });
  if (trades.length > 500) trades = trades.slice(-500);
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
    const u = ss ? ss.upHeld : 0;
    const d = ss ? ss.downHeld : 0;
    totalUpShares += u; totalDownShares += d;
    return {
      slug: m.slug.substring(0, 22), asset: m.asset, windowType: m.windowType,
      upPrice: fl4(b.upMid), downPrice: fl4(b.downMid),
      upBid: fl4(b.upBid), upAsk: fl4(b.upAsk),
      downBid: fl4(b.downBid), downAsk: fl4(b.downAsk),
      secondsToEnd: m.secondsToEnd,
      entered: ss ? ss.entered : false, phase: ss ? ss.phase : 'idle',
      upHeld: u || 0, downHeld: d || 0,
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
    trades: trades.slice(-50).reverse().map(t => ({
      asset: t.asset, windowType: t.windowType, action: t.action || '',
      side: t.side || '', price: t.price || 0, shares: t.shares || 0,
      scalpCount: t.scalpCount || 0, pnl: t.pnl || 0, reason: t.reason || '',
    })),
    uptime: Math.floor((now - startTime) / 1000),
    discoveryCount,
    connected: true,
    timestamp: now,
    note: `Strategy v${STATE_VERSION}: Pure scalp — buy at bid-0.02, sell at ask+0.02, no upfront position. TP last min. ${totalUpShares}UP/${totalDownShares}DN held.`,
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
  logFn(`✅ Strategy v${STATE_VERSION} | Scalp bot | Capital: $${fl2(balance)}`);
  await discoverMarkets();
  await tick();
  setInterval(tick, 1000); // check every 1s
}

async function runBacktest() {
  return { overall: { trades: wins + losses, wins, losses, pnl: totalRealizedPnl, fees: totalFees } };
}

module.exports = { start, buildSnapshot, runBacktest };
