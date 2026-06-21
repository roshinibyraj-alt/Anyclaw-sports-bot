'use strict';

// ── Complete-Set Arbitrage Bot ──────────────────────────────────────────────
// Strategy: ent0n29/polybot GabagoolDirectionalEngine (spec-compliant)
// Edge = 1.0 − (bestBid_UP + bestBid_DN) ≥ 0.01 → buy both legs as maker
// Redemption: sell both sides at ask when complete sets accumulate
// KILL_SWITCH: set env var KILL_SWITCH=true to pause trading

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const KILL_SWITCH            = process.env.KILL_SWITCH === 'true';
const MIN_EDGE               = 0.01;
const TICK_SIZE              = 0.01;
const IMPROVE_TICKS          = 1;
const MAX_SKEW_TICKS         = 1;
const SKEW_SHARES_FOR_MAX    = 200;
const FAST_TOPUP_MIN_IMB     = 10;
const FAST_TOPUP_MIN_SECS    = 3;
const FAST_TOPUP_MAX_SECS    = 120;
const FAST_TOPUP_COOLDOWN_MS = 15000;
const ENDGAME_SECS           = 60;
const ENDGAME_MIN_IMB        = 10;
const TAKER_MAX_SPREAD       = 0.02;
const MIN_REPLACE_MS         = 5000;
const MIN_BALANCE            = 5;
const TICK_MS                = 500;

// Sizing table: spec table scaled ×5/11 (min 5 shares = Polymarket minimum)
function getSize(secsToEnd) {
  if (secsToEnd < 60)  return 5;   // was 11
  if (secsToEnd < 180) return 6;   // was 13
  if (secsToEnd < 300) return 8;   // was 17
  if (secsToEnd < 600) return 9;   // was 19
  return 9;                         // was 20
}

const fl2 = v => Math.round((v || 0) * 100) / 100;
const fl4 = v => Math.round((v || 0) * 10000) / 10000;

