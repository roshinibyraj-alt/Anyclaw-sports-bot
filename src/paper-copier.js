'use strict';

const { classifyAsset } = require('./strategy-engine');

const MAX_COPY_EVENTS = 2000;

function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}

function sweepBook(levels, requestedShares, side, cashAvailable = Infinity, feeRate = null) {
  const buy = side === 'BUY';
  const sorted = [...(levels || [])]
    .filter(level => Number(level.price) > 0 && Number(level.price) < 1 && Number(level.size) > 0)
    .sort((a, b) => buy ? a.price - b.price : b.price - a.price);
  let remaining = Math.max(0, requestedShares);
  let cashLeft = cashAvailable;
  let shares = 0;
  let gross = 0;
  let fees = 0;
  const fills = [];

  for (const level of sorted) {
    if (remaining <= 0) break;
    const price = Number(level.price);
    const feePerShare = feeRate === null ? 0 : feeRate * price * (1 - price);
    const affordable = buy
      ? cashLeft / Math.max(0.00000001, price + feePerShare)
      : Infinity;
    const quantity = Math.min(remaining, Number(level.size), affordable);
    if (quantity <= 0) continue;
    const value = quantity * price;
    const levelFee = quantity * feePerShare;
    shares += quantity;
    gross += value;
    fees += levelFee;
    cashLeft -= buy ? value + levelFee : 0;
    remaining -= quantity;
    fills.push({ price, shares: round(quantity), value: round(value), fee: round(levelFee) });
  }

  return {
    requestedShares: round(requestedShares),
    filledShares: round(shares),
    remainingShares: round(Math.max(0, requestedShares - shares)),
    grossValue: round(gross, 8),
    fees: round(fees, 8),
    netValue: round(buy ? gross + fees : gross - fees, 8),
    averagePrice: shares > 0 ? round(gross / shares, 6) : null,
    fills,
  };
}

function createCopyEvent(source, result) {
  return {
    id: `${source.id}:copy`,
    sourceId: source.id,
    sourceTimestamp: source.timestamp,
    processedAt: Math.floor(Date.now() / 1000),
    conditionId: source.conditionId,
    tokenId: source.tokenId,
    slug: source.slug,
    marketTitle: source.title,
    asset: classifyAsset(source.title, source.slug),
    outcome: source.outcome,
    side: source.side,
    sourcePrice: source.price,
    sourceSize: source.size,
    requestedShares: result.requestedShares,
    filledShares: result.filledShares,
    averagePrice: result.averagePrice,
    grossValue: result.grossValue,
    estimatedFees: result.fees,
    feeStatus: result.feeStatus,
    remainingShares: result.remainingShares,
    lagMs: Math.max(0, (result.processedAtMs || Date.now()) - source.timestamp * 1000),
    status: result.status,
    message: result.message || '',
  };
}

class PaperCopier {
  constructor(state, dependencies) {
    this.state = state;
    this.fetchBook = dependencies.fetchBook;
    this.fetchFeeRate = dependencies.fetchFeeRate;
    this.fetchMarket = dependencies.fetchMarket;
    this.bookCache = new Map();
    this.feeCache = new Map();
  }

  async getBook(tokenId, maxAgeMs = 250) {
    const cached = this.bookCache.get(tokenId);
    if (cached && Date.now() - cached.timestamp < maxAgeMs) return cached.value;
    const value = await this.fetchBook(tokenId);
    this.bookCache.set(tokenId, { value, timestamp: Date.now() });
    return value;
  }

  async getFeeRate(tokenId) {
    if (!this.feeCache.has(tokenId)) {
      const promise = this.fetchFeeRate(tokenId).catch(() => ({ rate: null, status: 'unavailable' }));
      this.feeCache.set(tokenId, promise);
    }
    return this.feeCache.get(tokenId);
  }

  addEvent(event) {
    this.state.copyEvents.unshift(event);
    if (this.state.copyEvents.length > MAX_COPY_EVENTS) {
      this.state.copyEvents.length = MAX_COPY_EVENTS;
    }
    const stats = this.state.paper.copyStats;
    stats.total += 1;
    if (Object.prototype.hasOwnProperty.call(stats, event.status)) stats[event.status] += 1;
  }

  updateFeeStatus(status) {
    if (status === 'unavailable') {
      this.state.paper.feeStatus = 'partial';
    } else if (status === 'estimated' && this.state.paper.feeStatus !== 'partial') {
      this.state.paper.feeStatus = 'estimated';
    } else if (status === 'fee-free' && this.state.paper.feeStatus === 'waiting') {
      this.state.paper.feeStatus = 'fee-free';
    }
  }

