'use strict';

const fs = require('fs');
const path = require('path');

// ── Config ──
const INITIAL_CAPITAL = 10000;
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const STATE_FILE = path.join(__dirname, 'state.json');
const STATE_VERSION = 8;

// Gabagool config — EXACT match of ent0n29/polybot (44k-trade strategy)
const COMPLETE_SET_MIN_EDGE = 0.001;         // 0.1% min edge (aggressive quoting both sides)
const IMPROVE_TICKS = 0;                     // quote at bid, no improvement
const TICK_SIZE = 0.01;                      // standard tick
const MAX_SKEW_TICKS = 0;                    // no inventory skew
const IMBALANCE_SHARES_FOR_MAX_SKEW = 5000;  // effectively disabled (skew=0)
const MIN_SECS = 0;                          // trade until end
const MAX_SPREAD_FOR_ENTRY = 0.06;           // wide book threshold
const BANKROLL_FRAC_PER_ORDER = 0.02;        // 2% per order max
const BANKROLL_TOTAL_FRAC = 0.50;            // 50% total exposure
const TOP_UP_SECS = 120;                     // taker top-up below 120s
const TOP_UP_MIN_SHARES = 80;                // min imbalance for top-up
const RESOLUTION_DELAY_SECS = 30;            // wait after end before resolve
const STALE_ORDER_SECS = 300;                // cancel orders older than this
const REFRESH_MS = 500;                      // 500ms loop like real Gabagool

// Taker mode — cross spread when tight
const TAKER_MODE_ENABLED = true;
const TAKER_MODE_MAX_EDGE = 0.004;           // 0.4 cents max edge to take
const TAKER_MODE_MAX_SPREAD = 0.01;          // 1 cent max spread to cross

// ── State ──
let balance = INITIAL_CAPITAL;
let totalRealizedPnl = 0;
let totalFees = 0;
let wins = 0;
let losses = 0;
let trades = [];
let positions = [];
let pendingOrders = [];
let marketCache = {};
let inventory = {};
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
  return [
    { asset: 'btc', slug: 'btc-updown-15m-' + (cw - 1800), epoch: cw - 1800, windowS: 900, windowType: '15m' },
    { asset: 'btc', slug: 'btc-updown-15m-' + (cw - 900), epoch: cw - 900, windowS: 900, windowType: '15m' },
    { asset: 'btc', slug: 'btc-updown-15m-' + cw, epoch: cw, windowS: 900, windowType: '15m' },
    { asset: 'btc', slug: 'btc-updown-15m-' + (cw + 900), epoch: cw + 900, windowS: 900, windowType: '15m' },
    { asset: 'btc', slug: 'btc-updown-15m-' + (cw + 1800), epoch: cw + 1800, windowS: 900, windowType: '15m' },
    { asset: 'eth', slug: 'eth-updown-15m-' + (cw - 1800), epoch: cw - 1800, windowS: 900, windowType: '15m' },
    { asset: 'eth', slug: 'eth-updown-15m-' + (cw - 900), epoch: cw - 900, windowS: 900, windowType: '15m' },
    { asset: 'eth', slug: 'eth-updown-15m-' + cw, epoch: cw, windowS: 900, windowType: '15m' },
    { asset: 'eth', slug: 'eth-updown-15m-' + (cw + 900), epoch: cw + 900, windowS: 900, windowType: '15m' },
    { asset: 'eth', slug: 'eth-updown-15m-' + (cw + 1800), epoch: cw + 1800, windowS: 900, windowType: '15m' },
  ];
}

async function discoverMarkets() {
  const candidates = windowEpochs();
  let found = 0;
  let now = Date.now();
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
      windowType: c.windowType || '15m',
    };
    if (!inventory[c.slug]) inventory[c.slug] = { upShares: 0, downShares: 0 };
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
      if (m.secondsToEnd < -RESOLUTION_DELAY_SECS - 60) {
        if (!m.resolved) m.active = false;
      }
    } catch(e) {}
  }
}

function replicaShares(slug, secondsToEnd) {
  if (slug.startsWith('btc-updown-15m-')) {
    if (secondsToEnd < 60) return 11;
    if (secondsToEnd < 180) return 13;
    if (secondsToEnd < 300) return 17;
    if (secondsToEnd < 600) return 19;
    return 20;
  }
  if (slug.startsWith('eth-updown-15m-')) {
    if (secondsToEnd < 60) return 8;
    if (secondsToEnd < 180) return 10;
    if (secondsToEnd < 300) return 12;
    if (secondsToEnd < 600) return 13;
    return 14;
  }
  return 10;
}

