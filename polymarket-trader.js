'use strict';

const ethers = require('ethers');
const crypto = require('crypto');

const CHAIN_ID = 137;
const EXCHANGE_CONTRACT = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const CLOB_API = 'https://clob.polymarket.com';
const COLLATERAL_DECIMALS = 6;
const MIN_SHARES = 5; // Polymarket CLOB minimum order size
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const PUSD_TOKEN = '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb';
const USDC_TOKEN_OLD = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_TOKEN_NEW = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
// Default to Poly Proxy (1) when FUNDER_ADDRESS is set, else EOA (0)
const hasProxyWallet = !!process.env.FUNDER_ADDRESS;
const SIGNATURE_TYPE = parseInt(process.env.SIGNATURE_TYPE || (hasProxyWallet ? '1' : '0'), 10);

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
  constructor(privateKey, funderAddress) {
    this.wallet = new ethers.Wallet(privateKey);
    this.address = this.wallet.address;
    this.signerAddress = this.address;
    this.funderAddress = funderAddress || this.address;
    this._feeCache = {};
    this._tickSizeCache = {};
    this.logFn = () => {};

    if (funderAddress && funderAddress.toLowerCase() !== this.address.toLowerCase()) {
      console.log(`🔐 Proxy wallet mode: signer=${this.address} maker=${this.funderAddress} sigType=${SIGNATURE_TYPE}`);
      if (SIGNATURE_TYPE === 0) {
        console.log('⚠️ SIGNATURE_TYPE is 0 (EOA) but FUNDER_ADDRESS is set. Set SIGNATURE_TYPE=1 for Poly Proxy wallets.');
      }
    }
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

  // ── Get total available balance ──
  // Checks USDC + PUSD (Polymarket USD) + CTF exchange deposit.
  // In proxy wallet mode, all checks are against the funder (Deposit Wallet).
  // Supports POLYGON_RPC_URL env var for custom RPC endpoints.
  async getBalance() {
    const EXCHANGE_CTF = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
    const checkAddress = this.funderAddress;
    
    const rpcEnv = process.env.POLYGON_RPC_URL;
    const RPCS = [];
    if (rpcEnv) RPCS.push(rpcEnv);
    RPCS.push(
      'https://polygon.llamarpc.com',
      'https://1rpc.io/matic',
      'https://rpc-mainnet.maticvigil.com',
      'https://rpc.ankr.com/polygon',
      'https://polygon-mainnet.g.alchemy.com/v2/demo',
      'https://polygon-rpc.com',
    );
    
    for (const rpcUrl of RPCS) {
      try {
        const payload = [
          {jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:USDC_TOKEN_OLD,data:'0x70a08231'+checkAddress.substring(2).padStart(64,'0')},'latest']},
          {jsonrpc:'2.0',id:2,method:'eth_call',params:[{to:USDC_TOKEN_NEW,data:'0x70a08231'+checkAddress.substring(2).padStart(64,'0')},'latest']},
          {jsonrpc:'2.0',id:3,method:'eth_call',params:[{to:PUSD_TOKEN,data:'0x70a08231'+checkAddress.substring(2).padStart(64,'0')},'latest']},
          {jsonrpc:'2.0',id:4,method:'eth_call',params:[{to:EXCHANGE_CTF,data:'0x27e235e3'+checkAddress.substring(2).padStart(64,'0')},'latest']}
        ];
        const resp = await fetch(rpcUrl, {
          method: 'POST',
          headers: {'Content-Type':'application/json'},
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) continue;
        const results = await resp.json();
        if (!Array.isArray(results)) continue;
        const usdcOld = results[0]?.result ? Number(BigInt(results[0].result)) / 1e6 : 0;
        const usdcNew = results[1]?.result ? Number(BigInt(results[1].result)) / 1e6 : 0;
        const pusdBal = results[2]?.result ? Number(BigInt(results[2].result)) / 1e6 : 0;
        const exBal = results[3]?.result ? Number(BigInt(results[3].result)) / 1e6 : 0;
        const total = usdcOld + usdcNew + pusdBal + exBal;
        return total;
      } catch (_) { continue; }
    }
    return 0;
  }

  // ── Fetch fee rate for a token (cached per token) ──
  async getFeeRate(tokenId) {
    const cached = this._feeCache[tokenId];
    if (cached && Date.now() - cached.ts < 300000) return cached.rate;
    try {
      const data = await this.fetch(`${CLOB_API}/fee-rate?token_id=${tokenId}`);
      if (data && typeof data.base_fee !== 'undefined') {
        const rate = Number(data.base_fee);
        this._feeCache[tokenId] = { rate, ts: Date.now() };
        this.logFn(`💸 Fee rate: ${rate} bps`);
        return rate;
      }
    } catch (_) { /* ignore */ }
    const fallback = 1000;
    this.logFn(`⚠️ Using default fee rate ${fallback} bps`);
    return fallback;
  }

  // ── Fetch tick size for a token (cached) ──
  async getTickSize(tokenId) {
    const cached = this._tickSizeCache[tokenId];
    if (cached && Date.now() - cached.ts < 300000) return cached.tickSize;
    try {
      const data = await this.fetch(`${CLOB_API}/tick-size?token_id=${tokenId}`);
      if (data && typeof data.tick_size !== 'undefined') {
        const tickSize = parseFloat(data.tick_size);
        this._tickSizeCache[tokenId] = { tickSize, ts: Date.now() };
        return tickSize;
      }
    } catch (_) { /* ignore */ }
    return 0.01; // fallback default
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
    if (size < MIN_SHARES) {
      this.logFn('⚠️ Order too small: ' + size + ' shares (min ' + MIN_SHARES + ')');
      return null;
    }
    if (!this.apiKey) {
      this.logFn('❌ No API key - authenticate first');
      return null;
    }
    
    const salt = Math.floor(Math.random() * Date.now()).toString();
    const expiration = '0';
    const nonce = (++this.nonce).toString();
    const scale = Math.pow(10, COLLATERAL_DECIMALS);
    // Get the market's fee rate – MUST match or API rejects with "Invalid order payload"
    const marketFeeBps = await this.getFeeRate(tokenId);
    const feeRateBps = marketFeeBps.toString();
    // Get dynamic tick size for this market
    const tickSize = await this.getTickSize(tokenId);
    
    // Calculate maker/taker amounts (USDC has 6 decimals)
    // For BUY: maker pays cost (shares * price), taker gives shares
    // For SELL: maker gives shares, taker pays cost
    const rawPrice = Math.round(price / tickSize) * tickSize;
    let makerAmount, takerAmount;
    if (side === 'BUY') {
      const rawTakerAmt = size;
      const rawMakerAmt_full = rawTakerAmt * rawPrice;
      const rawMakerAmt = Math.floor(rawMakerAmt_full * 100) / 100;
      makerAmount = BigInt(Math.floor(rawMakerAmt * scale)).toString();
      takerAmount = BigInt(Math.floor(rawTakerAmt * scale)).toString();
    } else {
      makerAmount = BigInt(Math.floor(size * scale)).toString();
      takerAmount = BigInt(Math.floor(size * rawPrice * scale)).toString();
    }

    // EIP-712 signing uses uint8 side (0=BUY, 1=SELL)
    const eip712Side = side === 'BUY' ? 0 : 1;
    // maker = funderAddress (proxy wallet that holds funds), signer = EOA that signs
    const orderData = {
      salt, maker: this.funderAddress, signer: this.signerAddress, taker: ZERO_ADDRESS,
      tokenId, makerAmount, takerAmount, expiration, nonce,
      feeRateBps, side: eip712Side, signatureType: SIGNATURE_TYPE,
    };

    const signature = await this.wallet.signTypedData(ORDER_DOMAIN_DATA, ORDER_TYPE, orderData);
    
    // CLOB API payload format
    const orderPayload = {
      order: {
        salt: Number(salt),
        maker: this.funderAddress, signer: this.signerAddress, taker: ZERO_ADDRESS,
        tokenId, makerAmount, takerAmount, expiration, nonce,
        feeRateBps, side: side,
        signatureType: SIGNATURE_TYPE,
        signature,
      },
      owner: this.apiKey,
      orderType: 'GTC',
      deferExec: false,
    };
    const body = JSON.stringify(orderPayload);

    const headers = this.l2Headers('POST', '/order', body);
    const result = await this.fetch(`${CLOB_API}/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    
    if (result) {
      const orderId = result.id || result.orderID || (result.order && result.order.id) || 'ok';
      this.logFn(`📤 ${side} ${size}sh@$${rawPrice.toFixed(2)} id:${orderId.toString().substring(0,12)}`);
      return result;
    }
    this.logFn(`❌ Order failed: ${side} ${size}sh@$${rawPrice.toFixed(2)}`);
    return null;
  }

  // ── Cancel order ──
  // DELETE /order signs the base path only (no query params in HMAC)
  async cancelOrder(orderId) {
    const basePath = '/order';
    const body = JSON.stringify({ orderID: orderId });
    const headers = this.l2Headers('DELETE', basePath, body);
    try {
      const result = await this.fetch(`${CLOB_API}${basePath}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      return result !== null;
    } catch (_) { return false; }
  }

  // ── Get open orders ──
  // HMAC signs base path without query params; filter by status=LIVE for open orders
  async getOpenOrders(tokenId) {
    const basePath = '/data/orders';
    const qs = tokenId ? `token_id=${tokenId}&status=LIVE` : 'status=LIVE';
    const headers = this.l2Headers('GET', basePath);
    const result = await this.fetch(`${CLOB_API}${basePath}?${qs}`, { headers });
    return Array.isArray(result?.data) ? result.data : (Array.isArray(result) ? result : []);
  }

  // ── Get filled orders ──
  async getFills(tokenId) {
    const basePath = '/data/orders';
    const qs = `token_id=${tokenId}&status=MATCHED`;
    const headers = this.l2Headers('GET', basePath);
    const result = await this.fetch(`${CLOB_API}${basePath}?${qs}`, { headers });
    return result && result.data ? result.data : [];
  }

  // ── Get balance via CLOB /balance-allowance (authenticated, no RPC needed) ──
  async getBalanceAllowance() {
    if (!this.apiKey) return -1;
    try {
      // HMAC signs the base path WITHOUT query params (official client behaviour)
      const basePath = '/balance-allowance';
      const qs = `asset_type=COLLATERAL&signature_type=${SIGNATURE_TYPE}`;
      const headers = this.l2Headers('GET', basePath);
      const result = await this.fetch(`${CLOB_API}${basePath}?${qs}`, { headers });
      if (result && typeof result.balance !== 'undefined') {
        const bal = Number(result.balance) / 1e6;
        this.logFn(`💰 CLOB balance: $${bal.toFixed(2)}`);
        return bal;
      }
      if (result && typeof result.allowance !== 'undefined') {
        const bal = Number(result.allowance) / 1e6;
        this.logFn(`💰 CLOB allowance: $${bal.toFixed(2)}`);
        return bal;
      }
      this.logFn(`⚠️ Balance-allowance response unexpected: ${JSON.stringify(result).substring(0,80)}`);
      return -1;
    } catch(e) {
      this.logFn(`⚠️ Balance-allowance error: ${e.message.substring(0,80)}`);
      return -1;
    }
  }

  // ── Cancel all open orders (optionally filtered by token) ──
  async cancelAllOrders(tokenId) {
    const basePath = '/cancel-all';
    const body = tokenId ? JSON.stringify({ token_id: tokenId }) : '{}';
    const headers = this.l2Headers('DELETE', basePath, body);
    try {
      return await this.fetch(`${CLOB_API}${basePath}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
    } catch (_) { return null; }
  }
}

module.exports = PolymarketTrader;
