'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findEventMarket, normalizeTrade } = require('../src/polymarket');

test('finds the nested market returned by Gamma event lookup', () => {
  const market = {
    slug: 'btc-updown-5m-1000',
    closed: true,
    outcomes: '["Up","Down"]',
    outcomePrices: '["1","0"]',
  };

  assert.equal(findEventMarket([
    { slug: 'btc-updown-5m-1000', markets: [market] },
  ], 'btc-updown-5m-1000'), market);
});

test('finds a nested market when Gamma encodes event markets as JSON', () => {
  const market = { slug: 'eth-updown-5m-1300', closed: false };
  assert.deepEqual(findEventMarket({
    slug: 'eth-updown-5m-1300',
    markets: JSON.stringify([market]),
  }, 'eth-updown-5m-1300'), market);
});

test('does not mistake an unrelated event market for a settlement', () => {
  assert.equal(findEventMarket([
    { slug: 'another-market', markets: [{ slug: 'another-market' }] },
  ], 'btc-updown-5m-1000'), null);
});

test('keeps a missing outcome index unknown instead of treating it as UP', () => {
  const trade = normalizeTrade({
    timestamp: 1000,
    price: 0.4,
    size: 2,
    outcome_index: null,
    side: 'BUY',
  });
  assert.equal(trade.outcomeIndex, null);
});

test('preserves explicit outcome index zero from the source trade', () => {
  const trade = normalizeTrade({
    timestamp: 1000,
    price: 0.4,
    size: 2,
    outcome_index: 0,
    side: 'BUY',
  });
  assert.equal(trade.outcomeIndex, 0);
});
