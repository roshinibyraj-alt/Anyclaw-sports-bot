'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { groupMarketPositions } = require('../src/market-positions');

test('keeps UP and DOWN shares together only within their own market', () => {
  const grouped = groupMarketPositions([
    {
      conditionId: 'market-a', slug: 'btc-updown-5m-1000', marketTitle: 'BTC window A',
      asset: 'BTC', outcome: 'Up', status: 'open', shares: 10, costBasis: 4,
      marketValue: 5, markBid: 0.5, unrealizedPnl: 1,
    },
    {
      conditionId: 'market-a', slug: 'btc-updown-5m-1000', marketTitle: 'BTC window A',
      asset: 'BTC', outcome: 'Down', status: 'open', shares: 8, costBasis: 2,
      marketValue: 1.6, markBid: 0.2, unrealizedPnl: -0.4,
    },
    {
      conditionId: 'market-b', slug: 'btc-updown-5m-1300', marketTitle: 'BTC window B',
      asset: 'BTC', outcome: 'Up', status: 'open', shares: 3, costBasis: 1.5,
      marketValue: 1.8, markBid: 0.6, unrealizedPnl: 0.3,
    },
  ]);

  assert.equal(grouped.length, 2);
  const windowA = grouped.find(market => market.conditionId === 'market-a');
  const windowB = grouped.find(market => market.conditionId === 'market-b');
  assert.equal(windowA.up.shares, 10);
  assert.equal(windowA.down.shares, 8);
  assert.equal(windowA.up.averageCost, 0.4);
  assert.equal(windowA.up.unrealizedPnl, 1);
  assert.equal(windowB.up.shares, 3);
  assert.equal(windowB.down.shares, 0);
  assert.equal(windowB.down.markBid, null);
});

test('does not report an incomplete mark as zero P&L', () => {
  const [market] = groupMarketPositions([{
    conditionId: 'market-c', outcome: 'Down', status: 'open', shares: 5,
    costBasis: 2, marketValue: null, markBid: null, unrealizedPnl: null,
  }]);

  assert.equal(market.down.shares, 5);
  assert.equal(market.down.averageCost, 0.4);
  assert.equal(market.down.marketValue, null);
  assert.equal(market.down.unrealizedPnl, null);
});
