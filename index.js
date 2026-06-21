'use strict';

// ── Proxy setup (must be first — patches globalThis.fetch before any bot code) ──
const _proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (_proxyUrl) {
  try {
    const { ProxyAgent, fetch: _uFetch } = require('undici');
    const _agent = new ProxyAgent({ uri: _proxyUrl, requestTls: { rejectUnauthorized: false } });
    globalThis.fetch = (url, opts = {}) => _uFetch(url, { ...opts, dispatcher: _agent });
    console.log('🌐 Proxy active:', _proxyUrl.replace(/:[^:@]*@/, ':***@'));
  } catch(e) {
    console.log('⚠️ Proxy setup error:', e.message);
  }
}

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const bot = require('./polymarket-bot');

process.on('unhandledRejection', (err) => console.error('❌', err?.message));
process.on('uncaughtException', (err) => console.error('❌', err?.message));

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e6,
  pingInterval: 10000,
  pingTimeout: 5000,
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname)));

app.get('/api/snapshot', (req, res) => {
  try { res.json(bot.buildSnapshot()); } catch(e) { res.json({error:e.message}); }
});

let lastEmit = 0;
function broadcast(snapshot) {
  const now = Date.now();
  if (now - lastEmit < 500) return;
  lastEmit = now;
  io.emit('snapshot', snapshot);
}

io.on('connection', (socket) => {
  console.log(`🔌 Client ${socket.id}`);
  try { socket.emit('snapshot', bot.buildSnapshot()); } catch (_) {}
  socket.on('disconnect', () => console.log(`🔌 Left ${socket.id}`));
});

async function main() {
  await bot.start(
    (event, data) => { if (event === 'snapshot') broadcast(data); },
    (msg) => console.log(msg)
  );
  server.listen(PORT, () => console.log(`🌐 http://0.0.0.0:${PORT}`));
}

main();
