'use strict';

const fs = require('fs');
const path = require('path');

const INITIAL_CAPITAL = 10000;
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const STATE_FILE = path.join(__dirname, 'state.json');
const STATE_VERSION = 10;

const SCALP_SIZE = 10;
const SCALP_OFFSET = 0.02;
const TP_PRICE = 0.99;
const FEE_RATE = 0; // 0% maker fee (limit orders)

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
  const ws = 900; const cw = Math.floor(now / ws) * ws;
  const ws5 = 300; const cw5 = Math.floor(now / ws5) * ws5;
  return [
    { asset: 'btc', slug: 'btc-updown-5m-' + (cw5 - 300), epoch: cw5 - 300, windowS: 300, windowType: '5m' },
    { asset: 'btc', slug: 'btc-updown-5m-' + cw5, epoch: cw5, windowS: 300, windowType: '5m' },
    { asset: 'btc', slug: 'btc-updown-5m-' + (cw5 + 300), epoch: cw5 + 300, windowS: 300, windowType: '5m' },
    { asset: 'eth', slug: 'eth-updown-5m-' + (cw5 - 300), epoch: cw5 - 300, windowS: 300, windowType: '5m' },
    { asset: 'eth', slug: 'eth-updown-5m-' + cw5, epoch: cw5, windowS: 300, windowType: '5m' },
    { asset: 'eth', slug: 'eth-updown-5m-' + (cw5 + 300), epoch: cw5 + 300, windowS: 300, windowType: '5m' },
    { asset: 'sol', slug: 'sol-updown-5m-' + (cw5 - 300), epoch: cw5 - 300, windowS: 300, windowType: '5m' },
    { asset: 'sol', slug: 'sol-updown-5m-' + cw5, epoch: cw5, windowS: 300, windowType: '5m' },
    { asset: 'sol', slug: 'sol-updown-5m-' + (cw5 + 300), epoch: cw5 + 300, windowS: 300, windowType: '5m' },
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
        scalpCycles: [], // [{buyPrice, sellPrice, shares, pnl, time}]
        entryBalance: 0, entryTime: 0,
        upBuyOrder: null, upSellOrder: null, upPendingSell: [],
        downBuyOrder: null, downSellOrder: null, downPendingSell: [],
        baseCost: 0,
        tpCount: 0, resolvePnl: 0,
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
      else m.upMid = undefined;
      if (dnRes && dnRes.mid !== undefined) m.downMid = parseFloat(dnRes.mid);
      else m.downMid = undefined;
      if (m.upMid !== undefined && m.downMid === undefined) m.downMid = fl4(1 - m.upMid);
      else if (m.downMid !== undefined && m.upMid === undefined) m.upMid = fl4(1 - m.downMid);
      m.hasClob = (m.upMid !== undefined && m.downMid !== undefined);
    } catch(e) { m.hasClob = false; }
  });
  await Promise.all(promises);
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
  ss.upBuyOrder = null; ss.upSellOrder = null;
  ss.upPendingSell = [];
  ss.downBuyOrder = null; ss.downSellOrder = null;
  ss.downPendingSell = [];
  ss.scalpPnl = 0; ss.scalpCount = 0;
  ss.scalpCycles = [];
  ss.baseCost = 0;
  ss.tpCount = 0; ss.resolvePnl = 0;
  logFn(`🟢 ENTER ${m.asset.toUpperCase()} ${m.windowType} | UP:${fl4(b.upMid)} DN:${fl4(b.downMid)} remaining:${secs}s`);
}

