[![make.fun bounty](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/inisejarahabsurd-eng/makefun-agent2-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/inisejarahabsurd-eng/makefun-agent2-u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

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
- Momentum reversal: velocity flips to <= -1.5%/s while the position is still green (>= +5%) — sell into strength before the rug.
- Hard time stop: close any position after 30 minutes regardless of P&L.

## Transcripts

`transcripts.jsonl` records every paper trade executed during the replay window, one JSON object per line. Events:

- `BUY`: entry with the triggering velocity, consistency, coin age, and entry price.
- `SELL`: exit with entry price, realized P&L percent, position peak, and the exit reason (`take-profit`, `stop-loss`, `trailing stop`, `momentum reversal`, `hard time stop`).

Each line is written at decision time by `main.ts` (stdout as JSON lines, mirrored to this file). Sample transcripts from the 6-hour replay are committed here so results are auditable without rerunning the harness.

## Running

```bash
npm start                # node --experimental-strip-types main.ts
node main.ts data.json   # CLI mode: read market data file, emit trade JSON lines
```

No external dependencies. Node >= 22.

## License

MIT — see `LICENSE`.