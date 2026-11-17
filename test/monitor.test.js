'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WalletMonitor } = require('../src/monitor');

test('dashboard snapshot retains per-market settled share boxes', () => {
  const state = {
    sourceWallet: '0x0000000000000000000000000000000000000001',
    baselineLoaded: true,
    sourceTrades: [],
    sourceTradeCount: 0,
    seenTradeIds: [],
    copyEvents: [],
    watcher: { status: 'connected' },
    paper: {
      startingBalance: 100,
      cash: 106,
      realizedPnl: 6,
      positions: {
        resolvedToken: {
          tokenId: 'resolvedToken',
          conditionId: 'market',
          slug: 'btc-updown-5m-1000',
          title: 'Bitcoin Up or Down',
          asset: 'BTC',
          outcome: 'Up',
          shares: 0,
          costBasis: 0,
          status: 'resolved',
          settlementValue: 10,
          settlementPnl: 6,
        },
      },
      settlements: [{
        tokenId: 'resolvedToken',
        conditionId: 'market',
        slug: 'btc-updown-5m-1000',
        marketTitle: 'Bitcoin Up or Down',
        asset: 'BTC',
        outcome: 'Up',
        winningOutcome: 'Up',
        shares: 10,
        costBasis: 4,
        payout: 10,
        pnl: 6,
        settledAt: '2026-11-17T00:00:00.000Z',
      }],
      copyStats: { total: 0, filled: 0, partial: 0, missed: 0 },
      multiplier: 1,
      paused: false,
      feeStatus: 'estimated',
    },
  };
  const monitor = new WalletMonitor({
    state,
    saveState: () => {},
    dependencies: {},
  });

  const snapshot = monitor.buildSnapshot();
  const market = snapshot.markets.find(item => item.slug === 'btc-updown-5m-1000');

  assert.equal(market.status, 'resolved');
  assert.equal(market.up.shares, 10);
  assert.equal(market.up.marketValue, 10);
  assert.equal(market.up.unrealizedPnl, 6);
  assert.equal(snapshot.summary.paperBalance, 106);
  assert.equal(snapshot.summary.settledPositions, 1);
});