// ── Scalp ──
function runScalp(m) {
  const ss = strategyState[m.slug];
  if (!ss || !ss.entered || ss.phase !== 'scalp' || !m.hasClob) return;
  const secs = m.secondsToEnd;
  if (secs <= 0) return;

  const scalpEnd = m.windowType === '5m' ? 60 : 180;
  if (secs <= scalpEnd) { endScalpPhase(m, ss); return; }

  const b = book(m);
  const SIZE = SCALP_SIZE;

  // === UP side ===
  const upBuyPrice = fl4(b.upBid - SCALP_OFFSET);
  if (upBuyPrice > 0.01) {
    if (!ss.upBuyOrder) ss.upBuyOrder = { id: id8(), price: upBuyPrice, shares: SIZE, tickCount: 0 };
    else { ss.upBuyOrder.price = upBuyPrice; ss.upBuyOrder.tickCount++; }
  }
  if (ss.upBuyOrder) {
    const fillProb = Math.min(0.90, 0.02 + ss.upBuyOrder.tickCount * 0.015);
    if (b.upMid <= ss.upBuyOrder.price || Math.random() < fillProb) {
      const cost = fl2(SIZE * ss.upBuyOrder.price);
      if (cost >= 2 && cost <= balance * 0.2) {
        const filledPrice = ss.upBuyOrder.price;
        balance = fl2(balance - cost);
        ss.upHeld += SIZE;
        ss.baseCost = fl2(ss.baseCost + cost);
        logFn(`🟢 BUY↑ ${m.asset.toUpperCase()} ${SIZE}sh@$${filledPrice} cost:$${cost}`);
        trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,action:'BUY',side:'UP',price:filledPrice,shares:SIZE,cost,pnl:0,reason:'SCALP',time:Date.now()});
        if(trades.length>1000)trades=trades.slice(-1000);
        const sellPrice = fl4(b.upAsk + SCALP_OFFSET);
        if (sellPrice < 0.99 && sellPrice > filledPrice + 0.01)
          ss.upPendingSell.push({ id: id8(), price: sellPrice, shares: SIZE, buyPrice: filledPrice, time: Date.now() });
        ss.upBuyOrder = { id: id8(), price: upBuyPrice, shares: SIZE, tickCount: 0 };
      }
    }
  }
  // UP sells
  if (ss.upPendingSell.length > 0) {
    for (let i = ss.upPendingSell.length - 1; i >= 0; i--) {
      const o = ss.upPendingSell[i];
      const fillProb = Math.min(0.90, 0.02 + (o.tickCount || 0) * 0.02);
      if (b.upMid >= o.price - 0.002 || Math.random() < fillProb) {
        const proceeds = fl2(o.shares * o.price);
        const pnl = fl2((o.price - o.buyPrice) * o.shares);
        const fee = fl2(proceeds * FEE_RATE);
        balance = fl2(balance + proceeds - fee);
        totalFees = fl2(totalFees + fee);
        ss.scalpPnl = fl2(ss.scalpPnl + pnl - fee);
        ss.scalpCount++;
        ss.scalpCycles.push({buyPrice:o.buyPrice, sellPrice:o.price, shares:o.shares, pnl:fl2(pnl-fee), side:'UP', time:Date.now()});
        totalRealizedPnl = fl2(totalRealizedPnl + pnl - fee);
        if (pnl >= 0) wins++; else losses++;
        ss.upHeld -= o.shares;
        logFn(`🔴 SELL↑ ${m.asset.toUpperCase()} ${o.shares}sh@$${o.price} (cost:$${o.buyPrice}) PnL:$${fl2(pnl)} fee:$${fee}`);
        trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,action:'SELL',side:'UP',price:o.price,shares:o.shares,cost:fl2(o.buyPrice*o.shares),pnl,fee,reason:'SCALP',time:Date.now()});
        if(trades.length>1000)trades=trades.slice(-1000);
        ss.upPendingSell.splice(i, 1);
      } else { o.tickCount = (o.tickCount || 0) + 1; }
    }
  }
  // UP endgame sell
  if (ss.upSellOrder) {
    const o = ss.upSellOrder;
    if (b.upMid >= o.price - 0.002 || o.price >= 0.98) {
      const proceeds = fl2(o.shares * o.price);
      const fee = fl2(proceeds * FEE_RATE);
      balance = fl2(balance + proceeds - fee);
      totalFees = fl2(totalFees + fee);
      ss.upHeld -= o.shares;
      ss.tpCount++;
      ss.upSellOrder = null;
      logFn(`💰 TP↑ ${m.asset.toUpperCase()} ${o.shares}sh@$${o.price} fee:$${fee}`);
      trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,action:'TP',side:'UP',price:o.price,shares:o.shares,cost:0,pnl:fl2(proceeds-fee),fee,reason:'ENDGAME',time:Date.now()});
      if(trades.length>1000)trades=trades.slice(-1000);
    }
  }

  // === DOWN side (mirror) ===
  const dnBuyPrice = fl4(b.downBid - SCALP_OFFSET);
  if (dnBuyPrice > 0.01) {
    if (!ss.downBuyOrder) ss.downBuyOrder = { id: id8(), price: dnBuyPrice, shares: SIZE, tickCount: 0 };
    else { ss.downBuyOrder.price = dnBuyPrice; ss.downBuyOrder.tickCount++; }
  }
  if (ss.downBuyOrder) {
    const fillProb = Math.min(0.90, 0.02 + ss.downBuyOrder.tickCount * 0.015);
    if (b.downMid <= ss.downBuyOrder.price || Math.random() < fillProb) {
      const cost = fl2(SIZE * ss.downBuyOrder.price);
      if (cost >= 2 && cost <= balance * 0.2) {
        const filledPrice = ss.downBuyOrder.price;
        balance = fl2(balance - cost);
        ss.downHeld += SIZE;
        ss.baseCost = fl2(ss.baseCost + cost);
        logFn(`🟢 BUY↓ ${m.asset.toUpperCase()} ${SIZE}sh@$${filledPrice} cost:$${cost}`);
        trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,action:'BUY',side:'DOWN',price:filledPrice,shares:SIZE,cost,pnl:0,reason:'SCALP',time:Date.now()});
        if(trades.length>1000)trades=trades.slice(-1000);
        const sellPrice = fl4(b.downAsk + SCALP_OFFSET);
        if (sellPrice < 0.99 && sellPrice > filledPrice + 0.01)
          ss.downPendingSell.push({ id: id8(), price: sellPrice, shares: SIZE, buyPrice: filledPrice, time: Date.now() });
        ss.downBuyOrder = { id: id8(), price: dnBuyPrice, shares: SIZE, tickCount: 0 };
      }
    }
  }
  if (ss.downPendingSell.length > 0) {
    for (let i = ss.downPendingSell.length - 1; i >= 0; i--) {
      const o = ss.downPendingSell[i];
      const fillProb = Math.min(0.90, 0.02 + (o.tickCount || 0) * 0.02);
      if (b.downMid >= o.price - 0.002 || Math.random() < fillProb) {
        const proceeds = fl2(o.shares * o.price);
        const pnl = fl2((o.price - o.buyPrice) * o.shares);
        const fee = fl2(proceeds * FEE_RATE);
        balance = fl2(balance + proceeds - fee);
        totalFees = fl2(totalFees + fee);
        ss.scalpPnl = fl2(ss.scalpPnl + pnl - fee);
        ss.scalpCount++;
        ss.scalpCycles.push({buyPrice:o.buyPrice, sellPrice:o.price, shares:o.shares, pnl:fl2(pnl-fee), side:'DOWN', time:Date.now()});
        totalRealizedPnl = fl2(totalRealizedPnl + pnl - fee);
        if (pnl >= 0) wins++; else losses++;
        ss.downHeld -= o.shares;
        logFn(`🔴 SELL↓ ${m.asset.toUpperCase()} ${o.shares}sh@$${o.price} (cost:$${o.buyPrice}) PnL:$${fl2(pnl)} fee:$${fee}`);
        trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,action:'SELL',side:'DOWN',price:o.price,shares:o.shares,cost:fl2(o.buyPrice*o.shares),pnl,fee,reason:'SCALP',time:Date.now()});
        if(trades.length>1000)trades=trades.slice(-1000);
        ss.downPendingSell.splice(i, 1);
      } else { o.tickCount = (o.tickCount || 0) + 1; }
    }
  }
  if (ss.downSellOrder) {
    const o = ss.downSellOrder;
    if (b.downMid >= o.price - 0.002 || o.price >= 0.98) {
      const proceeds = fl2(o.shares * o.price);
      const fee = fl2(proceeds * FEE_RATE);
      balance = fl2(balance + proceeds - fee);
      totalFees = fl2(totalFees + fee);
      ss.downHeld -= o.shares;
      ss.tpCount++;
      ss.downSellOrder = null;
      logFn(`💰 TP↓ ${m.asset.toUpperCase()} ${o.shares}sh@$${o.price} fee:$${fee}`);
      trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,action:'TP',side:'DOWN',price:o.price,shares:o.shares,cost:0,pnl:fl2(proceeds-fee),fee,reason:'ENDGAME',time:Date.now()});
      if(trades.length>1000)trades=trades.slice(-1000);
    }
  }
}

