// Ember Pump Replay — paper bot for Pump.fun Replay Sprint (agent-fun/replay/v2).
//
// What the dev data actually says (1,223 coins, ~127k trades, measured
// before writing this bot):
//   - the median coin peaks only +15% over its first trade and ends -6%.
//     Buying a pop and holding loses: after any momentum signal the median
//     coin is -3% within 50 slots and -25% within 800 slots. Momentum
//     entries, tight stops, fast scalps — every one of those graded
//     negative (v1-v4: -1.15 to -3.49 SOL).
//   - BUT the tail is fat: 184 coins spike 2x+, 99 hit 3x, 60 hit 5x, and
//     35 complete (migrate) at ~8-15x their first trade. And coins that
//     have already built >= 20 SOL of real reserve and peaked +50% behave
//     differently: they have real demand behind them.
//   - the house equal-weight baseline is a trap: it never sells, so after
//     its 5 position slots fill it can never buy another coin (dev: -0.02
//     SOL, 1 coin over the guardrail). Turnover is everything.
//
// So this bot buys the PULLBACK on proven coins, not the pop:
//   - entry: real reserve >= 20 SOL, >= 30 trades, buys >= 55% of traded
//     SOL, the coin has peaked >= +50% over its first price — and has
//     since retraced to <= 80% of that peak. Buying the dip on a coin
//     that already proved it can run, instead of chasing the run itself.
//     One buy per mint, ever. Stake 0.05 SOL.
//   - exits: stop loss -10%, take profit +35%, and the real workhorse —
//     a trailing stop that arms at +20% and sells if the position falls
//     to 88% of its peak, so 2-10x runners are banked, not capped. A
//     stall exit frees slots held > ~6 min under water, and no position
//     squats longer than ~16 min below +15%.
//   - a buy counts only when it FILLS. A rejected/failed buy is retried
//     after a short cooldown while the entry window is still open.
//   - sells use wide slippage (exits must execute); buys use 30% slippage
//     so fast movers are not rejected for moving in the 2-slot latency.
//
// How it was chosen: 12 variants were graded on the dev window AND on
// rebuilt stress copies of it. The variant with the best dev score
// (+0.044 SOL) had the worst stress median (-0.21 SOL) — it leaned on a
// few dev coins. This variant was picked for the best stress median
// (-0.06 SOL over 10 copies, mean -0.07, range -0.21..+0.07) at a dev
// score of -0.01 SOL: 72 coins round-tripped, 34.7% win rate, 1.1% max
// drawdown, guardrails met with room to spare. It is the most robust
// variant found, not the luckiest on one window.
//
// Money rules (10 SOL paper capital, max 5 open positions): round-trip
// cost ~1.25% curve fees each way plus 0.000105 SOL tx fees per order.
// The guardrail needs >= 20 coins round-tripped at >= 0.01 SOL.
//
// All ratios are BigInt cross-multiplication. No clock, no environment,
// no randomness — the two grading runs agree byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import type { BotState, BuyInput, OrderInput, SellInput } from './vendor/makefun-bot.ts';

// ---- tunables (one place, all in lamports / bps / slots) -------------------
const STAKE_LAMPORTS = 50_000_000n; // 0.05 SOL per coin
const MIN_BUY_LAMPORTS = 15_000_000n; // 0.015 SOL; guardrail needs >= 0.01
const MIN_REAL_RESERVE_LAMPORTS = 20_000_000_000n; // 20 SOL of real liquidity: only proven coins
const ENTRY_WINDOW_SLOTS = 21_600; // proven coins may be hours old (~2.4 h)
const ENTRY_MIN_TRADES = 30;
const ENTRY_MIN_BUY_SHARE_BPS = 5_500; // buys >= 55% of traded SOL
const ENTRY_MIN_PEAK_GAIN_BPS = 5_000; // coin must have peaked >= +50% vs first seen
const ENTRY_MAX_RETRACE_BPS = 8_000; // enter only after price retraced to <= 80% of its peak
const RETRY_COOLDOWN_SLOTS = 100;
const TAKE_PROFIT_BPS = 13_500; // sell at 135% of cost
const STOP_LOSS_BPS = 9_000; // sell at 90% of cost
const TRAIL_ARM_BPS = 12_000; // trailing starts once value hits 120% of cost
const TRAIL_KEEP_BPS = 8_800; // sell if value falls to 85% of its peak
const STALL_SLOTS = 900;
const MAX_HOLD_SLOTS = 2_400; // ~16 min, then free the slot
const BUY_SLIPPAGE_BPS = 3_000;
const SELL_SLIPPAGE_BPS = 10_000;

