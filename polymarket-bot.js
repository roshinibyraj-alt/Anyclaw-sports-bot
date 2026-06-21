'use strict';

const fs = require('fs');
const path = require('path');
const PolymarketTrader = require('./polymarket-trader');

const INITIAL_CAPITAL = 0;
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

const SCALP_SIZE = 6;
const SCALP_OFFSET = 0.02;
const TP_PRICE = 0.99;
// Fee rate is fetched dynamically from CLOB for each market

// MUST have private key - no simulation mode
if (!process.env.POLYMARKET_PRIVATE_KEY) {
  throw new Error('POLYMARKET_PRIVATE_KEY required - no simulation mode. Set your wallet private key.');
}

let trader = null;
let balance = INITIAL_CAPITAL;
let totalRealizedPnl = 0;
let totalFees = 0;
let wins = 0;
let losses = 0;
let trades = [];
let marketCache = {};
let strategyState = {};
let initialEquity = INITIAL_CAPITAL;
let equityHistory = [];
let peakEquity = INITIAL_CAPITAL;
let maxDrawdown = 0;
let windowResults = [];
let emitFn = () => {};
let logFn = () => {};
let startTime = Date.now();
let discoveryCount = 0;
let tickCount = 0;
let pendingOrders = {}; // {id: {side, tokenId, price, shares, status}}

function fl2(v) { return Math.round((v || 0) * 100) / 100; }
function fl4(v) { return Math.round((v || 0) * 10000) / 10000; }
function id8() { return Date.now().toString(36) + Math.random().toString(36).substring(2, 6); }

async function getJson(url) {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 8000);
    const r = await fetch(url, { signal: ac.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    return await r.json();
  } catch (_) { return null; }
}

function windowEpochs() {
  const now = Math.floor(Date.now() / 1000);
  const ws = 900;
  const cw = Math.floor(now / ws) * ws;
  return [
    { asset: 'btc', slug: 'btc-updown-15m-' + (cw - 900), epoch: cw - 900, windowS: 900, windowType: '15m' },
    { asset: 'btc', slug: 'btc-updown-15m-' + cw, epoch: cw, windowS: 900, windowType: '15m' },
    { asset: 'btc', slug: 'btc-updown-15m-' + (cw + 900), epoch: cw + 900, windowS: 900, windowType: '15m' },
  ];
}

