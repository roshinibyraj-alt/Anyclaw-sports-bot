'use strict';

// ── Complete-Set Arbitrage Bot v2 ───────────────────────────────────────────
// Strategy: buy UP + DN as maker when combined bid < $0.99 → settle at ask (~$1)
// KILL_SWITCH: env var KILL_SWITCH=true to pause trading (Railway env var)
// Key safety rules:
//   • Balance deducted immediately on BUY placement (GTC locks funds on CLOB)
//   • Orders cancelled (balance refunded) when edge disappears
//   • MAX_POSITION_PER_LEG hard cap per side
//   • MAX_IMBALANCE pauses excess side when one leg runs ahead

const PolymarketTrader = require('./polymarket-trader');

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB  = 'https://clob.polymarket.com';

const KILL_SWITCH            = process.env.KILL_SWITCH === 'true';
const MIN_EDGE               = 0.01;
const TICK_SIZE              = 0.01;
const IMPROVE_TICKS          = 1;
const MAX_SKEW_TICKS         = 1;
const SKEW_SHARES_FOR_MAX    = 100;
const MAX_POSITION_PER_LEG   = 45;   // hard cap per side (shares)
const MAX_IMBALANCE          = 18;   // pause excess side beyond this
const FAST_TOPUP_MIN_IMB     = 9;    // min imbalance to trigger fast top-up
const FAST_TOPUP_COOLDOWN_MS = 15000;
const ENDGAME_SECS           = 60;
const TAKER_MAX_SPREAD       = 0.02;
const MIN_REPLACE_MS         = 4000;
const MIN_BALANCE            = 5;
const TICK_MS                = 500;
const ORDER_FAIL_PAUSE_MS    = 5000; // after balance error, pause that side

