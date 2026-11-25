# Ember Pump Replay

[![make.fun](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/pranatakripto95/ember-pump-replay/rank.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/pranatakripto95/ember-pump-replay/reward.svg)](https://make.fun/competitions/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper-trading bot for the Pump.fun Replay Sprint: it trades 10 SOL of
paper money on a 24h replay of pump.fun bonding-curve activity. No real
funds, no real trades — the house replay scorer runs this bot over recorded
chain data and scores what it would have made.

## The idea

Most pump.fun coins die within minutes. In the dev window (1,223 coins,
~127k trades) the median coin peaks only +15% over its first trade and ends
-6% down — and after any momentum signal the median coin is -3% within 50
slots and -25% within 800. Chasing pops loses, however the exits are tuned:
momentum entries, tight stops and fast scalps all graded negative.

But the tail is fat: 184 coins spike 2x or more, 99 hit 3x, 60 hit 5x, and
35 complete (migrate) at roughly 8–15x their first trade. And coins that
have already built real demand behave differently from fresh launches. So
this bot buys the **pullback on proven coins, not the pop**.

## Strategy

**Entry** — all must hold:

- real SOL reserve at least 20 SOL (proven liquidity and demand)
- at least 30 trades, with buys at least 55% of traded SOL
- the coin has peaked at least +50% over its first price — it proved it
  can run
- price has since retraced to at most 80% of that peak — buy the dip on
  a proven runner, not the top
- one buy per mint, ever — breadth beats doubling down

Stake is 0.05 SOL per coin.

**Exits** — checked every batch for every held position:

- stop loss at -10% of cost — cut the loser
- take profit at +35% of cost
- trailing stop: once a position peaks at +20%, sell if it falls to 88%
  of that peak — 2–10x runners are banked, not capped
- stall exit: held over ~6 minutes and still under water — sell and free
  the slot for the next coin
- no position squats longer than ~16 minutes below +15%

A buy counts only when it fills; a rejected or failed buy is retried after
a short cooldown while the entry window is still open. Sells use wide
slippage so exits execute; buys use 30% slippage so fast movers are not
rejected for moving in the 2-slot latency.

Round-trip cost is ~1.25% curve fees each way plus 0.000105 SOL in
transaction fees per order. The guardrail needs at least 20 coins
round-tripped at 0.01 SOL or more, with max drawdown under 50%.

## Results — chosen for robustness, not the luckiest dev score

Every variant was graded on the dev window **and** on rebuilt stress
copies of it. The variant with the best dev score (+0.044 SOL) had the
worst stress median (-0.21 SOL) — it leaned on a few dev coins. This
variant was picked for the best stress median instead:

| variant | dev net PnL | stress median (10 copies) | stress mean | coins | win rate | max drawdown |
|---|---|---|---|---|---|---|
| v8 pullback, loose | -0.33 SOL | -0.275 SOL | -0.29 SOL | 132 | 31.8% | 4.3% |
| v12 stake 0.15, trail 92% | +0.044 SOL | -0.21 SOL (20 copies) | -0.28 SOL | 72 | 34.7% | 3.3% |
| v9c stake 0.10 | +0.006 SOL | -0.10 SOL | -0.14 SOL | 72 | 34.7% | 2.0% |
| v9b trail 92% | -0.025 SOL | -0.055 SOL | -0.08 SOL | 72 | 34.7% | 1.2% |
| **v9 (this bot)** | **-0.01 SOL** | **-0.06 SOL** | **-0.07 SOL** | **72** | **34.7%** | **1.1%** |

Final version: **dev -0.01 SOL (breakeven), stress median -0.06 SOL over
10 copies (range -0.21..+0.07), 72 coins round-tripped, 34.7% win rate,
1.1% max drawdown** — guardrails met with room to spare, and the
tightest, most robust distribution of any variant tested. The two grading
executions reproduce byte for byte.

## Determinism

Every decision is pure integer (BigInt) math on the replay state. No clock,
no environment, no randomness — the two grading runs agree byte for byte.

## Layout

- `main.ts` — the whole strategy (hand-written, zero dependencies)
- `vendor/makefun-bot.ts` — the kit's replay shim, copied byte-identical
  from the competition kit (`sdk/ts/makefun-bot.ts`)

Run locally with the kit's grader:

```sh
node cli/makefun.mjs grade-local --kit <kit dir> --bot . --driver process
```
