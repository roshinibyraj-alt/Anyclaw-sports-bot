'use strict';

const DURATION_SECONDS = {
  '5m': 300,
  '15m': 900,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
};

function classifyAsset(title = '', slug = '') {
  const text = `${title} ${slug}`.toLowerCase();
  if (/\b(bitcoin|btc)\b/.test(text)) return 'BTC';
  if (/\b(ethereum|ether|eth)\b/.test(text)) return 'ETH';
  if (/\b(binance coin|bnb)\b/.test(text)) return 'BNB';
  if (/\b(hyperliquid|hype)\b/.test(text)) return 'HYPE';
  if (/\b(solana|sol)\b/.test(text)) return 'SOL';
  if (/\b(xrp|ripple)\b/.test(text)) return 'XRP';
  if (/\b(dogecoin|doge)\b/.test(text)) return 'DOGE';
  return 'OTHER';
}

function marketTiming(slug, timestamp) {
  if (!slug) return { durationSeconds: null, secondsIntoMarket: null, secondsRemaining: null };
  const match = slug.match(/(?:^|-)(5m|15m|1h|4h|1d)-(\d{9,})$/i);
  if (!match) return { durationSeconds: null, secondsIntoMarket: null, secondsRemaining: null };
  const durationSeconds = DURATION_SECONDS[match[1].toLowerCase()];
  const start = Number(match[2]);
  if (!durationSeconds || !Number.isFinite(start)) {
    return { durationSeconds: null, secondsIntoMarket: null, secondsRemaining: null };
  }
  const secondsIntoMarket = Math.max(0, Math.min(durationSeconds, timestamp - start));
  return {
    durationSeconds,
    secondsIntoMarket,
    secondsRemaining: Math.max(0, durationSeconds - secondsIntoMarket),
  };
}

function confidenceFor(sampleMarkets) {
  if (sampleMarkets >= 30) return 0.9;
  if (sampleMarkets >= 10) return 0.75;
  return 0.5;
}

