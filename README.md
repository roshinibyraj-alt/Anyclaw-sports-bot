# Polymarket Sports Bot

Multi-sport trading bot for Polymarket — Tennis, Cricket, Football, and FIFA World Cup.

## Architecture

```
bot.js             FIFA World Cup cross-market arb strategy
sports-bot.js      Tennis/Cricket/Football moneyline fade strategy
index.js           Express + Socket.IO server
index.html         Mobile-friendly dashboard
```

## Strategies

### Sports (Tennis, Cricket, Football)
- **Moneyline fade**: Fade when one side is heavily favored (≥0.60)
- Takes profit on reversion, stops on trend continuation
- Line discovery via Polymarket Gamma API

### FIFA World Cup
- **Cross-market arb**: Trades across draw/home/away sub-markets
- Triangular arbitrage and spike fading

## Setup

```bash
pnpm install
export PRIVATE_KEY="0x..."
pnpm start
```

Open http://localhost:3000

## Fees (Polymarket)

Fees are fetched per-market from the CLOB API. Sports = 3% taker, 0% maker.

## Dashboard

Mobile-friendly real-time dashboard shows all matches, positions, and trade history.
