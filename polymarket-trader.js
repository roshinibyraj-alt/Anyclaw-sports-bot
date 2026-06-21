'use strict';

const ethers = require('ethers');
const crypto = require('crypto');

const CHAIN_ID = 137;
const EXCHANGE_CONTRACT = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const CLOB_API = 'https://clob.polymarket.com';
const COLLATERAL_DECIMALS = 6;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SIGNATURE_TYPE = 0;

const AUTH_DOMAIN = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
  ]
};
const AUTH_DOMAIN_DATA = { name: 'ClobAuthDomain', version: '1', chainId: CHAIN_ID };
const AUTH_TYPE = {
  ClobAuth: [
    { name: 'address', type: 'address' },
    { name: 'timestamp', type: 'string' },
    { name: 'nonce', type: 'uint256' },
    { name: 'message', type: 'string' },
  ]
};

const ORDER_DOMAIN = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ]
};
const ORDER_DOMAIN_DATA = { name: 'Polymarket CTF Exchange', version: '1', chainId: CHAIN_ID, verifyingContract: EXCHANGE_CONTRACT };
const ORDER_TYPE = {
  Order: [
    { name: 'salt', type: 'uint256' },
    { name: 'maker', type: 'address' },
    { name: 'signer', type: 'address' },
    { name: 'taker', type: 'address' },
    { name: 'tokenId', type: 'uint256' },
    { name: 'makerAmount', type: 'uint256' },
    { name: 'takerAmount', type: 'uint256' },
    { name: 'expiration', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'feeRateBps', type: 'uint256' },
    { name: 'side', type: 'uint8' },
    { name: 'signatureType', type: 'uint8' },
  ]
};

/**
 * HMAC-SHA256 signing exactly like Java polybot:
 * 1. Sanitize secret (replace - → +, _ → /)
 * 2. Base64-decode secret
 * 3. HMAC-SHA256 of: ts + method + path + body
 * 4. Base64-encode result with URL-safe chars (- instead of +, _ instead of /)
 */