function dynMultiplier() {
  const eq = getEquity();
  const ratio = eq / initialEquity;
  return Math.max(0.25, Math.min(5.0, ratio));
}

function getEquity() {
  const openPos = positions.filter(p => !p.closed);
  const posValue = openPos.reduce((s, p) => s + p.cost, 0);
  let unrealizedPnl = 0;
  for (const p of openPos) {
    const m = marketCache[p.slug];
    if (!m) continue;
    const cur = p.direction === 'UP' ? (m.upMid || m.upPrice) : (m.downMid || m.downPrice);
    unrealizedPnl += (p.shares * cur) - p.cost;
  }
  return balance + posValue + unrealizedPnl;
}

function totalExposure() { return positions.filter(p => !p.closed).reduce((s, p) => s + p.cost, 0); }
function bankroll() { return balance; }

function calculateEdge(m) {
  const bidUp = Math.max(0.01, (m.upMid || m.upPrice) - 0.005);
  const askUp = Math.min(0.99, (m.upMid || m.upPrice) + 0.005);
  const bidDown = Math.max(0.01, (m.downMid || m.downPrice) - 0.005);
  const askDown = Math.min(0.99, (m.downMid || m.downPrice) + 0.005);
  const edge = 1.0 - (bidUp + bidDown);
  return { edge, bidUp, askUp, bidDown, askDown, midUp: (m.upMid || m.upPrice), midDown: (m.downMid || m.downPrice) };
}

function calcSkew(slug) {
  const inv = inventory[slug];
  if (!inv) return { up: 0, down: 0 };
  const imbalance = (inv.upShares || 0) - (inv.downShares || 0);
  const absImb = Math.abs(imbalance);
  const scale = Math.min(1, absImb / IMBALANCE_SHARES_FOR_MAX_SKEW);
  const skew = Math.round(scale * MAX_SKEW_TICKS);
  return { up: imbalance > 0 ? skew : 0, down: imbalance < 0 ? skew : 0, };
}

function makerEntryPrice(bid, ask, tickSize, improveTicks, skewTicks) {
  if (bid == null || ask == null || bid <= 0 || ask >= 1) return null;
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  let entry;
  if (spread >= 0.06) {
    entry = mid - tickSize * Math.max(0, improveTicks - skewTicks);
  } else {
    const improvedBid = bid + tickSize * (improveTicks + skewTicks);
    entry = Math.min(improvedBid, mid);
  }
  entry = Math.floor(entry / tickSize) * tickSize;
  entry = fl4(entry);
  if (entry < 0.01 || entry > 0.99) return null;
  if (entry >= ask) {
    entry = fl4(ask - tickSize);
    if (entry < 0.01) return null;
  }
  return entry;
}

function orderShares(slug, entryPrice, secondsToEnd) {
  if (!entryPrice || entryPrice <= 0) return 0;
  let shares = replicaShares(slug, secondsToEnd);
  shares = Math.round(shares * dynMultiplier());
  const maxNotional = bankroll() * BANKROLL_FRAC_PER_ORDER;
  const capShares = Math.floor(maxNotional / entryPrice);
  shares = Math.min(shares, capShares);
  const totalCap = bankroll() * BANKROLL_TOTAL_FRAC;
  const remaining = totalCap - totalExposure();
  if (remaining <= 0) return 0;
  const remShares = Math.floor(remaining / entryPrice);
  shares = Math.min(shares, remShares);
  return Math.max(0, shares);
}

