'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wallet-copy-state-'));
process.env.DATA_DIR = tempDir;
const { loadState, saveState } = require('../src/storage');
const wallet = '0x0000000000000000000000000000000000000001';

test('saves and reloads paper balances and seen-trade history', () => {
  const state = loadState(wallet);
  assert.equal(state.paper.cash, 10000);
  state.paper.cash = 9876.54;
  state.seenTradeIds.push('trade-id');
  saveState(state);

  const restored = loadState(wallet);
  assert.equal(restored.paper.cash, 9876.54);
  assert.deepEqual(restored.seenTradeIds, ['trade-id']);
});

test('fails explicitly on a corrupt saved ledger instead of silently resetting', () => {
  const file = path.join(tempDir, 'state-0000000000000000000000000000000000000001.json');
  fs.writeFileSync(file, '{not-json');
  assert.throws(() => loadState(wallet), /Could not load saved paper state/);
});

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