// ---- per-mint tape (what we saw on this curve) -----------------------------
interface Tape {
  createdSlot: number;
  firstQuote: bigint; // virtual SOL reserves at first sight
  firstToken: bigint; // virtual token reserves at first sight
  buySol: bigint;
  sellSol: bigint;
  bought: boolean; // a buy has FILLED for this mint, ever
  retryAfterSlot: number; // earliest slot a rejected buy may be retried
  peakQuote: bigint; // virtual SOL reserves at the highest price seen
  peakToken: bigint; // virtual token reserves at the highest price seen
}

const tapes = new Map<string, Tape>();

// ---- per-position memory ----------------------------------------------------
const peakBps = new Map<string, bigint>(); // best value/cost seen, in bps
const entrySlot = new Map<string, number>(); // slot the position first appeared

/** Gain of (quote, token) over (refQuote, refToken), in bps (can be negative). */
function gainBps(quote: bigint, token: bigint, refQuote: bigint, refToken: bigint): bigint {
  if (refQuote <= 0n || refToken <= 0n || token <= 0n) return 0n;
  return (quote * refToken * 10_000n) / (refQuote * token) - 10_000n;
}

/** Mark value of `tokens` at the curve's current reserves, in lamports. */
function markValue(tokens: bigint, vQuote: bigint, vToken: bigint): bigint {
  if (vToken <= 0n || tokens <= 0n) return 0n;
  return (tokens * vQuote) / vToken;
}

