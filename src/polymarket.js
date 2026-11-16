'use strict';

const DATA_API = 'https://data-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';

async function fetchJson(url, timeoutMs = 7000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'paper-wallet-observer/1.0' },
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`Polymarket API returned HTTP ${response.status}`);
      error.status = response.status;
      error.body = text.slice(0, 400);
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Polymarket API returned invalid JSON.');
    }
  } finally {
    clearTimeout(timer);
  }
}

async function fetchActivityPage(wallet, cursor) {
  const query = new URLSearchParams({
    user: wallet,
    limit: '1000',
    type: 'TRADE',
  });
  if (cursor) query.set('cursor', cursor);
  const payload = await fetchJson(`${DATA_API}/v2/activity?${query}`);
  if (!payload || !Array.isArray(payload.data) || !payload.pagination) {
    throw new Error('Polymarket activity response is missing its data or pagination envelope.');
  }
  return payload;
}

async function fetchRecentActivity(wallet, knownIds = new Set(), maxPages = 5) {
  const all = [];
  let cursor;
  let pageCount = 0;
  let foundKnown = false;

  do {
    const payload = await fetchActivityPage(wallet, cursor);
    pageCount += 1;
    const rows = payload.data.filter(row => row && row.type === 'TRADE');
    all.push(...rows);
    foundKnown = rows.some(row => knownIds.has(tradeId(row)));
    cursor = payload.pagination.has_more ? payload.pagination.next_cursor : null;
    if (foundKnown || !cursor || pageCount >= maxPages) break;
  } while (cursor);

  return { rows: all, pages: pageCount };
}

function tradeId(row) {
  return [
    row.transaction_hash || 'no-tx',
    row.condition_id || 'no-condition',
    row.token_id || 'no-token',
    row.side || 'no-side',
    row.timestamp ?? 'no-time',
    row.price ?? 'no-price',
    row.size ?? 'no-size',
    row.outcome_index ?? 'no-outcome',
  ].join(':').toLowerCase();
}

function normalizeTrade(row) {
  const timestamp = Number(row.timestamp);
  const price = Number(row.price);
  const size = Number(row.size);
  return {
    id: tradeId(row),
    type: 'TRADE',
    transactionHash: row.transaction_hash || null,
    conditionId: row.condition_id || null,
    tokenId: row.token_id || null,
    slug: row.slug || row.event_slug || null,
    eventSlug: row.event_slug || null,
    title: row.title || row.slug || 'Untitled market',
    outcome: row.outcome || 'Unknown',
    outcomeIndex: Number.isFinite(Number(row.outcome_index)) ? Number(row.outcome_index) : null,
    side: String(row.side || '').toUpperCase(),
    timestamp: Number.isFinite(timestamp) ? timestamp : Math.floor(Date.now() / 1000),
    price: Number.isFinite(price) ? price : null,
    size: Number.isFinite(size) ? size : 0,
    usdcSize: Number.isFinite(Number(row.usdc_size)) ? Number(row.usdc_size) : null,
  };
}

async function fetchBook(tokenId) {
  if (!tokenId) throw new Error('A token ID is required to read the order book.');
  const payload = await fetchJson(`${CLOB_API}/book?token_id=${encodeURIComponent(tokenId)}`);
  const normalize = levels => (Array.isArray(levels) ? levels : [])
    .map(level => ({ price: Number(level.price), size: Number(level.size) }))
    .filter(level => Number.isFinite(level.price) && level.price > 0 && level.price < 1 &&
      Number.isFinite(level.size) && level.size > 0);
  return {
    asks: normalize(payload.asks).sort((a, b) => a.price - b.price),
    bids: normalize(payload.bids).sort((a, b) => b.price - a.price),
    timestamp: Date.now(),
  };
}

async function fetchFeeRate(tokenId) {
  if (!tokenId) return { rate: null, status: 'unavailable' };
  const payload = await fetchJson(`${CLOB_API}/fee-rate?token_id=${encodeURIComponent(tokenId)}`);
  const baseFee = Number(payload.base_fee);
  if (!Number.isFinite(baseFee) || baseFee < 0) return { rate: null, status: 'unavailable' };
  return { rate: baseFee / 10000, status: baseFee === 0 ? 'fee-free' : 'estimated' };
}

async function fetchMarket(slug) {
  if (!slug) return null;
  const payload = await fetchJson(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`);
  if (Array.isArray(payload)) return payload[0] || null;
  return payload && typeof payload === 'object' ? payload : null;
}

module.exports = {
  fetchActivityPage,
  fetchRecentActivity,
  fetchBook,
  fetchFeeRate,
  fetchMarket,
  normalizeTrade,
  tradeId,
};