// Sizing: 9 shares always; reduce only in the final 60s to limit endgame exposure
function getSize(secsToEnd) {
  if (secsToEnd < 60) return 5;
  return 9;
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

// ── Runtime state ─────────────────────────────────────────────────────────────
let trader        = null;
let balance       = 0;
let startBalance  = 0;
let marketCache   = {};   // slug → market info
let strategyState = {};   // slug → position state
let pendingOrders = {};   // orderId → order record
let recentFills   = [];   // for dashboard
let activityLog   = [];   // for dashboard
let tickCount     = 0;
let startTime     = Date.now();
let emitFn        = () => {};
let logFn         = () => {};

function slog(msg) {
  const ts = new Date().toTimeString().substring(0, 8);
  activityLog.unshift(`[${ts}] ${msg}`);
  if (activityLog.length > 150) activityLog.length = 150;
  logFn(msg);
}

// ── Market discovery ──────────────────────────────────────────────────────────
async function discoverMarkets() {
  const now = Math.floor(Date.now() / 1000);
  const ws  = 900;
  const cw  = Math.floor(now / ws) * ws;

  await Promise.allSettled([cw - ws, cw, cw + ws].map(async ep => {
    const slug = `btc-updown-15m-${ep}`;
    if (marketCache[slug]?.resolved) return;
    const d = await getJson(`${GAMMA}/events?slug=${slug}`);
    if (!Array.isArray(d) || !d[0]?.markets?.[0]) return;
    const m = d[0].markets[0];
    if (!m.clobTokenIds) return;
    let tokenIds;
    try { tokenIds = JSON.parse(m.clobTokenIds); } catch (_) { return; }
    if (tokenIds.length < 2) return;
    if (marketCache[slug]) return;
    marketCache[slug] = {
      slug, windowS: ws, epoch: ep,
      upTokenId: tokenIds[0], downTokenId: tokenIds[1],
      endTime: (ep + ws) * 1000, active: false, resolved: false,
      hasClob: false, upMid: 0, downMid: 0, secondsToEnd: ep + ws - now,
    };
    slog(`📡 Discovered: ${slug}`);
  }));
}

// ── Price refresh ─────────────────────────────────────────────────────────────
async function updatePrices() {
  const now = Date.now();
  await Promise.allSettled(Object.values(marketCache).map(async m => {
    m.secondsToEnd = Math.floor((m.endTime - now) / 1000);
    m.active = !m.resolved && m.secondsToEnd > 0 && m.secondsToEnd <= m.windowS;
    if (m.secondsToEnd < -120) { m.active = false; return; }
    if (!m.active) return;
    const [upR, dnR] = await Promise.all([
      getJson(`${CLOB}/midpoint?token_id=${m.upTokenId}`),
      getJson(`${CLOB}/midpoint?token_id=${m.downTokenId}`),
    ]);
    if (upR?.mid) m.upMid = parseFloat(upR.mid);
    if (dnR?.mid) m.downMid = parseFloat(dnR.mid);
    m.hasClob = m.upMid > 0 && m.downMid > 0;
  }));
}

// ── Fill detection (checks open orders vs our pending list) ───────────────────
async function checkFills() {
  if (!trader || Object.keys(pendingOrders).length === 0) return;
  let openOrders;
  try { openOrders = await trader.getOpenOrders(); } catch (_) { return; }
  const openIds = new Set((openOrders || []).map(o => o.id));
  const now = Date.now();

  for (const [id, po] of Object.entries(pendingOrders)) {
    if (po.status === 'cancelling') {
      if (!openIds.has(id)) {
        // Confirm cancelled → credit back the locked funds
        if (po.side === 'BUY') balance = fl2(balance + po.shares * po.price);
        po.status = 'cancelled';
      }
      continue;
    }
    if (po.status !== 'pending') continue;
    if (openIds.has(id)) continue;

    // Disappeared → filled
    po.status = 'filled';
    const ss = strategyState[po.slug];
    if (!ss) continue;

    if (po.dir === 'up_buy') {
      // Balance already deducted at placement — just update inventory
      ss.upHeld  += po.shares;
      ss.upCost   = fl2(ss.upCost + po.shares * po.price);
      ss.lastUpFillTime  = now;
      ss.lastUpFillPrice = po.price;
      ss.upBuyOrderId    = null;
      ss.upFailTime      = 0;
      recentFills.unshift({ ts: new Date().toTimeString().substring(0,8), leg:'UP', action:'BUY', shares:po.shares, price:po.price, bal:fl2(balance) });
      if (recentFills.length > 80) recentFills.length = 80;
      slog(`✅ FILL BUY↑ ${po.shares}sh@${po.price} held:↑${ss.upHeld} ↓${ss.dnHeld}`);
      scheduleSettle(ss, marketCache[po.slug]);

    } else if (po.dir === 'dn_buy') {
      ss.dnHeld  += po.shares;
      ss.dnCost   = fl2(ss.dnCost + po.shares * po.price);
      ss.lastDnFillTime  = now;
      ss.lastDnFillPrice = po.price;
      ss.dnBuyOrderId    = null;
      ss.dnFailTime      = 0;
      recentFills.unshift({ ts: new Date().toTimeString().substring(0,8), leg:'DN', action:'BUY', shares:po.shares, price:po.price, bal:fl2(balance) });
      if (recentFills.length > 80) recentFills.length = 80;
      slog(`✅ FILL BUY↓ ${po.shares}sh@${po.price} held:↑${ss.upHeld} ↓${ss.dnHeld}`);
      scheduleSettle(ss, marketCache[po.slug]);

    } else if (po.dir === 'up_sell') {
      const proceeds = fl2(po.shares * po.price);
      balance        = fl2(balance + proceeds);
      ss.upHeld      = Math.max(0, ss.upHeld - po.shares);
      ss.upSellId    = null;
      const avgUp    = ss.upHeld + po.shares > 0 ? ss.upCost / (ss.upHeld + po.shares) : po.price;
      const pnl      = fl2(proceeds - po.shares * avgUp);
      ss.makerPnl    = fl2(ss.makerPnl + pnl);
      recentFills.unshift({ ts: new Date().toTimeString().substring(0,8), leg:'UP', action:'SELL', shares:po.shares, price:po.price, pnl, bal:fl2(balance) });
      if (recentFills.length > 80) recentFills.length = 80;
      slog(`♻️  SELL↑ ${po.shares}sh@${po.price} +$${proceeds} pnl:$${pnl} mkrPnl:$${fl2(ss.makerPnl)}`);

    } else if (po.dir === 'dn_sell') {
      const proceeds = fl2(po.shares * po.price);
      balance        = fl2(balance + proceeds);
      ss.dnHeld      = Math.max(0, ss.dnHeld - po.shares);
      ss.dnSellId    = null;
      const avgDn    = ss.dnHeld + po.shares > 0 ? ss.dnCost / (ss.dnHeld + po.shares) : po.price;
      const pnl      = fl2(proceeds - po.shares * avgDn);
      ss.makerPnl    = fl2(ss.makerPnl + pnl);
      ss.completeSetsSettled++;
      recentFills.unshift({ ts: new Date().toTimeString().substring(0,8), leg:'DN', action:'SELL', shares:po.shares, price:po.price, pnl, bal:fl2(balance) });
      if (recentFills.length > 80) recentFills.length = 80;
      slog(`♻️  SELL↓ ${po.shares}sh@${po.price} +$${proceeds} pnl:$${pnl} bal:$${fl2(balance)}`);
    }
  }

  // Purge old closed entries
  const cutoff = now - 120000;
  for (const [id, po] of Object.entries(pendingOrders)) {
    if (['filled','cancelled','expired'].includes(po.status) && po.time < cutoff) {
      delete pendingOrders[id];
    }
  }
}

// ── Place order — deducts balance immediately for BUY (GTC locks funds) ───────
async function placeOrder(tokenId, side, price, shares, slug, dir) {
  if (!trader) return null;

  // Pre-deduct locked capital for BUY before the async call
  if (side === 'BUY') balance = fl2(balance - shares * price);

  try {
    const result = await trader.placeOrder(tokenId, side, price, shares);
    const oid    = result?.id || result?.orderID || null;
    if (!oid) {
      // Placement failed — credit funds back
      if (side === 'BUY') balance = fl2(balance + shares * price);
      // Log balance errors only once per pause window (handled by caller with failTime)
      if (!String(result).includes('balance')) {
        slog(`❌ ${side} ${shares}sh@${price}: No order ID`);
      }
      return null;
    }
    pendingOrders[oid] = { id:oid, tokenId, side, price, shares, slug, dir, status:'pending', time:Date.now() };
    return oid;
  } catch (e) {
    if (side === 'BUY') balance = fl2(balance + shares * price);
    const msg = String(e.message || e).substring(0, 80);
    if (!msg.includes('balance') && !msg.includes('allowance')) slog(`❌ ${side} ${shares}sh@${price}: ${msg}`);
    return null;
  }
}

// Cancel a tracked order and credit back if it was a pending BUY
function cancelTracked(orderId) {
  const po = pendingOrders[orderId];
  if (!po || po.status !== 'pending') return;
  po.status = 'cancelling';
  // Credit back speculatively — checkFills will confirm and not double-credit
  // (using 'cancelling' status prevents double credit)
  trader?.cancelOrder(orderId).catch(() => {});
}

// ── Enter a new market window ─────────────────────────────────────────────────
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
    upBuyOrderId: null, dnBuyOrderId: null,
    upOrderTime: 0, dnOrderTime: 0,
    upSellId: null, dnSellId: null,
    upFailTime: 0, dnFailTime: 0,  // when last balance error happened
    lastUpFillTime: 0, lastDnFillTime: 0, lastTopUpTime: 0,
    lastUpFillPrice: 0, lastDnFillPrice: 0,
    completeSetsSettled: 0, makerPnl: 0, settlePnl: 0, takerTopUps: 0,
    entryTime: Date.now(),
  };
  slog(`🟢 ENTER BTC 15m | UP:${fl4(m.upMid)} DN:${fl4(m.downMid)} edge:${fl4(edge)} rem:${m.secondsToEnd}s`);
}

