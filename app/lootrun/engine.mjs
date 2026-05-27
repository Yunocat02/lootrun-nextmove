import {
  BASE_CHALLENGE_CAP,
  BASE_START_TIMER_SECONDS,
  BEACON_IDS,
  BEACONS,
  COMPUTE_MODES,
  DEFAULT_OFFERED_BEACONS,
  DEFAULT_OFFERED_MISSIONS,
  DEFAULT_OFFERED_TRIALS,
  DEFAULT_WEIGHTS,
  GREEN_TIMER_OVER_CAP_SECONDS,
  HARD_CHALLENGE_CAP,
  MAX_TIMER_SECONDS,
  MISSIONS,
  PLAYER_PROFILES,
  RED_NO_TIME_BONUS_SECONDS,
  SEARCH_MODES,
  TRIALS,
} from "./rules.mjs";

const CLOCK_FIELDS = new Set(["START_CLOCK", "PAUSE_CLOCK", "SET_TIMER"]);

export function createInitialRunState() {
  return {
    schema: 1,
    phase: "beacon",
    clock: {
      running: false,
      startedAt: null,
      timerSeconds: BASE_START_TIMER_SECONDS,
    },
    challenge: 0,
    maxChallenges: BASE_CHALLENGE_CAP,
    pulls: 0,
    rewardRerolls: 0,
    sacrifices: 0,
    beaconRerolls: 2,
    boons: 0,
    boonPotency: 0,
    curses: 0,
    radianceCurses: 0,
    flyingChests: 0,
    redDebt: {
      noTimeChallenges: 0,
      secondsLost: 0,
    },
    activeMission: null,
    activeTrial: null,
    completedMissions: [],
    completedTrials: [],
    missionSlotsUsed: 0,
    trialSlotsUsed: 0,
    effects: {
      aquaBoost: 0,
      rainbowVibrant: 0,
      orangeChoices: [],
      stasisSeconds: 0,
      nextBoonPotencyBonus: 0,
      backupBeatSeconds: 0,
      gourmandChoices: 0,
      interestSchemeChests: 0,
      greenSafetyChallenges: 0,
      gamblingBeastTriggers: 0,
    },
    useCounts: Object.fromEntries(BEACON_IDS.map((id) => [id, 0])),
    skipCounts: {
      grey: 0,
      crimson: 0,
    },
    lastBeacon: null,
    offered: [],
    offeredMissions: DEFAULT_OFFERED_MISSIONS,
    offeredTrials: DEFAULT_OFFERED_TRIALS,
    profile: "balanced",
    computeMode: "balanced",
    searchMode: "mcts",
    mctsIterations: COMPUTE_MODES.balanced.mctsIterations,
    mctsDepth: COMPUTE_MODES.balanced.mctsDepth,
    seed: 732451,
    observedOffers: [],
    history: [],
    log: [],
    savedAt: null,
  };
}

export function runReducer(state, action) {
  const current = hydrateRunState(state);
  const now = action.now ?? Date.now();

  if (action.type === "HYDRATE") {
    return hydrateRunState(action.state);
  }

  if (action.type === "UNDO") {
    const previous = current.history.at(-1);
    if (!previous) {
      return current;
    }
    return {
      ...previous,
      history: current.history.slice(0, -1),
      savedAt: now,
    };
  }

  if (action.type === "RESET") {
    return createInitialRunState();
  }

  const next = applyAction(current, action, now);
  if (next === current) {
    return current;
  }

  if (CLOCK_FIELDS.has(action.type) || action.skipHistory) {
    return { ...next, savedAt: now };
  }

  return {
    ...next,
    history: [...current.history.slice(-39), stripHistory(current)],
    savedAt: now,
  };
}

function applyAction(state, action, now) {
  switch (action.type) {
    case "START_CLOCK":
      return startClock(state, now);
    case "PAUSE_CLOCK":
      return pauseClock(state, now);
    case "SET_TIMER":
      return {
        ...state,
        clock: {
          running: false,
          startedAt: null,
          timerSeconds: clamp(Math.round(action.seconds), 0, GREEN_TIMER_OVER_CAP_SECONDS),
        },
      };
    case "SET_PROFILE":
      return {
        ...state,
        profile: PLAYER_PROFILES[action.profile] ? action.profile : state.profile,
      };
    case "SET_COMPUTE_MODE":
      return {
        ...state,
        computeMode: COMPUTE_MODES[action.mode] ? action.mode : state.computeMode,
        mctsIterations: action.keepMcts ? state.mctsIterations : (COMPUTE_MODES[action.mode]?.mctsIterations ?? state.mctsIterations),
        mctsDepth: action.keepMcts ? state.mctsDepth : (COMPUTE_MODES[action.mode]?.mctsDepth ?? state.mctsDepth),
      };
    case "SET_SEARCH_MODE":
      return {
        ...state,
        searchMode: SEARCH_MODES[action.mode] ? action.mode : state.searchMode,
      };
    case "SET_MCTS_ITERATIONS":
      return {
        ...state,
        mctsIterations: clamp(Math.round(action.value), 40, 8000),
      };
    case "SET_MCTS_DEPTH":
      return {
        ...state,
        mctsDepth: clamp(Math.round(action.value), 2, 24),
      };
    case "SET_OFFERED_BEACON":
      return setOfferedBeacon(state, action.index, action.beaconId);
    case "TOGGLE_OFFERED_VIBRANT":
      return toggleOfferedVibrant(state, action.index);
    case "ADD_OFFERED_BEACON": {
      if (
        action.beaconId &&
        (!BEACONS[action.beaconId] ||
          state.offered.some((item) => item.id === action.beaconId))
      ) {
        return state;
      }
      const fallbackBeaconId =
        action.beaconId ??
        BEACON_IDS.find((beaconId) => !state.offered.some((item) => item.id === beaconId));
      if (!fallbackBeaconId) {
        return state;
      }
      const nextOffered = [
        ...state.offered,
        { id: fallbackBeaconId, vibrant: false },
      ].slice(0, getBeaconChoiceCount(state));
      return applyOfferSideEffects(
        {
          ...state,
          offered: nextOffered,
        },
        state.offered,
        nextOffered,
      );
    }
    case "REMOVE_OFFERED_BEACON":
      return {
        ...state,
        offered: state.offered.filter((_, index) => index !== action.index),
      };
    case "CLEAR_OFFERED_BEACONS":
      return {
        ...state,
        offered: [],
      };
    case "CLEAR_AQUA":
      if ((state.effects.aquaBoost ?? 0) <= 0) {
        return state;
      }
      return {
        ...state,
        effects: {
          ...state.effects,
          aquaBoost: 0,
        },
        log: [...state.log.slice(-79), "Aqua boost cleared by death or /kill"],
      };
    case "PICK_BEACON":
      return applyBeaconChoice(state, action.beaconId, Boolean(action.vibrant), now, {
        clearOffer: true,
      });
    case "REROLL_BEACONS":
      return applyReroll(state, { clearOffer: true });
    case "CHOOSE_MISSION":
      return applyMissionChoice(state, action.missionId);
    case "COMPLETE_MISSION":
      return completeMission(state, action.missionId);
    case "CHOOSE_TRIAL":
      return applyTrialChoice(state, action.trialId);
    case "COMPLETE_TRIAL":
      return completeTrial(state, action.trialId);
    case "SET_OFFERED_MISSION":
      return setOfferedMission(state, action.index, action.missionId);
    case "SET_OFFERED_TRIAL":
      return setOfferedTrial(state, action.index, action.trialId);
    default:
      return state;
  }
}

