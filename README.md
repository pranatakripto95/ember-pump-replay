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

Stake is 0.15 SOL per coin: the 1%-of-real-reserve size cap allows it at
20+ SOL of reserve, and the size keeps the fixed transaction fees small
next to the trade.

**Exits** — checked every batch for every held position:

- stop loss at -10% of cost — cut the loser
- take profit at +60% of cost (rarely binds — the trailing stop usually
  exits first)
- trailing stop: once a position peaks at +20%, sell if it falls to 92%
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

## Results (dev window, kit's own grader)

| version | idea | net PnL |
|---|---|---|
| v1 | momentum entry, TP +45% / SL -15% | -2.18 SOL |
| v3 | no fixed TP, trailing only | -1.15 SOL |
| v5 | entry needs reserve ≥ 8 SOL | -0.67 SOL |
| v6 | entry needs reserve ≥ 15 SOL | -0.46 SOL |
| v8 | pullback entry (peak +30%, retrace to 90%) | -0.33 SOL |
| v9 | pullback, stricter (peak +50%, retrace to 80%, reserve ≥ 20 SOL) | -0.01 SOL |
| v10 | same, stake 0.15 SOL | **+0.017 SOL** |
| v12 | trailing keeps 92% of peak | +0.017 SOL |

Final version: **+0.017 SOL net PnL, 72 coins round-tripped, 34.7% win
rate, 3.0% max drawdown** — above holding cash, with guardrails met and
room to spare. The two grading executions reproduce byte for byte.

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