function evaluateMarkets() {
  const active = Object.values(marketCache).filter(m => m.active);
  if (active.length === 0 || bankroll() < 5) return;
  for (const m of active) {
    const secs = m.secondsToEnd;
    if (secs < MIN_SECS || secs > m.windowS) continue;
    const hasPos = positions.some(p => p.slug === m.slug && !p.closed);
    if (hasPos) continue;
    const { edge, bidUp, askUp, bidDown, askDown } = calculateEdge(m);
    if (edge < COMPLETE_SET_MIN_EDGE) { cancelPendingFor(m.slug, 'LOW_EDGE'); continue; }
    if ((m.upMid || m.upPrice) > 0.97 || (m.downMid || m.downPrice) > 0.97) continue;
    if ((m.upMid || m.upPrice) < 0.03 || (m.downMid || m.downPrice) < 0.03) continue;
    const skew = calcSkew(m.slug);
    const upEntry = makerEntryPrice(bidUp, askUp, TICK_SIZE, IMPROVE_TICKS, skew.up);
    const dnEntry = makerEntryPrice(bidDown, askDown, TICK_SIZE, IMPROVE_TICKS, skew.down);
    const upShares = upEntry ? orderShares(m.slug, upEntry, secs) : 0;
    const dnShares = dnEntry ? orderShares(m.slug, dnEntry, secs) : 0;
    if (upShares < 1 && dnShares < 1) continue;
    const existingUp = pendingOrders.find(o => o.slug === m.slug && o.side === 'UP');
    const existingDn = pendingOrders.find(o => o.slug === m.slug && o.side === 'DOWN');
    if (upShares >= 1) {
      if (existingUp) { if (existingUp.price !== upEntry || existingUp.shares !== upShares) { cancelOrder(existingUp.id, 'REPRICE'); placeOrder(m, 'UP', upEntry, upShares); } }
      else { placeOrder(m, 'UP', upEntry, upShares); }
    } else if (existingUp) { cancelOrder(existingUp.id, 'NO_SIZE'); }
    if (dnShares >= 1) {
      if (existingDn) { if (existingDn.price !== dnEntry || existingDn.shares !== dnShares) { cancelOrder(existingDn.id, 'REPRICE'); placeOrder(m, 'DOWN', dnEntry, dnShares); } }
      else { placeOrder(m, 'DOWN', dnEntry, dnShares); }
    } else if (existingDn) { cancelOrder(existingDn.id, 'NO_SIZE'); }
  }
}

function placeOrder(m, side, price, shares) {
  const cost = fl2(shares * price);
  if (cost < 2 || cost > bankroll()) return;
  const id = id8();
  pendingOrders.push({
    id, slug: m.slug, asset: m.asset, side, direction: side, price, shares, cost, placedAt: Date.now(), endTime: m.endTime,
    outcome: side === 'UP' ? m.upOutcome : m.downOutcome,
  });
  balance = fl2(balance - cost);
  logFn(`📋 LIMIT ${m.asset.toUpperCase()} ${side} ${shares}sh @ $${price} (cost:$${cost})`);
}

function cancelOrder(id, reason) {
  const idx = pendingOrders.findIndex(o => o.id === id);
  if (idx === -1) return;
  balance = fl2(balance + pendingOrders[idx].cost);
  pendingOrders.splice(idx, 1);
}

function cancelPendingFor(slug, reason) {
  for (let i = pendingOrders.length - 1; i >= 0; i--) {
    if (pendingOrders[i].slug === slug) {
      balance = fl2(balance + pendingOrders[i].cost);
      pendingOrders.splice(i, 1);
    }
  }
}

function takerEntry() {
  if (!TAKER_MODE_ENABLED) return;
  const active = Object.values(marketCache).filter(m => m.active);
  for (const m of active) {
    const secs = m.secondsToEnd;
    if (secs < 10 || secs > m.windowS) continue;
    if (positions.some(p => p.slug === m.slug && !p.closed)) continue;
    if (pendingOrders.some(o => o.slug === m.slug)) continue;
    const { edge, bidUp, askUp, bidDown, askDown } = calculateEdge(m);
    if (edge > TAKER_MODE_MAX_EDGE) continue;
    const spreadUp = askUp - bidUp;
    const spreadDown = askDown - bidDown;
    if (spreadUp > TAKER_MODE_MAX_SPREAD || spreadDown > TAKER_MODE_MAX_SPREAD) continue;
    const edgeUp = 1 - (askUp + bidDown);
    const edgeDown = 1 - (bidUp + askDown);
    const dir = edgeUp >= edgeDown ? 'UP' : 'DOWN';
    const price = dir === 'UP' ? askUp : askDown;
    if (price >= 0.97 || price <= 0.03) continue;
    let shares = Math.round(replicaShares(m.slug, secs) * 0.5 * dynMultiplier());
    if (shares < 1) shares = 1;
    const cost = fl2(shares * price);
    if (cost < 2 || cost > bankroll()) continue;
    if (totalExposure() + cost > bankroll() * BANKROLL_TOTAL_FRAC) continue;
    balance = fl2(balance - cost);
    const pos = {
      id: id8(), slug: m.slug, asset: m.asset, eventTitle: m.eventTitle || m.slug,
      outcome: dir === 'UP' ? m.upOutcome : m.downOutcome,
      direction: dir, entryPrice: price, entryEdge: edge, shares, cost, time: Date.now(), endTime: m.endTime,
      closed: false, exitPrice: 0, pnl: 0, reason: 'TAKER', mult: dynMultiplier(), skewT: 0,
    };
    positions.push(pos);
    if (dir === 'UP') inventory[m.slug].upShares += shares;
    else inventory[m.slug].downShares += shares;
    logFn(`⚡ TAKER ${m.asset.toUpperCase()} ${dir} ${shares}sh @ $${price} (cost:$${cost})`);
  }
}

