'use strict';

const fetch = require('node-fetch');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

// ═══════════════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════════════
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB_REST = 'https://clob.polymarket.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY || null;
const DRY_RUN = process.env.DRY_RUN !== 'false';
const START_BALANCE = 2000;

// Fee cache — fetches per-market fee rates from CLOB API
const FEE_CACHE = {};
async function getFeeRate(tokenId) {
  if (!tokenId) return 0.03;
  if (FEE_CACHE[tokenId]) return FEE_CACHE[tokenId];
  try {
    const res = await fetch(CLOB_REST + '/fee-rate?token_id=' + tokenId, { timeout: 3000 });
    if (res.ok) {
      const d = await res.json();
      if (d && d.base_fee > 0) {
        const rate = d.base_fee / 1000;
        if (rate <= 0.10) { FEE_CACHE[tokenId] = rate; return rate; }
      }
    }
  } catch (_) {}
  return 0.03; // default sports fee
}

// ═══════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════
const fl2 = n => Math.round(n * 100) / 100;
const fl4 = n => Math.round(n * 10000) / 10000;
const addF = (a, b) => fl2((a * 100 + b * 100) / 100);
const subF = (a, b) => fl2((a * 100 - b * 100) / 100);

const priceBook = {};
let clobClient = null;
let logFn = console.log;
let emitFn = () => {};

function getPrice(tokenId) {
  if (!tokenId) return 0;
  const b = priceBook[tokenId] || priceBook[String(tokenId)];
  return b ? (b.bid > 0 && b.ask > 0) ? (b.bid + b.ask) / 2 : (b.bid || b.ask || 0) : 0;
}

async function getJson(url) {
  try { const r = await fetch(url, { timeout: 10000 }); if (!r.ok) return null; return r.json().catch(() => null); } catch (_) { return null; }
}
async function getJsonArray(url) {
  try { const r = await fetch(url, { timeout: 10000 }); if (!r.ok) return []; const d = await r.json().catch(() => []); return Array.isArray(d) ? d : d.events || []; } catch (_) { return []; }
}

// ═══════════════════════════════════════════════════════════════════════
// SPORTS BOT — Tennis, Cricket, Football (Moneyline Fade)
// ═══════════════════════════════════════════════════════════════════════

const SPORTS_CFG = {
  tennis:   { label: 'Tennis',   capital: 2000, threshold: 0.55, tpSpread: 0.10, stopSpread: 0.05, maxBetPct: 0.05, gammaTag: 'Tennis',   matchTags: ['tennis','atp','wta','challenger','libema','slam','open'],                  seedPatterns: ['tennis','atp','wta','slam','open','challenger'] },
  cricket:  { label: 'Cricket',  capital: 2000, threshold: 0.55, tpSpread: 0.10, stopSpread: 0.05, maxBetPct: 0.05, gammaTag: 'Cricket',  matchTags: ['cricket','t20','odi','bbl','ipl','test','icc','women','world cup','crint'], seedPatterns: ['icc','t20','world cup','crint','cricket'] },
  football: { label: 'Football', capital: 2000, threshold: 0.60, tpSpread: 0.08, stopSpread: 0.05, maxBetPct: 0.05, gammaTag: 'Soccer',   matchTags: ['soccer','football','world cup','fifa','uefa','premier','champions'],         seedPatterns: ['soccer','football','fifa','uefa','champions','world cup'] },
  mlb: { label: 'MLB', capital: 2000, threshold: 0.60, tpSpread: 0.08, stopSpread: 0.05, maxBetPct: 0.05, gammaTag: 'MLB', matchTags: ['mlb','baseball'], seedPatterns: ['mlb','baseball'] }
};

const sportsState = {};
const sportsDiscovery = {};
let lastSportsDiscovery = 0;

function loadSportsState() {
  for (const s of Object.keys(SPORTS_CFG)) {
    try {
      const f = path.join(__dirname, `state_${s}.json`);
      if (fs.existsSync(f)) sportsState[s] = JSON.parse(fs.readFileSync(f, 'utf8'));
      else sportsState[s] = { balance: SPORTS_CFG[s].capital, totalPnl: 0, totalFees: 0, wins: 0, losses: 0, recentTrades: [] };
    } catch (_) { sportsState[s] = { balance: SPORTS_CFG[s].capital, totalPnl: 0, totalFees: 0, wins: 0, losses: 0, recentTrades: [] }; }
  }
}
function saveSportsState(sport) {
  try { fs.writeFileSync(path.join(__dirname, `state_${sport}.json`), JSON.stringify(sportsState[sport], null, 2)); } catch (_) {}
}
function matchKey(matchId) { return 'm:' + matchId; }

