// Pump.fun Paper Sprint — fresh-mint momentum sprinter (paper trading only).
//
// Strategy, in one paragraph: buy each new coin at the first moment a
// meaningful trade is even possible — the first trade where its real SOL
// reserves reach 1.2 SOL (below that, the 1%-of-reserves size cap makes a
// 0.01 SOL round trip impossible) — and only on a buy trade. Then exit fast:
// take profit at +6% of cost, stop out at -5%, or sell at market after ~600
// slots, whichever comes first. Fresh coins that just attracted their first
// real SOL of buying keep drifting up a little in the next few minutes far
// more often than they crash, so a short, tight trade harvests that drift
// while the stop keeps the losers small; chasing later momentum or buying
// dips both lose more once the two-slot fill delay and the round-trip fees
// are counted. At most 5 positions are open at once and each mint is traded
// at most once, so the book stays spread across many coins instead of
// concentrating.
//
// Wire: agent-fun/replay/v2 over NDJSON on stdin/stdout. One reply per batch,
// echoing the batch seq. Node stdlib only, no network, no clock, no random
// numbers: every decision comes from slot numbers and the data the harness
// sends, so two runs produce byte-identical replies.

import * as readline from "node:readline";

const LAMPORTS_PER_SOL = 1_000_000_000n;

// --- strategy knobs (all in slots / basis points / lamports) -----------------
const MIN_REAL_LAMPORTS = 1_200_000_000n; // first trade with >= 1.2 SOL real reserves
const TARGET_BUY_LAMPORTS = 500_000_000n; // 0.5 SOL per position
const MIN_BUY_LAMPORTS = 12_000_000n; // 0.012 SOL (round trip must be >= 0.01)
const MAX_BUY_BPS_OF_REAL = 90; // stay under the 100 bps per-reply size cap
const TAKE_PROFIT_BPS = 10600; // sell when value >= 106% of cost
const STOP_LOSS_BPS = 9500; // sell when value <= 95% of cost
const MAX_HOLD_SLOTS = 600; // sell after this many slots no matter what
const MAX_SLIPPAGE_BPS = 500;
const MAX_SELL_SLIPPAGE_BPS = 1000; // exits must get out: tolerate more slippage

// --- small helpers -----------------------------------------------------------
// Value in lamports of `tokens` at price q/t.
function valueLamports(tokens, q, t) {
  if (t === 0n) return 0n;
  return (tokens * q) / t;
}

// --- per-mint bookkeeping ----------------------------------------------------
function newMint(mint, slot) {
  return {
    mint,
    createdSlot: slot,
    complete: false,
    firstQ: 0n,
    firstT: 0n,
    lastQ: 0n,
    lastT: 0n,
    lastRealQ: 0n,
    affordableSeen: false, // already had its first trade with >= MIN_REAL reserves
  };
}

function recordPrice(m, slot, q, t) {
  if (m.firstT === 0n) {
    m.firstQ = q;
    m.firstT = t;
  }
  m.lastQ = q;
  m.lastT = t;
}

// --- bot state ----------------------------------------------------------------
const state = {
  capital: 0n,
  maxOpen: 5,
  maxOrdersPerBatch: 16,
  maxOrderBps: 100,
  cash: 0n,
  positions: new Map(), // mint -> { tokens, cost, entrySlot }
  pendingBuys: new Map(), // clientId -> { mint, amount }
  pendingSells: new Set(), // mints with a sell in flight
  traded: new Set(), // mints already bought once (one round trip each)
  blockedUntil: new Map(), // mint -> slot: cool-off after a rejected buy
  curves: new Map(), // mint -> mint record
  orderSeq: 0,
};

function curveFor(mint, slot) {
  let m = state.curves.get(mint);
  if (m === undefined) {
    m = newMint(mint, slot);
    state.curves.set(mint, m);
  }
  return m;
}

function openCount() {
  const held = new Set(state.positions.keys());
  for (const p of state.pendingBuys.values()) held.add(p.mint);
  return held.size;
}

function freeCash() {
  let free = state.cash;
  for (const p of state.pendingBuys.values()) free -= p.amount;
  free -= BigInt(state.pendingBuys.size + state.pendingSells.size) * 105000n;
  return free;
}

// --- decisions ----------------------------------------------------------------
function decideExits(slot, orders) {
  for (const [mint, pos] of state.positions) {
    if (state.pendingSells.has(mint)) continue;
    const m = state.curves.get(mint);
    if (m === undefined || m.lastT === 0n) continue;
    const value = valueLamports(pos.tokens, m.lastQ, m.lastT);
    const held = slot - pos.entrySlot;
    const takeProfit = value * 10000n >= pos.cost * BigInt(TAKE_PROFIT_BPS);
    const stopLoss = value * 10000n <= pos.cost * BigInt(STOP_LOSS_BPS);
    const tooOld = held >= MAX_HOLD_SLOTS;
    if (takeProfit || stopLoss || tooOld) {
      const id = `s${++state.orderSeq}`;
      orders.push({
        side: "sell",
        client_id: id,
        mint,
        token_amount: pos.tokens.toString(),
        max_slippage_bps: MAX_SELL_SLIPPAGE_BPS,
      });
      state.pendingSells.add(mint);
    }
  }
}

