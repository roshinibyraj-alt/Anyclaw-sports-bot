'use strict';

const { privateKeyToAccount } = require('viem/accounts');
const { createWalletClient, http } = require('viem');
const { polygon } = require('viem/chains');
const {
  ClobClient, SignatureTypeV2, AssetType, Side, OrderType,
} = require('@polymarket/clob-client-v2');
const { deriveDepositWallet } = require('@polymarket/builder-relayer-client');

const CLOB_HOST = 'https://clob.polymarket.com';
const CHAIN_ID = 137;
const DEPOSIT_WALLET_FACTORY    = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07';
const DEPOSIT_WALLET_IMPL_POL   = '0x58CA52ebe0DadfdF531Cde7062e76746de4Db1eB';

class PolymarketTrader {
  constructor(privateKey, funderAddr) {
    const pk = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;

    this._account = privateKeyToAccount(pk);
    this.address  = this._account.address;

    this._walletClient = createWalletClient({
      account: this._account,
      chain:   polygon,
      transport: http(),
    });

    // Deposit wallet: deterministic from EOA, holds the $190.37
    this.depositWallet = funderAddr
      || deriveDepositWallet(this.address, DEPOSIT_WALLET_FACTORY, DEPOSIT_WALLET_IMPL_POL);

    this._clob  = null;
    this.apiKey = null;
    this.balance = 0;
    this._log   = () => {};
  }

  setLogFn(fn) { this._log = fn; }

  async authenticate() {
    this._log(`🔑 Authenticating with Polymarket CLOB...`);

    // Step 1 – derive API credentials (L1 auth, no funds needed)
    const tempClient = new ClobClient({
      host:          CLOB_HOST,
      chain:         CHAIN_ID,
      signer:        this._walletClient,
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: this.depositWallet,
    });

    const creds = await tempClient.createOrDeriveApiKey();
    this.apiKey = creds.key;

    // Step 2 – full client with L2 API credentials
    this._clob = new ClobClient({
      host:          CLOB_HOST,
      chain:         CHAIN_ID,
      signer:        this._walletClient,
      creds,
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: this.depositWallet,
    });

    this._log(`✅ Authenticated: ${this.address}`);
    this._log(`💼 Deposit wallet: ${this.depositWallet}`);

    return { apiKey: this.apiKey };
  }

  async getBalance() {
    try {
      const resp = await this._clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const raw  = parseFloat(resp?.balance ?? '0');
      const bal  = raw / 1e6;
      this.balance = bal;
      return bal;
    } catch (_) {
      return this.balance;
    }
  }

  async getBalanceAllowance() {
    try {
      const resp = await this._clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
      const raw  = parseFloat(resp?.balance ?? '0');
      const bal  = (raw / 1e6).toFixed(2);
      this.balance = parseFloat(bal);
      const allow = resp?.allowances
        ? Object.values(resp.allowances).map(v => parseFloat(v) > 1e30 ? '∞' : v).join(', ')
        : '?';
      return `💳 CLOB balance (deposit wallet): $${bal} | allowances: ${allow}`;
    } catch (e) {
      return `💳 balance fetch failed: ${e.message}`;
    }
  }

  async getOpenOrders() {
    return this._clob.getOpenOrders();
  }

  async cancelOrder(orderId) {
    return this._clob.cancelOrder(orderId);
  }

  async placeOrder(tokenId, side, price, size) {
    const sideVal = side === 'BUY' ? Side.BUY : Side.SELL;

    let tickSize = '0.01';
    let negRisk  = false;
    try {
      tickSize = (await this._clob.getTickSize(tokenId)) ?? '0.01';
      negRisk  = (await this._clob.getNegRisk(tokenId)) ?? false;
    } catch (_) {}

    const resp = await this._clob.createAndPostOrder(
      { tokenID: tokenId, price, size, side: sideVal },
      { tickSize, negRisk },
      OrderType.GTC,
    );

    const id = resp?.orderID ?? resp?.id ?? null;
    if (!id) throw new Error(`No order ID returned: ${JSON.stringify(resp).substring(0, 100)}`);
    this._log(`🔏 ORDER submitted id:${id}`);
    return { id };
  }

  // Compat stubs (used by local test harness only)
  defaultHeaders() { return { 'Content-Type': 'application/json' }; }
  l2Headers()      { return {}; }
}

module.exports = PolymarketTrader;
