# Pump.fun Paper Sprint — Momentum Sniper

Paper-trading strategy bot for the pump.fun 6-hour replay window. TypeScript, Node 22, zero dependencies, single file: `main.ts`.

## Strategy

Momentum sniping with fast exits. pump.fun coins mostly rug, so the bot never buy-and-holds.

**Entry** — buy a coin when all of these hold:

- Enough samples seen (>= 4) to trust velocity.
- Coin is "young": first observed tick within the last 10 minutes (early-entry constraint).
- Trailing 12s price velocity >= 0.4%/s.
- Price rose on >= 70% of recent ticks (spike consistency, filters one-tick noise).
- Under 3 concurrent positions; 20s per-coin cooldown after any exit.

**Exit** — sell on the first trigger:

- Take-profit: +35%.
- Stop-loss: -12% (tight — rug velocity is brutal).
- Trailing stop: 10% giveback from the position's peak price.
- Momentum reversal: velocity flips to <= -1.5%/s while the position is still green (>= +5%) — sell into strength before the dump completes.
- Hard time stop: 90s max hold.

**Sizing** — 10% of current equity per trade (computed from paper cash + open cost basis), max 3 concurrent positions. Diversifies across independent spikes; a single rug cannot kill the book.

## Harness compatibility

The exact replay API is unknown by design, so `main.ts` adaptively detects it:

1. **Function export** — `main` (or default export) callable as `(event, api)`, `(api, event)`, or `(api)` returning a driver object.
2. **Object export** — `strategy`, `agent`, `bot`, plus `onCandle`, `onTick`, `onMarketUpdate`, `onData`, `handleTick`, `decide`, `step`, `run`, `execute`, `handleEvent` getters, all bound to the same strategy core.
3. **Execution probing** — buy/sell calls are attempted against `buy`, `open`, `enter`, `placeBuy`, `placeOrder`, `submitOrder`, `execute`, `trade`, `order`, `submit`, `createOrder` (and sell equivalents, plus `sellAll`/`closeAll`/`liquidate`/`flatten`), with both object-arg and positional-arg shapes.
4. **CLI mode** — `node --experimental-strip-types main.ts` reads JSONL market events from stdin or `argv[2]`, prints one JSON trade decision per line and a final `summary` object. A harness that only reads decisions can consume these.

Every market-data field alias is normalized: `coin|mint|token|id`, `price|p|lastPrice|close`, `time|ts|timestamp|t` (seconds auto-converted to ms), string-encoded JSON events are parsed.

## Edge cases handled

- Unknown/missing harness API: all execution calls guarded, never throws; bot keeps its own paper book regardless.
- Non-finite, zero, or missing prices: skipped.
- Out-of-order / stale events older than 60s behind the high-water clock: dropped.
- `t` in seconds vs milliseconds: normalized.
- Dust balance (< $1 trade size): no trade.
- History eviction for dead coins; velocity window pruning.
- Harness end/liquidation signals (`side: "sell"` without a coin, `kind: "end"|"closeAll"`): flattens all positions.
- Re-entry after exit blocked for 20s (prevents churn on a dying spike).
- Any exception inside event handling is swallowed — the replay always completes.

## Tuning

All thresholds live in the `CFG` block at the top of `main.ts` (entry velocity, exits, sizing, time stop). They are tuned for a fast 6-hour window: tight stops and a 90s time stop cap downside, 35% take-profit and trailing stop capture spike tops.

## Self-check

```sh
npm run typecheck
node --experimental-strip-types main.ts < sample.jsonl
```

## Entry

Repo: `main.ts` at the pinned commit. Paper trading only; no real funds, no external calls, no dependencies.