'use strict';

function groupMarketPositions(positions) {
  const markets = new Map();

  for (const position of positions || []) {
    const sideName = String(position.outcome || '').toLowerCase();
    if (sideName !== 'up' && sideName !== 'down') continue;
    const key = String(position.conditionId || position.slug || position.tokenId || position.marketTitle);
    if (!markets.has(key)) {
      markets.set(key, {
        conditionId: position.conditionId || null,
        slug: position.slug || null,
        title: position.marketTitle || position.title || 'Untitled market',
        asset: position.asset || 'OTHER',
        status: position.status || 'open',
        resolvedOutcome: position.resolvedOutcome || null,
        up: emptySide(),
        down: emptySide(),
      });
    }

    const market = markets.get(key);
    const side = market[sideName];
    const shares = Number(position.shares) || 0;
    const costBasis = Number(position.costBasis) || 0;
    side.shares += shares;
    side.costBasis += costBasis;
    side.positionCount += 1;
    if (position.markBid === null || position.markBid === undefined ||
        position.marketValue === null || position.marketValue === undefined ||
        position.unrealizedPnl === null || position.unrealizedPnl === undefined) {
      side.markComplete = false;
    } else {
      side.marketValue += Number(position.marketValue) || 0;
      side.unrealizedPnl += Number(position.unrealizedPnl) || 0;
    }
  }

  return [...markets.values()].map(market => ({
    ...market,
    up: finalizeSide(market.up),
    down: finalizeSide(market.down),
  })).sort((a, b) => String(b.slug || '').localeCompare(String(a.slug || '')));
}

function emptySide() {
  return {
    shares: 0,
    costBasis: 0,
    marketValue: 0,
    unrealizedPnl: 0,
    positionCount: 0,
    markComplete: true,
  };
}

function finalizeSide(side) {
  const hasPosition = side.positionCount > 0;
  return {
    shares: side.shares,
    costBasis: side.costBasis,
    averageCost: hasPosition && side.shares > 0 ? side.costBasis / side.shares : null,
    marketValue: hasPosition && side.markComplete ? side.marketValue : null,
    unrealizedPnl: hasPosition && side.markComplete ? side.unrealizedPnl : null,
    markBid: hasPosition && side.markComplete && side.shares > 0 ? side.marketValue / side.shares : null,
    positionCount: side.positionCount,
  };
}

module.exports = { groupMarketPositions };