// ── Maker tick — manage GTC quotes on both legs ───────────────────────────────
async function makerTick(m, ss) {
  const upMid = m.upMid, dnMid = m.downMid;
  const upBid = fl4(upMid - 0.005), upAsk = fl4(upMid + 0.005);
  const dnBid = fl4(dnMid - 0.005), dnAsk = fl4(dnMid + 0.005);
  const edge  = fl4(1.0 - upBid - dnBid);
  const now   = Date.now();

  // ── If edge is gone: cancel all outstanding buy orders and stop ──
  if (edge < MIN_EDGE) {
    if (ss.upBuyOrderId) { cancelTracked(ss.upBuyOrderId); ss.upBuyOrderId = null; ss.upBuyPrice = 0; }
    if (ss.dnBuyOrderId) { cancelTracked(ss.dnBuyOrderId); ss.dnBuyOrderId = null; ss.dnBuyPrice = 0; }
    slog(`⏸  NO EDGE: ${fl4(edge)} | UP:${fl4(upMid)} DN:${fl4(dnMid)}`);
    return;
  }

  const imbalance   = ss.upHeld - ss.dnHeld;
  const scale       = Math.min(Math.abs(imbalance) / SKEW_SHARES_FOR_MAX, 1);
  const skew        = Math.round(scale * MAX_SKEW_TICKS);
  const skewUp      = imbalance > 0 ? -skew : +skew;
  const skewDn      = imbalance > 0 ? +skew : -skew;
  const upEntry     = fl4(Math.min(upBid + TICK_SIZE * (IMPROVE_TICKS + skewUp), upMid - 0.001));
  const dnEntry     = fl4(Math.min(dnBid + TICK_SIZE * (IMPROVE_TICKS + skewDn), dnMid - 0.001));

  // Position guards
  const canBuyUp = ss.upHeld < MAX_POSITION_PER_LEG
                && imbalance <= MAX_IMBALANCE
                && balance >= MIN_BALANCE
                && (now - ss.upFailTime) > ORDER_FAIL_PAUSE_MS;

  const canBuyDn = ss.dnHeld < MAX_POSITION_PER_LEG
                && imbalance >= -MAX_IMBALANCE
                && balance >= MIN_BALANCE
                && (now - ss.dnFailTime) > ORDER_FAIL_PAUSE_MS;

  // ── UP leg ──
  const upPriceChanged = upEntry !== ss.upBuyPrice;
  if (upPriceChanged && ss.upBuyOrderId && (now - ss.upOrderTime) >= MIN_REPLACE_MS) {
    cancelTracked(ss.upBuyOrderId);
    ss.upBuyOrderId = null; ss.upBuyPrice = 0;
  }
  if (!ss.upBuyOrderId && canBuyUp) {
    ss.upBuyPrice = upEntry; ss.upOrderTime = now;
    const sz = getSize(m.secondsToEnd);
    const oid = await placeOrder(m.upTokenId, 'BUY', upEntry, sz, m.slug, 'up_buy');
    if (oid) {
      ss.upBuyOrderId = oid;
    } else {
      ss.upBuyPrice = 0;
      ss.upFailTime = now;
    }
  }

  // ── DN leg ──
  const dnPriceChanged = dnEntry !== ss.dnBuyPrice;
  if (dnPriceChanged && ss.dnBuyOrderId && (now - ss.dnOrderTime) >= MIN_REPLACE_MS) {
    cancelTracked(ss.dnBuyOrderId);
    ss.dnBuyOrderId = null; ss.dnBuyPrice = 0;
  }
  if (!ss.dnBuyOrderId && canBuyDn) {
    ss.dnBuyPrice = dnEntry; ss.dnOrderTime = now;
    const sz = getSize(m.secondsToEnd);
    const oid = await placeOrder(m.downTokenId, 'BUY', dnEntry, sz, m.slug, 'dn_buy');
    if (oid) {
      ss.dnBuyOrderId = oid;
    } else {
      ss.dnBuyPrice = 0;
      ss.dnFailTime = now;
    }
  }

  // Settle any complete sets
  scheduleSettle(ss, m);

  // Fast top-up if imbalance is large enough
  await tryFastTopUp(m, ss, upAsk, dnAsk, edge, now);
}