function endScalpPhase(m, ss) {
  ss.phase = 'endgame';
  ss.upBuyOrder = null; ss.downBuyOrder = null;
  ss.upPendingSell = []; ss.downPendingSell = [];
  if (ss.upHeld > 0 && !ss.upSellOrder)
    ss.upSellOrder = { id: id8(), price: TP_PRICE, shares: ss.upHeld };
  if (ss.downHeld > 0 && !ss.downSellOrder)
    ss.downSellOrder = { id: id8(), price: TP_PRICE, shares: ss.downHeld };
  logFn(`🛑 ENDGAME ${m.asset.toUpperCase()} ${m.windowType} | Scalps:${ss.scalpCount} Held:↑${ss.upHeld}↓${ss.downHeld} TP@$${TP_PRICE}`);
}

function runEndgame(m) {
  const ss = strategyState[m.slug];
  if (!ss || !ss.entered || ss.phase !== 'endgame' || !m.hasClob) return;
  const secs = m.secondsToEnd;
  if (secs < -10) return;

  if (ss.upHeld > 0 && !ss.upSellOrder) ss.upSellOrder = { id: id8(), price: TP_PRICE, shares: ss.upHeld };
  if (ss.downHeld > 0 && !ss.downSellOrder) ss.downSellOrder = { id: id8(), price: TP_PRICE, shares: ss.downHeld };

  const b = book(m);
  if (ss.upSellOrder && b.upMid >= TP_PRICE - 0.005) {
    const proceeds = fl2(ss.upSellOrder.shares * TP_PRICE);
    const fee = fl2(proceeds * FEE_RATE);
    balance = fl2(balance + proceeds - fee);
    totalFees = fl2(totalFees + fee);
    logFn(`💰 TP↑ ${m.asset.toUpperCase()} ${ss.upSellOrder.shares}sh@$${TP_PRICE} proceeds:$${proceeds} fee:$${fee}`);
    trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,action:'TP',side:'UP',price:TP_PRICE,shares:ss.upSellOrder.shares,cost:0,pnl:fl2(proceeds-fee),fee,reason:'TP',time:Date.now()});
    if(trades.length>1000)trades=trades.slice(-1000);
    ss.upHeld = 0; ss.upSellOrder = null; ss.tpCount++;
  }
  if (ss.downSellOrder && b.downMid >= TP_PRICE - 0.005) {
    const proceeds = fl2(ss.downSellOrder.shares * TP_PRICE);
    const fee = fl2(proceeds * FEE_RATE);
    balance = fl2(balance + proceeds - fee);
    totalFees = fl2(totalFees + fee);
    logFn(`💰 TP↓ ${m.asset.toUpperCase()} ${ss.downSellOrder.shares}sh@$${TP_PRICE} proceeds:$${proceeds} fee:$${fee}`);
    trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,action:'TP',side:'DOWN',price:TP_PRICE,shares:ss.downSellOrder.shares,cost:0,pnl:fl2(proceeds-fee),fee,reason:'TP',time:Date.now()});
    if(trades.length>1000)trades=trades.slice(-1000);
    ss.downHeld = 0; ss.downSellOrder = null; ss.tpCount++;
  }
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
    const fee = fl2(val * FEE_RATE);
    balance = fl2(balance + val - fee);
    totalFees = fl2(totalFees + fee);
    settlePnl += fl2(val - fee);
    logFn('🏁 RESOLVE↑ ' + m.asset.toUpperCase() + ' ' + m.windowType + ' ' + ss.upHeld + 'sh settle $' + (winnerUp ? '0.99' : '0.01') + ' = $' + val);
  }
  if (ss.downHeld > 0) {
    const val = fl2(!winnerUp ? ss.downHeld * 0.99 : ss.downHeld * 0.01);
    const fee = fl2(val * FEE_RATE);
    balance = fl2(balance + val - fee);
    totalFees = fl2(totalFees + fee);
    settlePnl += fl2(val - fee);
    logFn('🏁 RESOLVE↓ ' + m.asset.toUpperCase() + ' ' + m.windowType + ' ' + ss.downHeld + 'sh settle $' + (!winnerUp ? '0.99' : '0.01') + ' = $' + val);
  }

  for (const o of (ss.upPendingSell || [])) {
    const val = fl2(b.upMid * o.shares);
    const fee = fl2(val * FEE_RATE);
    balance = fl2(balance + val - fee);
    totalFees = fl2(totalFees + fee);
    const pnl = fl2(val - (o.buyPrice * o.shares) - fee);
    if (pnl >= 0) wins++; else losses++;
    settlePnl += pnl;
  }
  for (const o of (ss.downPendingSell || [])) {
    const val = fl2(b.downMid * o.shares);
    const fee = fl2(val * FEE_RATE);
    balance = fl2(balance + val - fee);
    totalFees = fl2(totalFees + fee);
    const pnl = fl2(val - (o.buyPrice * o.shares) - fee);
    if (pnl >= 0) wins++; else losses++;
    settlePnl += pnl;
  }

  ss.resolvePnl = fl2(settlePnl);
  const windowPnl = fl2(balance - ss.entryBalance);
  totalRealizedPnl = fl2(totalRealizedPnl + windowPnl);
  logFn('💰 RESOLVED ' + m.asset.toUpperCase() + ' ' + m.windowType + ' | WindowsPnL:$' + fl2(windowPnl) + ' (scalps:' + fl2(ss.scalpPnl) + ' settle:' + fl2(settlePnl) + ')');
  trades.push({slug:m.slug,asset:m.asset,windowType:m.windowType,scalpCount:ss.scalpCount,tpCount:ss.tpCount,pnl:fl2(windowPnl),scalpPnl:ss.scalpPnl,settlePnl:fl2(settlePnl),reason:'RESOLVED',time:ss.entryTime||Date.now(),exitTime:Date.now()});
  windowResults.push({asset:m.asset,windowType:m.windowType,pnl:fl2(windowPnl),scalpPnl:ss.scalpPnl,settlePnl:fl2(settlePnl),scalps:ss.scalpCount,time:Date.now()});
  if (windowResults.length > 100) windowResults = windowResults.slice(-100);
  if(trades.length>500)trades=trades.slice(-500);
  delete strategyState[m.slug];
  m.resolved = true;
}

