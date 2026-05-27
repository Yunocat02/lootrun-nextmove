import assert from "node:assert/strict";
import {
  applyBeaconChoice,
  applyReroll,
  applyMissionChoice,
  applyTrialChoice,
  buildBeaconPool,
  canTakeBeacon,
  completeMission,
  completeTrial,
  createInitialRunState,
  evaluateAction,
  generateSuggestedOffer,
  getLegalActions,
  rankActions,
  rankMissions,
  runReducer,
} from "./engine.mjs";
import { runSimulation } from "./simulator.mjs";
import {
  canRunMainThreadFallback,
  createTimeoutFallbackResult,
  simulateForWorker,
  simulationEntriesToMap,
} from "./simulationWorkerCore.mjs";

const NOW = 1_700_000_000_000;

function stateWith(values) {
  return {
    ...createInitialRunState(),
    clock: {
      running: false,
      startedAt: null,
      timerSeconds: 600,
    },
    ...values,
  };
}

{
  assert.equal(createInitialRunState().maxChallenges, 12);
}

{
  const afterAquaBlue = applyBeaconChoice(
    {
      ...applyBeaconChoice(
        stateWith({ challenge: 7, offered: [{ id: "aqua", vibrant: false }] }),
        "aqua",
        false,
        NOW,
      ),
      offered: [{ id: "blue", vibrant: false }],
    },
    "blue",
    false,
    NOW + 30_000,
  );
  assert.equal(afterAquaBlue.boons, 1);
  assert.equal(afterAquaBlue.boonPotency, 200);
}

{
  const afterAqua = applyBeaconChoice(
    stateWith({ challenge: 7, offered: [{ id: "aqua", vibrant: true }] }),
    "aqua",
    true,
    NOW,
  );
  const afterYellow = applyBeaconChoice(
    {
      ...afterAqua,
      offered: [{ id: "yellow", vibrant: true }],
    },
    "yellow",
    true,
    NOW + 30_000,
  );

  assert.equal(afterAqua.effects.aquaBoost, 2);
  assert.equal(afterYellow.flyingChests, 6);
  assert.equal(afterYellow.effects.aquaBoost, 0);
}

{
  const afterFourthChallenge = applyBeaconChoice(
    stateWith({
      challenge: 3,
      offered: [{ id: "blue", vibrant: false }],
    }),
    "blue",
    false,
    NOW,
  );
  assert.equal(afterFourthChallenge.phase, "mission");
  assert.equal(afterFourthChallenge.offeredMissions.length, 3);
}

{
  const withBlue = runReducer(createInitialRunState(), {
    type: "ADD_OFFERED_BEACON",
    beaconId: "blue",
    now: NOW,
  });
  const duplicateAdd = runReducer(withBlue, {
    type: "ADD_OFFERED_BEACON",
    beaconId: "blue",
    now: NOW,
  });
  const withPurple = runReducer(withBlue, {
    type: "ADD_OFFERED_BEACON",
    beaconId: "purple",
    now: NOW,
  });
  const duplicateSet = runReducer(withPurple, {
    type: "SET_OFFERED_BEACON",
    index: 1,
    beaconId: "blue",
    now: NOW,
  });

  assert.deepEqual(withBlue.offered.map((item) => item.id), ["blue"]);
  assert.deepEqual(duplicateAdd.offered.map((item) => item.id), ["blue"]);
  assert.deepEqual(duplicateSet.offered.map((item) => item.id), ["blue", "purple"]);
}

{
  const materialismState = {
    ...stateWith({
      challenge: 6,
      maxChallenges: 20,
      completedMissions: ["materialism"],
      offered: [{ id: "blue", vibrant: false }],
    }),
  };
  const afterChallenge = applyBeaconChoice(materialismState, "blue", false, NOW);
  assert.equal(afterChallenge.flyingChests, 2);
}