export function hydrateRunState(value) {
  const base = createInitialRunState();
  if (!value || typeof value !== "object") {
    return base;
  }
  return {
    ...base,
    ...value,
    clock: { ...base.clock, ...(value.clock ?? {}) },
    effects: { ...base.effects, ...(value.effects ?? {}) },
    redDebt: { ...base.redDebt, ...(value.redDebt ?? {}) },
    useCounts: { ...base.useCounts, ...(value.useCounts ?? {}) },
    skipCounts: { ...base.skipCounts, ...(value.skipCounts ?? {}) },
    offered: normalizeOffered(value.offered ?? base.offered),
    offeredMissions: normalizeIds(value.offeredMissions, MISSIONS, base.offeredMissions),
    offeredTrials: normalizeIds(value.offeredTrials, TRIALS, base.offeredTrials),
    completedMissions: Array.isArray(value.completedMissions) ? value.completedMissions : [],
    completedTrials: Array.isArray(value.completedTrials) ? value.completedTrials : [],
    computeMode: COMPUTE_MODES[value.computeMode] ? value.computeMode : base.computeMode,
    searchMode: SEARCH_MODES[value.searchMode] ? value.searchMode : base.searchMode,
    mctsIterations: clamp(Math.round(value.mctsIterations ?? base.mctsIterations), 40, 8000),
    mctsDepth: clamp(Math.round(value.mctsDepth ?? base.mctsDepth), 2, 24),
    observedOffers: normalizeObservedOffers(value.observedOffers),
    history: Array.isArray(value.history) ? value.history.map(stripHistory) : [],
    log: Array.isArray(value.log) ? value.log.slice(-80) : [],
  };
}

export function stripHistory(state) {
  const { history: _history, ...rest } = state;
  return rest;
}

function normalizeOffered(offered) {
  if (!Array.isArray(offered)) {
    return [];
  }
  const seen = new Set();
  const cleaned = offered
    .filter((item) => BEACONS[item?.id])
    .filter((item) => {
      if (seen.has(item.id)) {
        return false;
      }
      seen.add(item.id);
      return true;
    })
    .map((item) => ({
      id: item.id,
      vibrant: Boolean(item.vibrant),
    }));
  return cleaned;
}

function normalizeIds(ids, table, fallback) {
  if (!Array.isArray(ids)) {
    return fallback;
  }
  const cleaned = ids.filter((id) => table[id]);
  return cleaned.length ? cleaned : fallback;
}

function normalizeObservedOffers(observedOffers) {
  if (!Array.isArray(observedOffers)) {
    return [];
  }
  return observedOffers
    .filter((offerSet) => Array.isArray(offerSet))
    .map((offerSet) =>
      offerSet
        .filter((item) => BEACONS[item?.id])
        .map((item) => ({ id: item.id, vibrant: Boolean(item.vibrant) })),
    )
    .filter((offerSet) => offerSet.length > 0)
    .slice(-80);
}

function setOfferedBeacon(state, index, beaconId) {
  if (!BEACONS[beaconId] || index < 0 || index >= state.offered.length) {
    return state;
  }
  if (state.offered.some((item, itemIndex) => item.id === beaconId && itemIndex !== index)) {
    return state;
  }
  const nextOffered = state.offered.map((item, itemIndex) =>
    itemIndex === index ? { ...item, id: beaconId } : item,
  );
  return {
    ...applyOfferSideEffects(
      {
        ...state,
        offered: nextOffered,
      },
      state.offered,
      nextOffered,
    ),
  };
}

function toggleOfferedVibrant(state, index) {
  if (index < 0 || index >= state.offered.length) {
    return state;
  }
  return {
    ...state,
    offered: state.offered.map((item, itemIndex) =>
      itemIndex === index ? { ...item, vibrant: !item.vibrant } : item,
    ),
  };
}

function applyOfferSideEffects(state, previousOffered, nextOffered) {
  const activeNames = getActiveNames(state);
  const hadPurple = previousOffered.some((item) => item.id === "purple");
  const hasPurple = nextOffered.some((item) => item.id === "purple");

  if (activeNames.has("porphyrophobia") && hasPurple && !hadPurple) {
    return applyCurseAndPullGain(state, 1, 0, activeNames);
  }

  return state;
}

export function setGeneratedOffer(state, offered) {
  return applyOfferSideEffects(
    {
      ...state,
      offered,
    },
    state.offered ?? [],
    offered,
  );
}

function setOfferedMission(state, index, missionId) {
  if (!MISSIONS[missionId] || index < 0 || index >= state.offeredMissions.length) {
    return state;
  }
  return {
    ...state,
    offeredMissions: state.offeredMissions.map((id, itemIndex) =>
      itemIndex === index ? missionId : id,
    ),
  };
}

function setOfferedTrial(state, index, trialId) {
  if (!TRIALS[trialId] || index < 0 || index >= state.offeredTrials.length) {
    return state;
  }
  return {
    ...state,
    offeredTrials: state.offeredTrials.map((id, itemIndex) =>
      itemIndex === index ? trialId : id,
    ),
  };
}

export function startClock(state, now = Date.now()) {
  if (state.clock.running) {
    return state;
  }
  return {
    ...state,
    clock: {
      ...state.clock,
      running: true,
      startedAt: now,
    },
  };
}

export function pauseClock(state, now = Date.now()) {
  if (!state.clock.running) {
    return state;
  }
  return {
    ...state,
    clock: {
      running: false,
      startedAt: null,
      timerSeconds: getCurrentTimerSeconds(state, now),
    },
  };
}

export function getCurrentTimerSeconds(state, now = Date.now()) {
  if (!state.clock.running || !state.clock.startedAt) {
    return state.clock.timerSeconds;
  }
  const elapsedSeconds = Math.floor((now - state.clock.startedAt) / 1000);
  return clamp(state.clock.timerSeconds - elapsedSeconds, 0, GREEN_TIMER_OVER_CAP_SECONDS);
}

export function formatTimer(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = String(safeSeconds % 60).padStart(2, "0");
  return `${minutes}:${remainder}`;
}

export function getBeaconChoiceCount(state) {
  const orangeExtra = state.effects.orangeChoices.reduce(
    (sum, effect) => sum + Math.max(0, effect.extra ?? 0),
    0,
  );
  const gourmandExtra = Math.max(0, state.effects.gourmandChoices ?? 0);
  const sentinelExtra = 1;
  return clamp(2 + sentinelExtra + orangeExtra + gourmandExtra, 2, 6);
}

export function getBeaconMultiplier(state, vibrant) {
  const rainbowVibrant = state.effects.rainbowVibrant > 0;
  const effectiveVibrant = Boolean(vibrant || rainbowVibrant);
  return {
    effectiveVibrant,
    multiplier: (1 + Math.max(0, state.effects.aquaBoost)) * (effectiveVibrant ? 2 : 1),
  };
}

export function canTakeBeacon(state, beaconId) {
  const beacon = BEACONS[beaconId];
  if (!beacon) {
    return { ok: false, reason: "Unknown beacon." };
  }
  const monochromokopiaBonus =
    state.completedTrials?.includes("monochromokopia") &&
    ["white", "grey", "darkGrey"].includes(beaconId)
      ? 1
      : 0;
  if (
    beacon.maxUses &&
    (state.useCounts[beaconId] ?? 0) >= beacon.maxUses + monochromokopiaBonus
  ) {
    return { ok: false, reason: "This beacon has reached its run limit." };
  }
  if (beacon.noConsecutive && state.lastBeacon === beaconId) {
    return { ok: false, reason: "This beacon cannot be taken consecutively." };
  }
  if (beaconId === "grey") {
    if (state.activeMission) {
      return { ok: false, reason: "A mission is already active, so Grey is locked out." };
    }
    if (state.completedMissions.length < 1) {
      return { ok: false, reason: "Grey cannot appear before your first mission is completed." };
    }
    if (state.challenge > 45) {
      return { ok: false, reason: "Grey has usually faded from the pool after challenge 40-45." };
    }
    if ((state.skipCounts.grey ?? 0) >= 7) {
      return { ok: false, reason: "Grey has been skipped too often this run." };
    }
  }
  if (beaconId === "red" && state.maxChallenges >= HARD_CHALLENGE_CAP) {
    return { ok: false, reason: "Challenge cap is already reached." };
  }
  if (beaconId === "crimson") {
    if (state.challenge < 20) {
      return { ok: false, reason: "Crimson cannot appear before challenge 20." };
    }
    if (state.challenge > 70) {
      return { ok: false, reason: "Crimson has usually faded from the pool after challenge 65-70." };
    }
    if ((state.skipCounts.crimson ?? 0) >= 7) {
      return { ok: false, reason: "Crimson has been skipped too often this run." };
    }
  }
  return { ok: true, reason: "" };
}