function decideEntries(slot, candidates, orders) {
  for (const cand of candidates) {
    if (orders.length >= state.maxOrdersPerBatch) break;
    if (openCount() >= state.maxOpen) break;
    const mint = cand.mint;
    if (state.traded.has(mint)) continue;
    if (state.positions.has(mint)) continue;
    if (state.pendingSells.has(mint)) continue;
    let alreadyPending = false;
    for (const p of state.pendingBuys.values()) {
      if (p.mint === mint) {
        alreadyPending = true;
        break;
      }
    }
    if (alreadyPending) continue;
    const blocked = state.blockedUntil.get(mint);
    if (blocked !== undefined && slot < blocked) continue;

    const m = state.curves.get(mint);
    if (m === undefined || m.complete || m.lastT === 0n) continue;

    // Size off the reserves at the triggering trade, capped at 90 bps of them
    // so the order stays under the harness's 100 bps per-reply size cap.
    const cap = (cand.realQ * BigInt(MAX_BUY_BPS_OF_REAL)) / 10000n;
    let size = TARGET_BUY_LAMPORTS;
    if (size > cap) size = cap;
    if (size < MIN_BUY_LAMPORTS) continue;
    if (freeCash() < size + 210000n) continue;

    const id = `b${++state.orderSeq}`;
    orders.push({
      side: "buy",
      client_id: id,
      mint,
      quote_lamports: size.toString(),
      max_slippage_bps: MAX_SLIPPAGE_BPS,
    });
    state.pendingBuys.set(id, { mint, amount: size });
    state.traded.add(mint);
  }
}

// --- message handling -----------------------------------------------------------
function applyFills(fills, slot) {
  for (const f of fills) {
    if (f.side === "buy") {
      const p = state.pendingBuys.get(f.client_id);
      state.pendingBuys.delete(f.client_id);
      if (p !== undefined && f.status !== "filled") {
        // Rejected/failed buy: cool off, and allow a later retry.
        state.traded.delete(p.mint);
        state.blockedUntil.set(p.mint, slot + 5000);
      }
    } else {
      // Any resolved sell (filled, rejected or failed) frees the mint for a
      // fresh exit decision next batch. Without this, one rejected sell
      // would jam the position — and the open-position slot — forever.
      state.pendingSells.delete(f.mint);
    }
  }
}

function applyAccount(account, slot) {
  state.cash = BigInt(account.cash_lamports);
  const seen = new Set();
  for (const p of account.positions) {
    const tokens = BigInt(p.token_amount);
    if (tokens === 0n) continue;
    seen.add(p.mint);
    const prev = state.positions.get(p.mint);
    state.positions.set(p.mint, {
      tokens,
      cost: BigInt(p.cost_lamports),
      entrySlot: prev !== undefined ? prev.entrySlot : slot,
    });
  }
  for (const mint of [...state.positions.keys()]) {
    if (!seen.has(mint)) {
      state.positions.delete(mint);
      state.pendingSells.delete(mint);
    }
  }
}

function applyBatch(batch) {
  applyFills(batch.fills, batch.slot);
  applyAccount(batch.account, batch.slot);

  for (const mark of batch.marks) {
    const m = state.curves.get(mark.mint);
    if (m !== undefined) {
      recordPrice(m, mark.slot, BigInt(mark.virtual_quote_reserves), BigInt(mark.virtual_token_reserves));
      m.lastRealQ = BigInt(mark.real_quote_reserves);
    }
  }

  const candidates = [];
  const seenCandidate = new Set();
  for (const e of batch.events) {
    if (e.event === "CreateEvent") {
      const m = curveFor(e.mint, e.slot);
      m.createdSlot = e.slot;
      recordPrice(m, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      m.lastRealQ = 0n;
    } else if (e.event === "TradeEvent") {
      const m = curveFor(e.mint, e.slot);
      recordPrice(m, e.slot, BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      const realQ = BigInt(e.real_quote_reserves);
      m.lastRealQ = realQ;
      // First trade where the curve holds enough real SOL for a minimum-size
      // buy: this is the one affordable moment, and only on a buy trade.
      if (!m.affordableSeen && realQ >= MIN_REAL_LAMPORTS) {
        m.affordableSeen = true;
        if (e.is_buy && !seenCandidate.has(e.mint)) {
          seenCandidate.add(e.mint);
          candidates.push({ mint: e.mint, realQ });
        }
      }
    } else if (e.event === "CompleteEvent") {
      const m = curveFor(e.mint, e.slot);
      m.complete = true;
    }
  }
  return candidates;
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === "") continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      process.exitCode = 1;
      throw new Error("input line is not JSON");
    }
    if (msg.type === "hello") {
      if (msg.protocol !== "agent-fun/replay/v2") {
        process.exitCode = 1;
        throw new Error("unsupported protocol");
      }
      state.capital = BigInt(msg.capital.lamports);
      state.cash = state.capital;
      state.maxOpen = msg.caps.max_open_positions;
      state.maxOrdersPerBatch = msg.caps.max_orders_per_batch;
      state.maxOrderBps = msg.caps.max_order_bps_of_real_reserve;
    } else if (msg.type === "batch") {
      const candidates = applyBatch(msg);
      const orders = [];
      decideExits(msg.slot, orders);
      decideEntries(msg.slot, candidates, orders);
      const reply = JSON.stringify({ type: "reply", seq: msg.seq, orders });
      if (!process.stdout.write(reply + "\n")) {
        await new Promise((resolve) => process.stdout.once("drain", resolve));
      }
    } else if (msg.type === "done") {
      return;
    } else {
      process.exitCode = 1;
      throw new Error(`unknown message type ${msg.type}`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
