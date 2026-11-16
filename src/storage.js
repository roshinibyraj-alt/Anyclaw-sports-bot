'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));

function initialState(wallet) {
  const configuredBalance = Number(process.env.PAPER_START_BALANCE || 10000);
  const configuredMultiplier = Number(process.env.COPY_MULTIPLIER || 1);
  const startingBalance = Number.isFinite(configuredBalance) && configuredBalance > 0
    ? configuredBalance
    : 10000;
  return {
    schemaVersion: 1,
    sourceWallet: wallet.toLowerCase(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    baselineLoaded: false,
    sourceTradeCount: 0,
    seenTradeIds: [],
    sourceTrades: [],
    copyEvents: [],
    paper: {
      startingBalance,
      cash: startingBalance,
      realizedPnl: 0,
      positions: {},
      settlements: [],
      feeStatus: 'waiting',
      paused: false,
      multiplier: Number.isFinite(configuredMultiplier) && configuredMultiplier > 0
        ? configuredMultiplier
        : 1,
      copyStats: { total: 0, filled: 0, partial: 0, missed: 0, paused: 0, skipped: 0 },
    },
    watcher: {
      status: 'starting',
      lastPollAt: null,
      lastSourceTimestamp: null,
      lastError: null,
      consecutiveErrors: 0,
      lastObservedTradeLagMs: null,
      lagMs: null,
    },
  };
}

function statePathFor(wallet) {
  const suffix = wallet.toLowerCase().replace(/^0x/, '');
  return path.join(DATA_DIR, `state-${suffix}.json`);
}

function loadState(wallet) {
  const file = statePathFor(wallet);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || parsed.schemaVersion !== 1 || !parsed.paper || !parsed.sourceTrades) {
      throw new Error('State file has an unsupported structure.');
    }
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return initialState(wallet);
    throw new Error(`Could not load saved paper state at ${file}: ${error.message}`);
  }
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const destination = statePathFor(state.sourceWallet);
  const temporary = `${destination}.${process.pid}.tmp`;
  state.updatedAt = new Date().toISOString();
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(temporary, destination);
}

module.exports = { DATA_DIR, initialState, loadState, saveState };