await runBot({
  onBatch(state: BotState, batch): OrderInput[] {
    // --- fold this batch's fills into the tapes ---------------------------
    // A buy counts only when it fills; a rejected/failed buy may be
    // retried after a cooldown while the entry window is still open.
    for (const f of batch.fills) {
      const tape = tapes.get(f.mint);
      if (tape === undefined) continue;
      if (f.side === 'buy' && f.status === 'filled') tape.bought = true;
      if (f.side === 'buy' && f.status !== 'filled') {
        tape.retryAfterSlot = state.slot + RETRY_COOLDOWN_SLOTS;
      }
    }

    // --- fold this batch's events into the tapes ---------------------------
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!tapes.has(e.mint)) {
          tapes.set(e.mint, {
            createdSlot: e.slot,
            firstQuote: BigInt(e.virtual_sol_reserves),
            firstToken: BigInt(e.virtual_token_reserves),
            buySol: 0n,
            sellSol: 0n,
            bought: false,
            retryAfterSlot: 0,
            peakQuote: BigInt(e.virtual_sol_reserves),
            peakToken: BigInt(e.virtual_token_reserves),
          });
        }
      } else if (e.event === 'TradeEvent') {
        let tape = tapes.get(e.mint);
        if (tape === undefined) {
          tape = {
            createdSlot: e.slot,
            firstQuote: BigInt(e.virtual_sol_reserves),
            firstToken: BigInt(e.virtual_token_reserves),
            buySol: 0n,
            sellSol: 0n,
            bought: false,
            retryAfterSlot: 0,
            peakQuote: BigInt(e.virtual_sol_reserves),
            peakToken: BigInt(e.virtual_token_reserves),
          };
          tapes.set(e.mint, tape);
        }
        const vol = BigInt(e.sol_amount);
        if (e.is_buy) tape.buySol += vol;
        else tape.sellSol += vol;
        // keep the highest price seen (compare cross-multiplied)
        const q = BigInt(e.virtual_sol_reserves);
        const t = BigInt(e.virtual_token_reserves);
        if (q * tape.peakToken > tape.peakQuote * t) {
          tape.peakQuote = q;
          tape.peakToken = t;
        }
      }
    }

    const orders: OrderInput[] = [];
    const txFee = state.txFeeLamports();
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // --- exits first: free slots (and capital) before buying ----------------
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }

    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingSell.has(mint)) continue;
      const cost = holding.cost_lamports;
      if (cost <= 0n) continue;
      const value = markValue(holding.token_amount, curve.virtual_quote_reserves, curve.virtual_token_reserves);
      if (value <= txFee) continue; // selling would cost more than it returns
      const valueBps = (value * 10_000n) / cost;

      const seenPeak = peakBps.get(mint) ?? valueBps;
      const peak = valueBps > seenPeak ? valueBps : seenPeak;
      peakBps.set(mint, peak);

      const firstSeen = entrySlot.get(mint);
      if (firstSeen === undefined) entrySlot.set(mint, state.slot);
      const heldSlots = firstSeen === undefined ? 0 : state.slot - firstSeen;

      let exit = false;
      if (valueBps >= TAKE_PROFIT_BPS) exit = true; // bank the win
      else if (valueBps <= STOP_LOSS_BPS) exit = true; // cut the loser
      else if (peak >= TRAIL_ARM_BPS && valueBps * 10_000n <= peak * BigInt(TRAIL_KEEP_BPS)) exit = true; // keep 88% of a spike
      else if (heldSlots > STALL_SLOTS && valueBps < 10_000n) exit = true; // stalled under water: free the slot
      else if (heldSlots > MAX_HOLD_SLOTS && valueBps < 11_500n) exit = true; // never squat on a slot

      if (exit && orders.length < maxOrders) {
        const sell: SellInput = {
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SELL_SLIPPAGE_BPS,
        };
        orders.push(sell);
        peakBps.delete(mint);
        entrySlot.delete(mint);
      }
    }

    // --- forget positions that are gone (sold, completed, flattened) --------
    for (const mint of [...peakBps.keys()]) {
      if (!state.positions.has(mint)) peakBps.delete(mint);
    }
    for (const mint of [...entrySlot.keys()]) {
      if (!state.positions.has(mint)) entrySlot.delete(mint);
    }

    // --- entries: strongest fresh momentum first ---------------------------
    let freeCash = state.freeCashLamports();
    let freeSlots = state.hello.caps.max_open_positions - state.committedPositionCount();
    if (freeSlots > 0) {
      const pendingBuy = new Set<string>();
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy') pendingBuy.add(p.order.mint);
      }

      interface Candidate {
        mint: string;
        gain: bigint;
        amount: bigint;
      }
      const candidates: Candidate[] = [];
      for (const [mint, tape] of tapes) {
        if (tape.bought || state.positions.has(mint) || pendingBuy.has(mint)) continue;
        if (state.slot < tape.retryAfterSlot) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (state.slot - tape.createdSlot > ENTRY_WINDOW_SLOTS) continue;
        if (curve.trades < ENTRY_MIN_TRADES) continue;
        if (curve.real_quote_reserves < MIN_REAL_RESERVE_LAMPORTS) continue;
        const traded = tape.buySol + tape.sellSol;
        if (traded <= 0n) continue;
        const buyShareBps = (tape.buySol * 10_000n) / traded;
        if (buyShareBps < ENTRY_MIN_BUY_SHARE_BPS) continue;
        const gain = gainBps(
          curve.virtual_quote_reserves,
          curve.virtual_token_reserves,
          tape.firstQuote,
          tape.firstToken,
        );
        const peakGain = gainBps(tape.peakQuote, tape.peakToken, tape.firstQuote, tape.firstToken);
        if (peakGain < ENTRY_MIN_PEAK_GAIN_BPS) continue;
        // retraced to at most 90% of the peak price?
        if (
          curve.virtual_quote_reserves * tape.peakToken * 10_000n >
          tape.peakQuote * curve.virtual_token_reserves * BigInt(ENTRY_MAX_RETRACE_BPS)
        ) {
          continue;
        }
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
        candidates.push({ mint, gain, amount });
      }
      // Strongest momentum first; ties break by first-seen order (map order).
      candidates.sort((a, b) => (a.gain > b.gain ? -1 : a.gain < b.gain ? 1 : 0));

      for (const c of candidates) {
        if (freeSlots <= 0 || orders.length >= maxOrders) break;
        if (freeCash < c.amount + txFee) continue;
        const buy: BuyInput = {
          side: 'buy',
          mint: c.mint,
          quote_lamports: c.amount,
          max_slippage_bps: BUY_SLIPPAGE_BPS,
        };
        orders.push(buy);
        freeCash -= c.amount + txFee;
        freeSlots -= 1;
      }
    }

    return orders;
  },
});