{
  const porphyOffer = runReducer(
    stateWith({
      completedMissions: ["porphyrophobia"],
    }),
    {
      type: "ADD_OFFERED_BEACON",
      beaconId: "purple",
      now: NOW,
    },
  );
  assert.equal(porphyOffer.curses, 1);
}

{
  const stackedOrange = applyBeaconChoice(
    stateWith({
      effects: {
        ...createInitialRunState().effects,
        aquaBoost: 2,
      },
      offered: [{ id: "orange", vibrant: true }],
    }),
    "orange",
    true,
    NOW,
  );
  assert.equal(stackedOrange.effects.orangeChoices[0].extra, 1);
  assert.equal(stackedOrange.effects.orangeChoices[0].remaining, 30);
}

{
  const lastBlue = applyBeaconChoice(
    stateWith({
      challenge: 11,
      maxChallenges: 12,
      offered: [{ id: "blue", vibrant: true }],
    }),
    "blue",
    true,
    NOW,
  );
  const lastPurple = applyBeaconChoice(
    stateWith({
      challenge: 11,
      maxChallenges: 12,
      offered: [{ id: "purple", vibrant: false }],
    }),
    "purple",
    false,
    NOW,
  );
  assert.equal(lastBlue.boons, 0);
  assert.equal(lastBlue.pulls, 0);
  assert.equal(lastPurple.pulls, 1);
  assert.equal(lastPurple.curses, 0);
}

{
  const state = stateWith({
    challenge: 8,
    offered: [{ id: "blue", vibrant: false }],
  });
  const pickedManually = applyBeaconChoice(state, "blue", false, NOW, {
    clearOffer: true,
  });
  const projected = evaluateAction(state, {
    type: "beacon",
    beaconId: "blue",
    vibrant: false,
    key: "beacon:blue:n:0",
  }).projectedState;

  assert.deepEqual(createInitialRunState().offered, []);
  assert.deepEqual(pickedManually.offered, []);
  assert.equal(projected.offered.length > 0, true);
}

{
  const state = stateWith({
    challenge: 8,
    effects: {
      ...createInitialRunState().effects,
      orangeChoices: [{ remaining: 5, extra: 1 }],
    },
    offered: [
      { id: "blue", vibrant: false },
      { id: "purple", vibrant: false },
      { id: "yellow", vibrant: false },
      { id: "green", vibrant: false },
    ],
  });
  assert.equal(rankActions(state)[0].type, "reroll");
}

{
  const state = stateWith({
    beaconRerolls: 2,
    offered: [
      { id: "purple", vibrant: false },
      { id: "yellow", vibrant: false },
    ],
  });
  const rerolledManually = applyReroll(state, { clearOffer: true });
  const projected = evaluateAction(state, { type: "reroll", key: "reroll" }).projectedState;

  assert.deepEqual(rerolledManually.offered, []);
  assert.equal(projected.offered.length > 0, true);
}

{
  const chaos = applyBeaconChoice(
    stateWith({
      challenge: 20,
      completedMissions: ["completeChaos"],
      offered: [{ id: "blue", vibrant: false }],
    }),
    "blue",
    false,
    NOW,
  );
  assert.notEqual(chaos.phase, "mission");
  assert.notEqual(chaos.phase, "trial");
}

{
  const state = stateWith({
    challenge: 3,
    boons: 0,
    curses: 0,
    offered: [
      { id: "blue", vibrant: false },
      { id: "purple", vibrant: false },
      { id: "yellow", vibrant: false },
    ],
  });
  const ranked = rankActions(state);
  const blue = ranked.find((action) => action.beaconId === "blue");
  const purple = ranked.find((action) => action.beaconId === "purple");
  assert.equal(blue.score > purple.score, true);
}

{
  const state = stateWith({
    challenge: 24,
    maxChallenges: 58,
    boons: 2,
    boonPotency: 420,
    curses: 1,
    completedMissions: ["opalOffering"],
    offered: [
      { id: "blue", vibrant: false },
      { id: "purple", vibrant: false },
      { id: "green", vibrant: false },
    ],
  });
  const ranked = rankActions(state);
  assert.equal(ranked[0].beaconId, "blue");
}

