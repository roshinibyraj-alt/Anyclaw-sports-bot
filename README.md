# Polymarket Wallet Copy — Paper Only

This app observes completed public trades from a Polymarket wallet, simulates copying new trades against the visible public order book, and summarizes repeated behavior as descriptive strategy clues.

The prior live order-entry code has been removed. This replacement has no private-key, CLOB-authentication, signing, or order-submission module. Every state and status label is paper-only.

## What it does

- Polls Polymarket Data API v2 for public completed trades from `SOURCE_WALLET`.
- On first run, stores a recent sample for analysis but does **not** replay those old trades into the paper ledger.
- For each new observed trade, tries to simulate the same share amount at the then-current visible CLOB book:
  - Source BUY: paper sweeps visible asks.
  - Source SELL: paper sells no more than the matching shares held.
- Tracks source fill price separately from simulated copy fill price and reports the observed-feed-to-copy delay.
- Uses Polymarket's public token fee-rate endpoint to estimate taker fees. If the fee cannot be read, it flags that copy and the account fee status rather than claiming a fee-free result.
- Refreshes visible bids and checks Gamma market resolution for paper holdings.
- Detects descriptive patterns such as repeated buys, two-outcome exposure, price averaging, late-window fills, and changes in trade size/cadence.
- Persists the paper ledger as atomic JSON files under `DATA_DIR`.

Strategy detections are statistical descriptions, not proof of the wallet's intent. Public activity only exposes completed fills; it cannot reveal private signals, unfilled orders, or reliably establish whether an original order was a resting limit or a marketable order. The copy simulation uses the live public book after the source fill appears, so it can be slower and receive a different price. It does not simulate maker rebates.

## Run locally

Requires Node.js 20 or newer. There are no runtime npm dependencies.

```sh
SOURCE_WALLET=0xeebde7a0e019a63e6b476eb425505b7b3e6eba30 npm start
```

The dashboard is served from `/`. Health and data endpoints:

- `GET /api/health`
- `GET /api/snapshot`
- `GET /api/events` (server-sent updates)
- `POST /api/copier/pause`
- `POST /api/copier/resume`

## Railway setup

1. Connect this repository to a Railway Node service. `railway.json` provides the Nixpacks build, `npm start`, and `/api/health` health check.
2. Add a persistent Railway volume mounted at `/data`.
3. Set `DATA_DIR=/data`.
4. Set or confirm `SOURCE_WALLET`, `PAPER_START_BALANCE`, `COPY_MULTIPLIER`, and `POLL_INTERVAL_MS`.
5. Deploy the service. `PORT` is supplied by Railway.

No API keys, private keys, wallet signer, or live-trading variables are required.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `SOURCE_WALLET` | Provided public wallet | Wallet activity to observe |
| `PAPER_START_BALANCE` | `10000` | Starting simulated cash in USDC |
| `COPY_MULTIPLIER` | `1` | Paper share quantity relative to each observed fill |
| `POLL_INTERVAL_MS` | `1000` | Minimum time between public activity checks; errors back off |
| `DATA_DIR` | `./data` | Directory for durable paper ledger files |
| `PORT` | `3000` | HTTP port; Railway sets this automatically |