// ── Settle complete sets (maker phase): sell min(upHeld,dnHeld) pairs at ask ──
function scheduleSettle(ss, m) {
  if (!m || !m.hasClob) return;
  const canSettle = Math.min(ss.upHeld, ss.dnHeld);
  if (canSettle <= 0) return;
  const upAsk = fl4(m.upMid + 0.005);
  const dnAsk = fl4(m.downMid + 0.005);
  if (!ss.upSellId) {
    placeOrder(m.upTokenId, 'SELL', upAsk, canSettle, m.slug, 'up_sell').then(oid => {
      if (oid) ss.upSellId = oid;
    });
  }
  if (!ss.dnSellId) {
    placeOrder(m.downTokenId, 'SELL', dnAsk, canSettle, m.slug, 'dn_sell').then(oid => {
      if (oid) ss.dnSellId = oid;
    });
  }
}

// ── Endgame sell: sell ALL held shares on both legs at ask ────────────────────
// Called every endgame tick. Uses same upSellId/dnSellId tracking so it only
// places a new order when the previous one filled (id cleared) or never existed.
function scheduleEndgameSell(ss, m) {
  if (!m || !m.hasClob) return;
  const upAsk = fl4(m.upMid + 0.005);
  const dnAsk = fl4(m.downMid + 0.005);
  if (ss.upHeld > 0 && !ss.upSellId) {
    placeOrder(m.upTokenId, 'SELL', upAsk, ss.upHeld, m.slug, 'up_sell').then(oid => {
      if (oid) { ss.upSellId = oid; slog(`📤 ENDGAME SELL↑ ${ss.upHeld}sh@${upAsk}`); }
    });
  }
  if (ss.dnHeld > 0 && !ss.dnSellId) {
    placeOrder(m.downTokenId, 'SELL', dnAsk, ss.dnHeld, m.slug, 'dn_sell').then(oid => {
      if (oid) { ss.dnSellId = oid; slog(`📤 ENDGAME SELL↓ ${ss.dnHeld}sh@${dnAsk}`); }
    });
  }
}

