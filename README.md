# YunYun Lootrun Advisor

YunYun Lootrun Advisor is a self-hosted, manual companion web app for Wynncraft lootruns. Enter the beacon choices you see in game, keep the timer in sync, and the app ranks the next move with guide-tuned rules, Monte Carlo rollouts, and MCTS tree search.

The app is built for live play: it avoids game automation entirely, runs heavy search in a Web Worker, and keeps local state in the browser so a reload does not lose the current run.

## Features

- Manual current-offer input with beacon color, vibrant state, and no duplicate offers.
- Ranked next-move decision list, including `Reroll` when it is worth considering.
- Mission and trial selection ranking, including the free mission after challenge 4.
- Fruma-era beacon rules: Pink, Rainbow, Aqua stacking, Orange choice cap, Grey/Crimson gating, max-use beacons, and last-challenge limits.
- Red debt and no-time-bonus tracking so Green rises when Red-heavy paths become risky.
- Observed-offer calibration that adapts beacon priors from offers entered during the current run.
- Web Worker simulation with safe fallback behavior for weaker devices.
- Two search modes: fast Monte Carlo rollout and deeper MCTS.
- Profiles for different play styles: Safe, Balanced, Greed, and Fast Clear.
- Undo, autosave, timer controls, active combo tracker, and manual completion controls.

## Manual-Only Safety

This project is a companion website only. It does not:

- read Minecraft memory
- send packets
- automate clicks or keyboard input
- depend on a mod
- interact with the Wynncraft client directly

All choices must be entered and confirmed by the player.

## Quick Start

```bash
pnpm install
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Production

```bash
pnpm build
pnpm start
```

The app can be deployed to any Next.js-compatible host, including a Node server or Vercel.

## Scripts

```bash
pnpm dev          # start the local Next.js dev server
pnpm build        # create a production build
pnpm start        # run the production server
pnpm lint         # run ESLint
pnpm test:engine  # run deterministic lootrun engine tests
```

## How To Use

1. Press `Start` when you start the lootrun in Wynncraft.
2. Add the current offered beacons exactly as they appear in game.
3. Mark vibrant beacons when needed.
4. Wait for the ranked Decision list.
5. Pick the same beacon in game and in the app.
6. When a mission or trial is offered, select the matching option from the ranked chooser.
7. Use `Undo` if you misclick or need to correct the run state.

The app waits until enough current offers are entered before thinking, so it does not rank incomplete beacon screens.

## Search Modes

`Monte Carlo rollout` is the faster mode. It samples many possible future runs from the current state and is best for live play when you need a quick recommendation.

`MCTS` is the smarter but slower mode. It builds a search tree with visits, UCB exploration, average utility, and best-child selection, so it is better for setup chains and high-impact decisions.

## Profiles

`Balanced` is the recommended default for most runs.

`Safe` values timer, survival, and run stability more heavily.

`Greed` pushes harder for pulls, rerolls, and sacrifice value.

`Fast Clear` assumes a fast build and gives more room to aggressive timing choices.

## Rules And Data

Rules are tuned from the Rover & Rem community lootrun guide, last updated 23/05/2026, including its Fruma-era mechanics. Hidden beacon offer probabilities are not public, so the simulator uses editable priors and calibrates them from offers entered during the current run.

Because Wynncraft can change, treat the advisor as a decision aid, not a guaranteed optimal solver.

## Project Structure

```text
app/page.js                         # Next.js page entry
app/lootrun/LootrunAdvisor.js       # client UI and run reducer
app/lootrun/rules.mjs               # versioned lootrun data and weights
app/lootrun/engine.mjs              # deterministic scorer and reducer helpers
app/lootrun/simulator.mjs           # rollout and MCTS simulation
app/lootrun/simulation.worker.js    # browser worker entry
app/lootrun/simulationWorkerCore.mjs # worker-safe simulation bridge
app/lootrun/engine.test.mjs         # deterministic sanity tests
```

## Disclaimer

This is an unofficial fan project and is not affiliated with Wynncraft, Mojang, or Microsoft.

## License

MIT
