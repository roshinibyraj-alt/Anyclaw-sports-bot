'use strict';

const { fetchRecentActivity, normalizeTrade, tradeId } = require('./polymarket');
const { analyzeTrades, classifyAsset, marketTiming } = require('./strategy-engine');
const { PaperCopier } = require('./paper-copier');
const { groupMarketPositions } = require('./market-positions');

const SOURCE_HISTORY_LIMIT = 10000;
const SEEN_ID_LIMIT = 50000;
const COPY_EVENT_LIMIT = 2000;

class WalletMonitor {
  constructor({ state, saveState, dependencies = {}, pollIntervalMs = 1000 }) {
    this.state = state;
    this.saveState = saveState;
    this.pollIntervalMs = Math.max(500, Number(pollIntervalMs) || 1000);
    this.dependencies = dependencies;
    this.copier = new PaperCopier(state, dependencies);
    this.onUpdate = () => {};
    this.running = false;
    this.stopped = false;
    this.timer = null;
    this.markTimer = null;
  }

  start(onUpdate) {
    this.onUpdate = onUpdate || (() => {});
    this.stopped = false;
    this.poll();
    this.markTimer = setInterval(() => this.refreshMarks(), 20000);
    this.markTimer.unref?.();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.markTimer);
    this.saveState(this.state);
  }

  async poll() {
    if (this.stopped || this.running) return;
    this.running = true;
    let nextDelay = this.pollIntervalMs;
    try {
      const knownIds = new Set(this.state.seenTradeIds);
      const feed = await fetchRecentActivity(
        this.state.sourceWallet,
        knownIds,
        this.state.baselineLoaded ? 5 : 5,
      );
      const normalized = feed.rows
        .map(normalizeTrade)
        .sort((a, b) => a.timestamp - b.timestamp);

      const unseenById = new Map();
      for (const trade of normalized) {
        if (!knownIds.has(trade.id)) unseenById.set(trade.id, trade);
      }
      const unseen = [...unseenById.values()];
      if (!this.state.baselineLoaded) {
        for (const trade of normalized) this.recordSourceTrade(trade, false);
        this.state.baselineLoaded = true;
        this.state.sourceTradeCount = Math.max(this.state.sourceTradeCount, this.state.sourceTrades.length);
        this.state.watcher.lastObservedTradeLagMs = null;
        this.state.watcher.status = 'connected';
        this.state.watcher.lastError = null;
        this.state.watcher.consecutiveErrors = 0;
        this.state.watcher.lastPollAt = new Date().toISOString();
        this.state.watcher.lastSourceTimestamp = normalized.length
          ? normalized[normalized.length - 1].timestamp
          : null;
      } else {
        for (const trade of unseen) {
          if (!this.recordSourceTrade(trade, true)) continue;
          this.state.sourceTradeCount += 1;
          this.state.watcher.lastSourceTimestamp = trade.timestamp;
          await this.copier.mirror(trade);
          if (this.state.copyEvents.length > COPY_EVENT_LIMIT) {
            this.state.copyEvents.length = COPY_EVENT_LIMIT;
          }
          this.saveState(this.state);
        }
        this.state.watcher.status = 'connected';
        this.state.watcher.lastError = null;
        this.state.watcher.consecutiveErrors = 0;
        this.state.watcher.lastPollAt = new Date().toISOString();
      }

      this.state.watcher.lagMs = this.state.watcher.lastObservedTradeLagMs ?? null;
      this.state.watcher.lastPageCount = feed.pages;
      this.saveState(this.state);
    } catch (error) {
      this.state.watcher.status = error.status === 429 ? 'rate-limited' : 'degraded';
      this.state.watcher.lastError = error.message || 'Could not read wallet activity.';
      this.state.watcher.consecutiveErrors += 1;
      const multiplier = Math.min(2 ** Math.min(this.state.watcher.consecutiveErrors, 6), 60);
      nextDelay = Math.min(60000, this.pollIntervalMs * multiplier);
      this.saveState(this.state);
      console.error(`Wallet poll failed (${this.state.watcher.status}): ${this.state.watcher.lastError}`);
    } finally {
      this.running = false;
      this.onUpdate(this.buildSnapshot());
      if (!this.stopped) {
        this.timer = setTimeout(() => this.poll(), nextDelay);
        this.timer.unref?.();
      }
    }
  }

  recordSourceTrade(trade, measureObservedLag = true) {
    if (this.state.seenTradeIds.includes(trade.id)) return false;
    trade.observedAt = Date.now();
    this.state.seenTradeIds.push(trade.id);
    if (this.state.seenTradeIds.length > SEEN_ID_LIMIT) {
      this.state.seenTradeIds.splice(0, this.state.seenTradeIds.length - SEEN_ID_LIMIT);
    }
    this.state.sourceTrades.push(trade);
    if (measureObservedLag) {
      this.state.watcher.lastObservedTradeLagMs = Math.max(0, trade.observedAt - trade.timestamp * 1000);
    }
    if (this.state.sourceTrades.length > SOURCE_HISTORY_LIMIT) {
      this.state.sourceTrades.splice(0, this.state.sourceTrades.length - SOURCE_HISTORY_LIMIT);
    }
    return true;
  }

  async refreshMarks() {
    if (this.stopped || this.running) return;
    try {
      await this.copier.refreshMarksAndSettle();
      this.saveState(this.state);
    } catch (error) {
      console.error(`Paper mark refresh failed: ${error.message}`);
    }
    this.onUpdate(this.buildSnapshot());
  }

  setPaused(paused) {
    this.state.paper.paused = Boolean(paused);
    this.saveState(this.state);
    this.onUpdate(this.buildSnapshot());
  }

  buildSnapshot() {
    const openPositions = Object.values(this.state.paper.positions)
      .filter(position => position.status === 'open' && position.shares > 0);
    let markedValue = 0;
    let unrealizedPnl = 0;
    let knownMarkCount = 0;
    const positions = Object.values(this.state.paper.positions)
      .filter(position => position.status === 'open' && position.shares > 0)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, 500)
      .map(position => {
        const markBid = position.markBid !== null && position.markBid !== undefined &&
          Number.isFinite(Number(position.markBid))
          ? Number(position.markBid)
          : null;
        const marketValue = position.status === 'open' && markBid !== null
          ? position.shares * markBid
          : position.status === 'open' ? null : Number(position.settlementValue || 0);
        const pnl = position.status === 'open'
          ? marketValue === null ? null : marketValue - position.costBasis
          : Number(position.settlementPnl || 0);
        if (position.status === 'open' && marketValue !== null && pnl !== null) {
          markedValue += marketValue;
          unrealizedPnl += pnl;
          knownMarkCount += 1;
        }
        return {
          tokenId: position.tokenId,
          conditionId: position.conditionId,
          marketTitle: position.title,
          title: position.title,
          asset: position.asset,
          slug: position.slug,
          outcome: position.outcome,
          shares: position.shares,
          costBasis: position.costBasis,
          averageCost: position.averageCost,
          markBid,
          marketValue,
          unrealizedPnl: pnl,
          status: position.status,
          resolvedOutcome: position.resolvedOutcome || null,
          updatedAt: position.updatedAt || null,
        };
      });

    const feeStatus = this.state.paper.feeStatus || 'waiting';
    const settled = this.state.paper.settlements || [];
    const settledWins = settled.filter(entry => entry.pnl > 0).length;
    const settledLosses = settled.filter(entry => entry.pnl <= 0).length;
    const marksComplete = knownMarkCount === openPositions.length;
    const totalPnl = marksComplete ? this.state.paper.realizedPnl + unrealizedPnl : null;
    const sourceTrades = this.state.sourceTrades.slice(-100).reverse();
    const copyEvents = this.state.copyEvents.slice(0, 100);
    const analysis = analyzeTrades(this.state.sourceTrades);
    const settledMarketKeys = new Set();
    const recentSettledPositions = [];
    for (const entry of settled) {
      const marketKey = String(entry.conditionId || entry.slug || entry.tokenId);
      if (!settledMarketKeys.has(marketKey) && settledMarketKeys.size >= 50) continue;
      settledMarketKeys.add(marketKey);
      recentSettledPositions.push({
        conditionId: entry.conditionId,
        slug: entry.slug,
        marketTitle: entry.marketTitle,
        title: entry.marketTitle,
        asset: entry.asset,
        outcome: entry.outcome,
        status: 'resolved',
        resolvedOutcome: entry.winningOutcome,
        shares: Number(entry.shares) || 0,
        costBasis: Number(entry.costBasis) || 0,
        averageCost: Number(entry.shares) > 0
          ? Number(entry.costBasis || 0) / Number(entry.shares)
          : null,
        markBid: Number(entry.shares) > 0
          ? Number(entry.payout || 0) / Number(entry.shares)
          : null,
        marketValue: Number(entry.payout) || 0,
        unrealizedPnl: Number(entry.pnl) || 0,
        updatedAt: entry.settledAt || null,
      });
    }

    return {
      mode: 'PAPER_ONLY',
      sourceWallet: this.state.sourceWallet,
      updatedAt: new Date().toISOString(),
      watcher: {
        ...this.state.watcher,
        error: this.state.watcher.lastError,
        lagMs: this.state.watcher.lagMs ?? null,
      },
      copier: {
        paused: Boolean(this.state.paper.paused),
        multiplier: this.state.paper.multiplier,
        execution: 'Public order-book sweep simulation',
      },
      summary: {
        paperBalance: this.state.paper.cash,
        paperEquity: marksComplete ? this.state.paper.cash + markedValue : null,
        startingBalance: this.state.paper.startingBalance,
        realizedPnl: this.state.paper.realizedPnl,
        unrealizedPnl: marksComplete ? unrealizedPnl : null,
        totalPnl,
        sourceTradeCount: this.state.sourceTradeCount,
        copyCount: this.state.paper.copyStats.total,
        filledCopies: this.state.paper.copyStats.filled,
        partialCopies: this.state.paper.copyStats.partial,
        missedCopies: this.state.paper.copyStats.missed,
        settledPositionWinRate: settledWins + settledLosses
          ? settledWins / (settledWins + settledLosses)
          : null,
        winRate: settledWins + settledLosses
          ? settledWins / (settledWins + settledLosses)
          : null,
        settledPositions: settledWins + settledLosses,
        openPositions: openPositions.length,
        markedPositions: knownMarkCount,
        feeStatus,
      },
      markets: groupMarketPositions([...positions, ...recentSettledPositions]),
      recentSourceTrades: sourceTrades.map(trade => ({
        ...trade,
        marketTitle: trade.title,
        asset: classifyAsset(trade.title, trade.slug),
        secondsIntoMarket: marketTiming(trade.slug, trade.timestamp).secondsIntoMarket,
      })),
      recentCopies: copyEvents,
      insights: {
        ...analysis,
        sizing: {
          label: analysis.averageBuyShares === null ? 'Sizing sample unavailable' : `Mean buy ${analysis.averageBuyShares} shares`,
          trend: analysis.sizingTrend || 'No persistent size progression detected yet',
        },
        cadence: { medianSeconds: analysis.medianSecondsBetweenTrades },
        limits: {
          orderType: 'The public feed does not expose the source order type.',
        },
      },
    };
  }
}

module.exports = { WalletMonitor };
