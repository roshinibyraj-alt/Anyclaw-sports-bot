'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeTrades, classifyAsset, marketTiming } = require('../src/strategy-engine');

test('classifies supported crypto symbols and keeps unknown markets', () => {
  assert.equal(classifyAsset('Bitcoin Up or Down', 'btc-updown-5m-1000'), 'BTC');
  assert.equal(classifyAsset('Ethereum Up or Down', ''), 'ETH');
  assert.equal(classifyAsset('BNB Up or Down', ''), 'BNB');
  assert.equal(classifyAsset('Hyperliquid Up or Down', ''), 'HYPE');
  assert.equal(classifyAsset('Unlisted event', 'some-market'), 'OTHER');
});

test('derives elapsed time from window slug when available', () => {
  assert.deepEqual(marketTiming('btc-updown-5m-1000000000', 1000000115), {
    durationSeconds: 300,
    secondsIntoMarket: 115,
    secondsRemaining: 185,
  });
  assert.equal(marketTiming('random-market', 1000000115).secondsIntoMarket, null);
});

test('describes repeated two-outcome buys without treating them as proven intent', () => {
  const trades = [
    { id: 'a', type: 'TRADE', conditionId: 'market-1', slug: 'btc-updown-5m-1000', title: 'Bitcoin Up or Down', tokenId: 'u', side: 'BUY', outcome: 'Up', timestamp: 1001, price: 0.4, size: 10 },
    { id: 'b', type: 'TRADE', conditionId: 'market-1', slug: 'btc-updown-5m-1000', title: 'Bitcoin Up or Down', tokenId: 'u', side: 'BUY', outcome: 'Up', timestamp: 1002, price: 0.35, size: 12 },
    { id: 'c', type: 'TRADE', conditionId: 'market-1', slug: 'btc-updown-5m-1000', title: 'Bitcoin Up or Down', tokenId: 'd', side: 'BUY', outcome: 'Down', timestamp: 1003, price: 0.6, size: 8 },
    { id: 'd', type: 'TRADE', conditionId: 'market-1', slug: 'btc-updown-5m-1000', title: 'Bitcoin Up or Down', tokenId: 'd', side: 'BUY', outcome: 'Down', timestamp: 1004, price: 0.65, size: 9 },
    { id: 'e', type: 'TRADE', conditionId: 'market-1', slug: 'btc-updown-5m-1000', title: 'Bitcoin Up or Down', tokenId: 'd', side: 'BUY', outcome: 'Down', timestamp: 1005, price: 0.7, size: 10 },
  ];
  const result = analyzeTrades(trades);
  assert.equal(result.sampleTrades, 5);
  assert.equal(result.sampleMarkets, 1);
  assert.ok(result.patterns.some(pattern => pattern.key === 'two-sided-accumulation'));
  assert.ok(result.patterns.some(pattern => pattern.key === 'repeat-adds'));
  assert.ok(result.limitations.some(text => text.includes('why the wallet traded')));
});