export function getLegalActions(state) {
  if (state.phase === "mission") {
    return state.offeredMissions
      .filter((missionId) => MISSIONS[missionId])
      .map((missionId) => ({ type: "mission", missionId, key: `mission:${missionId}` }));
  }
  if (state.phase === "trial") {
    return state.offeredTrials
      .filter((trialId) => TRIALS[trialId])
      .map((trialId) => ({ type: "trial", trialId, key: `trial:${trialId}` }));
  }

  const actions = state.offered
    .filter((item) => BEACONS[item.id])
    .map((item, index) => ({
      type: "beacon",
      beaconId: item.id,
      vibrant: Boolean(item.vibrant || state.effects.rainbowVibrant > 0),
      index,
      key: `beacon:${item.id}:${item.vibrant || state.effects.rainbowVibrant > 0 ? "v" : "n"}:${index}`,
    }))
    .filter((action) => canTakeBeacon(state, action.beaconId).ok);

  if (state.beaconRerolls > 0 && state.offered.length > 0) {
    actions.push({ type: "reroll", key: "reroll" });
  }

  return actions;
}

export function rankActions(state, simulation = null) {
  const actions = getLegalActions(state);
  const baseline = scoreState(state);
  const ranked = actions.map((action) => {
    const deterministic = evaluateAction(state, action);
    const sim = simulation?.get(action.key) ?? null;
    const simDelta = sim ? sim.mean - baseline : 0;
    const score = deterministic.score * 0.68 + simDelta * 0.32;
    return {
      ...action,
      score,
      deterministicScore: deterministic.score,
      projectedState: deterministic.projectedState,
      reasons: [
        ...deterministic.reasons,
        ...(sim ? [formatSimulationReason(sim)] : []),
      ],
      confidence: sim ? calculateConfidence(sim) : 0.58,
      spread: sim ? sim.max - sim.min : 0,
    };
  });
  return ranked.sort((a, b) => b.score - a.score);
}

