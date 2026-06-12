# Polymarket Bot — Strategy Reference

## Cricket — Live Moneyline Only (Continuous)

**Market type**: Moneyline (Team A / Team B), no over-by-over or wicket markets.

### Core Principle
Binary price spikes on discrete events (wickets, boundaries, big overs). Crowd overreacts → mean reversion.

### Event → Price → Fade Map

| Event | Price Move | Fade Signal |
|-------|-----------|-------------|
| Early wicket (top order falls) | Fielding team → 0.60-0.65 | Buy batting team (deep lineup recovers) |
| 15+ run over | Batting team → 0.55-0.60 | Buy fielding team (regression) |
| 2 quick wickets in 3 overs | Fielding team → 0.70+ | Buy batting team unless truly dominant bowling lineup |
| Toss won + batting first hype | Batting team → 0.55-0.58 | Hedge/fade — toss advantage is overstated in T20 |
| Set batter reaches 50 | Batting team → 0.60+ | Fade if wickets in hand < 5 |
| Death overs (18-20) boundaries | Batting team spikes hard | Skip fading — death overs trend is real |

### Entry / Exit Rules

- **Entry**: Fade when one side hits ≥0.62 (or ≥0.56 on slow match days)
- **TP**: 0.08-0.12 price improvement from entry (reversion target)
- **STOP**: 0.04-0.06 price against entry (trend continuing)
- **No time exit** — continuous market, no window
- **Re-entry**: Allowed on next spike after STOP

### Edge Source
Polymarket moneyline overreacts to discrete events in a 5-15 ball window, then reverts as the match context normalizes. Batting lineups with depth (6+ proper batsmen) are statistically under-priced right after a wicket.

---

## BTC 5M Fade the Hype (Windowed)

- **Window**: 300 seconds
- **Entry**: One side ≥0.62 → fade it (buy cheap side)
- **Time decay**: Bet size shrinks as window progresses (35%-60% of window)
- **TP**: 0.52 (maker exit = 0% fee)
- **STOP**: 0.06 (taker exit = 0.5% fee)
- **Weekend mode** (Fri-Sun): Threshold 0.56, entry window extended, decay boosted 1.3x
- **Fee on entry**: 0.5% taker

## BTC 15M Extreme Fade (Windowed)

- **Window**: 900 seconds
- **Entry**: One side ≥0.68 → fade it (stricter, larger TF)
- **Time decay**: Bet size shrinks (30%-50% of window)
- **TP**: 0.50 (maker exit = 0% fee)
- **STOP**: 0.04 (taker exit = 0.5% fee)
- **Weekend mode**: Threshold 0.62, decay boosted 1.3x

## FIFA World Cup — Cross-Market (Continuous)

Auto-discovers WC matches. Triangular arbitrage + volatility fade across Yes/No sub-markets. 10% base bet, TP 0.45, STOP 0.03.

---

*Last updated: 2026-06-12*

---

## Tennis — Live Moneyline Only (Continuous)

**Market type**: Player A / Player B moneyline. No set betting, no game totals.

### Core Principle
Same as cricket — binary price spikes on discrete events (breaks, sets, tie-breaks). Crowd overreacts to momentum shifts.

### Event → Price → Fade Map

| Event | Price Move | Fade Signal |
|-------|-----------|-------------|
| First set won (men's best-of-3) | Winner → 0.75-0.85 | ✅ **Fade** — ATP first-set winner wins ~73% but market prices at 0.80-0.85. 7-12 point gap to fade. |
| First set won (women's) | Winner → 0.82-0.90 | ⚠️ Skip — WTA first-set winner wins ~82%, market is accurate |
| Break point saved by server | Server bumps +0.05-0.08 | ✅ **Fade** — server was under pressure, returner in rhythm |
| Break conceded | Returner jumps +0.10-0.15 | ⚠️ Caution — can trend if returner is dominating |
| Tie-break lost (close, 7-5 or 7-6) | Loser drops 0.12-0.20 | ✅ **Buy the dip** — competitive TB means players are evenly matched |
| Medical timeout called | Injured player drops 0.10-0.15 | ✅ **Buy if they hold serve immediately after** — no real issue |
| Serving for match (up break, final set) | Server → 0.88-0.95 | ✅ **Fade** — hold rate under pressure is 85-88%, not 95% |
| Quick break to start 2nd set | Returner jumps again | ⚠️ Skip — this is a genuine trend, not overreaction |
| Double fault on break point | Server price craters | ✅ **Fade** — mental error, point quality not indicative of full match |

### Entry / Exit Rules

- **Entry**: Fade when one side spikes ≥0.65-0.68 from a discrete event
- **TP**: 0.08-0.12 reversion (the crowd settles back)
- **STOP**: 0.05-0.06 if the price keeps trending against you (real shift)
- **No time exit** — continuous market, no window
- **Re-entry**: Allowed if another spike event occurs

### Key Distinctions vs Cricket

| Factor | Tennis | Cricket |
|--------|--------|---------|
| Price movement speed | Ball-by-ball (every point) | Over-by-over |
| Spike magnitude | 0.10-0.20 on set loss | 0.08-0.15 on wicket |
| Mean reversion speed | Within 2-3 games (~10 min) | Within 3-5 overs (~15 min) |
| Trend risk | Lower — breaks are common | Higher — wickets compound |

*Added: 2026-06-12*

---

## Finding Live Tennis Matches via API

### Step 1: Find the ATP series
```bash
# ATP events use slug pattern: atp-{player1}-{player2}-YYYY-MM-DD
# Get series info from Gamma API
curl -s "https://gamma-api.polymarket.com/events?slug=atp-{player1}-{player2}-YYYY-MM-DD"
```

### Step 2: Extract the moneyline market
- Filter markets for `question` that is just the player names (no "Set", "Total", "Handicap")
- Extract `clobTokenIds` — first = first-named player, second = second-named player
- Check `acceptingOrders: true` and `liquidityNum` > 1000

### Step 3: Poll live prices via CLOB
```bash
curl -s "https://clob.polymarket.com/price?token_id={TOKEN_ID}&side=BUY"
curl -s "https://clob.polymarket.com/price?token_id={TOKEN_ID}&side=SELL"
```

### Step 4: Match state from event data
- `score`: e.g. "7-6(7-2), 3-6, 1-4" (set scores)
- `period`: "S1", "S2", "S3" (current set)
- `live`: true/false
- `ended`: true/false

## Example — Lyon Challenger (June 12, 2026)

**Match**: Dali Blanch vs David Jorda Sanchis
**Score**: 7-6(7-2), 3-6, 1-4 → Sanchis leading S3
**Moneyline**: Blanch 0.011, Sanchis 0.989 (Sanchis about to win)

**Price movements through the match** (observed pattern):
1. **Pre-match**: Sanchis favored at ~0.615
2. **Blanch wins Set 1 (TB)**: Blanch spikes to ~0.65+ — ✅ **Fade opportunity** (1 set ≠ match win)
3. **Sanchis wins Set 2**: Re-balances around 0.50 — ⚠️ Holding pattern
4. **Sanchis breaks early S3**: Sanchis surges to 0.85+ — ⚠️ Could fade if early break
5. **Sanchis consolidates to 4-1**: Sanchis 0.989 — ✅ Trend is real, skip fading

**What to trade**: Only the moneyline (highest liquidity at ~$89K). Set/games markets exist but lack liquidity.

*Added: 2026-06-12*