function simulateFills() {
  for (let i = pendingOrders.length - 1; i >= 0; i--) {
    const o = pendingOrders[i];
    const m = marketCache[o.slug];
    if (!m) { cancelOrder(o.id, 'NO_MARKET'); continue; }
    const secs = Math.floor((m.endTime - Date.now()) / 1000);
    if (Date.now() - o.placedAt > STALE_ORDER_SECS * 1000) { cancelOrder(o.id, 'STALE'); continue; }
    if (!m.active && secs < -RESOLUTION_DELAY_SECS) { cancelOrder(o.id, 'EXPIRED'); continue; }
    const curPrice = o.side === 'UP' ? (m.upMid || m.upPrice) : (m.downMid || m.downPrice);
    let filled = false;
    if (curPrice <= o.price + 0.002 && curPrice >= o.price - 0.005) {
      const prob = Math.min(1, 0.15 + (o.price - curPrice) * 5);
      if (Math.random() < prob) filled = true;
    }
    if (curPrice <= o.price - 0.003) filled = true;
    if (filled) {
      pendingOrders.splice(i, 1);
      const pos = {
        id: o.id, slug: o.slug, asset: o.asset, eventTitle: (m.eventTitle || o.slug),
        outcome: o.outcome, direction: o.side, entryPrice: o.price, entryEdge: 0,
        shares: o.shares, cost: o.cost, time: Date.now(), endTime: m.endTime,
        closed: false, exitPrice: 0, pnl: 0, reason: '', mult: dynMultiplier(), skewT: 0,
      };
      positions.push(pos);
      if (o.side === 'UP') inventory[o.slug].upShares += o.shares;
      else inventory[o.slug].downShares += o.shares;
      logFn(`✅ FILLED ${o.asset.toUpperCase()} ${o.side} ${o.shares}sh @ $${o.price}`);
    }
  }
}

function takerTopUp() {
  const now = Date.now();
  for (const m of Object.values(marketCache)) {
    if (!m.active) continue;
    const secs = Math.floor((m.endTime - now) / 1000);
    if (secs > TOP_UP_SECS || secs < 0) continue;
    const inv = inventory[m.slug];
    if (!inv) continue;
    const imbalance = Math.abs((inv.upShares || 0) - (inv.downShares || 0));
    if (imbalance < TOP_UP_MIN_SHARES) continue;
    const moreUp = (inv.upShares || 0) > (inv.downShares || 0);
    const lagSide = moreUp ? 'DOWN' : 'UP';
    const lagShares = Math.min(imbalance, 50);
    const lagPrice = lagSide === 'UP' ? (m.upMid || m.upPrice) : (m.downMid || m.downPrice);
    const cost = fl2(lagShares * lagPrice);
    if (cost < 2 || cost > bankroll()) continue;
    if (totalExposure() + cost > bankroll() * BANKROLL_TOTAL_FRAC) continue;
    balance = fl2(balance - cost);
    const pos = {
      id: id8(), slug: m.slug, asset: m.asset, eventTitle: m.eventTitle || m.slug,
      outcome: lagSide === 'UP' ? m.upOutcome : m.downOutcome,
      direction: lagSide, entryPrice: lagPrice, entryEdge: 0, shares: lagShares, cost,
      time: now, endTime: m.endTime, closed: false, exitPrice: 0, pnl: 0, reason: 'TOPUP',
      mult: 1, skewT: 0,
    };
    positions.push(pos);
    if (lagSide === 'UP') inventory[m.slug].upShares += lagShares;
    else inventory[m.slug].downShares += lagShares;
    logFn(`🔄 TOPUP ${m.asset.toUpperCase()} ${lagSide} ${lagShares}sh @ $${lagPrice}`);
  }
}

