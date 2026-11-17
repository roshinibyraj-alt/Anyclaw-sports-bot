'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { findEventMarket } = require('../src/polymarket');

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