async function getJson(url) {
  try {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 8000);
    const r  = await fetch(url, { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return null;
    return r.json();
  } catch (_) { return null; }
}

// ── State ────────────────────────────────────────────────────────────────────
let trader        = null;
let balance       = 0;
let startBalance  = 0;
let marketCache   = {};
let strategyState = {};
let pendingOrders = {};   // id → { tokenId, side, price, shares, slug, dir, status, time }
let fills         = [];   // recent fill log for dashboard
let logs          = [];   // recent strategy logs
let tickCount     = 0;
let startTime     = Date.now();
let emitFn        = () => {};
let logFn         = () => {};

function slog(msg) {
  const ts = new Date().toTimeString().substring(0, 8);
  const line = `[${ts}] ${msg}`;
  logs.unshift(line);
  if (logs.length > 200) logs.length = 200;
  logFn(msg);
}

function addFill(dir, shares, price, leg, pnl) {
  const ts = new Date().toTimeString().substring(0, 8);
  fills.unshift({ time: ts, dir, shares, price, leg, pnl });
  if (fills.length > 100) fills.length = 100;
}

// ── Market discovery ─────────────────────────────────────────────────────────
async function discoverMarkets() {
  const now = Math.floor(Date.now() / 1000);
  const ws  = 900;
  const cw  = Math.floor(now / ws) * ws;
  const candidates = [cw - ws, cw, cw + ws].map(ep => ({
    slug: `btc-updown-15m-${ep}`, epoch: ep, windowS: ws,
  }));

  await Promise.allSettled(candidates.map(async c => {
    if (marketCache[c.slug]?.resolved) return;
    const d = await getJson(`${GAMMA}/events?slug=${c.slug}`);
    if (!Array.isArray(d) || !d[0]?.markets?.[0]) return;
    const m = d[0].markets[0];
    if (!m.clobTokenIds) return;
    let tokenIds;
    try { tokenIds = JSON.parse(m.clobTokenIds); } catch (_) { return; }
    if (tokenIds.length < 2) return;
    if (marketCache[c.slug]) return;
    const tradingEndMs = (c.epoch + c.windowS) * 1000;
    const secsLeft     = Math.round((tradingEndMs - Date.now()) / 1000);
    marketCache[c.slug] = {
      slug: c.slug, windowS: c.windowS,
      upTokenId: tokenIds[0], downTokenId: tokenIds[1],
      endTime: tradingEndMs, active: false, resolved: false,
      hasClob: false, upMid: 0, downMid: 0, secondsToEnd: secsLeft,
    };
    slog(`🔍 Found: ${c.slug}`);
  }));
}

// ── Price update + fill detection ────────────────────────────────────────────
async function updatePrices() {
  const now = Date.now();
  for (const m of Object.values(marketCache)) {
    m.secondsToEnd = Math.floor((m.endTime - now) / 1000);
    m.active = !m.resolved && m.secondsToEnd > 0 && m.secondsToEnd <= m.windowS;
    if (m.secondsToEnd < -60) { m.active = false; continue; }
    if (!m.active) continue;
    const [upR, dnR] = await Promise.all([
      getJson(`${CLOB}/midpoint?token_id=${m.upTokenId}`),
      getJson(`${CLOB}/midpoint?token_id=${m.downTokenId}`),
    ]);
    if (upR?.mid) m.upMid = parseFloat(upR.mid);
    if (dnR?.mid) m.downMid = parseFloat(dnR.mid);
    m.hasClob = m.upMid > 0 && m.downMid > 0;
  }
}

async function checkFills() {
  if (!trader || Object.keys(pendingOrders).length === 0) return;
  let openOrders;
  try { openOrders = await trader.getOpenOrders(); } catch (_) { return; }

  const openIds = new Set((openOrders || []).map(o => o.id));
  const now = Date.now();

  for (const [id, po] of Object.entries(pendingOrders)) {
    if (po.status === 'cancelling' && !openIds.has(id)) { po.status = 'cancelled'; continue; }
    if (po.status !== 'pending') continue;
    if (openIds.has(id)) continue;

    // Disappeared from open orders → filled
    po.status = 'filled';
    const ss = strategyState[po.slug];
    if (!ss) continue;

    if (po.dir === 'up_buy') {
      ss.upHeld += po.shares;
      ss.upCost  = fl2(ss.upCost + po.shares * po.price);
      ss.lastUpFillTime  = now;
      ss.lastUpFillPrice = po.price;
      ss.upBuyOrderId    = null;
      addFill('up_buy', po.shares, po.price, 'UP', 0);
      slog(`✅ FILL BUY↑ ${po.shares}sh@${po.price} held:↑${ss.upHeld} ↓${ss.dnHeld}`);
      trySettle(marketCache[po.slug], ss);

    } else if (po.dir === 'dn_buy') {
      ss.dnHeld += po.shares;
      ss.dnCost  = fl2(ss.dnCost + po.shares * po.price);
      ss.lastDnFillTime  = now;
      ss.lastDnFillPrice = po.price;
      ss.dnBuyOrderId    = null;
      addFill('dn_buy', po.shares, po.price, 'DN', 0);
      slog(`✅ FILL BUY↓ ${po.shares}sh@${po.price} held:↑${ss.upHeld} ↓${ss.dnHeld}`);
      trySettle(marketCache[po.slug], ss);

    } else if (po.dir === 'up_sell') {
      const proceeds = fl2(po.shares * po.price);
      balance        = fl2(balance + proceeds);
      ss.upHeld      = Math.max(0, ss.upHeld - po.shares);
      ss.upSellId    = null;
      const cost     = fl2(po.shares * (ss.upCost / (ss.upHeld + po.shares) || po.price));
      const pnl      = fl2(proceeds - cost);
      ss.makerPnl    = fl2(ss.makerPnl + pnl);
      addFill('up_sell', po.shares, po.price, 'UP', pnl);
      slog(`♻️ SELL↑ ${po.shares}sh@${po.price} +$${proceeds} pnl:$${pnl} mkrPnl:$${fl2(ss.makerPnl)}`);

    } else if (po.dir === 'dn_sell') {
      const proceeds = fl2(po.shares * po.price);
      balance        = fl2(balance + proceeds);
      ss.dnHeld      = Math.max(0, ss.dnHeld - po.shares);
      ss.dnSellId    = null;
      const cost     = fl2(po.shares * (ss.dnCost / (ss.dnHeld + po.shares) || po.price));
      const pnl      = fl2(proceeds - cost);
      ss.makerPnl    = fl2(ss.makerPnl + pnl);
      ss.completeSetsSettled++;
      addFill('dn_sell', po.shares, po.price, 'DN', pnl);
      slog(`♻️ SELL↓ ${po.shares}sh@${po.price} +$${proceeds} pnl:$${pnl} bal:$${fl2(balance)}`);
    }

    // Clean up old closed orders
    if (['filled', 'cancelled', 'expired'].includes(po.status) && now - po.time > 120000) {
      delete pendingOrders[id];
    }
  }
}

// ── Place / cancel helpers ────────────────────────────────────────────────────
async function placeOrder(tokenId, side, price, shares, slug, dir) {
  if (!trader) return null;
  try {
    const result = await trader.placeOrder(tokenId, side, price, shares);
    const oid = result?.id || result?.orderID || null;
    if (!oid) { slog(`❌ No order ID: ${side} ${shares}sh@${price}`); return null; }
    pendingOrders[oid] = { id: oid, tokenId, side, price, shares, slug, dir, status: 'pending', time: Date.now() };
    return oid;
  } catch (e) {
    const msg = String(e.message || e).substring(0, 100);
    if (!msg.includes('GEO_BLOCKED')) slog(`❌ ${side} ${shares}sh@${price}: ${msg}`);
    return null;
  }
}

function cancelTracked(orderId) {
  if (!orderId || !pendingOrders[orderId]) return;
  pendingOrders[orderId].status = 'cancelling';
  trader?.cancelOrder(orderId).catch(() => {});
}

// ── Enter market ─────────────────────────────────────────────────────────────
function tryEnter(m) {
  if (strategyState[m.slug]) return;
  if (!m.hasClob || m.secondsToEnd <= 5 || m.secondsToEnd > m.windowS) return;
  const upBid = fl4(m.upMid - 0.005);
  const dnBid = fl4(m.downMid - 0.005);
  const edge  = fl4(1.0 - upBid - dnBid);
  if (edge < MIN_EDGE) return;

  strategyState[m.slug] = {
    phase: 'maker',
    upHeld: 0, dnHeld: 0, upCost: 0, dnCost: 0,
    upBuyPrice: 0, dnBuyPrice: 0,
    upOrderTime: Date.now(), dnOrderTime: Date.now(),
    upBuyOrderId: null, dnBuyOrderId: null,
    upSellId: null, dnSellId: null,
    lastUpFillTime: 0, lastDnFillTime: 0, lastTopUpTime: 0,
    lastUpFillPrice: 0, lastDnFillPrice: 0,
    completeSetsSettled: 0, makerPnl: 0, settlePnl: 0, takerTopUps: 0,
    entryTime: Date.now(),
  };
  slog(`🟢 ENTER BTC 15m | UP:${fl4(m.upMid)} DN:${fl4(m.downMid)} edge:${fl4(edge)} remaining:${m.secondsToEnd}s`);
}

// ── Maker tick ────────────────────────────────────────────────────────────────
async function makerTick(m, ss) {
  const upBid = fl4(m.upMid - 0.005);
  const upAsk = fl4(m.upMid + 0.005);
  const dnBid = fl4(m.downMid - 0.005);
  const dnAsk = fl4(m.downMid + 0.005);
  const edge  = fl4(1.0 - upBid - dnBid);

  if (edge < MIN_EDGE) {
    ss.upBuyPrice = 0; ss.dnBuyPrice = 0;
    slog(`⏸ NO EDGE: ${fl4(edge)} (UP:${fl4(m.upMid)} DN:${fl4(m.downMid)})`);
    return;
  }

  // Inventory skew
  const imbalance = ss.upHeld - ss.dnHeld;
  const scale     = Math.min(Math.abs(imbalance) / SKEW_SHARES_FOR_MAX, 1);
  const skew      = Math.round(scale * MAX_SKEW_TICKS);
  const skewUp    = imbalance > 0 ? -skew : +skew;
  const skewDn    = imbalance > 0 ? +skew : -skew;

  // Maker entry prices: bestBid + improve_ticks + skew, capped at mid
  const upEntry = fl4(Math.min(upBid + TICK_SIZE * (IMPROVE_TICKS + skewUp), m.upMid - 0.001));
  const dnEntry = fl4(Math.min(dnBid + TICK_SIZE * (IMPROVE_TICKS + skewDn), m.downMid - 0.001));
  const now     = Date.now();

  // Update and place UP quote
  if (upEntry !== ss.upBuyPrice && (now - ss.upOrderTime) >= MIN_REPLACE_MS || ss.upBuyPrice === 0) {
    if (ss.upBuyOrderId && upEntry !== ss.upBuyPrice) {
      cancelTracked(ss.upBuyOrderId);
      ss.upBuyOrderId = null;
    }
    ss.upBuyPrice  = upEntry;
    ss.upOrderTime = now;
  }
  if (ss.upBuyPrice > 0 && !ss.upBuyOrderId && balance >= MIN_BALANCE) {
    const sz = getSize(m.secondsToEnd);
    placeOrder(m.upTokenId, 'BUY', ss.upBuyPrice, sz, m.slug, 'up_buy').then(oid => {
      if (oid) ss.upBuyOrderId = oid;
    });
  }

  // Update and place DN quote
  if (dnEntry !== ss.dnBuyPrice && (now - ss.dnOrderTime) >= MIN_REPLACE_MS || ss.dnBuyPrice === 0) {
    if (ss.dnBuyOrderId && dnEntry !== ss.dnBuyPrice) {
      cancelTracked(ss.dnBuyOrderId);
      ss.dnBuyOrderId = null;
    }
    ss.dnBuyPrice  = dnEntry;
    ss.dnOrderTime = now;
  }
  if (ss.dnBuyPrice > 0 && !ss.dnBuyOrderId && balance >= MIN_BALANCE) {
    const sz = getSize(m.secondsToEnd);
    placeOrder(m.downTokenId, 'BUY', ss.dnBuyPrice, sz, m.slug, 'dn_buy').then(oid => {
      if (oid) ss.dnBuyOrderId = oid;
    });
  }

  // Settle any complete sets already in hand
  trySettle(m, ss);

  // Fast top-up
  await tryFastTopUp(m, ss, upAsk, dnAsk, edge, now);
}

// ── Settle complete sets: sell both sides at ask ──────────────────────────────
function trySettle(m, ss) {
  const canSettle = Math.min(ss.upHeld, ss.dnHeld);
  if (canSettle <= 0 || !m) return;
  const upAsk = fl4(m.upMid + 0.005);
  const dnAsk = fl4(m.downMid + 0.005);

  // Place UP sell if not already placed
  if (!ss.upSellId) {
    placeOrder(m.upTokenId, 'SELL', upAsk, canSettle, m.slug, 'up_sell').then(oid => {
      if (oid) { ss.upSellId = oid; }
    });
  }
  // Place DN sell if not already placed
  if (!ss.dnSellId) {
    placeOrder(m.downTokenId, 'SELL', dnAsk, canSettle, m.slug, 'dn_sell').then(oid => {
      if (oid) { ss.dnSellId = oid; }
    });
  }
}

// ── Fast top-up ───────────────────────────────────────────────────────────────
async function tryFastTopUp(m, ss, upAsk, dnAsk, edge, now) {
  const imbalance    = ss.upHeld - ss.dnHeld;
  const absImbalance = Math.abs(imbalance);
  if (absImbalance < FAST_TOPUP_MIN_IMB) return;
  if (now - ss.lastTopUpTime < FAST_TOPUP_COOLDOWN_MS) return;

  if (imbalance > 0) {
    // More UP than DN → top-up DN at ask
    if (!ss.lastUpFillTime) return;
    const secsSince = (now - ss.lastUpFillTime) / 1000;
    if (secsSince < FAST_TOPUP_MIN_SECS || secsSince > FAST_TOPUP_MAX_SECS) return;
    const hedgedEdge = fl4(1.0 - ss.lastUpFillPrice - dnAsk);
    if (hedgedEdge < MIN_EDGE) return;
    const spread = 0.01;
    if (spread > TAKER_MAX_SPREAD) return;
    const sz = getSize(m.secondsToEnd);
    const oid = await placeOrder(m.downTokenId, 'BUY', dnAsk, sz, m.slug, 'dn_buy');
    if (oid) {
      ss.lastTopUpTime = now;
      ss.takerTopUps++;
      slog(`⚡ FAST TOPUP↓ ${sz}sh@${fl4(dnAsk)} hedgedEdge:${fl4(hedgedEdge)}`);
    }
  } else {
    // More DN than UP → top-up UP at ask
    if (!ss.lastDnFillTime) return;
    const secsSince = (now - ss.lastDnFillTime) / 1000;
    if (secsSince < FAST_TOPUP_MIN_SECS || secsSince > FAST_TOPUP_MAX_SECS) return;
    const hedgedEdge = fl4(1.0 - upAsk - ss.lastDnFillPrice);
    if (hedgedEdge < MIN_EDGE) return;
    const spread = 0.01;
    if (spread > TAKER_MAX_SPREAD) return;
    const sz = getSize(m.secondsToEnd);
    const oid = await placeOrder(m.upTokenId, 'BUY', upAsk, sz, m.slug, 'up_buy');
    if (oid) {
      ss.lastTopUpTime = now;
      ss.takerTopUps++;
      slog(`⚡ FAST TOPUP↑ ${sz}sh@${fl4(upAsk)} hedgedEdge:${fl4(hedgedEdge)}`);
    }
  }
}

// ── Endgame ───────────────────────────────────────────────────────────────────
async function endgameTick(m, ss) {
  if (ss.phase !== 'endgame') {
    ss.phase = 'endgame';
    ss.upBuyPrice = 0; ss.dnBuyPrice = 0;
    cancelTracked(ss.upBuyOrderId); ss.upBuyOrderId = null;
    cancelTracked(ss.dnBuyOrderId); ss.dnBuyOrderId = null;
    slog(`🛑 ENDGAME | held ↑${ss.upHeld} ↓${ss.dnHeld} imb:${ss.upHeld - ss.dnHeld} sets:${ss.completeSetsSettled}`);
    // Try to settle any complete sets we're holding
    trySettle(m, ss);
  }

  const imbalance    = ss.upHeld - ss.dnHeld;
  const absImbalance = Math.abs(imbalance);
  if (absImbalance < ENDGAME_MIN_IMB) return;

  const upAsk = fl4(m.upMid + 0.005);
  const dnAsk = fl4(m.downMid + 0.005);
  const now   = Date.now();
  if (now - ss.lastTopUpTime < 5000) return;

  if (imbalance > 0) {
    const sz  = Math.min(absImbalance, getSize(m.secondsToEnd));
    const oid = await placeOrder(m.downTokenId, 'BUY', dnAsk, sz, m.slug, 'dn_buy');
    if (oid) { ss.lastTopUpTime = now; ss.takerTopUps++; slog(`🏁 ENDGAME TOPUP↓ ${sz}sh@${fl4(dnAsk)}`); }
  } else {
    const sz  = Math.min(absImbalance, getSize(m.secondsToEnd));
    const oid = await placeOrder(m.upTokenId, 'BUY', upAsk, sz, m.slug, 'up_buy');
    if (oid) { ss.lastTopUpTime = now; ss.takerTopUps++; slog(`🏁 ENDGAME TOPUP↑ ${sz}sh@${fl4(upAsk)}`); }
  }
}

// ── Settlement at resolution ──────────────────────────────────────────────────
function settle(m, ss) {
  if (ss.phase === 'resolved') return;
  if (m.secondsToEnd > -15) return;
  ss.phase = 'resolved';

  const upWins = m.upMid >= m.downMid;
  let settlePnl = 0;

  // Any held shares on winning side pay $1 at resolution
  if (upWins && ss.upHeld > 0) {
    const proceeds = fl2(ss.upHeld * 1.0);
    balance        = fl2(balance + proceeds);
    settlePnl      = fl2(proceeds - ss.upCost);
    slog(`🏆 SETTLE UP wins | ${ss.upHeld}sh → +$${proceeds} net:$${fl2(settlePnl)}`);
  } else if (!upWins && ss.dnHeld > 0) {
    const proceeds = fl2(ss.dnHeld * 1.0);
    balance        = fl2(balance + proceeds);
    settlePnl      = fl2(proceeds - ss.dnCost);
    slog(`🏆 SETTLE DN wins | ${ss.dnHeld}sh → +$${proceeds} net:$${fl2(settlePnl)}`);
  } else {
    slog(`💀 SETTLE ${upWins ? 'UP' : 'DN'} wins — losing side worthless`);
  }

  ss.settlePnl = settlePnl;
  const total  = fl2(ss.makerPnl + settlePnl);
  slog(`✅ RESOLVED | sets:${ss.completeSetsSettled} mkrPnl:$${fl2(ss.makerPnl)} settlePnl:$${fl2(settlePnl)} total:$${fl2(total)} bal:$${fl2(balance)}`);
  m.resolved = true;
}

// ── Strategy tick ─────────────────────────────────────────────────────────────
async function strategyTick() {
  if (KILL_SWITCH) return;

  for (const m of Object.values(marketCache)) {
    if (!m.active && m.secondsToEnd > -60) {
      const ss = strategyState[m.slug];
      if (ss && ss.phase !== 'resolved') settle(m, ss);
      continue;
    }
    if (!m.active || !m.hasClob) continue;
    if (!strategyState[m.slug]) tryEnter(m);
    const ss = strategyState[m.slug];
    if (!ss || ss.phase === 'resolved') continue;
    if (m.secondsToEnd <= -15) { settle(m, ss); continue; }
    if (m.secondsToEnd <= ENDGAME_SECS) {
      await endgameTick(m, ss);
    } else {
      await makerTick(m, ss);
    }
  }
}

// ── Main tick ─────────────────────────────────────────────────────────────────
async function tick() {
  try {
    tickCount++;
    if (tickCount === 1 || tickCount % 60 === 0) await discoverMarkets();
    await updatePrices();
    await strategyTick();
    await checkFills();
    // Sync real balance every 30 ticks (~15s)
    if (tickCount % 30 === 0 && trader) {
      const rb = await trader.getBalance().catch(() => -1);
      if (rb > 0) balance = rb;
    }
    emitFn('snapshot', buildSnapshot());
  } catch (e) { slog(`⚠️ tick: ${e.message}`); }
}

// ── Snapshot ──────────────────────────────────────────────────────────────────
function buildSnapshot() {
  const active  = Object.values(marketCache).filter(m => m.active);
  const allSS   = Object.entries(strategyState);
  const entered = allSS.find(([, s]) => s.phase !== 'resolved');
  const market  = entered ? marketCache[entered[0]] : active[0] || null;
  const ss      = entered ? entered[1] : null;

  const upMid   = market?.upMid   || 0;
  const downMid = market?.downMid || 0;
  const upBid   = fl4(upMid - 0.005);
  const dnBid   = fl4(downMid - 0.005);
  const edge    = fl4(1.0 - upBid - dnBid);

  let totalMakerPnl = 0, totalSettlePnl = 0, totalSets = 0, totalTopUps = 0;
  for (const [, st] of allSS) {
    totalMakerPnl  += st.makerPnl;
    totalSettlePnl += st.settlePnl;
    totalSets      += st.completeSetsSettled;
    totalTopUps    += st.takerTopUps;
  }

  return {
    balance:      fl2(balance),
    startBalance: fl2(startBalance),
    pnl:          fl2(balance - startBalance),
    tickCount, liveMode: true, geoBlocked: false,
    uptime:       Math.floor((Date.now() - startTime) / 1000),
    killSwitch:   KILL_SWITCH,
    commitVersion: process.env.RAILWAY_GIT_COMMIT || process.env.GIT_COMMIT || 'live',

    market: {
      slug:         market?.slug || 'BTC-15m',
      upMid:        fl4(upMid), downMid: fl4(downMid),
      secondsToEnd: market?.secondsToEnd ?? -1,
      active:       market?.active ?? false,
      hasClob:      market?.hasClob ?? false,
      edge, hasEdge: edge >= MIN_EDGE,
    },

    position: ss ? {
      phase:                ss.phase,
      upHeld:               ss.upHeld,
      dnHeld:               ss.dnHeld,
      imbalance:            ss.upHeld - ss.dnHeld,
      upBuyPrice:           ss.upBuyPrice,
      dnBuyPrice:           ss.dnBuyPrice,
      upCost:               fl2(ss.upCost),
      dnCost:               fl2(ss.dnCost),
      completeSetsRedeemed: ss.completeSetsSettled,
      makerPnl:             fl2(ss.makerPnl),
      settlePnl:            fl2(ss.settlePnl),
      takerTopUps:          ss.takerTopUps,
    } : null,

    session: {
      makerPnl:  fl2(totalMakerPnl),
      settlePnl: fl2(totalSettlePnl),
      sets:      totalSets,
      topUps:    totalTopUps,
    },

    fills:         fills.slice(0, 60),
    logs:          logs.slice(0, 60),
    markets:       Object.keys(marketCache).length,
    activeMarkets: active.length,
    pendingOrders: Object.values(pendingOrders).filter(o => o.status === 'pending').length,
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function start(emit, logEmit) {
  emitFn = emit; logFn = logEmit; startTime = Date.now();

  if (KILL_SWITCH) {
    slog('🔴 KILL_SWITCH=true — bot paused. Set KILL_SWITCH=false on Railway to enable trading.');
  }

  slog(`🤖 Complete-Set Arb v1 | sizing:5→9sh | tick:${TICK_MS}ms | edge≥${MIN_EDGE}`);

  trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY, process.env.FUNDER_ADDRESS);
  trader.setLogFn(logFn);
  slog('🔑 Authenticating with Polymarket CLOB...');
  const auth = await trader.authenticate();
  if (!auth) { slog('❌ Auth failed. Check POLYMARKET_PRIVATE_KEY.'); process.exit(1); }

  const rb = await trader.getBalance().catch(() => -1);
  if (rb > 0) { balance = rb; startBalance = rb; }
  slog(`✅ LIVE | wallet:${trader.address} bal:$${fl2(balance)}`);

  await tick();
  setInterval(() => tick().catch(e => slog(`⚠️ ${e.message}`)), TICK_MS);
}

module.exports = { start, buildSnapshot, tick };