function managePositions() {
  const now = Date.now();
  for (let i = positions.length - 1; i >= 0; i--) {
    const pos = positions[i];
    if (pos.closed) continue;
    const m = marketCache[pos.slug];
    if (!m) { positions.splice(i, 1); continue; }
    const secs = Math.floor((m.endTime - now) / 1000);
    if (secs < -RESOLUTION_DELAY_SECS) {
      const upWon = (m.upMid || m.upPrice) >= 0.50;
      const won = (pos.direction === 'UP' && upWon) || (pos.direction === 'DOWN' && !upWon);
      const exitP = won ? 1.00 : 0.00;
      const exitV = pos.shares * exitP;
      const netPnl = fl2(exitV - pos.cost);
      if (pos.direction === 'UP') inventory[pos.slug].upShares -= pos.shares;
      else inventory[pos.slug].downShares -= pos.shares;
      pos.exitPrice = exitP; pos.pnl = netPnl; pos.reason = won ? 'WIN' : 'LOSS'; pos.closed = true;
      balance = fl2(balance + exitV);
      totalRealizedPnl = fl4(totalRealizedPnl + netPnl);
      if (won) wins++; else losses++;
      logTrade(pos, now);
      logFn(`${won?'💰':'❌'} RESOLVED ${pos.asset.toUpperCase()} ${pos.direction} ${pos.shares}sh → $${exitP.toFixed(2)} PnL:$${fl2(netPnl)}`);
      positions.splice(i, 1);
    }
  }
}

function logTrade(pos, now) {
  trades.push({
    slug: pos.slug, asset: pos.asset, outcome: pos.outcome, direction: pos.direction,
    entryPrice: pos.entryPrice, exitPrice: pos.exitPrice, shares: pos.shares, cost: pos.cost,
    pnl: pos.pnl, reason: pos.reason, time: pos.time, exitTime: now, mult: pos.mult, skewT: pos.skewT,
  });
  if (trades.length > 500) trades = trades.slice(-500);
  const eq = getEquity();
  equityHistory.push({ t: now, v: fl2(eq) });
  if (equityHistory.length > 2000) equityHistory = equityHistory.slice(-2000);
}

function cleanupMarkets() {
  const now = Date.now();
  for (const slug of Object.keys(marketCache)) {
    const m = marketCache[slug];
    if (m.resolved) continue;
    if (m.active && m.secondsToEnd < -RESOLUTION_DELAY_SECS - 120) { m.active = false; m.resolved = true; }
  }
}

function saveState() {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify({ stateVersion: STATE_VERSION, balance, totalRealizedPnl, totalFees, wins, losses, trades: trades.slice(-300), initialEquity }, null, 2)); } catch (_) {}
}
function loadState() {
  try { if (fs.existsSync(STATE_FILE)) { const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); if (d.stateVersion === STATE_VERSION) { balance = d.balance||INITIAL_CAPITAL; totalRealizedPnl = d.totalRealizedPnl||0; totalFees = d.totalFees||0; wins = d.wins||0; losses = d.losses||0; trades = d.trades||[]; initialEquity = d.initialEquity||INITIAL_CAPITAL; } } } catch (_) {}
}

