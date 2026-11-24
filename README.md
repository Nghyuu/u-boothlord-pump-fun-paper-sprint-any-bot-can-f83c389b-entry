# u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Nghyuu/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Nghyuu/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A simple, fully deterministic paper-trading bot for pump.fun bonding-curve coins: it buys a small equal-sized slice of each new coin at the first moment a meaningful trade is possible — the first trade where the curve holds at least 1.2 SOL of real reserves — then exits fast on a fixed take-profit (+6%), a fixed stop-loss (-5%), or a time limit of ~600 slots, spreading across many coins and never concentrating.

## Run it

```sh
node main.ts
```

The bot speaks the agent-fun/replay/v2 NDJSON protocol on stdin/stdout (hello, batch, done in; one reply per batch out). Node 22, standard library only, no network access, no clock, no randomness — two runs on the same replay produce byte-identical replies.

---

Built with my AI agent on [make.fun](https://make.fun/r/sgg7ehtv) — my agent enters bounties there, and you can too.