function findMoneylineMarket(event) {
  const markets = event.markets || [];
  let best = null;
  for (const m of markets) {
    if (!m.acceptingOrders || m.closed) continue;
    const q = (m.question || '').toLowerCase();
    const liq = m.liquidityNum || 0;
    let outcomes = []; try { outcomes = JSON.parse(m.outcomes || '[]'); } catch (_) {}
    if (outcomes.length !== 2) continue;
    if (q.includes('set') || q.includes('handicap') || q.includes('total') || q.includes('completed') || q.includes('spread') || q.includes('race to')) continue;
    const isMl = q === (event.title || '').toLowerCase() || q.includes(' vs ') || q.includes(' beat ');
    const hasPlayerOutcomes = outcomes.every(o => o.length > 1 && !['yes','no','over','under'].includes(o.toLowerCase()));
    if ((isMl || hasPlayerOutcomes) && liq > 0) { if (!best || liq > best.liquidityNum) best = m; }
  }
  if (!best) {
    for (const m of markets) {
      if (!m.acceptingOrders || m.closed) continue;
      const q = (m.question || '').toLowerCase();
      if (!q.includes(' vs ')) continue;
      let outcomes = []; try { outcomes = JSON.parse(m.outcomes || '[]'); } catch (_) {}
      if (outcomes.length !== 2) continue;
      if (q.includes('handicap') || q.includes('set') || q.includes('total')) continue;
      const liq = m.liquidityNum || 0;
      if (liq > 100 && (!best || liq > best.liquidityNum)) best = m;
    }
  }
  return best;
}

async function discoverSports() {
  if (Date.now() - lastSportsDiscovery < 120000) return;
  lastSportsDiscovery = Date.now();
  for (const [sport, cfg] of Object.entries(SPORTS_CFG)) {
    try {
      const found = [];
      const seen = new Set((sportsDiscovery[sport] || []).map(d => d.matchId));
      // Tag search
      const events = await getJsonArray(GAMMA + '/events?tag=' + cfg.gammaTag + '&closed=false&live=true&limit=25');
      for (const e of events) {
        if (!e || e.closed || seen.has(e.id)) continue;
        const tags = (e.tags || []).map(t => (t.label || '').toLowerCase());
        if (tags.some(t => t.includes('esports') || t.includes('league of legends') || t.includes('dota'))) continue;
        // Must match this sport's tags — prevents cross-sport pollution
        const matchesSport = cfg.matchTags.some(mt => tags.some(t => t.includes(mt)));
        if (!matchesSport) continue;
        const ml = findMoneylineMarket(e);
        if (!ml) continue;
        const liq = ml.liquidityNum || 0;
        if (liq < 300) continue;
        let tokens = []; try { tokens = JSON.parse(ml.clobTokenIds || '[]'); } catch (_) {}
        if (tokens.length < 2) continue;
        seen.add(e.id);
        found.push({ matchId: String(e.id), sport: sport, title: e.title, conditionId: ml.conditionId, tokenA: tokens[0], tokenB: tokens[1], outcomeA: (JSON.parse(ml.outcomes||"[]")||[])[0]||"A", outcomeB: (JSON.parse(ml.outcomes||"[]")||[])[1]||"B", isLive: e.live === true, mlLiquidity: liq, discoveredAt: Date.now() });
        if (found.length >= 10) break;
      if (found.length === 0) {
        const all = await getJsonArray(GAMMA + '/events?closed=false&live=true&limit=50');
        for (const e of all) {
          if (!e || seen.has(e.id)) continue;
          const tags = (e.tags || []).map(t => (t.label || '').toLowerCase());
          if (tags.some(t => t.includes('esports') || t.includes('dota') || t.includes('league of legends'))) continue;
          const ttl = (e.title || '').toLowerCase();
          const matches = cfg.matchTags.some(mt => tags.some(t => t.includes(mt))) || cfg.matchTags.some(mt => ttl.includes(mt));
          if (!matches) continue;
          const ml = findMoneylineMarket(e);
          if (!ml) continue;
          const liq = ml.liquidityNum || 0; if (liq < 300) continue;
          let tokens = []; try { tokens = JSON.parse(ml.clobTokenIds || '[]'); } catch (_) {}
          if (tokens.length < 2) continue;
          found.push({ matchId: String(e.id), sport, title: e.title, conditionId: ml.conditionId, tokenA: tokens[0], tokenB: tokens[1], outcomeA: (JSON.parse(ml.outcomes||"[]")||[])[0]||"A", outcomeB: (JSON.parse(ml.outcomes||"[]")||[])[1]||"B", isLive: e.live === true, mlLiquidity: liq, discoveredAt: Date.now() });
          if (found.length >= 10) break;
        }
      }
      }
      for (const m of found) {
        if (!sportsDiscovery[sport]) sportsDiscovery[sport] = [];
        sportsDiscovery[sport].push(m);
        logFn(`🎯 [${cfg.label}] ${m.isLive ? '🔴' : '📅'} ${m.title} | ML $${fl2(m.mlLiquidity)}`);
      }
    } catch (e) { logFn(`⚠️ Sports discover [${sport}]: ${e.message}`); }
  }
}