// ── Fast top-up (taker buy) for lagging leg ───────────────────────────────────
async function tryFastTopUp(m, ss, upAsk, dnAsk, edge, now) {
  const imb = ss.upHeld - ss.dnHeld;
  if (Math.abs(imb) < FAST_TOPUP_MIN_IMB) return;
  if (now - ss.lastTopUpTime < FAST_TOPUP_COOLDOWN_MS) return;
  if (balance < MIN_BALANCE) return;

  if (imb > 0 && (now - ss.dnFailTime) > ORDER_FAIL_PAUSE_MS) {
    const hedgedEdge = fl4(1.0 - ss.lastUpFillPrice - dnAsk);
    if (hedgedEdge < MIN_EDGE) return;
    if (dnAsk - (m.downMid - 0.005) > TAKER_MAX_SPREAD) return;
    const sz = Math.min(getSize(m.secondsToEnd), imb);
    const oid = await placeOrder(m.downTokenId, 'BUY', dnAsk, sz, m.slug, 'dn_buy');
    if (oid) {
      ss.lastTopUpTime = now; ss.takerTopUps++;
      slog(`⚡ TOPUP↓ ${sz}sh@${fl4(dnAsk)} hedgedEdge:${fl4(hedgedEdge)}`);
    } else { ss.dnFailTime = now; }

  } else if (imb < 0 && (now - ss.upFailTime) > ORDER_FAIL_PAUSE_MS) {
    const hedgedEdge = fl4(1.0 - upAsk - ss.lastDnFillPrice);
    if (hedgedEdge < MIN_EDGE) return;
    if (upAsk - (m.upMid - 0.005) > TAKER_MAX_SPREAD) return;
    const sz = Math.min(getSize(m.secondsToEnd), -imb);
    const oid = await placeOrder(m.upTokenId, 'BUY', upAsk, sz, m.slug, 'up_buy');
    if (oid) {
      ss.lastTopUpTime = now; ss.takerTopUps++;
      slog(`⚡ TOPUP↑ ${sz}sh@${fl4(upAsk)} hedgedEdge:${fl4(hedgedEdge)}`);
    } else { ss.upFailTime = now; }
  }
}