async function discoverMarkets() {
  const candidates = windowEpochs();
  let found = 0;
  const now = Date.now();
  const toFetch = candidates.filter(c => !(marketCache[c.slug] && marketCache[c.slug].resolved));
  if (toFetch.length === 0) return;

  const results = await Promise.allSettled(
    toFetch.map(async c => {
      const d = await getJson(`${GAMMA}/events?slug=${c.slug}`);
      if (!Array.isArray(d) || d.length === 0) return null;
      const ev = d[0];
      if (!ev.markets || ev.markets.length === 0) return null;
      const m = ev.markets[0];
      if (!m.clobTokenIds || !m.outcomePrices) return null;
      let tokenIds, prices;
      try { tokenIds = JSON.parse(m.clobTokenIds); } catch(e) { return null; }
      try { prices = JSON.parse(m.outcomePrices).map(parseFloat); } catch(e) { return null; }
      if (tokenIds.length < 2 || prices.length < 2) return null;
      return { c, ev, m, tokenIds, prices };
    })
  );

  for (const result of results) {
    if (result.status !== 'fulfilled' || !result.value) continue;
    const { c, ev, m, tokenIds, prices } = result.value;
    const tradingEndMs = (c.epoch + c.windowS) * 1000;
    const secs = Math.round((tradingEndMs - now) / 1000);
    const active = secs > 0 && secs <= c.windowS;

    marketCache[c.slug] = {
      slug: c.slug, asset: c.asset, epoch: c.epoch, windowS: c.windowS,
      windowType: c.windowType || '5m',
      upTokenId: tokenIds[0], downTokenId: tokenIds[1],
      upPrice: prices[0], downPrice: prices[1],
      endTime: tradingEndMs, startTime: (c.epoch * 1000),
      active, resolved: false, hasClob: false,
      outcomePrices: prices,
    };

    if (!strategyState[c.slug]) {
      strategyState[c.slug] = {
        slug: c.slug, asset: c.asset, windowType: c.windowType,
        entered: false, phase: 'idle',
        upHeld: 0, downHeld: 0, scalpPnl: 0, scalpCount: 0,
        scalpCycles: [],
        entryBalance: 0, entryTime: 0,
        upBuyOrder: null, upSellOrder: null, upPendingSell: [],
        downBuyOrder: null, downSellOrder: null, downPendingSell: [],
        baseCost: 0, tpCount: 0, resolvePnl: 0,
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
  const allMkts = Object.values(marketCache);
  const now = Date.now();
  for (const m of allMkts) {
    m.secondsToEnd = Math.floor((m.endTime - now) / 1000);
    if (!m.resolved && m.secondsToEnd > 0 && m.secondsToEnd <= m.windowS) m.active = true;
    if (m.secondsToEnd < -30) m.active = false;
  }

  const active = Object.values(marketCache).filter(m => m.active);
  const promises = active.map(async m => {
    try {
      const [upRes, dnRes] = await Promise.all([
        getJson(`${CLOB}/midpoint?token_id=${m.upTokenId}`),
        getJson(`${CLOB}/midpoint?token_id=${m.downTokenId}`)
      ]);
      if (upRes && upRes.mid !== undefined) m.upMid = parseFloat(upRes.mid);
      if (dnRes && dnRes.mid !== undefined) m.downMid = parseFloat(dnRes.mid);
      // Derive opposite from midpoint (they should sum to ~1.0)
      if (m.upMid !== undefined && m.downMid === undefined) m.downMid = fl4(1 - m.upMid);
      else if (m.downMid !== undefined && m.upMid === undefined) m.upMid = fl4(1 - m.downMid);
      m.hasClob = (m.upMid !== undefined && m.downMid !== undefined);
    } catch(e) { m.hasClob = false; }
  });
  await Promise.all(promises);
  
  // Check fills on pending orders
  if (trader && trader.apiKey && Object.keys(pendingOrders).length > 0) {
    try {
      const openOrders = await trader.getOpenOrders();
      const openIds = new Set((openOrders || []).map(o => o.id));
      for (const [id, po] of Object.entries(pendingOrders)) {
        if (po.status === 'cancelling' && !openIds.has(id)) {
          po.status = 'cancelled';
          continue;
        }
        if (po.status !== 'pending') continue;
        if (openIds.has(id)) continue;
        // Disappeared from open orders → filled
        po.status = 'filled';
        const ss = strategyState[po.slug];
        if (ss) {
          if (po.dir === 'up_buy') {
            ss.upHeld += po.shares;
            ss.baseCost = fl2(ss.baseCost + po.shares * po.price);
            logFn(`✅ FILLED BUY↑ ${po.shares}sh@$${po.price} held:${ss.upHeld}`);
          } else if (po.dir === 'dn_buy') {
            ss.downHeld += po.shares;
            ss.baseCost = fl2(ss.baseCost + po.shares * po.price);
            logFn(`✅ FILLED BUY↓ ${po.shares}sh@$${po.price} held:${ss.downHeld}`);
          } else if (po.dir === 'up_sell') {
            const proceeds = fl2(po.shares * po.price);
            ss.upHeld = Math.max(0, ss.upHeld - po.shares);
            balance = fl2(balance + proceeds);
            ss.scalpPnl = fl2(ss.scalpPnl + proceeds);
            ss.scalpCount++;
            logFn(`✅ FILLED SELL↑ ${po.shares}sh@$${po.price} +$${proceeds} held:${ss.upHeld}`);
          } else if (po.dir === 'dn_sell') {
            const proceeds = fl2(po.shares * po.price);
            ss.downHeld = Math.max(0, ss.downHeld - po.shares);
            balance = fl2(balance + proceeds);
            ss.scalpPnl = fl2(ss.scalpPnl + proceeds);
            ss.scalpCount++;
            logFn(`✅ FILLED SELL↓ ${po.shares}sh@$${po.price} +$${proceeds} held:${ss.downHeld}`);
          } else if (po.dir === 'up_sell_tp') {
            balance = fl2(balance + po.shares * po.price);
            ss.upHeld = Math.max(0, ss.upHeld - po.shares);
            ss.tpCount++;
            logFn(`💰 TP↑ filled ${po.shares}sh@$${po.price}`);
          } else if (po.dir === 'dn_sell_tp') {
            balance = fl2(balance + po.shares * po.price);
            ss.downHeld = Math.max(0, ss.downHeld - po.shares);
            ss.tpCount++;
            logFn(`💰 TP↓ filled ${po.shares}sh@$${po.price}`);
          }
        }
      }
      // Clean up old cancelled/filled entries
      for (const [id, po] of Object.entries(pendingOrders)) {
        if ((po.status === 'filled' || po.status === 'cancelled') &&
            Date.now() - po.time > 120000) {
          delete pendingOrders[id];
        }
      }
    } catch(e) { /* best-effort fill check */ }
  }
}

function book(m) {
  const midUp = m.upMid !== undefined ? m.upMid : 0.50;
  const midDown = m.downMid !== undefined ? m.downMid : 0.50;
  return {
    upBid: fl4(midUp - 0.005), upAsk: fl4(midUp + 0.005),
    downBid: fl4(midDown - 0.005), downAsk: fl4(midDown + 0.005),
    upMid: midUp, downMid: midDown,
  };
}

// ── Entry ──
function tryEnter(m) {
  const ss = strategyState[m.slug];
  if (!ss || ss.entered || !m.hasClob) return;
  const secs = m.secondsToEnd;
  if (secs <= 5 || secs > m.windowS) return;
  const b = book(m);
  if (b.upAsk >= 0.97 || b.upAsk <= 0.03 || b.downAsk >= 0.97 || b.downAsk <= 0.03) return;
  ss.entered = true;
  ss.entryTime = Date.now();
  ss.entryBalance = balance;
  ss.phase = 'scalp';
  ss.upHeld = 0; ss.downHeld = 0;
  // active order IDs tracked per side
  ss.upBuyOrderId = null; ss.upSellOrderId = null;
  ss.dnBuyOrderId = null; ss.dnSellOrderId = null;
  // endgame TP sell order IDs
  ss.upTpOrderId = null; ss.dnTpOrderId = null;
  ss.scalpPnl = 0; ss.scalpCount = 0;
  ss.baseCost = 0;
  ss.tpCount = 0; ss.resolvePnl = 0;
  logFn(`🟢 ENTER ${m.asset.toUpperCase()} ${m.windowType} | UP:${fl4(b.upMid)} DN:${fl4(b.downMid)} remaining:${secs}s`);
}

// ── Place real CLOB limit order ──
async function placeOrder(tokenId, side, price, shares, slug, dir) {
  if (!trader || !trader.apiKey) {
    logFn(`⚠️ No trader - cannot place ${side} order`);
    return null;
  }
  try {
    const result = await trader.placeOrder(tokenId, side, price, shares);
    if (result && result.id) {
      const oid = result.id;
      pendingOrders[oid] = { id: oid, tokenId, side, price, shares, slug, dir, status: 'pending', time: Date.now() };
      logFn(`📤 ${side} ${shares}sh@$${price} id:${oid.substring(0,10)}`);
      return oid;
    } else if (result && result.order?.id) {
      const oid = result.order.id;
      pendingOrders[oid] = { id: oid, tokenId, side, price, shares, slug, dir, status: 'pending', time: Date.now() };
      logFn(`📤 ${side} ${shares}sh@$${price} id:${oid.substring(0,10)}`);
      return oid;
    } else if (result && result.success) {
      logFn(`📤 ${side} ${shares}sh@$${price} (no id returned)`);
      return null;
    }
    logFn(`❌ Order failed: ${side} ${shares}sh@$${price}`);
    return null;
  } catch(e) {
    logFn(`❌ Order error: ${e.message.substring(0,80)}`);
    return null;
  }
}

// ── Cancel a tracked order, mark it so fill-detection ignores it ──
function cancelTracked(orderId) {
  if (!orderId) return;
  if (pendingOrders[orderId]) pendingOrders[orderId].status = 'cancelling';
  trader.cancelOrder(orderId).catch(() => {});
}

// ── Scalp — every tick: replace BUY + replace SELL if holding ──
function runScalp(m) {
  const ss = strategyState[m.slug];
  if (!ss || !ss.entered || ss.phase !== 'scalp' || !m.hasClob) return;
  const secs = m.secondsToEnd;
  if (secs <= 0) return;
  if (secs <= 180) { endScalpPhase(m, ss); return; }

  const b = book(m);
  const SIZE = SCALP_SIZE; // 6

  // ── UP BUY: cancel previous, place fresh at bid − offset ──
  cancelTracked(ss.upBuyOrderId);
  ss.upBuyOrderId = null;
  const upBuyPrice = fl4(b.upBid - SCALP_OFFSET);
  if (upBuyPrice > 0.01) {
    placeOrder(m.upTokenId, 'BUY', upBuyPrice, SIZE, m.slug, 'up_buy').then(oid => {
      if (oid) ss.upBuyOrderId = oid;
    });
  }

  // ── UP SELL: if holding, cancel previous, place fresh at ask + offset ──
  cancelTracked(ss.upSellOrderId);
  ss.upSellOrderId = null;
  if (ss.upHeld >= SIZE) {
    const upSellPrice = fl4(Math.min(b.upAsk + SCALP_OFFSET, 0.98));
    placeOrder(m.upTokenId, 'SELL', upSellPrice, SIZE, m.slug, 'up_sell').then(oid => {
      if (oid) ss.upSellOrderId = oid;
    });
  }

  // ── DN BUY: cancel previous, place fresh at bid − offset ──
  cancelTracked(ss.dnBuyOrderId);
  ss.dnBuyOrderId = null;
  const dnBuyPrice = fl4(b.downBid - SCALP_OFFSET);
  if (dnBuyPrice > 0.01) {
    placeOrder(m.downTokenId, 'BUY', dnBuyPrice, SIZE, m.slug, 'dn_buy').then(oid => {
      if (oid) ss.dnBuyOrderId = oid;
    });
  }

  // ── DN SELL: if holding, cancel previous, place fresh at ask + offset ──
  cancelTracked(ss.dnSellOrderId);
  ss.dnSellOrderId = null;
  if (ss.downHeld >= SIZE) {
    const dnSellPrice = fl4(Math.min(b.downAsk + SCALP_OFFSET, 0.98));
    placeOrder(m.downTokenId, 'SELL', dnSellPrice, SIZE, m.slug, 'dn_sell').then(oid => {
      if (oid) ss.dnSellOrderId = oid;
    });
  }
}

function endScalpPhase(m, ss) {
  ss.phase = 'endgame';
  // Cancel all active scalp orders
  cancelTracked(ss.upBuyOrderId);  ss.upBuyOrderId = null;
  cancelTracked(ss.upSellOrderId); ss.upSellOrderId = null;
  cancelTracked(ss.dnBuyOrderId);  ss.dnBuyOrderId = null;
  cancelTracked(ss.dnSellOrderId); ss.dnSellOrderId = null;
  // Place TP sell at 0.99 for all held shares
  if (ss.upHeld > 0 && !ss.upTpOrderId) {
    placeOrder(m.upTokenId, 'SELL', TP_PRICE, ss.upHeld, m.slug, 'up_sell_tp').then(oid => {
      if (oid) ss.upTpOrderId = oid;
    });
  }
  if (ss.downHeld > 0 && !ss.dnTpOrderId) {
    placeOrder(m.downTokenId, 'SELL', TP_PRICE, ss.downHeld, m.slug, 'dn_sell_tp').then(oid => {
      if (oid) ss.dnTpOrderId = oid;
    });
  }
  logFn(`🛑 ENDGAME ${m.asset.toUpperCase()} ${m.windowType} | Scalps:${ss.scalpCount} Held:↑${ss.upHeld}↓${ss.downHeld} TP@$${TP_PRICE}`);
}

function runEndgame(m) {
  const ss = strategyState[m.slug];
  if (!ss || !ss.entered || ss.phase !== 'endgame' || !m.hasClob) return;
  // Fill detection is handled in fetchClob for 'up_sell_tp' / 'dn_sell_tp' dirs
}

function resolve(m) {
  const ss = strategyState[m.slug];
  if (!ss || !ss.entered || ss.phase === 'resolved') return;
  const secs = m.secondsToEnd;
  if (secs > -15) return;

  ss.phase = 'resolved';
  const b = book(m);
  const winnerUp = b.upMid >= b.downMid;
  let settlePnl = 0;

  if (ss.upHeld > 0) {
    const val = fl2(winnerUp ? ss.upHeld * 0.99 : ss.upHeld * 0.01);
    balance = fl2(balance + val);
    settlePnl += val;
    logFn('🏁 RESOLVE↑ ' + m.asset.toUpperCase() + ' ' + m.windowType + ' ' + ss.upHeld + 'sh = $' + val);
  }
  if (ss.downHeld > 0) {
    const val = fl2(!winnerUp ? ss.downHeld * 0.99 : ss.downHeld * 0.01);
    balance = fl2(balance + val);
    settlePnl += val;
    logFn('🏁 RESOLVE↓ ' + m.asset.toUpperCase() + ' ' + m.windowType + ' ' + ss.downHeld + 'sh = $' + val);
  }

  ss.resolvePnl = fl2(settlePnl);
  const windowPnl = fl2(balance - ss.entryBalance);
  totalRealizedPnl = fl2(totalRealizedPnl + windowPnl);
  logFn('💰 RESOLVED ' + m.asset.toUpperCase() + ' ' + m.windowType + ' | WindowsPnL:$' + fl2(windowPnl) + ' (scalps:' + fl2(ss.scalpPnl) + ' settle:' + fl2(settlePnl) + ')');
  trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,scalpCount:ss.scalpCount,tpCount:ss.tpCount,pnl:fl2(windowPnl),scalpPnl:ss.scalpPnl,settlePnl:fl2(settlePnl),reason:'RESOLVED',time:ss.entryTime||Date.now()});
  windowResults.push({asset:m.asset,windowType:m.windowType,pnl:fl2(windowPnl),scalpPnl:ss.scalpPnl,settlePnl:fl2(settlePnl),scalps:ss.scalpCount,time:Date.now()});
  if (windowResults.length > 100) windowResults = windowResults.slice(-100);
  if(trades.length>500)trades=trades.slice(-500);
  delete strategyState[m.slug];
  m.resolved = true;
}

function strategyTick() {
  const active = Object.values(marketCache).filter(m => m.active);
  if (active.length === 0) return;
  for (const m of active) {
    if (!m.hasClob) continue;
    const ss = strategyState[m.slug];
    if (!ss) continue;
    if (!ss.entered) tryEnter(m);
    else if (ss.phase === 'scalp') runScalp(m);
    else if (ss.phase === 'endgame') runEndgame(m);
    resolve(m);
  }
}

function buildSnapshot() {
  const now = Date.now();
  for (const m of Object.values(marketCache)) {
    m.secondsToEnd = Math.floor((m.endTime - now) / 1000);
    if (m.secondsToEnd < -30) { m.active = false; m.hasClob = false; }
    if (m.secondsToEnd > 0 && m.secondsToEnd <= m.windowS && !m.resolved) m.active = true;
  }

  const active = Object.values(marketCache).filter(m => m.active && m.hasClob);
  let totalUpShares = 0, totalDownShares = 0;
  let unrealizedPnl = 0;

  const marketDisplay = active.map(m => {
    const b = book(m);
    const ss = strategyState[m.slug];
    const u = ss ? ss.upHeld : 0;
    const d = ss ? ss.downHeld : 0;
    totalUpShares += u; totalDownShares += d;
    if (ss) unrealizedPnl += fl2(u * b.upMid) + fl2(d * b.downMid);
    const cycles = ss ? ss.scalpCycles || [] : [];
    const last5 = cycles.slice(-5).reverse();
    const avgBuy = cycles.length > 0 ? fl4(cycles.reduce((s,c) => s + c.buyPrice, 0) / cycles.length) : 0;
    const avgSell = cycles.length > 0 ? fl4(cycles.reduce((s,c) => s + c.sellPrice, 0) / cycles.length) : 0;
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
      tpCount: ss ? ss.tpCount : 0,
      avgBuyPrice: avgBuy, avgSellPrice: avgSell,
      recentCycles: last5.map(c => ({...c, time: c.time})),
    };
  });

  const equity = fl2(balance + Math.max(0, unrealizedPnl));
  if (equity > peakEquity) peakEquity = equity;
  const dd = peakEquity > 0 ? fl4((peakEquity - equity) / peakEquity * 100) : 0;
  if (dd > maxDrawdown) maxDrawdown = dd;
  if (tickCount % 5 === 0) {
    equityHistory.push({ t: now, e: equity });
    if (equityHistory.length > 10000) equityHistory = equityHistory.slice(-10000);
  }

  // Clean stale pending orders
  for (const [id, po] of Object.entries(pendingOrders)) {
    if (po.status === 'pending' && now - po.time > 300000) {
      po.status = 'expired';
      trader.cancelOrder(id).catch(() => {});
    }
  }

  return {
    peakEquity: fl2(peakEquity), maxDrawdown, drawdown: dd,
    windowResults: windowResults.slice(-20).reverse(),
    balance: fl2(balance), equity,
    initialEquity: typeof initialEquity === 'number' ? fl2(initialEquity) : 0,
    totalPnl: fl4(totalRealizedPnl), totalFees: fl4(totalFees),
    wins, losses, totalTrades: wins + losses,
    winRate: wins + losses > 0 ? fl4(wins / (wins + losses) * 100) : 0,
    activeMarkets: active.length,
    totalUpShares, totalDownShares,
    equityHistory: equityHistory.slice(-500),
    marketDisplay,
    trades: trades.slice(-50).reverse().map(t => ({
      asset: t.asset, windowType: t.windowType, action: t.action || '',
      side: t.side || '', price: t.price || 0, shares: t.shares || 0,
      cost: t.cost || 0, pnl: t.pnl || 0, fee: t.fee || 0,
      scalpCount: t.scalpCount || 0, tpCount: t.tpCount || 0,
      scalpPnl: t.scalpPnl || 0, settlePnl: t.settlePnl || 0,
      reason: t.reason || '', time: t.time || 0,
    })),
    uptime: Math.floor((now - startTime) / 1000),
    discoveryCount, connected: true, timestamp: now,
    realTrading: true,
    note: `LIVE ONLY | BTC 15m | CLOB scalper | ${Object.keys(pendingOrders).length} pending orders`,
  commitVersion: process.env.RAILWAY_GIT_COMMIT || process.env.GIT_COMMIT || 'live',
  };
}