function _l2Sign(secretB64, ts, method, path, body) {
  const sanitized = secretB64.replace(/-/g, '+').replace(/_/g, '/');
  const secretBytes = Buffer.from(sanitized, 'base64');
  const msg = ts + method + path + (body || '');
  const mac = crypto.createHmac('sha256', secretBytes).update(msg).digest('base64');
  return mac.replace(/\+/g, '-').replace(/\//g, '_');
}

class PolymarketTrader {
  constructor(privateKey) {
    this.wallet = new ethers.Wallet(privateKey);
    this.address = this.wallet.address;
    this.logFn = () => {};
    this.apiKey = null;
    this.apiSecret = null;
    this.apiPassphrase = null;
    this.nonce = Math.floor(Math.random() * 100000);
  }

  setLogFn(fn) { this.logFn = fn; }

  async fetch(url, opts = {}) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000);
      const r = await fetch(url, { signal: ac.signal, ...opts });
      clearTimeout(timer);
      if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error(`HTTP ${r.status}: ${t.substring(0,200)}`); }
      return await r.json();
    } catch (e) { if (e.message && e.message.startsWith('HTTP')) throw e; return null; }
  }

  // ── L1 Auth: Sign ClobAuth message ──
  async signClobAuth(timestamp, nonce) {
    return await this.wallet.signTypedData(AUTH_DOMAIN_DATA, AUTH_TYPE, {
      address: this.address,
      timestamp: timestamp.toString(),
      nonce: nonce,
      message: 'This message attests that I control the given wallet',
    });
  }

  // ── L2 Auth: HMAC sign request (URL-safe base64) ──
  l2Sign(method, path, body, timestamp) {
    return _l2Sign(this.apiSecret, timestamp || Math.floor(Date.now() / 1000), method, path, body);
  }

  // ── Get L1 headers ──
  async l1Headers() {
    const ts = Math.floor(Date.now() / 1000);
    const nonce = ++this.nonce;
    const sig = await this.signClobAuth(ts, nonce);
    return {
      'POLY_ADDRESS': this.address,
      'POLY_SIGNATURE': sig,
      'POLY_TIMESTAMP': ts.toString(),
      'POLY_NONCE': nonce.toString(),
    };
  }

  // ── Get L2 headers ──
  l2Headers(method, path, body = '') {
    const ts = Math.floor(Date.now() / 1000);
    const sig = this.l2Sign(method, path, body, ts);
    return {
      'POLY_ADDRESS': this.address,
      'POLY_SIGNATURE': sig,
      'POLY_TIMESTAMP': ts.toString(),
      'POLY_API_KEY': this.apiKey,
      'POLY_PASSPHRASE': this.apiPassphrase,
    };
  }

  // ── Authenticate: derive API credentials from wallet ──
  async authenticate() {
    try {
      const headers = await this.l1Headers();
      // POST /auth/api-key with EMPTY body (not JSON), per Java polybot
      const result = await this.fetch(`${CLOB_API}/auth/api-key`, {
        method: 'POST',
        headers,
        body: '',
      });
      if (result && result.apiKey) {
        this.apiKey = result.apiKey;
        this.apiSecret = result.secret;
        this.apiPassphrase = result.passphrase;
        this.logFn('✅ Authenticated: ' + this.address.substring(0,10) + '...');
        return true;
      }
      this.logFn('❌ Auth failed: ' + JSON.stringify(result));
      return false;
    } catch (e) {
      this.logFn('❌ Auth error: ' + e.message);
      return false;
    }
  }

  // ── USDC balance via Polygon RPC (tries multiple endpoints) ──
  async getBalance() {
    const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    const RPCS = [
      'https://rpc-mainnet.maticvigil.com',
      'https://rpc.ankr.com/polygon',
      'https://polygon-mainnet.g.alchemy.com/v2/demo',
      'https://polygon-rpc.com',
    ];
    for (const rpcUrl of RPCS) {
      try {
        const provider = new ethers.JsonRpcProvider(rpcUrl, 137, { staticNetwork: true });
        const contract = new ethers.Contract(USDC, [
          'function balanceOf(address) view returns (uint256)',
          'function decimals() view returns (uint8)'
        ], provider);
        const bal = await contract.balanceOf(this.address);
        return Number(bal) / 1e6;
      } catch (_) {
        // try next RPC
      }
    }
    // All RPCs failed
    return 0;
  }

  // ── Get midpoint price (public, no auth) ──
  async getMidpoint(tokenId) {
    const data = await this.fetch(`${CLOB_API}/midpoint?token_id=${tokenId}`);
    return data && data.mid ? parseFloat(data.mid) : null;
  }

  // ── Get order book ──
  async getOrderBook(tokenId) {
    return await this.fetch(`${CLOB_API}/book?token_id=${tokenId}`);
  }

  // ── Place order ──
  async placeOrder(tokenId, side, price, size) {
    const salt = Math.floor(Math.random() * Date.now()).toString();
    const feeRateBps = '0';
    const expiration = '0';
    const nonce = (++this.nonce).toString();
    const scale = Math.pow(10, COLLATERAL_DECIMALS);
    
    let makerAmount, takerAmount;
    if (side === 'BUY') {
      const rawCost = Math.floor(size * price * 1000000) / 1000000;
      makerAmount = BigInt(Math.floor(rawCost * scale)).toString();
      takerAmount = BigInt(Math.floor(size * scale)).toString();
    } else {
      makerAmount = BigInt(Math.floor(size * scale)).toString();
      takerAmount = BigInt(Math.floor(size * price * scale)).toString();
    }

    const orderData = {
      salt, maker: this.address, signer: this.address, taker: ZERO_ADDRESS,
      tokenId, makerAmount, takerAmount, expiration, nonce,
      feeRateBps, side: side === 'BUY' ? 0 : 1, signatureType: SIGNATURE_TYPE,
    };

    const signature = await this.wallet.signTypedData(ORDER_DOMAIN_DATA, ORDER_TYPE, orderData);
    // Per CLOB API spec: wrap in { order: ..., owner: ..., orderType: ..., deferExec: false }
    const orderPayload = {
      order: { ...orderData, signature },
      owner: this.address,
      orderType: 'LIMIT',
      deferExec: false,
    };
    const body = JSON.stringify(orderPayload);

    const headers = this.l2Headers('POST', '/order', body);
    const result = await this.fetch(`${CLOB_API}/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    
    if (result) this.logFn(`📤 ${side} ${size}sh@$${price.toFixed(4)} | ${result.id || result.order?.id || 'ok'}`);
    else this.logFn(`❌ Order failed: ${side} ${size}sh@$${price.toFixed(4)}`);
    return result;
  }

  // ── Cancel order ──
  async cancelOrder(orderId) {
    const body = JSON.stringify({ orderID: orderId });
    const headers = this.l2Headers('DELETE', '/order', body);
    const result = await this.fetch(`${CLOB_API}/order?id=${orderId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    return result !== null;
  }

  // ── Get open orders ──
  async getOpenOrders(tokenId) {
    const path = tokenId ? `/data/orders?token_id=${tokenId}` : '/data/orders';
    const headers = this.l2Headers('GET', path);
    const result = await this.fetch(`${CLOB_API}${path}`, { headers });
    return Array.isArray(result?.data) ? result.data : (Array.isArray(result) ? result : []);
  }

  // ── Get fills ──
  async getFills(tokenId) {
    const path = `/data/orders?token_id=${tokenId}`;
    const headers = this.l2Headers('GET', path);
    const result = await this.fetch(`${CLOB_API}${path}`, { headers });
    return result && result.data ? result.data : [];
  }
}

module.exports = PolymarketTrader;