export function rankMissions(state) {
  return Object.values(MISSIONS)
    .map((mission) => {
      const offered = state.offeredMissions.includes(mission.id);
      const score = scoreMission(state, mission) + (offered ? 18 : -8);
      return {
        type: "mission",
        missionId: mission.id,
        key: `mission:${mission.id}`,
        score,
        confidence: offered ? 0.74 : 0.58,
        reasons: getMissionReasons(state, mission, offered),
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function rankTrials(state) {
  return Object.values(TRIALS)
    .map((trial) => {
      const offered = state.offeredTrials.includes(trial.id);
      const score = scoreTrial(state, trial) + (offered ? 18 : -12);
      return {
        type: "trial",
        trialId: trial.id,
        key: `trial:${trial.id}`,
        score,
        confidence: offered ? 0.72 : 0.55,
        reasons: getTrialReasons(state, trial, offered),
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function evaluateAction(state, action) {
  if (action.type === "mission") {
    const projectedState = applyMissionChoice(state, action.missionId);
    const mission = MISSIONS[action.missionId];
    return {
      projectedState,
      score: scoreState(projectedState) - scoreState(state) + scoreMission(state, mission),
      reasons: getMissionReasons(state, mission, true),
    };
  }
  if (action.type === "trial") {
    const projectedState = applyTrialChoice(state, action.trialId);
    const trial = TRIALS[action.trialId];
    return {
      projectedState,
      score: scoreState(projectedState) - scoreState(state) + scoreTrial(state, trial),
      reasons: getTrialReasons(state, trial, true),
    };
  }
  if (action.type === "reroll") {
    const projectedState = applyReroll(state);
    return {
      projectedState,
      score: scoreReroll(state, projectedState),
      reasons: getRerollReasons(state),
    };
  }

  const projectedState = applyBeaconChoice(state, action.beaconId, action.vibrant);
  const score = scoreState(projectedState) - scoreState(state) + getBeaconHeuristicBonus(state, action);
  return {
    projectedState,
    score,
    reasons: getBeaconReasons(state, action, projectedState),
  };
}

export function applyBeaconChoice(
  state,
  beaconId,
  vibrant = false,
  now = Date.now(),
  options = {},
) {
  const legal = canTakeBeacon(state, beaconId);
  if (!legal.ok) {
    return state;
  }

  const timerBefore = getCurrentTimerSeconds(state, now);
  const { multiplier, effectiveVibrant } = getBeaconMultiplier(state, vibrant);
  const completedChallenge = state.challenge + 1;
  const lastChallengeLimited =
    isLastChallengeBeforePick(state) && !["red", "white"].includes(beaconId);
  const useCounts = {
    ...state.useCounts,
    [beaconId]: (state.useCounts[beaconId] ?? 0) + 1,
  };
  const activeNames = getActiveNames(state);
  const timeGainBlocked = beaconId === "red" || state.activeTrial === "chronotrigger";
  const baseTimeGain =
    lastChallengeLimited || timeGainBlocked || timerBefore >= MAX_TIMER_SECONDS ? 0 : 150;
  const observedOffers = recordObservedOffer(state);
  const nextSuggestedOffer = options.clearOffer || lastChallengeLimited
    ? []
    : generateSuggestedOffer(state, beaconId);
  let timerAdded = baseTimeGain;
  let flyingChestGain = 0;

  let next = {
    ...state,
    phase: "beacon",
    clock: {
      running: state.clock.running,
      startedAt: state.clock.running ? now : null,
      timerSeconds: applyChallengeTimerGain(timerBefore, baseTimeGain),
    },
    challenge: completedChallenge,
    pulls: state.pulls + (lastChallengeLimited ? 0 : 1),
    lastBeacon: beaconId,
    useCounts,
    skipCounts: {
      ...state.skipCounts,
      ...(beaconId === "grey" ? { grey: 0 } : {}),
      ...(beaconId === "crimson" ? { crimson: 0 } : {}),
    },
    redDebt: advanceRedDebt(state.redDebt, beaconId),
    observedOffers,
    offered: nextSuggestedOffer,
    effects: {
      ...advanceTimedEffects(state.effects),
      gourmandChoices: 0,
    },
    log: [
      ...state.log.slice(-79),
      `${completedChallenge}. ${BEACONS[beaconId].name}${effectiveVibrant ? " Vibrant" : ""}`,
    ],
    seed: nextSeed(state.seed + completedChallenge + beaconId.length),
  };

  if (beaconId !== "aqua") {
    next.effects = {
      ...next.effects,
      aquaBoost: 0,
    };
  }

  if (lastChallengeLimited) {
    if (beaconId === "purple") {
      const pullGain = getTieredBeaconAmount(1, 2, 6, multiplier, effectiveVibrant) *
        (activeNames.has("porphyrophobia") ? 2 : 1);
      next.pulls += pullGain;
    }
    if (beaconId === "darkGrey") {
      next.pulls += getTieredBeaconAmount(3, 6, 18, multiplier, effectiveVibrant);
    }
  } else switch (beaconId) {
    case "blue": {
      const potency = Math.round(
        100 * multiplier * getMissionModifier(activeNames, "boon") +
          (next.effects.nextBoonPotencyBonus ?? 0),
      );
      next.boons += 1;
      next.boonPotency += potency;
      next.effects = {
        ...next.effects,
        nextBoonPotencyBonus: 0,
      };
      break;
    }
    case "purple": {
      const curseGain = Math.max(1, Math.round(multiplier));
      const pullGain = curseGain * (activeNames.has("porphyrophobia") ? 2 : 1);
      next = applyCurseAndPullGain(next, curseGain, pullGain, activeNames);
      break;
    }
    case "yellow": {
      const interestBonus = activeNames.has("interestScheme")
        ? Math.min(12, next.effects.interestSchemeChests ?? 0)
        : 0;
      const amount = getTieredBeaconAmount(1, 2, 6, multiplier, effectiveVibrant) +
        interestBonus;
      flyingChestGain += amount;
      next.flyingChests += amount;
      if (interestBonus > 0) {
        next.effects = {
          ...next.effects,
          interestSchemeChests: 0,
        };
      }
      break;
    }
    case "pink":
      next.beaconRerolls += getTieredBeaconAmount(1, 2, 6, multiplier, effectiveVibrant);
      break;
    case "aqua": {
      const addedBoost = effectiveVibrant ? 2 : 1;
      next.effects = {
        ...next.effects,
        aquaBoost: state.effects.aquaBoost + addedBoost,
      };
      break;
    }
    case "orange": {
      const duration = getTieredBeaconAmount(5, 10, 30, multiplier, effectiveVibrant);
      next.effects = {
        ...next.effects,
        orangeChoices: [
          ...next.effects.orangeChoices,
          { remaining: duration, extra: 1 },
        ].slice(-4),
      };
      break;
    }
    case "green": {
      const extraTime = timeGainBlocked
        ? 0
        : getTieredBeaconAmount(120, 240, 720, multiplier, effectiveVibrant);
      const safetyChallenges = getGreenSafetyChallenges(state.effects.aquaBoost);
      timerAdded += extraTime;
      const cleansed = activeNames.has("chronotrigger")
        ? Math.ceil(next.curses * 0.15)
        : 0;
      const chronotriggerPullGain = activeNames.has("chronotrigger")
        ? Math.floor(next.pulls * 0.035)
        : 0;
      next.clock = {
        running: state.clock.running,
        startedAt: state.clock.running ? now : null,
        timerSeconds: clamp(next.clock.timerSeconds + extraTime, 0, GREEN_TIMER_OVER_CAP_SECONDS),
      };
      next.curses = Math.max(0, next.curses - cleansed);
      next.pulls += chronotriggerPullGain;
      next.redDebt = reduceRedDebt(next.redDebt, Math.max(2, Math.ceil(multiplier * 1.5)));
      next.effects = {
        ...next.effects,
        greenSafetyChallenges: Math.max(
          next.effects.greenSafetyChallenges ?? 0,
          safetyChallenges,
        ),
      };
      if (activeNames.has("backupBeat") && extraTime >= 240) {
        next.beaconRerolls += 1;
      }
      break;
    }
    case "darkGrey": {
      const curseGain = getTieredBeaconAmount(3, 6, 18, multiplier, effectiveVibrant);
      next = applyCurseAndPullGain(next, curseGain, curseGain, activeNames);
      break;
    }
    case "white": {
      const amount = getTieredBeaconAmount(5, 10, 30, multiplier, effectiveVibrant);
      next.maxChallenges = clamp(next.maxChallenges + amount, 4, HARD_CHALLENGE_CAP);
      break;
    }
    case "grey": {
      const missionChoices = getChoiceTier(3, 4, 5, multiplier, effectiveVibrant);
      next.phase = "mission";
      next.offeredMissions = suggestMissions(next, missionChoices);
      break;
    }
    case "red": {
      const amount = getTieredBeaconAmount(3, 5, 15, multiplier, effectiveVibrant);
      next.maxChallenges = clamp(next.maxChallenges + amount, 4, HARD_CHALLENGE_CAP);
      next.redDebt = addRedDebt(next.redDebt, amount);
      if (activeNames.has("thrillSeeker")) {
        next.boons += 1;
        next.boonPotency += Math.round(100 * getMissionModifier(activeNames, "boon"));
      }
      break;
    }
    case "crimson": {
      const trialChoices = getChoiceTier(2, 3, 4, multiplier, effectiveVibrant);
      next.phase = "trial";
      next.offeredTrials = suggestTrials(next, trialChoices);
      break;
    }
    case "rainbow": {
      const duration = getTieredBeaconAmount(10, 20, 60, multiplier, effectiveVibrant);
      next.effects = {
        ...next.effects,
        rainbowVibrant: Math.max(next.effects.rainbowVibrant, duration),
      };
      if (activeNames.has("dyingLight")) {
        next.sacrifices += 1;
      }
      break;
    }
    default:
      break;
  }

  if (lastChallengeLimited) {
    return next;
  }

  if (activeNames.has("materialism")) {
    flyingChestGain += 2;
    next.flyingChests += 2;
  }

  if (activeNames.has("cleansingGreed") && flyingChestGain > 0) {
    next.curses = Math.max(0, next.curses - flyingChestGain);
  }

  if (activeNames.has("hoarder") && flyingChestGain > 0) {
    const previousChestThreshold = Math.floor(state.flyingChests / 7);
    const nextChestThreshold = Math.floor(next.flyingChests / 7);
    const boonGain = Math.max(0, nextChestThreshold - previousChestThreshold);
    if (boonGain > 0) {
      next.boons += boonGain;
      next.boonPotency += boonGain * Math.round(100 * getMissionModifier(activeNames, "boon"));
    }
  }

  const pullGain = Math.max(0, next.pulls - state.pulls);
  if (activeNames.has("interestScheme") && pullGain >= 2) {
    next.effects = {
      ...next.effects,
      interestSchemeChests: clamp(
        (next.effects.interestSchemeChests ?? 0) + Math.floor(pullGain / 2),
        0,
        12,
      ),
    };
  }

  if (activeNames.has("backupBeat") && timerAdded > 0) {
    const totalTrackedSeconds = (next.effects.backupBeatSeconds ?? 0) + timerAdded;
    const rerollsGained = Math.floor(totalTrackedSeconds / 300);
    next.beaconRerolls += rerollsGained;
    next.effects = {
      ...next.effects,
      backupBeatSeconds: totalTrackedSeconds % 300,
    };
  }

  if (activeNames.has("sacrificialRitual") && next.pulls > 0) {
    next.pulls -= 1;
    next.maxChallenges = clamp(next.maxChallenges + 3, 4, HARD_CHALLENGE_CAP);
  }

  if (activeNames.has("completeChaos")) {
    next = applyCompleteChaosReward(next, activeNames);
  }

  next = applyActiveTrialAfterChallenge(next, state);

  if (
    completedChallenge === 4 &&
    state.missionSlotsUsed === 0 &&
    !state.activeMission &&
    next.phase === "beacon"
  ) {
    next.phase = "mission";
    next.offeredMissions = suggestMissions(next, 3);
    next.offered = [];
  }

  return options.clearOffer || next.offered.length === 0
    ? next
    : applyOfferSideEffects(next, [], next.offered);
}

export function applyReroll(state, options = {}) {
  if (state.beaconRerolls <= 0) {
    return state;
  }
  const activeNames = getActiveNames(state);
  const skippedGrey = state.offered.some((item) => item.id === "grey") ? 1 : 0;
  const skippedCrimson = state.offered.some((item) => item.id === "crimson") ? 1 : 0;
  const gourmandChoices = activeNames.has("gourmand")
    ? clamp((state.effects.gourmandChoices ?? 0) + 1, 0, 3)
    : state.effects.gourmandChoices;
  const excludedRerollIds = activeNames.has("optimism")
    ? state.offered.map((item) => item.id)
    : [];
  return {
    ...state,
    beaconRerolls: state.beaconRerolls - 1,
    skipCounts: {
      ...state.skipCounts,
      grey: (state.skipCounts.grey ?? 0) + skippedGrey,
      crimson: (state.skipCounts.crimson ?? 0) + skippedCrimson,
    },
    effects: {
      ...state.effects,
      gourmandChoices,
    },
    observedOffers: recordObservedOffer(state),
    offered: options.clearOffer
      ? []
      : generateSuggestedOffer(state, "reroll", { excludeIds: excludedRerollIds }),
    seed: nextSeed(state.seed + 97),
    log: [...state.log.slice(-79), "Reroll beacon pool"],
  };
}

export function applyMissionChoice(state, missionId) {
  const mission = MISSIONS[missionId];
  if (!mission || state.activeMission) {
    return state;
  }
  return {
    ...state,
    phase: "beacon",
    activeMission: mission.id,
    missionSlotsUsed: Math.min(4, state.missionSlotsUsed + 1),
    log: [...state.log.slice(-79), `Mission chosen: ${mission.name}`],
  };
}

export function completeMission(state, missionId = state.activeMission) {
  const mission = MISSIONS[missionId];
  if (!mission || state.activeMission !== mission.id) {
    return state;
  }
  const immediate = mission.immediate ?? {};
  return {
    ...state,
    activeMission: null,
    completedMissions: unique([...state.completedMissions, mission.id]),
    pulls: state.pulls + (immediate.pulls ?? 0),
    rewardRerolls: state.rewardRerolls + (immediate.rewardRerolls ?? 0),
    sacrifices: state.sacrifices + (immediate.sacrifices ?? 0),
    beaconRerolls: state.beaconRerolls + (immediate.beaconRerolls ?? 0),
    log: [...state.log.slice(-79), `Mission complete: ${mission.name}`],
  };
}

export function applyTrialChoice(state, trialId) {
  const trial = TRIALS[trialId];
  if (!trial || state.activeTrial) {
    return state;
  }
  return {
    ...state,
    phase: "beacon",
    activeTrial: trial.id,
    trialSlotsUsed: Math.min(2, state.trialSlotsUsed + 1),
    effects: {
      ...state.effects,
      gamblingBeastTriggers:
        trial.id === "gamblingBeast" ? 0 : state.effects.gamblingBeastTriggers,
    },
    log: [...state.log.slice(-79), `Trial chosen: ${trial.name}`],
  };
}

export function completeTrial(state, trialId = state.activeTrial) {
  const trial = TRIALS[trialId];
  if (!trial || state.activeTrial !== trial.id) {
    return state;
  }
  const immediate = trial.immediate ?? {};
  const pullBoost = trial.id === "treasuryBill" ? Math.ceil(state.pulls * 0.75) : 0;
  const allInRerolls = trial.id === "allIn" ? state.sacrifices * 3 : 0;
  return {
    ...state,
    activeTrial: null,
    completedTrials: unique([...state.completedTrials, trial.id]),
    pulls: state.pulls + pullBoost,
    rewardRerolls:
      state.rewardRerolls + (immediate.rewardRerolls ?? 0) + allInRerolls,
    sacrifices: trial.id === "allIn"
      ? 0
      : state.sacrifices + (immediate.sacrifices ?? 0),
    beaconRerolls: state.beaconRerolls + (immediate.beaconRerolls ?? 0),
    log: [...state.log.slice(-79), `Trial complete: ${trial.name}`],
  };
}

function applyChallengeTimerGain(timerBefore, baseTimeGain) {
  if (baseTimeGain <= 0) {
    return clamp(timerBefore, 0, GREEN_TIMER_OVER_CAP_SECONDS);
  }
  if (timerBefore >= MAX_TIMER_SECONDS) {
    return clamp(timerBefore, 0, GREEN_TIMER_OVER_CAP_SECONDS);
  }
  return clamp(timerBefore + baseTimeGain, 0, MAX_TIMER_SECONDS);
}

function isLastChallengeBeforePick(state) {
  return state.challenge >= Math.max(0, state.maxChallenges - 1);
}

function getTieredBeaconAmount(baseAmount, vibrantAmount, stackedAmount, multiplier, effectiveVibrant) {
  if (multiplier >= 4) {
    return stackedAmount;
  }
  if (effectiveVibrant) {
    return vibrantAmount;
  }
  return Math.max(baseAmount, Math.round(baseAmount * multiplier));
}

function getChoiceTier(baseChoices, vibrantChoices, stackedChoices, multiplier, effectiveVibrant) {
  if (multiplier >= 4) {
    return stackedChoices;
  }
  if (effectiveVibrant || multiplier >= 2) {
    return vibrantChoices;
  }
  return baseChoices;
}

function getGreenSafetyChallenges(aquaBoost) {
  if (aquaBoost >= 2) {
    return 3;
  }
  if (aquaBoost > 0) {
    return 2;
  }
  return 1;
}

function applyActiveTrialAfterChallenge(next, previousState) {
  if (previousState.activeTrial === "gamblingBeast") {
    const triggerIndex = (previousState.effects.gamblingBeastTriggers ?? 0) + 1;
    const timerCost = 300 + 90 * (triggerIndex - 1);
    const canPay = next.clock.timerSeconds >= timerCost;
    return {
      ...next,
      rewardRerolls: next.rewardRerolls + (canPay ? 1 : 0),
      clock: {
        ...next.clock,
        timerSeconds: clamp(next.clock.timerSeconds - timerCost, 0, GREEN_TIMER_OVER_CAP_SECONDS),
      },
      effects: {
        ...next.effects,
        gamblingBeastTriggers: triggerIndex,
      },
    };
  }

  if (previousState.activeTrial === "warmthDevourer" && next.boons > 0) {
    const averagePotency = next.boons > 0 ? next.boonPotency / next.boons : 0;
    return {
      ...next,
      boons: Math.max(0, next.boons - 1),
      boonPotency: Math.max(0, Math.round(next.boonPotency - averagePotency)),
      maxChallenges: Math.max(next.challenge, next.maxChallenges - 1),
    };
  }

  if (previousState.activeTrial === "sideHustle") {
    return {
      ...next,
      clock: {
        ...next.clock,
        timerSeconds: 75,
      },
    };
  }

  return next;
}

function applyCurseAndPullGain(state, curseGain, pullGain, activeNames) {
  let next = {
    ...state,
    curses: state.curses + curseGain,
    pulls: state.pulls + pullGain,
  };

  if (activeNames.has("equilibrium")) {
    next.effects = {
      ...next.effects,
      nextBoonPotencyBonus: clamp(
        (next.effects.nextBoonPotencyBonus ?? 0) + curseGain * 50,
        0,
        300,
      ),
    };
  }

  if (activeNames.has("opalOffering") && next.boons > 0) {
    const averagePotency = next.boons > 0 ? next.boonPotency / next.boons : 0;
    next.boons -= 1;
    next.boonPotency = Math.max(0, Math.round(next.boonPotency - averagePotency));
    next.pulls += 2 + Math.floor(averagePotency / 50);
  }

  return next;
}

function applyCompleteChaosReward(state, activeNames) {
  const rng = seededRandom(nextSeed(state.seed + state.challenge * 17));
  const pool = buildBeaconPool({ ...state, offered: [] })
    .filter((item) => !["grey", "crimson"].includes(item.id));
  const picked = weightedPick(pool, rng);

  if (!picked) {
    return state;
  }

  switch (picked.id) {
    case "blue":
      return {
        ...state,
        boons: state.boons + 1,
        boonPotency:
          state.boonPotency + Math.round(100 * getMissionModifier(activeNames, "boon")),
      };
    case "purple":
      return applyCurseAndPullGain(state, 1, 1, activeNames);
    case "yellow":
      return {
        ...state,
        flyingChests: state.flyingChests + 1,
      };
    case "aqua":
      return {
        ...state,
        effects: {
          ...state.effects,
          aquaBoost: state.effects.aquaBoost + 1,
        },
      };
    case "orange":
      return {
        ...state,
        effects: {
          ...state.effects,
          orangeChoices: [
            ...state.effects.orangeChoices,
            { remaining: 5, extra: 1 },
          ].slice(-4),
        },
      };
    case "green":
      return {
        ...state,
        clock: {
          ...state.clock,
          timerSeconds: clamp(state.clock.timerSeconds + 120, 0, GREEN_TIMER_OVER_CAP_SECONDS),
        },
        redDebt: reduceRedDebt(state.redDebt, 2),
      };
    case "darkGrey":
      return applyCurseAndPullGain(state, 3, 3, activeNames);
    case "white":
      return {
        ...state,
        maxChallenges: clamp(state.maxChallenges + 5, 4, HARD_CHALLENGE_CAP),
      };
    case "red":
      return {
        ...state,
        maxChallenges: clamp(state.maxChallenges + 3, 4, HARD_CHALLENGE_CAP),
        redDebt: addRedDebt(state.redDebt, 3),
      };
    case "pink":
      return {
        ...state,
        beaconRerolls: state.beaconRerolls + 1,
      };
    case "rainbow":
      return {
        ...state,
        effects: {
          ...state.effects,
          rainbowVibrant: Math.max(state.effects.rainbowVibrant, 10),
        },
      };
    default:
      return state;
  }
}

function advanceTimedEffects(effects) {
  return {
    ...effects,
    rainbowVibrant: Math.max(0, effects.rainbowVibrant - 1),
    greenSafetyChallenges: Math.max(0, (effects.greenSafetyChallenges ?? 0) - 1),
    orangeChoices: effects.orangeChoices
      .map((effect) => ({
        ...effect,
        remaining: effect.remaining - 1,
      }))
      .filter((effect) => effect.remaining > 0),
  };
}

function recordObservedOffer(state) {
  const normalized = normalizeOffered(state.offered);
  const previous = state.observedOffers.at(-1);
  const duplicate =
    previous &&
    previous.length === normalized.length &&
    previous.every((item, index) => item.id === normalized[index].id && item.vibrant === normalized[index].vibrant);

  if (duplicate) {
    return state.observedOffers;
  }
  return [...state.observedOffers.slice(-79), normalized];
}

function advanceRedDebt(redDebt, beaconId) {
  if (beaconId === "red") {
    return redDebt;
  }
  return reduceRedDebt(redDebt, 1);
}

function addRedDebt(redDebt, challenges) {
  const addedChallenges = Math.max(0, challenges);
  return {
    noTimeChallenges: redDebt.noTimeChallenges + addedChallenges,
    secondsLost: redDebt.secondsLost + addedChallenges * RED_NO_TIME_BONUS_SECONDS,
  };
}

function reduceRedDebt(redDebt, challenges) {
  const paidChallenges = Math.max(0, challenges);
  return {
    noTimeChallenges: Math.max(0, redDebt.noTimeChallenges - paidChallenges),
    secondsLost: Math.max(
      0,
      redDebt.secondsLost - paidChallenges * RED_NO_TIME_BONUS_SECONDS,
    ),
  };
}

export function scoreState(state) {
  const weights = DEFAULT_WEIGHTS;
  const profile = PLAYER_PROFILES[state.profile] ?? PLAYER_PROFILES.balanced;
  const remaining = Math.max(0, state.maxChallenges - state.challenge);
  const timer = getCurrentTimerSeconds(state);
  const activeNames = getActiveNames(state);
  const curseEffectiveness = activeNames.has("requiem")
    ? 0
    : activeNames.has("innerPeace")
      ? 0.5
      : 1;
  const cursePenalty = state.curses * curseEffectiveness * weights.curse * (2 - profile.curseTolerance);
  const timePressure = getTimePressure(state, timer);
  const activeCombo =
    (activeNames.has("equilibrium") && state.curses > 0 ? 110 : 0) +
    (activeNames.has("gourmand") && activeNames.has("optimism") ? 160 : 0) +
    (activeNames.has("materialism") && state.flyingChests > 0 ? 90 : 0) +
    (activeNames.has("porphyrophobia") && state.boons > 0 ? 85 : 0);

  return (
    state.pulls * weights.pull +
    state.rewardRerolls * weights.rewardReroll +
    state.sacrifices * weights.sacrifice +
    state.beaconRerolls * weights.beaconReroll +
    state.boons * weights.boon +
    state.boonPotency * weights.boonPotency +
    state.flyingChests * weights.flyingChest +
    remaining * weights.challenge * profile.clearSpeed +
    timer * weights.second * profile.timeValue +
    state.effects.aquaBoost * 130 +
    state.effects.rainbowVibrant * 46 +
    getBeaconChoiceCount(state) * weights.futureChoice +
    activeCombo +
    cursePenalty +
    state.radianceCurses * weights.radianceCurse +
    state.redDebt.secondsLost * weights.redDebtSecond +
    state.redDebt.noTimeChallenges * weights.redDebtChallenge +
    timePressure * weights.danger * (2 - profile.riskTolerance)
  );
}

function getTimePressure(state, timer = getCurrentTimerSeconds(state)) {
  const remaining = Math.max(1, state.maxChallenges - state.challenge);
  const expectedNeed = Math.min(720, remaining * 34 + state.redDebt.secondsLost * 0.65);
  if (timer >= expectedNeed) {
    return 0;
  }
  return clamp((expectedNeed - timer) / expectedNeed, 0, 1);
}

function scoreReroll(state, projectedState) {
  const currentBest = state.offered
    .map((item) =>
      canTakeBeacon(state, item.id).ok
        ? getBeaconHeuristicBonus(state, { type: "beacon", beaconId: item.id, vibrant: item.vibrant })
        : -200,
    )
    .sort((a, b) => b - a)[0] ?? -200;
  const poolNeed =
    (state.challenge < 18 && !state.useCounts.rainbow ? 90 : 0) +
    (!state.activeMission && state.completedMissions.length > 0 && state.missionSlotsUsed < 4
      ? 86
      : 0) +
    (state.challenge >= 20 && state.trialSlotsUsed < 2 ? 70 : 0);
  const choiceCount = getBeaconChoiceCount(state);
  const hasEarlySetupTarget = state.offered.some((item) =>
    ["rainbow", "orange"].includes(item.id),
  );
  const forceSetupBonus =
    state.challenge <= 13 && choiceCount >= 4 && !hasEarlySetupTarget
      ? 580
      : 0;
  const badPoolBonus = currentBest < 95 ? 150 : currentBest < 160 ? 70 : -40;
  const pinkOfferedPenalty = state.offered.some((item) => item.id === "pink") ? 80 : 0;
  const pinkSupplyDiscount = Math.min(72, (state.useCounts.pink ?? 0) * 24 + Math.max(0, state.beaconRerolls - 2) * 12);
  const lowSupplyPenalty = Math.max(0, 3 - state.beaconRerolls) * 36;
  return (
    scoreState(projectedState) -
    scoreState(state) +
    poolNeed +
    forceSetupBonus +
    badPoolBonus +
    pinkSupplyDiscount -
    pinkOfferedPenalty -
    lowSupplyPenalty
  );
}

function getBeaconHeuristicBonus(state, action) {
  const beacon = BEACONS[action.beaconId];
  const { multiplier, effectiveVibrant } = getBeaconMultiplier(state, action.vibrant);
  const timer = getCurrentTimerSeconds(state);
  const activeNames = getActiveNames(state);
  const early = state.challenge <= 12;
  const late = state.maxChallenges - state.challenge <= 8 || timer < 240;
  const remaining = Math.max(0, state.maxChallenges - state.challenge);
  const choiceCount = getBeaconChoiceCount(state);
  const hasRainbowSetup = state.effects.rainbowVibrant > 0 || (state.useCounts.rainbow ?? 0) > 0;
  const setupNeedsChoices = early && choiceCount < 5;
  const setupNeedsRainbow = early && !hasRainbowSetup;
  const stackedPremium = multiplier >= 4;

  let score = 0;
  switch (action.beaconId) {
    case "blue":
      score +=
        150 +
        34 * multiplier +
        Math.max(0, 5 - state.boons) * 54 +
        Math.max(0, state.curses - state.boons) * 34 +
        (early ? 45 : 0);
      if (setupNeedsChoices || setupNeedsRainbow) score -= 165;
      if (stackedPremium) score += 280;
      if (activeNames.has("orphionsGrace")) score += 44;
      if (activeNames.has("opalOffering")) score += 76;
      if (state.boonPotency < state.boons * 180) score += 60;
      if (activeNames.has("equilibrium") && (state.effects.nextBoonPotencyBonus ?? 0) > 0) {
        score += 135;
      }
      break;
    case "purple":
      score += 82 * multiplier - state.curses * 14;
      if (activeNames.has("porphyrophobia")) score += 95 * multiplier;
      if (activeNames.has("opalOffering") && state.boons > 0) score += 80;
      if (activeNames.has("equilibrium")) score += 58 * multiplier;
      if (activeNames.has("innerPeace")) score += 52;
      if (!hasPurpleSupportMission(activeNames)) score -= early ? 150 : 55;
      if (state.boons < 3) score -= 75;
      if (state.curses >= state.boons + 2) score -= 70;
      if (!early && state.boons >= 5) score += 54;
      break;
    case "yellow":
      score += 78 * multiplier;
      if (activeNames.has("materialism") || activeNames.has("hoarder")) score += 88 * multiplier;
      if (activeNames.has("jestersTrick") && activeNames.has("interestScheme")) {
        score += 160 * multiplier;
      }
      break;
    case "pink":
      score += 118 * multiplier + (state.beaconRerolls === 0 ? 100 : 0);
      if (early) score += 255;
      if (state.beaconRerolls >= 5) score -= 45;
      break;
    case "aqua":
      score += 190 + (hasPremiumFutureBeacon(state) ? 190 : 0) + (early ? 115 : 0);
      if (setupNeedsRainbow || setupNeedsChoices) score += 70;
      break;
    case "orange":
      score += 210 + (early ? 240 : 55);
      if (choiceCount < 4) score += 180;
      if (choiceCount < 5) score += 90;
      if (stackedPremium) score += 280;
      break;
    case "green":
      score +=
        95 * multiplier +
        (timer < 360 ? 180 : 0) +
        state.curses * 10 +
        state.redDebt.noTimeChallenges * 64 +
        state.redDebt.secondsLost * 0.7;
      if (activeNames.has("gamblingBeast")) {
        score += 230 + (state.effects.aquaBoost > 0 || effectiveVibrant ? 150 : 0);
      }
      if (activeNames.has("chronotrigger")) {
        score += 150 + state.pulls * 3.5 + state.curses * 16;
      }
      break;
    case "darkGrey":
      score += 250 * multiplier - state.curses * 18;
      if (activeNames.has("equilibrium") || activeNames.has("innerPeace")) score += 110;
      break;
    case "white":
      score += 250 + (stackedPremium ? 360 : effectiveVibrant ? 150 : 0) + (late ? -120 : 65);
      if (!hasRainbowSetup && early) score -= 100;
      break;
    case "grey":
      score += 260 + (state.missionSlotsUsed <= 1 ? 80 : 0) + (late ? -90 : 0);
      if (state.challenge < 14 || choiceCount < 4 || !hasRainbowSetup) score -= 130;
      if (state.challenge >= 20 && state.challenge <= 40) score += 90;
      if (stackedPremium) score += 120;
      break;
    case "red":
      score += 150 + (effectiveVibrant ? 85 : 0) + (stackedPremium ? 260 : 0);
      if (remaining <= 4) score += 320;
      if (early && !hasRainbowSetup && state.maxChallenges < 20) score += 540;
      score += timer > 480 ? 85 : -210;
      score -= state.redDebt.secondsLost * 0.55;
      break;
    case "crimson":
      score += 310 + (state.effects.aquaBoost > 0 || effectiveVibrant ? 120 : -90);
      if (stackedPremium) score += 160;
      if (state.challenge >= 20 && state.challenge <= 35) score += 90;
      break;
    case "rainbow":
      score += 560 + (early ? 260 : 90);
      if (!hasRainbowSetup) score += 220;
      if (state.effects.rainbowVibrant <= 3) score += 90;
      break;
    default:
      break;
  }

  if (
    isLastChallengeBeforePick(state) &&
    !["red", "white", "purple", "darkGrey"].includes(action.beaconId)
  ) {
    score -= 900;
  }

  return score;
}

function scoreMission(state, mission) {
  const timer = getCurrentTimerSeconds(state);
  const activeNames = getActiveNames(state);
  const early = state.challenge <= 14;
  const late = state.maxChallenges - state.challenge <= 8 || timer < 240;
  let score = mission.baseScore;

  if (mission.archetype === "curse-stack") {
    score += state.curses * 16 + state.beaconRerolls * 8;
  }
  if (mission.archetype === "reroll") {
    score += 95 + (state.beaconRerolls <= 1 ? 42 : 0);
    if (activeNames.has("gourmand") || activeNames.has("optimism")) score += 42;
  }
  if (mission.archetype === "sacrifice") {
    score += 130 + state.rewardRerolls * 11;
    if (activeNames.has("redemption") || activeNames.has("ultimateSacrifice")) score += 38;
  }
  if (mission.archetype === "pull") {
    score += 160 + state.sacrifices * 18 + state.rewardRerolls * 14;
  }
  if (mission.archetype === "chest") {
    score += state.flyingChests * 18 + (activeNames.has("materialism") ? 35 : 0);
    if (activeNames.has("hoarder") || activeNames.has("interestScheme")) score += 44;
  }
  if (mission.archetype === "timer") {
    score += timer < 360 ? 96 : 25;
    score += state.redDebt.noTimeChallenges * 18;
  }
  if (mission.id === "opalOffering") {
    score += 120 + Math.min(180, state.boonPotency * 0.08);
    if (activeNames.has("radiantHunter")) score += 55;
    if (activeNames.has("sacrificialRitual")) score += 45;
  }
  if (mission.id === "jestersTrick" && activeNames.has("interestScheme")) score += 140;
  if (mission.id === "interestScheme" && activeNames.has("jestersTrick")) score += 140;
  if (mission.id === "materialism" && activeNames.has("jestersTrick")) score += 90;
  if (mission.id === "radiantHunter") {
    if (activeNames.has("opalOffering") || activeNames.has("chronotrigger")) score += 70;
    if (activeNames.has("lightsOut")) score += 45;
  }
  if (mission.id === "backupBeat" && (activeNames.has("optimism") || activeNames.has("gamblingBeast"))) {
    score += 70;
  }
  if (mission.id === "porphyrophobia") {
    score += activeNames.has("innerPeace") || activeNames.has("opalOffering") ? 85 : -20;
    if (early && !activeNames.has("innerPeace")) score -= 45;
  }
  if (mission.id === "stasis" && !late) score += 42;
  if (late && !["highRoller", "redemption", "innerPeace", "completeChaos"].includes(mission.id)) score -= 38;
  return score;
}

function scoreTrial(state, trial) {
  const timer = getCurrentTimerSeconds(state);
  const profile = PLAYER_PROFILES[state.profile] ?? PLAYER_PROFILES.balanced;
  const activeNames = getActiveNames(state);
  let score = trial.baseScore;
  const immediate = trial.immediate ?? {};
  score += (immediate.rewardRerolls ?? 0) * 92;
  score += (immediate.sacrifices ?? 0) * 160;
  score += state.pulls > 40 && trial.id === "treasuryBill" ? 120 : 0;
  score += state.sacrifices > 0 && trial.id === "allIn" ? state.sacrifices * 95 : 0;
  score += timer < 420 && ["gamblingBeast", "sideHustle", "chronotrigger"].includes(trial.id) ? -85 : 0;
  if (trial.tier === "S") score += 85;
  if (trial.tier === "A") score += 45;
  if (trial.id === "gamblingBeast") {
    score += state.trialSlotsUsed >= 1 ? 150 : -60;
    if (activeNames.has("redemption") || activeNames.has("highRoller")) score += 70;
    if (activeNames.has("backupBeat") || activeNames.has("optimism")) score += 55;
  }
  if (trial.id === "chronotrigger") {
    if (activeNames.has("radiantHunter") || activeNames.has("chronokinesis")) score += 80;
    if (activeNames.has("porphyrophobia")) score += 60;
  }
  if (trial.id === "dyingLight" && state.boonPotency >= 700) score += 120;
  if (trial.id === "treasuryBill" && state.pulls < 20) score -= 70;
  score -= trial.danger * (2 - profile.riskTolerance) * 0.75;
  return score;
}

function getBeaconReasons(state, action, projectedState) {
  const beacon = BEACONS[action.beaconId];
  const { multiplier, effectiveVibrant } = getBeaconMultiplier(state, action.vibrant);
  const reasons = [beacon.reason];

  if (action.beaconId === "blue" && multiplier > 1) {
    reasons.push(`Blue still grants 1 boon; Aqua/Vibrant raises potency to x${round(multiplier, 1)}.`);
  } else if (action.beaconId === "crimson" && multiplier > 1) {
    reasons.push(`Boost increases Crimson trial choices, capped at 4.`);
  } else if (multiplier > 1) {
    reasons.push(`Receives x${round(multiplier, 1)} from Aqua${effectiveVibrant ? " + Vibrant" : ""}.`);
  } else if (effectiveVibrant) {
    reasons.push("Vibrant doubles this beacon's practical effect.");
  }

  if (projectedState.phase === "mission") {
    reasons.push("After picking it, the app switches to mission ranking.");
  }
  if (projectedState.phase === "trial") {
    reasons.push("After picking it, the app switches to trial ranking.");
  }
  if (getCurrentTimerSeconds(state) < 300 && action.beaconId !== "green") {
    reasons.push("Low timer applies a risk penalty.");
  }
  if (action.beaconId === "green" && state.redDebt.noTimeChallenges > 0) {
    reasons.push(`Green pays down Red no-time-bonus debt: ${state.redDebt.noTimeChallenges} challenges / ${state.redDebt.secondsLost}s.`);
  }
  if (action.beaconId === "red") {
    reasons.push("Red adds challenge ceiling but increases no-time-bonus debt.");
  }
  return reasons.slice(0, 4);
}

function getRerollReasons(state) {
  const reasons = ["Use reroll when the current pool lacks a high-EV Grey, Crimson, Rainbow, Aqua, or Green line."];
  if (state.beaconRerolls <= 2) {
    reasons.push("Low reroll supply increases opportunity cost.");
  }
  if (state.challenge < 18 && !state.useCounts.rainbow) {
    reasons.push("Early runs value finding Rainbow, Orange, and Aqua highly.");
  }
  if (state.offered.some((item) => item.id === "pink")) {
    reasons.push("Pink is currently offered, so spending a reroll is less attractive than refilling supply.");
  } else if ((state.useCounts.pink ?? 0) > 0) {
    reasons.push("Prior Pink value lowers the cost of using rerolls now.");
  }
  return reasons;
}

function getMissionReasons(state, mission, offered) {
  const reasons = [
    offered ? "Currently offered by the game." : "Reference only; not in the current offered set.",
    mission.reward,
  ];
  if (state.activeMission) {
    reasons.push("A pending mission blocks Grey until you mark it complete.");
  }
  if (mission.archetype === "reroll") {
    reasons.push("Best for forcing premium beacons and fixing bad pools.");
  }
  if (mission.archetype === "curse-stack") {
    reasons.push("Strong when Purple or Dark Grey converts curse into value.");
  }
  if (mission.archetype === "chest") {
    reasons.push("Strong with Yellow value or fast chest routing.");
  }
  if (getCurrentTimerSeconds(state) < 300 && mission.archetype !== "timer") {
    reasons.push("Low timer means this needs a finishable objective.");
  }
  if (state.completedMissions.length > 1) {
    reasons.push("Scores include all completed mission synergies together.");
  }
  return reasons.slice(0, 4);
}

function getTrialReasons(state, trial, offered) {
  const reasons = [
    offered ? "Currently offered by the game." : "Reference only; not in the current offered set.",
    trial.reward,
  ];
  if (trial.objective) {
    reasons.push(`Objective: ${trial.objective}`);
  }
  if (trial.penalty) {
    reasons.push(`Penalty: ${trial.penalty}`);
  }
  if ((trial.immediate?.sacrifices ?? 0) > 0) {
    reasons.push("Sacrifice improves long-term expected value.");
  }
  if ((trial.immediate?.rewardRerolls ?? 0) > 0) {
    reasons.push("End Reward Reroll increases reward chest sampling.");
  }
  if (trial.danger > 75) {
    reasons.push("High danger; needs enough timer, boons, or confidence.");
  }
  return reasons.slice(0, 4);
}

function formatSimulationReason(sim) {
  if (sim.kind === "mcts") {
    return `MCTS visits ${sim.visits}, avg utility ${round(sim.mean, 0)}, UCB search depth ${sim.horizon}.`;
  }
  return `Monte Carlo ${sim.samples} rollouts: EV ${round(sim.mean, 0)} / spread ${round(sim.max - sim.min, 0)}.`;
}

function calculateConfidence(sim) {
  if (sim.kind === "mcts") {
    return clamp(0.5 + Math.log10(Math.max(1, sim.visits)) * 0.12, 0.5, 0.94);
  }
  const spread = Math.max(1, sim.max - sim.min);
  const relative = Math.abs(sim.mean) / spread;
  return clamp(0.52 + relative * 0.18 + Math.log10(sim.samples) * 0.08, 0.5, 0.94);
}

function hasPremiumFutureBeacon(state) {
  return state.offered.some((item) =>
    ["grey", "crimson", "white", "darkGrey", "rainbow", "yellow", "green"].includes(item.id),
  );
}

function hasPurpleSupportMission(activeNames) {
  return [
    "porphyrophobia",
    "opalOffering",
    "equilibrium",
    "innerPeace",
    "cleansingGreed",
  ].some((missionId) => activeNames.has(missionId));
}

function getActiveNames(state) {
  return new Set([
    ...state.completedMissions,
    ...state.completedTrials,
    state.activeTrial === "gamblingBeast" ? state.activeTrial : null,
  ].filter(Boolean));
}

function getMissionModifier(activeNames, kind) {
  if (kind === "boon" && activeNames.has("orphionsGrace")) {
    return 1.5;
  }
  return 1;
}

export function suggestMissions(state, count = 3) {
  return rankMissions(state)
    .slice(0, count)
    .map((item) => item.missionId);
}

export function suggestTrials(state, count = 2) {
  return rankTrials(state)
    .slice(0, count)
    .map((item) => item.trialId);
}

export function generateSuggestedOffer(state, salt = "", options = {}) {
  const rng = seededRandom(state.seed + String(salt).length * 7919 + state.challenge * 37);
  const targetCount = getBeaconChoiceCount(state);
  const pool = buildBeaconPool(state);
  const excludedIds = new Set(options.excludeIds ?? []);
  const selected = [];
  const usedIds = new Set();
  let guard = 0;

  while (selected.length < targetCount && guard < 80) {
    guard += 1;
    const picked = weightedPick(pool, rng);
    if (!picked || usedIds.has(picked.id) || excludedIds.has(picked.id)) {
      continue;
    }
    usedIds.add(picked.id);
    const vibrantChance = state.effects.rainbowVibrant > 0 ? 1 : 0.1;
    selected.push({
      id: picked.id,
      vibrant: rng() < vibrantChance,
    });
  }

  guard = 0;
  while (selected.length < targetCount && guard < 80 && excludedIds.size > 0) {
    guard += 1;
    const picked = weightedPick(pool, rng);
    if (!picked || usedIds.has(picked.id)) {
      continue;
    }
    usedIds.add(picked.id);
    const vibrantChance = state.effects.rainbowVibrant > 0 ? 1 : 0.1;
    selected.push({
      id: picked.id,
      vibrant: rng() < vibrantChance,
    });
  }

  if (selected.length === 0) {
    return DEFAULT_OFFERED_BEACONS;
  }
  return selected;
}

export function buildBeaconPool(state) {
  const calibration = getObservedOfferCalibration(state);
  return BEACON_IDS
    .map((id) => {
      const beacon = BEACONS[id];
      const legal = canTakeBeacon({ ...state, offered: [] }, id);
      if (!legal.ok) {
        return null;
      }
      let weight = beacon.baseWeight;
      if (state.challenge > 10 && ["orange", "pink", "white", "darkGrey"].includes(id)) {
        weight *= 0.55;
      }
      if (getBeaconChoiceCount(state) <= 3 && ["orange", "pink", "crimson"].includes(id)) {
        weight *= 0.62;
      }
      if (id === "grey") {
        weight *= state.challenge > 35 ? 0.32 : 1;
        if ((state.useCounts.grey ?? 0) >= 1) {
          weight *= Math.max(0.12, 1 - (state.skipCounts.grey ?? 0) * 0.14);
        }
      }
      if (id === "crimson") {
        weight *= state.challenge > 60 ? 0.32 : 1;
        weight *= Math.max(0.08, 1 - (state.skipCounts.crimson ?? 0) * 0.16);
      }
      if (id === "rainbow") {
        weight *= state.challenge < 8 ? 0.58 : state.challenge > 44 ? 0.72 : 1;
      }
      weight = applyObservedCalibration(weight, id, calibration);
      return { id, weight: Math.max(0.02, weight) };
    })
    .filter(Boolean);
}

export function getObservedOfferCalibration(state) {
  const counts = Object.fromEntries(BEACON_IDS.map((id) => [id, 0]));
  const observedOffers = Array.isArray(state.observedOffers) ? state.observedOffers : [];
  let total = 0;

  for (const offerSet of observedOffers) {
    for (const offer of offerSet) {
      if (counts[offer.id] !== undefined) {
        counts[offer.id] += 1;
        total += 1;
      }
    }
  }

  return {
    counts,
    total,
    strength: Math.min(0.55, total / 80),
  };
}

function applyObservedCalibration(weight, id, calibration) {
  if (!calibration.total) {
    return weight;
  }

  const priorTotal = BEACON_IDS.reduce((sum, beaconId) => sum + BEACONS[beaconId].baseWeight, 0);
  const priorFrequency = BEACONS[id].baseWeight / priorTotal;
  const observedFrequency = calibration.counts[id] / calibration.total;
  const blendedFrequency =
    priorFrequency * (1 - calibration.strength) + observedFrequency * calibration.strength;
  const ratio = clamp(blendedFrequency / Math.max(0.001, priorFrequency), 0.45, 1.85);
  return weight * ratio;
}

function weightedPick(pool, rng) {
  const total = pool.reduce((sum, item) => sum + item.weight, 0);
  let roll = rng() * total;
  for (const item of pool) {
    roll -= item.weight;
    if (roll <= 0) {
      return item;
    }
  }
  return pool.at(-1);
}

function seededRandom(seed) {
  let value = seed || 1;
  return () => {
    value = (value * 1664525 + 1013904223) % 4294967296;
    return value / 4294967296;
  };
}

function nextSeed(seed) {
  return (seed * 1103515245 + 12345) & 0x7fffffff;
}

function unique(items) {
  return [...new Set(items)];
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}
