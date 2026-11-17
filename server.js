'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { loadState, saveState } = require('./src/storage');
const { fetchBook, fetchFeeRate, fetchMarket, fetchResolutions } = require('./src/polymarket');
const { WalletMonitor } = require('./src/monitor');

const DEFAULT_WALLET = '0xeebde7a0e019a63e6b476eb425505b7b3e6eba30';
const SOURCE_WALLET = String(process.env.SOURCE_WALLET || DEFAULT_WALLET).trim();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const walletValid = /^0x[a-fA-F0-9]{40}$/.test(SOURCE_WALLET);

if (!walletValid) {
  console.error('SOURCE_WALLET must be a valid 0x EVM address.');
  process.exit(1);
}

const state = loadState(SOURCE_WALLET);
if (process.env.COPY_MULTIPLIER !== undefined) {
  const configuredMultiplier = Number(process.env.COPY_MULTIPLIER);
  if (Number.isFinite(configuredMultiplier) && configuredMultiplier > 0) {
    state.paper.multiplier = configuredMultiplier;
    saveState(state);
  }
}
const monitor = new WalletMonitor({
  state,
  saveState,
  dependencies: { fetchBook, fetchFeeRate, fetchMarket, fetchResolutions },
  pollIntervalMs: process.env.POLL_INTERVAL_MS || 1000,
});
const clients = new Set();
let cachedSnapshot = monitor.buildSnapshot();

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function publish(snapshot) {
  cachedSnapshot = snapshot;
  const frame = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
  for (const client of clients) {
    try {
      client.write(frame);
    } catch {
      clients.delete(client);
    }
  }
}

function serveStatic(pathname, res) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  };
  const item = files[pathname];
  if (!item) return false;
  const [file, contentType] = item;
  const fullPath = path.join(PUBLIC_DIR, file);
  if (!fs.existsSync(fullPath)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Dashboard assets are not ready.');
    return true;
  }
  res.writeHead(200, {
    'content-type': contentType,
    'cache-control': pathname === '/' || pathname === '/index.html'
      ? 'no-cache'
      : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
  });
  fs.createReadStream(fullPath).pipe(res);
  return true;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return sendJson(res, 200, {
      ok: true,
      mode: 'PAPER_ONLY',
      sourceWallet: SOURCE_WALLET,
      watcher: state.watcher.status,
      lastPollAt: state.watcher.lastPollAt,
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/snapshot') {
    return sendJson(res, 200, cachedSnapshot);
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: snapshot\ndata: ${JSON.stringify(cachedSnapshot)}\n\n`);
    clients.add(res);
    const heartbeat = setInterval(() => {
      try { res.write(': keep-alive\n\n'); } catch { clearInterval(heartbeat); clients.delete(res); }
    }, 20000);
    heartbeat.unref?.();
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(res);
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/copier/pause') {
    monitor.setPaused(true);
    return sendJson(res, 200, { ok: true, paused: true, mode: 'PAPER_ONLY' });
  }
  if (req.method === 'POST' && url.pathname === '/api/copier/resume') {
    monitor.setPaused(false);
    return sendJson(res, 200, { ok: true, paused: false, mode: 'PAPER_ONLY' });
  }
  if (req.method === 'GET' && serveStatic(url.pathname, res)) return;
  sendJson(res, 404, { error: 'Not found.' });
});

server.headersTimeout = 15000;
server.requestTimeout = 15000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Paper wallet observer listening on 0.0.0.0:${PORT}`);
  console.log(`Watching public activity for ${SOURCE_WALLET}`);
  console.log('Mode is PAPER_ONLY; no order signing or submission code is loaded.');
  monitor.start(publish);
});

async function shutdown(signal) {
  console.log(`${signal} received; saving paper state.`);
  await monitor.stop();
  for (const client of clients) {
    try { client.end(); } catch {}
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref?.();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', error => {
  console.error('Unhandled async error:', error?.message || error);
});
process.on('uncaughtException', error => {
  console.error('Uncaught error:', error?.message || error);
  shutdown('uncaughtException');
});