  async mirror(source) {
    const processedAtMs = Date.now();
    const multiplier = Number(this.state.paper.multiplier) || 1;
    if (this.state.paper.paused) {
      const event = createCopyEvent(source, {
        requestedShares: source.size * multiplier,
        filledShares: 0,
        averagePrice: null,
        grossValue: 0,
        fees: 0,
        feeStatus: 'not-run',
        remainingShares: source.size * multiplier,
        processedAtMs,
        status: 'paused',
        message: 'Paper copier is paused.',
      });
      this.addEvent(event);
      return event;
    }

    if (!source.tokenId || !['BUY', 'SELL'].includes(source.side) || source.size <= 0) {
      const event = createCopyEvent(source, {
        requestedShares: Math.max(0, source.size * multiplier),
        filledShares: 0,
        averagePrice: null,
        grossValue: 0,
        fees: 0,
        feeStatus: 'not-run',
        remainingShares: Math.max(0, source.size * multiplier),
        processedAtMs,
        status: 'skipped',
        message: 'Trade is missing a token, side, or valid size.',
      });
      this.addEvent(event);
      return event;
    }

    const requested = round(source.size * multiplier);
    const position = this.state.paper.positions[source.tokenId] || null;
    const requestedToExecute = source.side === 'SELL'
      ? Math.min(requested, position ? position.shares : 0)
      : requested;

    if (requestedToExecute <= 0) {
      const event = createCopyEvent(source, {
        requestedShares: requested,
        filledShares: 0,
        averagePrice: null,
        grossValue: 0,
        fees: 0,
        feeStatus: 'not-run',
        remainingShares: requested,
        processedAtMs,
        status: 'missed',
        message: source.side === 'SELL'
          ? 'No matching paper shares are held to sell.'
          : 'No shares were requested.',
      });
      this.addEvent(event);
      return event;
    }

    try {
      const [book, fee] = await Promise.all([
        this.getBook(source.tokenId),
        this.getFeeRate(source.tokenId),
      ]);
      const levels = source.side === 'BUY' ? book.asks : book.bids;
      const cash = source.side === 'BUY' ? this.state.paper.cash : Infinity;
      const result = sweepBook(levels, requestedToExecute, source.side, cash, fee.rate);
      result.feeStatus = fee.status;
      result.processedAtMs = processedAtMs;
      result.requestedShares = requested;

      if (result.filledShares > 0) {
        if (source.side === 'BUY') this.applyBuy(source, result);
        else this.applySell(source, result);
      }

      const event = createCopyEvent(source, {
        ...result,
        requestedShares: requested,
        remainingShares: round(requested - result.filledShares),
        processedAtMs,
        status: result.filledShares <= 0
          ? 'missed'
          : requested - result.filledShares > 0.000001
            ? 'partial'
            : 'filled',
        message: result.filledShares <= 0
          ? `No visible ${source.side === 'BUY' ? 'ask' : 'bid'} liquidity at copy time.`
          : requested - result.filledShares > 0.000001
            ? source.side === 'SELL' && requestedToExecute < requested
              ? 'Paper inventory was smaller than the source sell; only held shares could be simulated.'
              : 'Visible book depth or paper cash filled only part of the copied size.'
            : '',
      });
      this.addEvent(event);
      return event;
    } catch (error) {
      const event = createCopyEvent(source, {
        requestedShares: requested,
        filledShares: 0,
        averagePrice: null,
        grossValue: 0,
        fees: 0,
        feeStatus: 'unavailable',
        remainingShares: requested,
        processedAtMs,
        status: 'missed',
        message: error.message || 'Could not read the public order book.',
      });
      this.addEvent(event);
      return event;
    }
  }

  applyBuy(source, fill) {
    const position = this.state.paper.positions[source.tokenId] || {
      tokenId: source.tokenId,
      conditionId: source.conditionId,
      slug: source.slug,
      title: source.title,
      asset: classifyAsset(source.title, source.slug),
      outcome: source.outcome,
      shares: 0,
      costBasis: 0,
      averageCost: 0,
      markBid: null,
      status: 'open',
    };
    position.shares = round(position.shares + fill.filledShares);
    position.costBasis = round(position.costBasis + fill.grossValue + fill.fees, 8);
    position.averageCost = round(position.costBasis / position.shares, 6);
    position.updatedAt = new Date().toISOString();
    this.state.paper.cash = round(this.state.paper.cash - fill.netValue, 8);
    this.state.paper.positions[source.tokenId] = position;
    this.updateFeeStatus(fill.feeStatus);
  }