// ── Endgame (<60s): cancel maker quotes, sell ALL positions, taker-fill any gap ─
async function endgameTick(m, ss) {
  if (ss.phase !== 'endgame') {
    ss.phase = 'endgame';
    if (ss.upBuyOrderId) { cancelTracked(ss.upBuyOrderId); ss.upBuyOrderId = null; ss.upBuyPrice = 0; }
    if (ss.dnBuyOrderId) { cancelTracked(ss.dnBuyOrderId); ss.dnBuyOrderId = null; ss.dnBuyPrice = 0; }
    slog(`🛑 ENDGAME | held ↑${ss.upHeld} ↓${ss.dnHeld} imb:${ss.upHeld - ss.dnHeld} sets:${ss.completeSetsSettled}`);
  }

  // Every endgame tick: place sell orders for ALL held shares at ask
  // (scheduleEndgameSell is idempotent — only places when no open sell exists)
  scheduleEndgameSell(ss, m);

  // Also try taker buy on the lagging leg to close imbalance before close
  const imb = ss.upHeld - ss.dnHeld;
  const absImb = Math.abs(imb);
  if (absImb < 5) return;
  const now = Date.now();
  if (now - ss.lastTopUpTime < 5000) return;
  if (balance < MIN_BALANCE) return;
  const sz = Math.min(getSize(m.secondsToEnd), absImb);
  if (imb > 0) {
    const oid = await placeOrder(m.downTokenId, 'BUY', fl4(m.downMid + 0.005), sz, m.slug, 'dn_buy');
    if (oid) { ss.lastTopUpTime = now; ss.takerTopUps++; slog(`🏁 ENDGAME TOPUP↓ ${sz}sh`); }
    else ss.dnFailTime = now;
  } else {
    const oid = await placeOrder(m.upTokenId, 'BUY', fl4(m.upMid + 0.005), sz, m.slug, 'up_buy');
    if (oid) { ss.lastTopUpTime = now; ss.takerTopUps++; slog(`🏁 ENDGAME TOPUP↑ ${sz}sh`); }
    else ss.upFailTime = now;
  }
}

// ── Settlement at market resolution ──────────────────────────────────────────
function settle(m, ss) {
  if (ss.phase === 'resolved') return;
  if (m.secondsToEnd > -10) return;
  ss.phase = 'resolved';

  const upWins = m.upMid >= m.downMid;
  let settlePnl = 0;
  if (upWins && ss.upHeld > 0) {
    const proceeds = fl2(ss.upHeld * 1.0);
    balance   = fl2(balance + proceeds);
    settlePnl = fl2(proceeds - ss.upCost);
    slog(`🏆 UP wins | ${ss.upHeld}sh → +$${proceeds} net:$${fl2(settlePnl)}`);
  } else if (!upWins && ss.dnHeld > 0) {
    const proceeds = fl2(ss.dnHeld * 1.0);
    balance   = fl2(balance + proceeds);
    settlePnl = fl2(proceeds - ss.dnCost);
    slog(`🏆 DN wins | ${ss.dnHeld}sh → +$${proceeds} net:$${fl2(settlePnl)}`);
  } else {
    slog(`💀 SETTLED — losing-side shares worthless`);
  }
  ss.settlePnl = settlePnl;
  slog(`✅ RESOLVED | sets:${ss.completeSetsSettled} mkrPnl:$${fl2(ss.makerPnl)} settlePnl:$${fl2(settlePnl)} bal:$${fl2(balance)}`);
  m.resolved = true;
}

// ── Strategy tick (runs every 500ms) ─────────────────────────────────────────
async function strategyTick() {
  if (KILL_SWITCH) return;
  for (const m of Object.values(marketCache)) {
    if (!m.active || !m.hasClob) {
      const ss = strategyState[m.slug];
      if (ss && ss.phase !== 'resolved') settle(m, ss);
      continue;
    }
    if (!strategyState[m.slug]) tryEnter(m);
    const ss = strategyState[m.slug];
    if (!ss || ss.phase === 'resolved') continue;
    if (m.secondsToEnd <= -10) { settle(m, ss); continue; }
    if (m.secondsToEnd <= ENDGAME_SECS) await endgameTick(m, ss);
    else                                await makerTick(m, ss);
  }
}

// ── Main tick loop ────────────────────────────────────────────────────────────
async function tick() {
  try {
    tickCount++;
    if (tickCount === 1 || tickCount % 60 === 0) await discoverMarkets();
    await updatePrices();
    await strategyTick();
    await checkFills();
    // Sync real balance from chain every 20s to correct any drift
    if (tickCount % 40 === 0 && trader) {
      const rb = await trader.getBalance().catch(() => -1);
      if (rb > 0) balance = rb;
    }
    emitFn('snapshot', buildSnapshot());
  } catch (e) { slog(`⚠️  tick: ${e.message}`); }
}