{
  const state = stateWith({
    challenge: 1,
    offered: [
      { id: "orange", vibrant: false },
      { id: "aqua", vibrant: false },
      { id: "pink", vibrant: false },
      { id: "red", vibrant: false },
      { id: "blue", vibrant: false },
    ],
  });
  const order = rankActions(state)
    .filter((action) => action.type === "beacon")
    .map((action) => action.beaconId);
  assert.deepEqual(order.slice(0, 5), ["orange", "aqua", "pink", "red", "blue"]);
}

{
  const state = stateWith({
    challenge: 9,
    beaconRerolls: 2,
    offered: [
      { id: "purple", vibrant: false },
      { id: "yellow", vibrant: false },
    ],
  });
  const actions = getLegalActions(state);
  assert.equal(actions.some((action) => action.type === "reroll"), true);
}

{
  const state = stateWith({
    challenge: 12,
    activeMission: "equilibrium",
    offered: [{ id: "grey", vibrant: false }],
  });
  assert.equal(canTakeBeacon(state, "grey").ok, false);
}

{
  const beforeFirstMission = stateWith({
    challenge: 12,
    offered: [{ id: "grey", vibrant: false }],
  });
  assert.equal(canTakeBeacon(beforeFirstMission, "grey").ok, false);
}

{
  const state = stateWith({
    useCounts: {
      ...createInitialRunState().useCounts,
      darkGrey: 1,
    },
  });
  assert.equal(canTakeBeacon(state, "darkGrey").ok, false);
}

{
  const state = stateWith({ lastBeacon: "aqua" });
  assert.equal(canTakeBeacon(state, "aqua").ok, false);
  assert.equal(canTakeBeacon({ ...state, lastBeacon: "green" }, "green").ok, false);
  assert.equal(canTakeBeacon({ ...state, lastBeacon: "red" }, "red").ok, false);
}

{
  const state = stateWith({
    challenge: 16,
    maxChallenges: 32,
    clock: {
      running: false,
      startedAt: null,
      timerSeconds: 120,
    },
    offered: [
      { id: "green", vibrant: false },
      { id: "purple", vibrant: false },
      { id: "yellow", vibrant: false },
    ],
  });
  const top = rankActions(state)[0];
  assert.equal(top.beaconId, "green");
}

{
  const state = stateWith({
    challenge: 18,
    phase: "mission",
    offeredMissions: ["highRoller", "redemption", "materialism"],
  });
  const highRoller = evaluateAction(state, {
    type: "mission",
    missionId: "highRoller",
    key: "mission:highRoller",
  }).projectedState;
  assert.equal(highRoller.activeMission, "highRoller");
  assert.equal(highRoller.pulls, state.pulls);

  const completedHighRoller = completeMission(highRoller);
  assert.equal(completedHighRoller.pulls, state.pulls + 10);
  assert.equal(completedHighRoller.rewardRerolls, 1);

  const redemption = applyMissionChoice(state, "redemption");
  assert.equal(redemption.sacrifices, 0);
  assert.equal(completeMission(redemption).sacrifices, 1);
}

{
  assert.equal(canTakeBeacon(stateWith({ challenge: 19 }), "crimson").ok, false);
}

