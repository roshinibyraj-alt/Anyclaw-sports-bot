'use strict';

const ethers = require('ethers');

// ── Constants ──
const CHAIN_ID = 137; // Polygon mainnet
const EXCHANGE_CONTRACT = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const USDC_CONTRACT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const CLOB_API = 'https://clob.polymarket.com';
const COLLATERAL_DECIMALS = 6;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
const SIGNATURE_TYPE = 0; // EOA

// ── EIP-712 Types ──
const DOMAIN_TYPE = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ]
};

const DOMAIN_DATA = {
  name: 'Polymarket CTF Exchange',
  version: '1',
  chainId: CHAIN_ID,
  verifyingContract: EXCHANGE_CONTRACT,
};

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

// ── Trader Class ──
class PolymarketTrader {
  constructor(privateKey) {
    this.wallet = new ethers.Wallet(privateKey);
    this.address = this.wallet.address;
    this.logFn = () => {};
    this.nonce = 0;
    this.apiCreds = null;
    this.tickSizes = {}; // cache: tokenId -> tickSize
  }

  setLogFn(fn) { this.logFn = fn; }

  async getJson(url) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 10000);
      const r = await fetch(url, { signal: ac.signal });
      clearTimeout(timer);
      if (!r.ok) return null;
      return await r.json();
    } catch (_) { return null; }
  }

  async postJson(url, body, headers = {}) {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status}: ${t.substring(0,200)}`); }
      return await r.json();
    } catch (e) { this.logFn(`❌ POST error: ${e.message}`); return null; }
  }

  async deleteJson(url, headers = {}) {
    try {
      const r = await fetch(url, { method: 'DELETE', headers });
      if (!r.ok) { const t = await r.text(); throw new Error(`HTTP ${r.status}: ${t.substring(0,200)}`); }
      return await r.json();
    } catch (e) { this.logFn(`❌ DELETE error: ${e.message}`); return null; }
  }

  // ── API Authentication ──
  async authenticate() {
    // Step 1: Get API key via CLOB auth
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = Math.floor(Math.random() * 1000000);
    
    // Sign CLOB auth message
    const authDomain = {
      name: 'ClobAuthDomain',
      version: '1',
      chainId: CHAIN_ID,
    };
    const authTypes = {
      ClobAuth: [
        { name: 'address', type: 'address' },
        { name: 'timestamp', type: 'string' },
        { name: 'nonce', type: 'uint256' },
        { name: 'message', type: 'string' },
      ]
    };
    const authData = {
      address: this.address,
      timestamp: timestamp.toString(),
      nonce: nonce,
      message: 'This message attests that I control the given wallet',
    };

    const signature = await this.wallet.signTypedData(authDomain, authTypes, authData);
    
    const result = await this.postJson(`${CLOB_API}/auth`, {
      signature,
      address: this.address,
      timestamp: timestamp,
      nonce: nonce,
      message: 'This message attests that I control the given wallet',
    });

    if (result && result.api_key) {
      this.apiCreds = result;
      this.logFn(`✅ Authenticated: ${this.address.substring(0,10)}...`);
      return true;
    }
    this.logFn(`❌ Auth failed: ${JSON.stringify(result)}`);
    return false;
  }

  // ── Get auth headers for API calls ──
  getAuthHeaders() {
    if (!this.apiCreds) return {};
    return {
      'POLYMARKET-API-KEY': this.apiCreds.api_key,
      'POLYMARKET-SECRET': this.apiCreds.secret,
      'POLYMARKET-PASSPHRASE': this.apiCreds.passphrase,
    };
  }

  // ── Get tick size for a token ──
  async getTickSize(tokenId) {
    if (this.tickSizes[tokenId]) return this.tickSizes[tokenId];
    const data = await this.getJson(`${CLOB_API}/tick-size?token_id=${tokenId}`);
    if (data && data.minimum_tick_size) {
      const ts = parseFloat(data.minimum_tick_size);
      this.tickSizes[tokenId] = ts;
      return ts;
    }
    return 0.001; // default tick size
  }

  // ── Get order book ──
  async getOrderBook(tokenId) {
    return await this.getJson(`${CLOB_API}/book?token_id=${tokenId}`);
  }

  // ── Get midpoint price ──
  async getMidpoint(tokenId) {
    const data = await this.getJson(`${CLOB_API}/midpoint?token_id=${tokenId}`);
    return data && data.mid ? parseFloat(data.mid) : null;
  }

  // ── Sign an order (EIP-712) ──
  async signOrder(tokenId, side, price, size, tickSize) {
    const feeRateBps = 0; // maker = 0%
    const salt = Math.floor(Math.random() * Date.now()).toString();
    const expiration = '0'; // GTC
    const nonce = (this.nonce++).toString();
    const taker = ZERO_ADDRESS;

    // Calculate maker/taker amounts based on side
    // polymarket uses 6 decimals for USDC
    const scale = Math.pow(10, COLLATERAL_DECIMALS);
    
    let makerAmount, takerAmount;
    if (side === 'BUY') {
      // BUY: you pay price*size USDC, receive size tokens
      const rawSize = Math.floor(size * scale) / scale; // round to 6 decimals
      const rawCost = Math.floor(rawSize * price * scale) / scale;
      makerAmount = BigInt(Math.floor(rawCost * scale)).toString(); // USDC to pay
      takerAmount = BigInt(Math.floor(rawSize * scale)).toString(); // tokens to receive
    } else {
      // SELL: you give size tokens, receive price*size USDC
      const rawSize = Math.floor(size * scale) / scale;
      const rawProceeds = Math.floor(rawSize * price * scale) / scale;
      makerAmount = BigInt(Math.floor(rawSize * scale)).toString(); // tokens to give
      takerAmount = BigInt(Math.floor(rawProceeds * scale)).toString(); // USDC to receive
    }

    const orderData = {
      salt,
      maker: this.address,
      signer: this.address,
      taker,
      tokenId,
      makerAmount,
      takerAmount,
      expiration,
      nonce,
      feeRateBps: feeRateBps.toString(),
      side: side === 'BUY' ? 0 : 1,
      signatureType: SIGNATURE_TYPE,
    };

    const signature = await this.wallet.signTypedData(DOMAIN_DATA, ORDER_TYPE, orderData);

    return {
      ...orderData,
      signature,
      owner: this.address,
      orderType: 'LIMIT',
      negRisk: false,
    };
  }

  // ── Place order on CLOB ──
  async placeOrder(tokenId, side, price, size, tickSize) {
    if (!this.apiCreds) {
      const authed = await this.authenticate();
      if (!authed) return null;
    }

    const signedOrder = await this.signOrder(tokenId, side, price, size, tickSize);
    const result = await this.postJson(`${CLOB_API}/order`, signedOrder, this.getAuthHeaders());
    
    if (result) {
      this.logFn(`📤 ${side} ${size}sh@$${price.toFixed(4)} token:${tokenId.substring(0,8)}...`);
    } else {
      this.logFn(`❌ Order failed: ${side} ${size}sh@$${price.toFixed(4)}`);
    }
    return result;
  }

  // ── Cancel order ──
  async cancelOrder(orderId) {
    if (!this.apiCreds) return false;
    const result = await this.deleteJson(`${CLOB_API}/order?id=${orderId}`, this.getAuthHeaders());
    return result !== null;
  }

  // ── Cancel all orders for a token ──
  async cancelAllOrders(tokenId) {
    if (!this.apiCreds) return false;
    const result = await this.deleteJson(`${CLOB_API}/orders?token_id=${tokenId}`, this.getAuthHeaders());
    return result !== null;
  }

  // ── Get open orders ──
  async getOpenOrders(tokenId) {
    if (!this.apiCreds) return [];
    const result = await this.getJson(`${CLOB_API}/orders?token_id=${tokenId}`, this.getAuthHeaders());
    return Array.isArray(result) ? result : [];
  }

  // ── Get fills/order history ──
  async getFills(tokenId) {
    if (!this.apiCreds) return [];
    const result = await this.getJson(`${CLOB_API}/orders/history?token_id=${tokenId}`, this.getAuthHeaders());
    return result && result.data ? result.data : [];
  }

  // ── Get USDC balance ──
  async getBalance() {
    // Try CLOB balance endpoint first
    if (this.apiCreds) {
      const result = await this.getJson(`${CLOB_API}/balance/allowance?asset_type=USDC`);
      if (result) return parseFloat(result.amount || '0');
    }
    return 0;
  }

  // ── Get server time ──
  async getServerTime() {
    const data = await this.getJson(`${CLOB_API}/time`);
    return data ? parseInt(data) : Math.floor(Date.now() / 1000);
  }
}

module.exports = PolymarketTrader;