function analyzeTrades(trades = []) {
  const valid = trades.filter(t => t && t.type === 'TRADE' &&
    (t.side === 'BUY' || t.side === 'SELL') && t.tokenId && t.size > 0);
  const ordered = [...valid].sort((a, b) => a.timestamp - b.timestamp);
  const markets = new Map();
  const gaps = [];
  let previousTime = null;

  for (const trade of ordered) {
    if (previousTime !== null) gaps.push(Math.max(0, trade.timestamp - previousTime));
    previousTime = trade.timestamp;
    const key = trade.conditionId || trade.slug || trade.id;
    if (!markets.has(key)) {
      markets.set(key, {
        key,
        title: trade.title,
        slug: trade.slug,
        asset: classifyAsset(trade.title, trade.slug),
        trades: [],
        sides: new Set(),
      });
    }
    const market = markets.get(key);
    market.trades.push(trade);
    if (trade.side === 'BUY') market.sides.add(trade.outcome);
  }

  const marketRows = [...markets.values()];
  const twoSidedMarkets = marketRows.filter(m => m.sides.size >= 2).length;
  const repeatedBuyMarkets = marketRows.filter(m => m.trades.filter(t => t.side === 'BUY').length >= 3).length;
  const buys = ordered.filter(t => t.side === 'BUY');
  const sells = ordered.filter(t => t.side === 'SELL');
  const knownTiming = ordered.map(t => ({ trade: t, ...marketTiming(t.slug, t.timestamp) }))
    .filter(x => x.durationSeconds);
  const lateBuys = knownTiming.filter(x => x.trade.side === 'BUY' &&
    x.secondsRemaining <= x.durationSeconds * 0.2).length;
  const lateBuyShare = knownTiming.filter(x => x.trade.side === 'BUY').length
    ? lateBuys / knownTiming.filter(x => x.trade.side === 'BUY').length
    : 0;

  const repeatedPriceChanges = [];
  let sameOutcomeAdds = 0;
  for (const market of marketRows) {
    const byOutcome = new Map();
    for (const trade of market.trades) {
      if (trade.side !== 'BUY' || !Number.isFinite(trade.price)) continue;
      const group = byOutcome.get(trade.outcome) || [];
      group.push(trade.price);
      byOutcome.set(trade.outcome, group);
    }
    for (const prices of byOutcome.values()) {
      if (prices.length >= 2) {
        sameOutcomeAdds += prices.length - 1;
        repeatedPriceChanges.push(prices[prices.length - 1] - prices[0]);
      }
    }
  }
  const fallingAddGroups = repeatedPriceChanges.filter(delta => delta < -0.005).length;
  const risingAddGroups = repeatedPriceChanges.filter(delta => delta > 0.005).length;
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const medianGap = sortedGaps.length
    ? sortedGaps[Math.floor((sortedGaps.length - 1) / 2)]
    : null;
  const avgSize = buys.length
    ? buys.reduce((sum, t) => sum + t.size, 0) / buys.length
    : null;
  let sizingTrend = 'Not enough trade-size history';
  if (buys.length >= 10) {
    const sampleSize = Math.min(20, Math.floor(buys.length / 2));
    const firstMean = buys.slice(0, sampleSize).reduce((sum, t) => sum + t.size, 0) / sampleSize;
    const lastMean = buys.slice(-sampleSize).reduce((sum, t) => sum + t.size, 0) / sampleSize;
    if (lastMean > firstMean * 1.2) sizingTrend = 'Recent buys are larger than earlier sampled buys';
    else if (lastMean < firstMean * 0.8) sizingTrend = 'Recent buys are smaller than earlier sampled buys';
    else sizingTrend = 'No strong overall size increase or decrease';
  }

  const patterns = [];
  if (marketRows.length) {
    const proportion = twoSidedMarkets / marketRows.length;
    if (proportion >= 0.3) {
      patterns.push({
        key: 'two-sided-accumulation',
        label: 'Buys both outcomes',
        confidence: confidenceFor(marketRows.length),
        support: `${twoSidedMarkets}/${marketRows.length} markets`,
        description: `${Math.round(proportion * 100)}% of sampled markets show buys on multiple outcomes. This indicates two-sided exposure, not proof of a hedge or arbitrage.`,
      });
    }
    const repeatedProportion = repeatedBuyMarkets / marketRows.length;
    if (repeatedProportion >= 0.2) {
      patterns.push({
        key: 'repeat-adds',
        label: 'Repeated entries',
        confidence: confidenceFor(marketRows.length),
        support: `${repeatedBuyMarkets}/${marketRows.length} markets`,
        description: `${Math.round(repeatedProportion * 100)}% of markets contain at least three buys. The wallet often adds more than once in a market.`,
      });
    }
  }
  if (repeatedPriceChanges.length && fallingAddGroups / repeatedPriceChanges.length >= 0.55) {
    patterns.push({
      key: 'averaging-down',
      label: 'Often adds at lower prices',
      confidence: confidenceFor(repeatedPriceChanges.length),
      support: `${fallingAddGroups}/${repeatedPriceChanges.length} repeated-entry groups`,
      description: 'Within repeated buys of the same outcome, later sampled prices more often fall than rise.',
    });
  } else if (repeatedPriceChanges.length && risingAddGroups / repeatedPriceChanges.length >= 0.55) {
    patterns.push({
      key: 'price-following',
      label: 'Often adds at higher prices',
      confidence: confidenceFor(repeatedPriceChanges.length),
      support: `${risingAddGroups}/${repeatedPriceChanges.length} repeated-entry groups`,
      description: 'Within repeated buys of the same outcome, later sampled prices more often rise than fall.',
    });
  }
  if (knownTiming.length && lateBuyShare >= 0.2) {
    patterns.push({
      key: 'late-window-buys',
      label: 'Late-window entries',
      confidence: confidenceFor(knownTiming.length),
      support: `${lateBuys}/${knownTiming.filter(x => x.trade.side === 'BUY').length} timed buys`,
      description: 'A meaningful share of buys occurs in the final fifth of known window markets.',
    });
  }
  if (sells.length) {
    patterns.push({
      key: 'sells-observed',
      label: 'Sells observed',
      confidence: confidenceFor(marketRows.length),
      support: `${sells.length}/${valid.length} trades`,
      description: 'The public activity sample includes sells. It does not reveal the original order type.',
    });
  } else if (valid.length) {
    patterns.push({
      key: 'no-sells-in-sample',
      label: 'No sells in sample',
      confidence: confidenceFor(marketRows.length),
      support: `${valid.length} trades`,
      description: 'No sells appear in the sampled trade feed; this is not proof the wallet never sells.',
    });
  }

  const byAsset = {};
  for (const market of marketRows) {
    byAsset[market.asset] = (byAsset[market.asset] || 0) + market.trades.length;
  }

  return {
    sampleTrades: valid.length,
    sampleMarkets: marketRows.length,
    buys: buys.length,
    sells: sells.length,
    averageBuyShares: avgSize === null ? null : Number(avgSize.toFixed(2)),
    sizingTrend,
    medianSecondsBetweenTrades: medianGap,
    repeatedOutcomeAdds: sameOutcomeAdds,
    timedTradeCount: knownTiming.length,
    lateBuyShare: Number(lateBuyShare.toFixed(3)),
    tradesByAsset: byAsset,
    patterns,
    limitations: [
      'Public activity reports completed fills, not private signals or unfilled orders.',
      'The public trade rows do not reliably identify the submitted order type.',
      'Patterns are descriptive heuristics and do not establish why the wallet traded.',
    ],
  };
}

module.exports = { analyzeTrades, classifyAsset, marketTiming };