function buildSnapshot() {
  const now = Date.now();
  for (const m of Object.values(marketCache)) { if (m.active) { m.secondsToEnd = Math.floor((m.endTime - now) / 1000); if (m.secondsToEnd < -RESOLUTION_DELAY_SECS - 60) m.active = false; } }
  const active = Object.values(marketCache).filter(m => m.active);
  const openPos = positions.filter(p => !p.closed);
  const posValue = openPos.reduce((s, p) => s + p.cost, 0);
  let unrealizedPnl = 0;
  for (const p of openPos) { const m = marketCache[p.slug]; if (!m) continue; const cur = p.direction === 'UP' ? (m.upMid||m.upPrice) : (m.downMid||m.downPrice); unrealizedPnl += (p.shares * cur) - p.cost; }
  const equity = fl2(getEquity());
  const mult = dynMultiplier();
  const marketDisplay = active.map(m => {
    const { edge, bidUp, askUp, bidDown, askDown, midUp, midDown } = calculateEdge(m);
    const inv = inventory[m.slug] || { upShares: 0, downShares: 0 };
    return { slug: m.slug.substring(0,22), asset: m.asset, upPrice: fl4(midUp), downPrice: fl4(midDown), upBid: fl4(bidUp), upAsk: fl4(askUp), downBid: fl4(bidDown), downAsk: fl4(askDown), edge: fl4(edge*100), secondsToEnd: m.secondsToEnd, invUp: inv.upShares||0, invDown: inv.downShares||0, windowType: m.windowType||'15m', pendingUp: pendingOrders.filter(o=>o.slug===m.slug&&o.side==='UP').length, pendingDown: pendingOrders.filter(o=>o.slug===m.slug&&o.side==='DOWN').length };
  });
  return { balance: fl2(balance), equity, initialEquity, locked: fl2(posValue), unrealizedPnl: fl2(unrealizedPnl), totalPnl: fl4(totalRealizedPnl+unrealizedPnl), totalRealizedPnl: fl4(totalRealizedPnl), totalFees: fl4(totalFees), wins, losses, totalTrades: wins+losses, winRate: wins+losses>0?fl4(wins/(wins+losses)*100):0, positionsCount: openPos.length, pendingCount: pendingOrders.length, activeMarkets: active.length, sizingMultiplier: fl4(mult), totalExposure: fl4(totalExposure()), maxExposure: fl4(bankroll()*BANKROLL_TOTAL_FRAC), marketDisplay, openPositions: openPos.map(p=>{const m=marketCache[p.slug]; return {id:p.id,asset:p.asset,outcome:p.outcome,direction:p.direction,entryPrice:p.entryPrice,shares:p.shares,cost:p.cost,entryEdge:fl4((p.entryEdge||0)*100),mult:fl4(p.mult||1),secondsToEnd:Math.floor((p.endTime-now)/1000),currentPrice:m?(p.direction==='UP'?(m.upMid||m.upPrice):(m.downMid||m.downPrice)):p.entryPrice,windowType:m?(m.windowType||'15m'):'?',reason:p.reason||''};}), pendingOrders: pendingOrders.map(o=>{const m=marketCache[o.slug]; return {id:o.id,asset:o.asset,side:o.side,price:o.price,shares:o.shares,cost:o.cost,placedAgo:Math.floor((now-o.placedAt)/1000),secondsToEnd:m?Math.floor((m.endTime-now)/1000):0,windowType:m?(m.windowType||'15m'):'?'};}), trades: trades.slice(-20).reverse().map(t=>({asset:t.asset,outcome:t.outcome,direction:t.direction,entryPrice:t.entryPrice,exitPrice:t.exitPrice,shares:t.shares,pnl:t.pnl,reason:t.reason,mult:fl4(t.mult||1)})), uptime: Math.floor((now-startTime)/1000), discoveryCount, connected: true, timestamp: now, note: `Gabagool v${STATE_VERSION}: EXACT match of 44k-trade strategy. Edge≥0.1% both legs. Maker at bid (improve=0). Taker cross when tight. No TP/SL. Top-up at 120s.` };
}

async function tick() {
  try {
    tickCount++;
    if (discoveryCount === 0) { await discoverMarkets(); await fetchClob(); }
    else if (tickCount % 60 === 0) await discoverMarkets();
    await fetchClob();
    evaluateMarkets();
    takerEntry();
    simulateFills();
    takerTopUp();
    managePositions();
    cleanupMarkets();
    saveState();
    emitFn('snapshot', buildSnapshot());
  } catch (e) { logFn(`⚠️ ${e.message}`); }
}

async function start(emit, logEmit) {
  emitFn = emit; logFn = logEmit; startTime = Date.now();
  loadState();
  logFn(`✅ Gabagool v${STATE_VERSION} | Bankroll: $${fl2(bankroll())} | Mult: ${dynMultiplier().toFixed(2)}x`);
  await discoverMarkets();
  await tick();
  setInterval(tick, REFRESH_MS);
}

async function runBacktest() { return { overall: { trades: wins+losses, wins, losses, pnl: totalRealizedPnl, fees: totalFees, winRate: wins+losses>0?fl4(wins/(wins+losses)*100):0 } }; }

module.exports = { start, buildSnapshot, runBacktest };