async function pollSportsPrices() {
  const now = Date.now();
  for (const sport of Object.keys(sportsDiscovery)) {
    for (const m of (sportsDiscovery[sport] || [])) {
      try {
        const data = await getJson(GAMMA + '/events/' + m.matchId);
        if (data) {
          m.isLive = data.live === true;
          m.score = data.score || '';
          for (const mk of (data.markets || [])) {
            if (mk.conditionId === m.conditionId) {
              let prices = []; try { prices = JSON.parse(mk.outcomePrices || '[]').map(parseFloat); } catch (_) {}
              if (prices.length === 2 && prices[0] > 0 && prices[1] > 0) {
                priceBook[m.tokenA] = { bid: Math.max(0.001, prices[0]-0.01), ask: Math.min(0.999, prices[0]+0.01) };
                priceBook[m.tokenB] = { bid: Math.max(0.001, prices[1]-0.01), ask: Math.min(0.999, prices[1]+0.01) };
              }
            }
          }
        }
      } catch (_) {}
    }
  }
}

async function checkSportsEntries() {
  for (const [sport, cfg] of Object.entries(SPORTS_CFG)) {
    for (const m of (sportsDiscovery[sport] || [])) {
      try {
        const k = matchKey(m.matchId);
        const st = sportsState[sport];
        if (!st) continue;
        if (!st[k]) st[k] = { openPosition: null, priceHistory: [], entries: 0, wins: 0, losses: 0 };
        const md = st[k];
        if (md.openPosition) continue;
        if (!m.isLive) {
          // Skip non-live unless recent price movement
          if (!st[k].priceHistory || st[k].priceHistory.length < 3) continue;
          const latest = st[k].priceHistory[st[k].priceHistory.length - 1];
          if (latest.pA > 0.97 || latest.pB > 0.97) continue;
        }
        const pA = getPrice(m.tokenA), pB = getPrice(m.tokenB);
        if (!pA || !pB || pA <= 0 || pB <= 0) continue;
        const ph = st[k].priceHistory || [];
        if (ph.length < 2) {
          if (!st[k].priceHistory) st[k].priceHistory = [];
          st[k].priceHistory.push({ t: Date.now(), pA, pB });
          if (st[k].priceHistory.length > 500) st[k].priceHistory.splice(0, 100);
          continue;
        }
        if (!st[k].priceHistory) st[k].priceHistory = [];
        const last = st[k].priceHistory[st[k].priceHistory.length - 1];
        if (!last || Date.now() - last.t > 3000) {
          st[k].priceHistory.push({ t: Date.now(), pA, pB });
          if (st[k].priceHistory.length > 500) st[k].priceHistory.splice(0, 100);
        }

        // Fade signal
        let signal = null;
        if (pA >= cfg.threshold && pB <= (1 - cfg.threshold + 0.05)) signal = { buySide: 'B', entryPrice: pB, tokenId: m.tokenB, reason: 'A='+fl4(pA)+'→buy B' };
        else if (pB >= cfg.threshold && pA <= (1 - cfg.threshold + 0.05)) signal = { buySide: 'A', entryPrice: pA, tokenId: m.tokenA, reason: 'B='+fl4(pB)+'→buy A' };
        if (!signal) continue;

        // Check spread
        const sp = priceBook[signal.tokenId];
        const spread = sp && sp.ask > 0 && sp.bid > 0 ? (sp.ask - sp.bid) : 0.05;
        if (spread > 0.15) continue;

        const balance = st.balance;
        let betAmount = fl2(balance * cfg.maxBetPct);
        if (betAmount < 5) continue;

        // Fee: amount × feeRate × (1-p)
        const fRate = await getFeeRate(signal.tokenId);
        const entryFee = fl2(betAmount * fRate * (1 - signal.entryPrice));
        const totalCost = fl2(betAmount + entryFee);
        const shares = fl4(betAmount / signal.entryPrice);

        md.openPosition = {
          side: signal.buySide, tokenId: signal.tokenId, entryPrice: fl4(signal.entryPrice),
          amount: betAmount, shares, netOut: totalCost, feeRate: fRate,
          tpPrice: fl4(signal.entryPrice + cfg.tpSpread),
          stopPrice: fl4(signal.entryPrice - cfg.stopSpread), entryTime: Date.now(),
        };
        st.balance = fl2(st.balance - totalCost);
        st.totalFees = fl2(st.totalFees + entryFee);
        md.entries++;
        logFn(`📈 [${cfg.label}] ${m.title} | BUY ${signal.buySide} @ ${fl4(signal.entryPrice)} | $${betAmount} | ${signal.reason}`);
        if (!st.recentTrades) st.recentTrades = [];
        st.recentTrades.push({ type: 'ENTRY', side: signal.buySide.toUpperCase(), entryPrice: fl4(signal.entryPrice), name: signal.buySide==="A"?(pos.outcomeA||m.outcomeA||"A"):(pos.outcomeB||m.outcomeB||"B"), amount: betAmount, at: new Date().toISOString() });
        if (st.recentTrades.length > 30) st.recentTrades = st.recentTrades.slice(-30);
        saveSportsState(sport);
      } catch (e) { logFn(`⚠️ Sports entry [${sport}]: ${e.message}`); }
    }
  }
}