function strategyTick() {
  const active = Object.values(marketCache).filter(m => m.active);
  if (active.length === 0 || balance < 10) return;
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

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      stateVersion: STATE_VERSION, balance, totalRealizedPnl, totalFees,
      wins, losses, trades: trades.slice(-300), initialEquity,
      equityHistory: equityHistory.slice(-5000), peakEquity, maxDrawdown, windowResults: windowResults.slice(-50),
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
        equityHistory = d.equityHistory || [];
        peakEquity = d.peakEquity || INITIAL_CAPITAL;
        maxDrawdown = d.maxDrawdown || 0;
        windowResults = d.windowResults || [];
      }
    }
  } catch (_) {}
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
  let shares15u = 0, shares15d = 0, shares5u = 0, shares5d = 0;
  let unrealizedPnl = 0;

  const marketDisplay = active.map(m => {
    const b = book(m);
    const ss = strategyState[m.slug];
    const u = ss ? ss.upHeld : 0;
    const d = ss ? ss.downHeld : 0;
    totalUpShares += u; totalDownShares += d;
    if (ss) unrealizedPnl += fl2(u * b.upMid) + fl2(d * b.downMid);
    if (m.windowType === '15m') { shares15u += u; shares15d += d; }
    else { shares5u += u; shares5d += d; }
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
      hasUpSell: ss && ss.upSellOrder ? 1 : 0,
      hasUpBuy: ss && ss.upBuyOrder ? 1 : 0,
      hasDnSell: ss && ss.downSellOrder ? 1 : 0,
      hasDnBuy: ss && ss.downBuyOrder ? 1 : 0,
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

  return {
    peakEquity: fl2(peakEquity),
    maxDrawdown,
    drawdown: dd,
    windowResults: windowResults.slice(-20).reverse(),
    balance: fl2(balance), equity, initialEquity,
    totalPnl: fl4(totalRealizedPnl), totalFees: fl4(totalFees),
    wins, losses, totalTrades: wins + losses,
    winRate: wins + losses > 0 ? fl4(wins / (wins + losses) * 100) : 0,
    activeMarkets: active.length,
    totalUpShares, totalDownShares,
    shares15m: { up: shares15u, dn: shares15d },
    shares5m: { up: shares5u, dn: shares5d },
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
    note: `v${STATE_VERSION} CLOB-only scalper | ${FEE_RATE*100}% fees | 5m scalp=4min, 15m scalp=12min | TP@$${TP_PRICE}`,
  };
}

async function tick() {
  try {
    tickCount++;
    if (discoveryCount === 0) { await discoverMarkets(); await fetchClob(); }
    else if (tickCount % 15 === 0) await discoverMarkets();
    await fetchClob();
    strategyTick();
    saveState();
    emitFn('snapshot', buildSnapshot());
  } catch (e) { logFn(`⚠️ ${e.message}`); }
}

async function start(emit, logEmit) {
  emitFn = emit; logFn = logEmit; startTime = Date.now();
  loadState();
  logFn(`✅ v${STATE_VERSION} Start | Capital:$${fl2(balance)} | ${equityHistory.length} eq pts`);
  await discoverMarkets();
  await tick();
  setInterval(tick, 1000);
}

async function runBacktest() {
  return { overall: { trades: wins + losses, wins, losses, pnl: totalRealizedPnl, fees: totalFees } };
}

module.exports = { start, buildSnapshot, runBacktest };