  applySell(source, fill) {
    const position = this.state.paper.positions[source.tokenId];
    if (!position || position.shares <= 0) return;
    const sold = Math.min(fill.filledShares, position.shares);
    const allocatedCost = position.costBasis * (sold / position.shares);
    const netProceeds = fill.grossValue - fill.fees;
    position.shares = round(position.shares - sold);
    position.costBasis = round(Math.max(0, position.costBasis - allocatedCost), 8);
    position.averageCost = position.shares > 0
      ? round(position.costBasis / position.shares, 6)
      : 0;
    position.updatedAt = new Date().toISOString();
    this.state.paper.cash = round(this.state.paper.cash + netProceeds, 8);
    this.state.paper.realizedPnl = round(
      this.state.paper.realizedPnl + netProceeds - allocatedCost,
      8,
    );
    if (position.shares <= 0.000001) {
      position.shares = 0;
      position.costBasis = 0;
      position.status = 'sold';
      position.closedAt = new Date().toISOString();
    }
    this.updateFeeStatus(fill.feeStatus);
  }

  async refreshMarksAndSettle() {
    const open = Object.values(this.state.paper.positions).filter(p => p.status === 'open' && p.shares > 0);
    const groups = new Map();
    for (const position of open) {
      const groupKey = position.conditionId || position.slug || position.tokenId;
      const group = groups.get(groupKey) || { slug: position.slug, positions: [] };
      group.positions.push(position);
      groups.set(groupKey, group);
    }

    const work = [];
    for (const position of open) {
      work.push(async () => {
        try {
          const book = await this.getBook(position.tokenId, 1000);
          if (book.bids[0]) position.markBid = book.bids[0].price;
          position.lastMarkedAt = new Date().toISOString();
        } catch (error) {
          position.markError = error.message;
        }
      });
    }
    for (const group of groups.values()) {
      if (!group.slug) continue;
      work.push(async () => {
        try {
          const market = await this.fetchMarket(group.slug);
          if (market) this.trySettleGroup(group, market);
        } catch (error) {
          for (const position of group.positions) position.resolutionError = error.message;
        }
      });
    }
    await runWithConcurrency(work, 6);
  }

  trySettleGroup(group, market) {
    const outcomes = parseArray(market.outcomes);
    const prices = parseArray(market.outcomePrices).map(Number);
    const closed = market.closed === true || market.resolved === true ||
      String(market.closed).toLowerCase() === 'true' ||
      String(market.resolved).toLowerCase() === 'true';
    if (!closed || !outcomes.length || outcomes.length !== prices.length) return;
    const winnerIndex = prices.findIndex(price => Number.isFinite(price) && price >= 0.99);
    if (winnerIndex < 0) return;
    const winningOutcome = String(outcomes[winnerIndex]).toLowerCase();
    for (const position of group.positions) {
      if (position.status !== 'open') continue;
      const payout = String(position.outcome).toLowerCase() === winningOutcome ? position.shares : 0;
      const pnl = payout - position.costBasis;
      this.state.paper.cash = round(this.state.paper.cash + payout, 8);
      this.state.paper.realizedPnl = round(this.state.paper.realizedPnl + pnl, 8);
      position.shares = 0;
      position.markBid = payout > 0 ? 1 : 0;
      position.status = 'resolved';
      position.resolvedOutcome = outcomes[winnerIndex];
      position.settlementValue = payout;
      position.settlementPnl = round(pnl, 8);
      position.closedAt = new Date().toISOString();
      this.state.paper.settlements.unshift({
        tokenId: position.tokenId,
        conditionId: position.conditionId,
        slug: position.slug,
        marketTitle: position.title,
        asset: position.asset,
        outcome: position.outcome,
        winningOutcome: outcomes[winnerIndex],
        costBasis: position.costBasis,
        payout,
        pnl: round(pnl, 8),
        settledAt: position.closedAt,
      });
    }
    if (this.state.paper.settlements.length > 1000) this.state.paper.settlements.length = 1000;
  }
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

async function runWithConcurrency(work, limit) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, work.length) }, async () => {
    while (next < work.length) {
      const index = next++;
      await work[index]();
    }
  });
  await Promise.all(workers);
}

module.exports = { PaperCopier, parseArray, runWithConcurrency, sweepBook };