async function tick() {
  try {
    tickCount++;
    if (discoveryCount === 0) { await discoverMarkets(); await fetchClob(); }
    else if (tickCount % 15 === 0) await discoverMarkets();
    await fetchClob();
    strategyTick();
    if (tickCount % 10 === 0) {
      // Periodically sync balance from on-chain
      try {
        const rb = await Promise.race([
          trader.getBalance(),
          new Promise(r => setTimeout(() => r(-1), 6000))
        ]);
        if (rb >= 0) balance = rb;
      } catch(_) {}
    }
    emitFn('snapshot', buildSnapshot());
  } catch (e) { logFn(`⚠️ ${e.message}`); }
}

async function start(emit, logEmit) {
  emitFn = emit; logFn = logEmit; startTime = Date.now();
  logFn('📦 v19 | every-tick buy+sell scalp | ' + (process.env.GIT_COMMIT || 'deploy-' + Date.now().toString(36)));
  
  const funderAddr = process.env.FUNDER_ADDRESS;
  const sigType = process.env.SIGNATURE_TYPE || (funderAddr ? '1' : '0');
  if (funderAddr) {
    logFn(`🔐 Deposit Wallet mode: funder=${funderAddr.substring(0,10)}... signer_type=${sigType}`);
  }
  
  trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY, funderAddr);
  trader.setLogFn(logFn);
  logFn('🔑 Authenticating with Polymarket CLOB...');
  const authed = await trader.authenticate();
  if (!authed) {
    logFn('❌ Authentication failed. Check your POLYMARKET_PRIVATE_KEY.');
    process.exit(1);
  }
  
  // Get real balance – try on-chain first (handles USDC + PUSD + CTF deposit)
  // For proxy wallets, on-chain PUSD balance is the source of truth
  try {
    let realBalance = await Promise.race([
      trader.getBalance(),
      new Promise(r => setTimeout(() => r(-1), 10000))
    ]);
    // Also try CLOB endpoint as supplementary info
    if (realBalance <= 0) {
      const clobBal = await Promise.race([
        trader.getBalanceAllowance(),
        new Promise(r => setTimeout(() => r(-2), 6000))
      ]);
      if (clobBal > 0) realBalance = clobBal;
    }
    if (realBalance > 0) {
      balance = realBalance;
      initialEquity = realBalance;
      peakEquity = realBalance;
      logFn(`💰 Balance: $${fl2(realBalance)}${funderAddr ? ' (PUSD in Deposit Wallet)' : ''}`);
    } else {
      balance = 0;
      initialEquity = 0;
      peakEquity = 0;
      logFn('💰 Balance: $0 (no funds or RPC unavailable)');
    }
  } catch(e) {
    balance = 0;
    initialEquity = 0;
    peakEquity = 0;
    logFn('💰 Balance fetch error, showing $0');
  }

  logFn(`🔴 LIVE TRADING MODE | Capital: $${fl2(balance)}${funderAddr ? ' via Deposit Wallet' : ''}`);
  await discoverMarkets();
  await tick();
  setInterval(tick, 1000);
  
  // Sync balance every 60s – prioritize on-chain (handles PUSD)
  setInterval(async () => {
    try {
      let rb = await Promise.race([
        trader.getBalance(),
        new Promise(r => setTimeout(() => r(-1), 10000))
      ]);
      if (rb < 0) {
        rb = await Promise.race([
          trader.getBalanceAllowance(),
          new Promise(r => setTimeout(() => r(-1), 6000))
        ]);
      }
      if (rb >= 0 && Math.abs(rb - balance) > 0.01) {
        balance = rb;
        logFn(`💰 Balance synced: $${fl2(rb)}`);
      }
    } catch(_) {}
  }, 60000);
}

async function runBacktest() {
  return { overall: { trades: wins + losses, wins, losses, pnl: totalRealizedPnl, fees: totalFees } };
}

module.exports = { start, buildSnapshot, runBacktest };