{
  const grey = applyBeaconChoice(
    stateWith({
      challenge: 10,
      completedMissions: ["highRoller"],
      missionSlotsUsed: 1,
      offered: [{ id: "grey", vibrant: false }],
    }),
    "grey",
    false,
    NOW,
  );
  assert.equal(grey.phase, "mission");
  assert.equal(grey.offeredMissions.length, 3);

  const crimson = applyBeaconChoice(
    stateWith({
      challenge: 22,
      maxChallenges: 45,
      offered: [{ id: "crimson", vibrant: false }],
    }),
    "crimson",
    false,
    NOW,
  );
  const boostedCrimson = applyBeaconChoice(
    stateWith({
      challenge: 22,
      maxChallenges: 45,
      effects: {
        ...createInitialRunState().effects,
        aquaBoost: 1,
      },
      offered: [{ id: "crimson", vibrant: false }],
    }),
    "crimson",
    false,
    NOW,
  );
  const stackedCrimson = applyBeaconChoice(
    stateWith({
      challenge: 22,
      maxChallenges: 45,
      effects: {
        ...createInitialRunState().effects,
        aquaBoost: 2,
      },
      offered: [{ id: "crimson", vibrant: true }],
    }),
    "crimson",
    true,
    NOW,
  );
  assert.equal(crimson.offeredTrials.length, 2);
  assert.equal(boostedCrimson.offeredTrials.length, 3);
  assert.equal(stackedCrimson.offeredTrials.length, 4);
}

{
  const state = stateWith({
    challenge: 20,
    maxChallenges: 45,
    activeMission: "equilibrium",
    completedMissions: ["equilibrium"],
    offered: [
      { id: "purple", vibrant: false },
      { id: "darkGrey", vibrant: false },
      { id: "yellow", vibrant: false },
    ],
  });
  const purple = evaluateAction(state, {
    type: "beacon",
    beaconId: "purple",
    vibrant: false,
    key: "beacon:purple:n:0",
  }).projectedState;
  const darkGrey = evaluateAction(state, {
    type: "beacon",
    beaconId: "darkGrey",
    vibrant: false,
    key: "beacon:darkGrey:n:1",
  }).projectedState;

  assert.equal(purple.beaconRerolls, state.beaconRerolls);
  assert.equal(purple.effects.nextBoonPotencyBonus, 50);
  assert.equal(darkGrey.beaconRerolls, state.beaconRerolls);
  assert.equal(darkGrey.effects.nextBoonPotencyBonus, 150);

  const boostedBlue = applyBeaconChoice(
    {
      ...darkGrey,
      offered: [{ id: "blue", vibrant: false }],
    },
    "blue",
    false,
    NOW,
  );
  assert.equal(boostedBlue.boons, state.boons + 1);
  assert.equal(boostedBlue.boonPotency, 250);
}

{
  const state = stateWith({
    challenge: 30,
    maxChallenges: 46,
    redDebt: {
      noTimeChallenges: 8,
      secondsLost: 360,
    },
    clock: {
      running: false,
      startedAt: null,
      timerSeconds: 105,
    },
    offered: [
      { id: "green", vibrant: false },
      { id: "red", vibrant: false },
      { id: "purple", vibrant: false },
    ],
  });
  assert.equal(rankActions(state)[0].beaconId, "green");
}

{
  const state = stateWith({
    challenge: 26,
    maxChallenges: 58,
    boons: 2,
    boonPotency: 500,
    redDebt: {
      noTimeChallenges: 6,
      secondsLost: 900,
    },
    clock: {
      running: false,
      startedAt: null,
      timerSeconds: 760,
    },
    offered: [
      { id: "green", vibrant: false },
      { id: "blue", vibrant: false },
      { id: "purple", vibrant: false },
    ],
  });
  assert.equal(rankActions(state)[0].beaconId, "blue");
}

{
  const red = applyBeaconChoice(
    stateWith({
      challenge: 18,
      clock: {
        running: false,
        startedAt: null,
        timerSeconds: 500,
      },
      offered: [{ id: "red", vibrant: false }],
    }),
    "red",
    false,
    NOW,
  );
  assert.equal(red.clock.timerSeconds, 500);
  assert.equal(red.maxChallenges, createInitialRunState().maxChallenges + 3);
  assert.equal(red.redDebt.secondsLost, 450);
}

