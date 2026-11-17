'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PaperCopier, sweepBook } = require('../src/paper-copier');

function state() {
  return {
    sourceWallet: '0x0000000000000000000000000000000000000001',
    sourceTrades: [],
    paper: {
      startingBalance: 100,
      cash: 100,
      realizedPnl: 0,
      positions: {},
      settlements: [],
      feeStatus: 'waiting',
      paused: false,
      multiplier: 1,
      copyStats: { total: 0, filled: 0, partial: 0, missed: 0, paused: 0, skipped: 0 },
    },
    copyEvents: [],
  };
}

test('sweeps asks across levels and computes weighted average fill price', () => {
  const fill = sweepBook([
    { price: 0.42, size: 10 },
    { price: 0.4, size: 3 },
  ], 5, 'BUY', 100, null);
  assert.equal(fill.filledShares, 5);
  assert.equal(fill.grossValue, 2.04);
  assert.equal(fill.averagePrice, 0.408);
});

test('uses Polymarket fee curve when a base fee is available', () => {
  const fill = sweepBook([{ price: 0.5, size: 100 }], 100, 'BUY', 100, 0.07);
  assert.equal(fill.fees, 1.75);
  assert.equal(fill.netValue, 51.75);
});

test('paper copier mirrors buys, limits sells to held shares, and realizes net PnL', async () => {
  const ledger = state();
  const copier = new PaperCopier(ledger, {
    fetchBook: async () => ({
      asks: [{ price: 0.4, size: 10 }],
      bids: [{ price: 0.5, size: 10 }],
    }),
    fetchFeeRate: async () => ({ rate: 0.07, status: 'estimated' }),
    fetchMarket: async () => null,
  });
  const source = {
    id: 'buy-1',
    timestamp: 1000,
    conditionId: 'market',
    tokenId: 'token',
    slug: 'btc-updown-5m-1000',
    title: 'Bitcoin Up or Down',
    outcome: 'Up',
    side: 'BUY',
    price: 0.39,
    size: 5,
  };

  const buy = await copier.mirror(source);
  assert.equal(buy.status, 'filled');
  assert.equal(ledger.paper.positions.token.shares, 5);
  assert.ok(ledger.paper.cash < 98);

  const sell = await copier.mirror({ ...source, id: 'sell-1', side: 'SELL', price: 0.5, size: 8 });
  assert.equal(sell.requestedShares, 8);
  assert.equal(sell.filledShares, 5);
  assert.equal(sell.status, 'partial');
  assert.equal(ledger.paper.positions.token.shares, 0);
  assert.equal(ledger.paper.positions.token.status, 'sold');
  assert.ok(ledger.paper.realizedPnl > 0);
  assert.equal(ledger.paper.copyStats.total, 2);
  assert.equal(ledger.paper.copyStats.filled, 1);
  assert.equal(ledger.paper.copyStats.partial, 1);
});

test('paper copier does not create a position when visible depth is missing', async () => {
  const ledger = state();
  const copier = new PaperCopier(ledger, {
    fetchBook: async () => ({ asks: [], bids: [] }),
    fetchFeeRate: async () => ({ rate: null, status: 'unavailable' }),
    fetchMarket: async () => null,
  });
  const result = await copier.mirror({
    id: 'buy-2', timestamp: 1000, conditionId: 'market', tokenId: 'token',
    slug: 'btc-updown-5m-1000', title: 'Bitcoin Up or Down', outcome: 'Up',
    side: 'BUY', price: 0.4, size: 5,
  });
  assert.equal(result.status, 'missed');
  assert.equal(ledger.paper.cash, 100);
  assert.equal(Object.keys(ledger.paper.positions).length, 0);
});

test('reports insufficient cash separately from an empty order book', async () => {
  const ledger = state();
  ledger.paper.cash = 0;
  const copier = new PaperCopier(ledger, {
    fetchBook: async () => ({
      asks: [{ price: 0.4, size: 10 }],
      bids: [],
    }),
    fetchFeeRate: async () => ({ rate: null, status: 'unavailable' }),
    fetchMarket: async () => null,
  });

  const result = await copier.mirror({
    id: 'buy-no-cash', timestamp: 1000, conditionId: 'market', tokenId: 'token',
    slug: 'btc-updown-5m-1000', title: 'Bitcoin Up or Down', outcome: 'Up',
    side: 'BUY', price: 0.4, size: 5,
  });

  assert.equal(result.status, 'missed');
  assert.match(result.message, /Insufficient paper cash/);
  assert.doesNotMatch(result.message, /No visible ask liquidity/);
  assert.equal(ledger.paper.cash, 0);
});

test('official market resolution pays the indexed winner and zeros the loser', async () => {
  const ledger = state();
  ledger.paper.cash = 96;
  ledger.sourceTrades.push({
    tokenId: 'token',
    conditionId: 'market',
    outcome: 'Up',
    outcomeIndex: 0,
  }, {
    tokenId: 'down-token',
    conditionId: 'market',
    outcome: 'Down',
    outcomeIndex: 1,
  });
  ledger.paper.positions.token = {
    tokenId: 'token',
    conditionId: 'market',
    slug: 'btc-updown-5m-1000',
    title: 'Bitcoin Up or Down',
    asset: 'BTC',
    outcome: 'Up',
    outcomeIndex: undefined,
    shares: 10,
    costBasis: 4,
    averageCost: 0.4,
    markBid: 0.99,
    status: 'open',
  };
  ledger.paper.positions['down-token'] = {
    tokenId: 'down-token',
    conditionId: 'market',
    slug: 'btc-updown-5m-1000',
    title: 'Bitcoin Up or Down',
    asset: 'BTC',
    outcome: 'Down',
    outcomeIndex: 1,
    shares: 5,
    costBasis: 3,
    averageCost: 0.6,
    markBid: 0.01,
    status: 'open',
  };
  const copier = new PaperCopier(ledger, {
    fetchBook: async () => ({ asks: [], bids: [] }),
    fetchFeeRate: async () => ({ rate: null, status: 'unavailable' }),
    fetchMarket: async () => { throw new Error('Should not need a slug lookup.'); },
    fetchResolutions: async conditionIds => {
      assert.deepEqual(conditionIds, ['market']);
      return [{
        condition_id: 'MARKET',
        status: 'resolved',
        payouts: [1000000, 0],
      }];
    },
  });

  await copier.refreshMarksAndSettle();

  assert.equal(ledger.paper.cash, 106);
  assert.equal(ledger.paper.realizedPnl, 3);
  assert.equal(ledger.paper.positions.token.status, 'resolved');
  assert.equal(ledger.paper.positions.token.shares, 0);
  assert.equal(ledger.paper.positions.token.resolvedOutcome, 'Up');
  assert.equal(ledger.paper.positions['down-token'].status, 'resolved');
  assert.equal(ledger.paper.positions['down-token'].resolvedOutcome, 'Up');
  assert.equal(ledger.paper.settlements[0].shares, 5);
  assert.equal(ledger.paper.settlements[0].payout, 0);
  assert.equal(ledger.paper.settlements[0].pnl, -3);
  assert.equal(ledger.paper.settlements[1].shares, 10);
  assert.equal(ledger.paper.settlements[1].payout, 10);
  assert.equal(ledger.paper.settlements[1].pnl, 6);
});