// ── Snapshot (sent to dashboard via socket.io) ────────────────────────────────
function buildSnapshot() {
  const activeMkts = Object.values(marketCache).filter(m => m.active);
  const positions  = Object.entries(strategyState).filter(([, s]) => s.phase !== 'resolved');
  const cur        = positions[0];
  const curM       = cur ? marketCache[cur[0]] : activeMkts[0] || null;
  const curS       = cur ? cur[1] : null;

  let totalMakerPnl = 0, totalSettlePnl = 0, totalSets = 0, totalTopUps = 0;
  for (const [, s] of Object.entries(strategyState)) {
    totalMakerPnl  += s.makerPnl;
    totalSettlePnl += s.settlePnl;
    totalSets      += s.completeSetsSettled;
    totalTopUps    += s.takerTopUps;
  }

  const upMid  = curM?.upMid  || 0;
  const dnMid  = curM?.downMid || 0;
  const edge   = fl4(1.0 - fl4(upMid - 0.005) - fl4(dnMid - 0.005));

  return {
    // Core financials
    balance:      fl2(balance),
    startBalance: fl2(startBalance),
    pnl:          fl2(balance - startBalance),

    // Market
    market: {
      slug:         curM?.slug || '',
      upMid:        fl4(upMid),
      downMid:      fl4(dnMid),
      secondsToEnd: curM?.secondsToEnd ?? -1,
      active:       curM?.active ?? false,
      hasClob:      curM?.hasClob ?? false,
      edge,
      hasEdge: edge >= MIN_EDGE,
    },

    // Active position
    position: curS ? {
      phase:                curS.phase,
      upHeld:               curS.upHeld,
      dnHeld:               curS.dnHeld,
      imbalance:            curS.upHeld - curS.dnHeld,
      upBuyPrice:           curS.upBuyPrice,
      dnBuyPrice:           curS.dnBuyPrice,
      upCost:               fl2(curS.upCost),
      dnCost:               fl2(curS.dnCost),
      completeSetsSettled:  curS.completeSetsSettled,
      makerPnl:             fl2(curS.makerPnl),
      settlePnl:            fl2(curS.settlePnl),
      takerTopUps:          curS.takerTopUps,
    } : null,

    // Session totals
    session: {
      makerPnl:  fl2(totalMakerPnl),
      settlePnl: fl2(totalSettlePnl),
      sets:      totalSets,
      topUps:    totalTopUps,
    },

    // Dashboard feeds
    recentFills:   recentFills.slice(0, 60),
    activityLog:   activityLog.slice(0, 50),

    // Meta
    tickCount,
    uptime:       Math.floor((Date.now() - startTime) / 1000),
    activeMarkets: activeMkts.length,
    pendingOrders: Object.values(pendingOrders).filter(o => o.status === 'pending').length,
    liveMode:     true,
    killSwitch:   KILL_SWITCH,
    commitVersion: process.env.RAILWAY_GIT_COMMIT || process.env.GIT_COMMIT || 'live',
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────
async function start(emit, logEmit) {
  emitFn = emit; logFn = logEmit; startTime = Date.now();

  if (KILL_SWITCH) slog('🔴 KILL_SWITCH=true — set KILL_SWITCH=false on Railway to enable trading');

  slog(`🤖 Complete-Set Arb v2 | sz:5-9sh | edge≥${MIN_EDGE} | maxPos:${MAX_POSITION_PER_LEG} | maxImb:${MAX_IMBALANCE}`);

  trader = new PolymarketTrader(process.env.POLYMARKET_PRIVATE_KEY, process.env.FUNDER_ADDRESS);
  trader.setLogFn(logFn);
  slog('🔑 Authenticating...');
  const auth = await trader.authenticate();
  if (!auth) { slog('❌ Auth failed. Check POLYMARKET_PRIVATE_KEY.'); process.exit(1); }

  const rb = await trader.getBalance().catch(() => -1);
  if (rb > 0) { balance = rb; startBalance = rb; }
  slog(`✅ LIVE | wallet:${trader.address} bal:$${fl2(balance)}`);

  await tick();
  setInterval(() => tick().catch(e => slog(`⚠️  ${e.message}`)), TICK_MS);
}

module.exports = { start, buildSnapshot, tick };