{
  const stackedRed = applyBeaconChoice(
    stateWith({
      challenge: 18,
      effects: {
        ...createInitialRunState().effects,
        aquaBoost: 2,
      },
      offered: [{ id: "red", vibrant: true }],
    }),
    "red",
    true,
    NOW,
  );
  assert.equal(stackedRed.maxChallenges, createInitialRunState().maxChallenges + 15);
  assert.equal(stackedRed.redDebt.secondsLost, 2250);
}

{
  const trialState = applyTrialChoice(
    stateWith({
      phase: "trial",
      offeredTrials: ["sideHustle", "hubris"],
    }),
    "sideHustle",
  );
  assert.equal(trialState.activeTrial, "sideHustle");
  assert.equal(trialState.rewardRerolls, 0);
  const completed = completeTrial(trialState);
  assert.equal(completed.activeTrial, null);
  assert.equal(completed.rewardRerolls, 2);
}

{
  const gambling = applyTrialChoice(
    stateWith({
      phase: "trial",
      offeredTrials: ["gamblingBeast", "hubris"],
      clock: {
        running: false,
        startedAt: null,
        timerSeconds: 800,
      },
    }),
    "gamblingBeast",
  );
  const afterChallenge = applyBeaconChoice(
    {
      ...gambling,
      offered: [{ id: "green", vibrant: false }],
    },
    "green",
    false,
    NOW,
  );
  assert.equal(afterChallenge.rewardRerolls, 1);
  assert.equal(afterChallenge.effects.gamblingBeastTriggers, 1);
}

{
  const gambling = applyTrialChoice(
    stateWith({
      phase: "trial",
      offeredTrials: ["gamblingBeast", "hubris"],
      clock: {
        running: false,
        startedAt: null,
        timerSeconds: 900,
      },
    }),
    "gamblingBeast",
  );
  const ranked = rankActions({
    ...gambling,
    offered: [
      { id: "green", vibrant: false },
      { id: "purple", vibrant: false },
      { id: "yellow", vibrant: false },
    ],
  });
  assert.equal(ranked[0].beaconId, "green");
}

{
  const base = stateWith({
    challenge: 14,
    beaconRerolls: 1,
    offered: [
      { id: "purple", vibrant: false },
      { id: "yellow", vibrant: false },
    ],
  });
  const withPinkOffer = {
    ...base,
    offered: [
      { id: "pink", vibrant: false },
      { id: "yellow", vibrant: false },
    ],
  };
  const afterPinkSupply = {
    ...base,
    beaconRerolls: 4,
    useCounts: {
      ...base.useCounts,
      pink: 1,
    },
  };
  const baseReroll = evaluateAction(base, { type: "reroll", key: "reroll" }).score;
  const pinkOfferReroll = evaluateAction(withPinkOffer, { type: "reroll", key: "reroll" }).score;
  const pinkSupplyReroll = evaluateAction(afterPinkSupply, { type: "reroll", key: "reroll" }).score;

  assert.equal(pinkOfferReroll < baseReroll, true);
  assert.equal(pinkSupplyReroll > baseReroll, true);
}

{
  const state = stateWith({
    phase: "mission",
    challenge: 18,
    flyingChests: 3,
    completedMissions: ["materialism", "hoarder"],
    activeMission: "hoarder",
    offeredMissions: ["interestScheme", "thrillSeeker", "backupBeat"],
  });
  const withoutMissionStack = {
    ...state,
    completedMissions: [],
    activeMission: null,
  };
  const stackedScore = rankMissions(state).find(
    (item) => item.missionId === "interestScheme",
  ).score;
  const unstackedScore = rankMissions(withoutMissionStack).find(
    (item) => item.missionId === "interestScheme",
  ).score;
  assert.equal(stackedScore > unstackedScore, true);
}

