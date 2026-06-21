'use strict';

const ethers = require('ethers');
const crypto = require('crypto');

const CHAIN_ID = 137;
// V2 protocol: new exchange contracts (ts-sdk / @polymarket/client)
const STANDARD_EXCHANGE = '0xE111180000d2663C0091e4f400237545B87B996B';
const NEG_RISK_EXCHANGE  = '0xe2222d279d744050d28e00520010520000310F59';
const CLOB_API = 'https://clob.polymarket.com';
const COLLATERAL_DECIMALS = 6;
const MIN_SHARES = 5;
const PUSD_TOKEN = '0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb';
const USDC_TOKEN_OLD = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_TOKEN_NEW = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const BYTES32_ZERO = '0x0000000000000000000000000000000000000000000000000000000000000000';
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

// V2 EIP-712 domain — version "2", verifyingContract is market-dependent
function getOrderDomainData(negRisk) {
  return {
    name: 'Polymarket CTF Exchange',
    version: '2',
    chainId: CHAIN_ID,
    verifyingContract: negRisk ? NEG_RISK_EXCHANGE : STANDARD_EXCHANGE,
  };
}
// V2 Order struct — taker/expiration/nonce/feeRateBps removed; timestamp/metadata/builder added
const ORDER_TYPE = {
  Order: [
    { name: 'salt',          type: 'uint256' },
    { name: 'maker',         type: 'address' },
    { name: 'signer',        type: 'address' },
    { name: 'tokenId',       type: 'uint256' },
    { name: 'makerAmount',   type: 'uint256' },
    { name: 'takerAmount',   type: 'uint256' },
    { name: 'side',          type: 'uint8'   },
    { name: 'signatureType', type: 'uint8'   },
    { name: 'timestamp',     type: 'uint256' },
    { name: 'metadata',      type: 'bytes32' },
    { name: 'builder',       type: 'bytes32' },
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
    this._negRiskCache = {};
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

  defaultHeaders() {
    return {
      'User-Agent': '@polymarket/clob-client',
      'Accept': '*/*',
      'Connection': 'keep-alive',
    };
  }

  async fetch(url, opts = {}) {
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15000);
      const defaultHeaders = {
        'User-Agent': '@polymarket/clob-client',
        'Accept': '*/*',
        'Connection': 'keep-alive',
      };
      const mergedHeaders = Object.assign({}, defaultHeaders, opts.headers || {});
      const r = await fetch(url, { signal: ac.signal, ...opts, headers: mergedHeaders });
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
        // Check what the CLOB sees for this wallet's balance + allowance
        this._checkBalanceAllowance().catch(() => {});
        return true;
      }
      this.logFn('❌ Auth failed: ' + JSON.stringify(result));
      return false;
    } catch (e) {
      this.logFn('❌ Auth error: ' + e.message);
      return false;
    }
  }

  // ── Check CLOB balance-allowance (what the exchange sees for this wallet) ──
  async _checkBalanceAllowance() {
    try {
      const endpoint = '/balance-allowance';
      const qs = `?asset_type=COLLATERAL&signature_type=${SIGNATURE_TYPE}`;
      const headers = this.l2Headers('GET', endpoint);
      const allHeaders = { ...this.defaultHeaders(), ...headers };
      const r = await fetch(`${CLOB_API}${endpoint}${qs}`, { headers: allHeaders, signal: AbortSignal.timeout(10000) });
      const data = await r.json();
      this.logFn(`💳 CLOB balance-allowance: ${JSON.stringify(data)}`);
    } catch (e) {
      this.logFn(`⚠️ balance-allowance check failed: ${e.message}`);
    }
  }

  // ── Get total available balance ──
  // Checks USDC + PUSD (Polymarket USD) + CTF exchange deposit.
  // In proxy wallet mode, all checks are against the funder (Deposit Wallet).
  // Supports POLYGON_RPC_URL env var for custom RPC endpoints.
  async getBalance() {
    const checkAddress = this.funderAddress;
    // getUserContext(address) selector 0x27e235e3 — reads deposited collateral balance from exchange
    const balSlot = '0x27e235e3' + checkAddress.substring(2).padStart(64, '0');
    
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
          // Wallet USDC balances
          {jsonrpc:'2.0',id:1,method:'eth_call',params:[{to:USDC_TOKEN_OLD,data:'0x70a08231'+checkAddress.substring(2).padStart(64,'0')},'latest']},
          {jsonrpc:'2.0',id:2,method:'eth_call',params:[{to:USDC_TOKEN_NEW,data:'0x70a08231'+checkAddress.substring(2).padStart(64,'0')},'latest']},
          {jsonrpc:'2.0',id:3,method:'eth_call',params:[{to:PUSD_TOKEN,   data:'0x70a08231'+checkAddress.substring(2).padStart(64,'0')},'latest']},
          // NEW V2 standard exchange deposit (active contract)
          {jsonrpc:'2.0',id:4,method:'eth_call',params:[{to:STANDARD_EXCHANGE, data:balSlot},'latest']},
          // Old CTF exchange deposit (kept for legacy, likely 0)
          {jsonrpc:'2.0',id:5,method:'eth_call',params:[{to:'0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', data:balSlot},'latest']},
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
        const parse = (r) => r?.result && r.result !== '0x' ? Number(BigInt(r.result)) / 1e6 : 0;
        const usdcOld = parse(results[0]);
        const usdcNew = parse(results[1]);
        const pusdBal = parse(results[2]);
        const exNew   = parse(results[3]); // V2 exchange deposit
        const exOld   = parse(results[4]); // old exchange (legacy)
        const total = usdcOld + usdcNew + pusdBal + exNew + exOld;
        this.logFn(`💳 wallet USDC=$${(usdcOld+usdcNew).toFixed(2)} PUSD=$${pusdBal.toFixed(2)} exV2=$${exNew.toFixed(2)} exOld=$${exOld.toFixed(2)}`);
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

  // ── Fetch neg_risk flag for a token (cached) ──
  async getNegRisk(tokenId) {
    const cached = this._negRiskCache[tokenId];
    if (cached && Date.now() - cached.ts < 600000) return cached.negRisk;
    try {
      const data = await this.fetch(`${CLOB_API}/markets/${tokenId}`);
      const negRisk = !!(data && data.neg_risk);
      this._negRiskCache[tokenId] = { negRisk, ts: Date.now() };
      return negRisk;
    } catch (_) { /* ignore */ }
    return false; // BTC 15m markets are always non-neg-risk
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

    // Fetch market context: tick size + neg_risk (determines which exchange contract to use)
    const [tickSize, negRisk] = await Promise.all([
      this.getTickSize(tokenId),
      this.getNegRisk(tokenId),
    ]);
    const domainData = getOrderDomainData(negRisk);
    const scale = Math.pow(10, COLLATERAL_DECIMALS);
    const rawPrice = Math.round(price / tickSize) * tickSize;

    // Amounts — V2 has no feeRateBps in the struct
    let makerAmount, takerAmount;
    if (side === 'BUY') {
      const takerAmt = size;
      let makerAmt = takerAmt * rawPrice;
      if ((makerAmt * 1e5) % 1 !== 0) makerAmt = Math.floor(makerAmt * 1e5 + 0.5) / 1e5;
      makerAmount = BigInt(Math.floor(makerAmt * scale)).toString();
      takerAmount = BigInt(Math.floor(takerAmt * scale)).toString();
    } else {
      const makerAmt = size;
      let takerAmt = makerAmt * rawPrice;
      if ((takerAmt * 1e5) % 1 !== 0) takerAmt = Math.floor(takerAmt * 1e5 + 0.5) / 1e5;
      makerAmount = BigInt(Math.floor(makerAmt * scale)).toString();
      takerAmount = BigInt(Math.floor(takerAmt * scale)).toString();
    }

    // Salt: random 53-bit integer (capped so JSON number round-trip is lossless)
    const saltBytes = crypto.randomBytes(8);
    const saltBig = (BigInt('0x' + saltBytes.toString('hex'))) & ((1n << 53n) - 1n);
    const salt = saltBig.toString();

    // timestamp = Date.now() in milliseconds (as bigint for EIP712, as string for POST)
    const timestamp = Date.now().toString();
    const eip712Side = side === 'BUY' ? 0 : 1;

    // V2 EIP-712 order data — new struct
    const orderData = {
      salt:          saltBig,
      maker:         this.funderAddress,
      signer:        this.signerAddress,
      tokenId:       BigInt(tokenId),
      makerAmount:   BigInt(makerAmount),
      takerAmount:   BigInt(takerAmount),
      side:          eip712Side,
      signatureType: SIGNATURE_TYPE,
      timestamp:     BigInt(timestamp),
      metadata:      BYTES32_ZERO,
      builder:       BYTES32_ZERO,
    };

    const signature = await this.wallet.signTypedData(domainData, ORDER_TYPE, orderData);

    // Verify locally
    const recovered = ethers.verifyTypedData(domainData, ORDER_TYPE, orderData, signature);
    const sigValid = recovered.toLowerCase() === this.signerAddress.toLowerCase();
    this.logFn(`🔏 V2 sig=${sigValid?'✅':'❌'} exchange=${domainData.verifyingContract.substring(0,10)} negRisk=${negRisk}`);
    this.logFn(`🔏 salt=${salt} ts=${timestamp} maker$=${makerAmount} taker#=${takerAmount}`);

    // V2 POST body — matches ts-sdk createSendOrderPayload exactly
    const orderPayload = {
      deferExec: false,
      order: {
        builder:       BYTES32_ZERO,
        expiration:    '0',
        maker:         this.funderAddress,
        makerAmount,
        metadata:      BYTES32_ZERO,
        salt:          Number.parseInt(salt, 10),
        side,
        signature,
        signatureType: SIGNATURE_TYPE,
        signer:        this.signerAddress,
        takerAmount,
        timestamp,
        tokenId,
      },
      orderType: 'GTC',
      owner: this.apiKey,
    };
    const body = JSON.stringify(orderPayload);
    this.logFn(`📦 POST /order: ${body.replace(signature, s => s.substring(0,16)+'...').substring(0,280)}`);

    const headers = this.l2Headers('POST', '/order', body);
    const allHeaders = { 'Content-Type': 'application/json', ...this.defaultHeaders(), ...headers };
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    const r = await fetch(`${CLOB_API}/order`, { signal: ac.signal, method: 'POST', headers: allHeaders, body });
    clearTimeout(timer);
    const text = await r.text();
    this.logFn(`📨 ORDER ${r.status}: ${text.substring(0, 200)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.substring(0, 200)}`);
    const rawResult = JSON.parse(text);
    const orderId = rawResult.orderID || rawResult.id || 'ok';
    this.logFn(`📤 ${side} ${size}sh@$${rawPrice.toFixed(3)} id:${orderId.toString().substring(0,12)}`);
    return rawResult;
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