function manageSportsPositions() {
  for (const [sport, cfg] of Object.entries(SPORTS_CFG)) {
    for (const m of (sportsDiscovery[sport] || [])) {
      try {
        const k = matchKey(m.matchId);
        const st = sportsState[sport];
        if (!st || !st[k] || !st[k].openPosition) continue;
        const pos = st[k].openPosition;
        const cp = getPrice(pos.tokenId);
        if (!cp || cp <= 0) continue;
        const gross = fl4(pos.shares * cp);
        const rawPnl = fl4(gross - pos.netOut);
        const isResolved = false;
        let exitType = null;
        if (cp >= pos.tpPrice) exitType = 'TP';
        else if (cp <= pos.stopPrice) exitType = 'STOP';
        else if (Date.now() - pos.entryTime > 7200000) exitType = 'TIME';
        else continue;
        const xFee = exitType === 'TP' ? 0 : (pos.feeRate || 0.03);
        const exitFee = exitType === 'TP' ? 0 : fl4(pos.shares * xFee * cp * (1 - cp));
        const netProceeds = fl4(gross - exitFee);
        const actualPnl = fl4(rawPnl - exitFee);
        const won = actualPnl >= 0;
        st.balance = fl2(st.balance + netProceeds);
        st.totalPnl = fl4(st.totalPnl + actualPnl);
        st.totalFees = fl2(st.totalFees + exitFee);
        if (won) { st.wins++; st[k].wins++; } else { st.losses++; st[k].losses++; }
        logFn(`${won?'🟢':'🔴'} [${cfg.label}] ${m.title} | ${exitType} ${pos.side} @ ${fl4(cp)} | P&L ${actualPnl>=0?'+':''}$${actualPnl.toFixed(2)}`);
        if (!st.recentTrades) st.recentTrades = [];
        st.recentTrades.push({ type: exitType, side: pos.side.toUpperCase(), entryPrice: fl4(pos.entryPrice), exitPrice: fl4(cp), name: pos.side==="A"?(pos.outcomeA||m.outcomeA||"A"):(pos.outcomeB||m.outcomeB||"B"), amount: pos.amount, pnl: fl4(actualPnl), won, at: new Date().toISOString() });
        if (st.recentTrades.length > 30) st.recentTrades = st.recentTrades.slice(-30);
        st[k].openPosition = null;
        saveSportsState(sport);
      } catch (e) { logFn(`⚠️ Sports mgmt [${sport}]: ${e.message}`); }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════
// FIFA BOT — World Cup Cross-Market
// ═══════════════════════════════════════════════════════════════════════

let fifaMatches = [];
let lastFifaDiscovery = 0;

function freshFifaState(cfg) {
  return { balance: 2000, totalPnl: 0, totalFees: 0, wins: 0, losses: 0, trades: [], openPosition: null, fifaMarkets: null, lastEntryReason: null, priceHistory: [] };
}
function loadFifaState(cfg) {
  try {
    const f = path.join(__dirname, `state_fifa_${cfg.matchId}.json`);
    if (fs.existsSync(f)) { states[cfg.key] = JSON.parse(fs.readFileSync(f, 'utf8')); return; }
  } catch (_) {}
  states[cfg.key] = freshFifaState(cfg);
}
function saveFifaState(cfg) {
  try { fs.writeFileSync(path.join(__dirname, `state_fifa_${cfg.matchId}.json`), JSON.stringify(states[cfg.key], null, 2)); } catch (_) {}
}

const states = {};

async function discoverFifa() {
  try {
    const data = await getJsonArray(GAMMA + '/events?tag_id=102232&limit=30&closed=false');
    for (const e of data) {
      const slug = e.slug || '';
      if (!slug.includes('fifwc-') && !(e.title||'').toLowerCase().includes('world cup')) continue;
      const matchId = slug.split('-').slice(1,4).join('-') || ('wc-'+(e.id||'').slice(0,8));
      if (fifaMatches.some(m => m.cfg.matchId === matchId)) continue;
      if (e.ended || e.closed) continue;
      const dateMatch = slug.match(/(\d{4}-\d{2}-\d{2})$/);
      let recent = e.live === true;
      if (dateMatch) { const h = (new Date(dateMatch[1]+'T23:59:59Z').getTime()-Date.now())/3600000; if (h<48&&h>-12) recent=true; }
      if (!recent) continue;
      const subs = [];
      for (const m of (e.markets || [])) {
        if (!m.acceptingOrders || m.closed) continue;
        let outcomes = []; try { outcomes = JSON.parse(m.outcomes || '[]'); } catch (_) {}
        if (outcomes.length !== 2) continue;
        const parts = (m.slug||'').split('-');
        const sfx = parts[parts.length-1]||'';
        let id = sfx === 'draw' ? 'draw' : (sfx === parts[1] ? sfx : (sfx === parts[2] ? sfx : sfx));
        let ids = []; try { ids = JSON.parse(m.clobTokenIds||'[]'); } catch (_) {}
        subs.push({ id, slug: m.slug, conditionId: m.conditionId||'', tokenA: ids[0]||null, tokenB: ids[1]||null, labelA: outcomes[0], labelB: outcomes[1], liquidity: m.liquidityNum||0 });
      }
      if (subs.length < 3) continue;
      const cfg = {
        key: 'fifa-'+matchId, label: '⚽ '+(e.title||'?'), matchId, slug: e.slug||'', eventId: e.id||'',
        subMarkets: subs, baseBetPct: 0.10, tpPrice: 0.45, stopPrice: 0.03, spikeLookbackMs: 15000, spikeThreshold: 0.012, arbThreshold: 0.030,
        stateFile: path.join(__dirname, 'state_fifa_'+matchId+'.json'),
      };
      loadFifaState(cfg);
      fifaMatches.push({ cfg });
      logFn(`📺 FIFA: ${e.title} (${e.live?'LIVE':'upcoming'}) | ${subs.length} markets`);
    }
  } catch (e) { logFn(`⚠️ FIFA discover: ${e.message}`); }
}

async function refreshFifa() {
  for (const match of fifaMatches) {
    const { cfg } = match;
    const s = states[cfg.key];
    if (!s) continue;
    for (const sub of cfg.subMarkets) {
      if (sub.tokenA && sub.tokenB) continue;
      try {
        const data = await getJson(GAMMA + '/markets/slug/' + sub.slug);
        const mkt = data?.markets?.length ? (data.markets.find(m=>m.acceptingOrders!==false)??data.markets[0]) : data;
        if (!mkt) continue;
        let ids = mkt.clobTokenIds || mkt.clob_token_ids;
        if (typeof ids === 'string') { try { ids = JSON.parse(ids); } catch (_) {} }
        if (Array.isArray(ids) && ids.length >= 2) { sub.tokenA = ids[0]; sub.tokenB = ids[1]; }
        const prices = mkt.outcomePrices ? (typeof mkt.outcomePrices === 'string' ? JSON.parse(mkt.outcomePrices).map(parseFloat) : mkt.outcomePrices.map?mkt.outcomePrices.map(parseFloat):[]) : [];
        if (prices.length >= 2 && prices[0] > 0 && prices[1] > 0) {
          priceBook[ids[0]] = { bid: Math.max(0.001,prices[0]-0.01), ask: Math.min(0.999,prices[0]+0.01) };
          priceBook[ids[1]] = { bid: Math.max(0.001,prices[1]-0.01), ask: Math.min(0.999,prices[1]+0.01) };
        }
      } catch(_) {}
    }
    const tokens = [];
    for (const sub of cfg.subMarkets) { if (sub.tokenA) tokens.push(sub.tokenA); if (sub.tokenB) tokens.push(sub.tokenB); }
    await Promise.all(tokens.map(async tid => {
      try {
        const [ar, br] = await Promise.all([
          fetch(CLOB_REST+'/price?token_id='+tid+'&side=BUY', {timeout:3000}),
          fetch(CLOB_REST+'/price?token_id='+tid+'&side=SELL', {timeout:3000})
        ]);
        const ask = parseFloat((await ar.json()).price||0)||0;
        const bid = parseFloat((await br.json()).price||0)||0;
        if (ask>0||bid>0) priceBook[tid] = {bid,ask};
    // Log when match goes live (first non-zero prices)
    if (!match._loggedLive) {
      const livePrices = tokens.filter(t => getPrice(t) > 0.01).length;
      if (livePrices >= 3) { match._loggedLive = true; logFn(`🔴 ${cfg.label} GONE LIVE — prices detected`); }
    }
      } catch(_) {}
    }));
    s.fifaMarkets = cfg.subMarkets.map(sub => ({
      id: sub.id, priceA: sub.tokenA?fl4(getPrice(sub.tokenA)):0, priceB: sub.tokenB?fl4(getPrice(sub.tokenB)):0, liquidity: sub.liquidity,
    }));
    if (!s.priceHistory) s.priceHistory = [];
    const snap = { t: Date.now() };
    for (const sub of cfg.subMarkets) { if (sub.tokenA) snap[sub.id+'_A']=fl4(getPrice(sub.tokenA)); if (sub.tokenB) snap[sub.id+'_B']=fl4(getPrice(sub.tokenB)); }
    if (Object.keys(snap).length > 1) { s.priceHistory.push(snap); if (s.priceHistory.length>500) s.priceHistory.splice(0,100); }
  }
}

function fifaSignal(cfg, s) {
  if (!s.fifaMarkets || !s.priceHistory || s.priceHistory.length < 3) return null;
  if (s.openPosition) return null;
  const recent = s.priceHistory.filter(p => p.t > Date.now() - cfg.spikeLookbackMs);
  if (recent.length < 2) return null;
  const last = recent[recent.length-1];
  function gp(subId, side) { return last[subId+(side==='A'?'_A':'_B')]||0; }
  // Arb signal
  let totalP = 0, prices = [];
  for (const sub of cfg.subMarkets) { const p = gp(sub.id,'A'); if (p>0) { totalP += p; prices.push({id:sub.id,p}); } }
  if (prices.length >= 3 && Math.abs(totalP-1.0) > cfg.arbThreshold) {
    const cheapest = prices.reduce((a,b)=>a.p<b.p?a:b);
    const ep = cheapest.p;
    if (ep > 0.02 && ep < 0.40) {
      const tok = cfg.subMarkets.find(s=>s.id===cheapest.id);
      if (tok && tok.tokenA) return { side:'A', token:{token_id:tok.tokenA}, marketId:cheapest.id, entryPrice:ep, reason:'arb dev='+fl4(totalP-1.0)+' buy '+cheapest.id };
    }
  }
  // Spike fade
  const first = recent[0];
  for (const sub of cfg.subMarkets) {
    const now = gp(sub.id,'A'), then = first[sub.id+'_A']||0;
    if (then>0 && now>0 && Math.abs(now-then)>cfg.spikeThreshold && now>0.65) {
      const cp = gp(sub.id,'B');
      if (cp > 0.05 && cp < 0.40) return { side:'B', token:{token_id:sub.tokenB}, marketId:sub.id, entryPrice:cp, reason:'spike '+sub.id+'='+fl4(now)+' buy B' };
    }
  }
  return null;
}

async function fifaEntry() {
  for (const match of fifaMatches) {
    const { cfg } = match;
    const s = states[cfg.key];
    if (!s || s.openPosition) continue;
    const signal = fifaSignal(cfg, s);
    if (!signal) continue;
    const betAmount = fl2(s.balance * cfg.baseBetPct);
    if (betAmount < 5) continue;
    const fRate = await getFeeRate(signal.token?.token_id);
    const entryFee = fl4(betAmount * fRate * (1 - signal.entryPrice));
    const totalCost = fl4(betAmount + entryFee);
    const shares = fl4(betAmount / signal.entryPrice);
    s.openPosition = {
      side: signal.side, token: signal.token, entryPrice: fl4(signal.entryPrice),
      amount: betAmount, shares, netOut: totalCost, feeRate: fRate,
      marketId: signal.marketId, tpPrice: cfg.tpPrice, stopPrice: cfg.stopPrice, entryTime: Date.now(),
    };
    s.balance = subF(s.balance, totalCost);
    s.totalFees = addF(s.totalFees, entryFee);
    s.lastEntryReason = signal.reason;
    logFn(`📈 [${cfg.label}] ENTRY ${signal.side} on ${signal.marketId} @ ${fl4(signal.entryPrice)} | $${betAmount} | ${signal.reason}`);
    s.trades.push({ type:'ENTRY', side:signal.side.toUpperCase(), entryPrice:fl4(signal.entryPrice), amount:betAmount, at:new Date().toISOString() });
    saveFifaState(cfg);
  }
}

function fifaManage() {
  for (const match of fifaMatches) {
    const { cfg } = match;
    const s = states[cfg.key];
    if (!s || !s.openPosition) continue;
    const pos = s.openPosition;
    const cp = fl4(getPrice(pos.token ? pos.token.token_id||pos.token : 0));
    if (!cp || cp <= 0) continue;
    const gross = fl4(pos.shares * cp);
    const rawPnl = fl4(gross - pos.netOut);
    let exitType = null;
    if (cp >= pos.tpPrice) exitType = 'TP';
    else if (cp <= pos.stopPrice) exitType = 'STOP';
    else if (Date.now() - pos.entryTime > 7200000) exitType = 'TIME';
    else continue;
    const xFee = exitType === 'TP' ? 0 : (pos.feeRate || 0.03);
    const exitFee = exitType === 'TP' ? 0 : fl4(pos.shares * xFee * cp * (1 - cp));
    const netProceeds = fl4(gross - exitFee);
    const actualPnl = fl4(rawPnl - exitFee);
    const won = actualPnl >= 0;
    s.balance = addF(s.balance, netProceeds);
    s.totalPnl = fl4(s.totalPnl + actualPnl);
    s.totalFees = addF(s.totalFees, exitFee);
    if (won) s.wins++; else s.losses++;
    logFn(`${won?'🟢':'🔴'} [${cfg.label}] ${exitType} ${pos.side} @ ${fl4(cp)} | P&L ${actualPnl>=0?'+':''}$${actualPnl.toFixed(2)}`);
    s.trades.push({ type:exitType, side:pos.side.toUpperCase(), entryPrice:fl4(pos.entryPrice), exitPrice:fl4(cp), amount:pos.amount, pnl:fl4(actualPnl), won, at:new Date().toISOString() });
    if (s.trades.length > 100) s.trades = s.trades.slice(-100);
    s.openPosition = null;
    saveFifaState(cfg);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// CLOB INIT (real trading)
// ═══════════════════════════════════════════════════════════════════════
async function initClob() {
  if (clobClient) return clobClient;
  if (!PRIVATE_KEY) return null;
  try {
    const ethers = require('ethers');
    const { ClobClient, Chain } = require('@polymarket/clob-client-v2');
    const provider = new ethers.JsonRpcProvider('https://rpc-mainnet.matic.quiknode.pro', 137, { staticNetwork: true });
    const signer = new ethers.Wallet(PRIVATE_KEY, provider);
    const ws = { ...signer, _signTypedData: (d,t,v)=>signer.signTypedData(d,t,v), getAddress: async ()=>signer.getAddress() };
    const c = new ClobClient({ host: CLOB_REST, chain: Chain.POLYGON, signer: ws });
    try { await c.createOrDeriveApiKey(); logFn('🔑 API key ready'); } catch (_) {}
    clobClient = c;
    return c;
  } catch (e) { logFn(`⚠️ CLOB: ${e.message}`); return null; }
}

// ═══════════════════════════════════════════════════════════════════════
// SNAPSHOT
// ═══════════════════════════════════════════════════════════════════════
function buildSnapshot() {
  const snap = { sports: {}, fifaMatches: [] };
  for (const [sport, cfg] of Object.entries(SPORTS_CFG)) {
    const st = sportsState[sport] || { balance: cfg.capital, totalPnl: 0, totalFees: 0, wins: 0, losses: 0 };
    const matches = [];
    for (const m of (sportsDiscovery[sport] || [])) {
      const k = matchKey(m.matchId);
      const md = (st[k] || {});
      const pos = md.openPosition;
      const livePnl = pos ? fl4(pos.shares * getPrice(pos.tokenId) - pos.netOut) : null;
      matches.push({
        title: m.title, score: m.score || '', isLive: m.isLive,
        prices: [fl4(getPrice(m.tokenA)), fl4(getPrice(m.tokenB))],
        mlLiquidity: m.mlLiquidity,
        openPosition: pos ? { side: pos.side, entryPrice: pos.entryPrice, amount: pos.amount, tpPrice: pos.tpPrice, stopPrice: pos.stopPrice, currentPrice: fl4(getPrice(pos.tokenId)) } : null,
        livePnl,
      });
    }
    const tt = (st.wins || 0) + (st.losses || 0);
    snap.sports[sport] = {
      label: cfg.label, balance: fl2(st.balance || cfg.capital), totalPnl: fl4(st.totalPnl || 0), totalFees: fl4(st.totalFees || 0),
      wins: st.wins || 0, losses: st.losses || 0, winRate: tt > 0 ? fl4(st.wins/tt) : 0,
      recentTrades: (st.recentTrades || []).slice(-20), matches,
    };
  }
  for (const match of fifaMatches) {
    const { cfg } = match;
    const s = states[cfg.key];
    if (!s) continue;
    const pos = s.openPosition;
    let currentPrice = null, livePnl = null;
    if (pos) { currentPrice = fl4(getPrice(pos.token?pos.token.token_id||pos.token:0)); livePnl = fl4(pos.shares*currentPrice-pos.netOut); }
    const tt = (s.wins||0)+(s.losses||0);
    snap.fifaMatches.push({
      matchId: cfg.matchId, label: cfg.label, balance: fl2(s.balance||2000), totalPnl: fl4(s.totalPnl||0), totalFees: fl4(s.totalFees||0),
      wins: s.wins||0, losses: s.losses||0, winRate: tt>0?fl4(s.wins/tt):0,
      openPosition: pos?{side:pos.side, entryPrice:fl4(pos.entryPrice), amount:fl2(pos.amount), tpPrice:pos.tpPrice, stopPrice:pos.stopPrice}:null,
      currentPrice, livePnl, recentTrades: (s.trades||[]).slice(-20), fifaMarkets: s.fifaMarkets, lastEntryReason: s.lastEntryReason,
    });
  }
  return snap;
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN TICK
// ═══════════════════════════════════════════════════════════════════════
let tickCount = 0;

async function tick() {
  try {
    // Discover every 60s
    if (tickCount % 20 === 0) {
      await discoverSports();
      if (tickCount % 60 === 0) await discoverFifa();
    }

    // Poll prices
    await pollSportsPrices();
    await refreshFifa();

    // Trade
    checkSportsEntries().catch(()=>{});
    manageSportsPositions();
    await fifaEntry();
    fifaManage();

    // Heartbeat
    tickCount++;
    if (tickCount % 10 === 0) {
      const parts = [];
      for (const [sport, ms] of Object.entries(sportsDiscovery)) {
        const live = ms.filter(x => x.isLive).length;
        parts.push(`${sport}:${live}/${ms.length}`);
      }
      const balParts = Object.entries(sportsState).map(([s,st]) => `${s}=$${fl2(st.balance||0)}`);
      logFn(`💓 ${parts.join(' | ')} | ${balParts.join(' ')} | FIFA:${fifaMatches.length}`);
    }

    emitFn('snapshot', buildSnapshot());
  } catch (e) {
    logFn(`⚠️ Tick: ${e.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════════════
async function start(emit, logEmit) {
  emitFn = emit;
  logFn = logEmit;
  await initClob();
  loadSportsState();
  for (const [sport, cfg] of Object.entries(SPORTS_CFG)) {
    const st = sportsState[sport];
    logFn(`✅ ${cfg.label}: $${fl2(st.balance)} | W${st.wins}/L${st.losses}`);
  }
  logFn(`🚀 Polymarket Bot | Sports + FIFA`);
  await discoverSports();
  await discoverFifa();
  await pollSportsPrices();
  await refreshFifa();
  setTimeout(tick, 2000);
  setInterval(tick, 3000);
}

module.exports = { start, buildSnapshot };