{
  const state = stateWith({
    challenge: 22,
    useCounts: {
      ...createInitialRunState().useCounts,
      darkGrey: 1,
      white: 1,
    },
  });
  const poolIds = buildBeaconPool(state).map((item) => item.id);
  assert.equal(poolIds.includes("darkGrey"), false);
  assert.equal(poolIds.includes("white"), false);

  for (let index = 0; index < 20; index += 1) {
    const offerIds = generateSuggestedOffer({ ...state, seed: state.seed + index }, index).map(
      (item) => item.id,
    );
    assert.equal(offerIds.includes("darkGrey"), false);
    assert.equal(offerIds.includes("white"), false);
  }
}

{
  const state = stateWith({
    challenge: 12,
    observedOffers: [
      [{ id: "green", vibrant: false }, { id: "green", vibrant: true }],
      [{ id: "green", vibrant: false }, { id: "pink", vibrant: false }],
      [{ id: "green", vibrant: false }, { id: "blue", vibrant: false }],
    ],
  });
  const calibratedPool = buildBeaconPool(state);
  const green = calibratedPool.find((item) => item.id === "green").weight;
  const blue = calibratedPool.find((item) => item.id === "blue").weight;
  assert.equal(green > blue * 0.5, true);
}

{
  const state = stateWith({
    challenge: 9,
    offered: [
      { id: "green", vibrant: false },
      { id: "purple", vibrant: false },
      { id: "pink", vibrant: false },
    ],
  });
  const mainThread = runSimulation(state, "light", "mcts", {
    mctsIterations: 80,
    mctsDepth: 4,
  });
  const workerResponse = simulateForWorker({
    id: 1,
    state,
    computeMode: "light",
    searchMode: "mcts",
    mctsIterations: 80,
    mctsDepth: 4,
  });
  const workerMap = simulationEntriesToMap(workerResponse.entries);
  assert.deepEqual([...workerMap.keys()].sort(), [...mainThread.keys()].sort());
  assert.equal([...workerMap.values()].every((entry) => typeof entry.mean === "number"), true);
  assert.equal(workerMap instanceof Map, true);
}

{
  const state = stateWith({
    challenge: 9,
    offered: [
      { id: "green", vibrant: false },
      { id: "purple", vibrant: false },
      { id: "pink", vibrant: false },
    ],
  });
  const rollout = runSimulation(state, "light", "rollout");
  const mcts = runSimulation(state, "light", "mcts", {
    mctsIterations: 80,
    mctsDepth: 4,
  });
  assert.deepEqual([...rollout.keys()].sort(), [...mcts.keys()].sort());

  const firstMcts = [...mcts.values()][0];
  assert.equal(firstMcts.kind, "mcts");
  assert.equal(typeof firstMcts.visits, "number");
  assert.equal(typeof firstMcts.samples, "number");
  assert.equal(typeof firstMcts.averageUtility, "number");
}

{
  const state = stateWith({
    challenge: 11,
    offered: [
      { id: "blue", vibrant: false },
      { id: "purple", vibrant: false },
      { id: "yellow", vibrant: false },
    ],
  });
  const previousSimulation = runSimulation(state, "light", "rollout");
  const fallback = createTimeoutFallbackResult(
    { simulation: previousSimulation },
    "max",
  );
  const ranked = rankActions(state, fallback.simulation);
  assert.equal(fallback.source, "stale");
  assert.equal(fallback.pending, false);
  assert.equal(fallback.error, "Worker timeout. Showing previous or heuristic result.");
  assert.equal(ranked.length > 0, true);
}

{
  assert.equal(canRunMainThreadFallback("light"), true);
  assert.equal(canRunMainThreadFallback("balanced"), true);
  assert.equal(canRunMainThreadFallback("deep"), false);
  assert.equal(canRunMainThreadFallback("max"), false);

  const deepTimeout = createTimeoutFallbackResult(
    { simulation: new Map() },
    "deep",
  );
  assert.equal(deepTimeout.source, "heuristic");
  assert.equal(deepTimeout.simulation.size, 0);
}

console.log("engine sanity tests passed");
