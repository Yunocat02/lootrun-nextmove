import { COMPUTE_MODES } from "./rules.mjs";
import {
  evaluateAction,
  generateSuggestedOffer,
  getLegalActions,
  scoreState,
  setGeneratedOffer,
} from "./engine.mjs";

const UCB_EXPLORATION = 1.414;

export function runMonteCarlo(state, mode = "balanced", overrides = {}) {
  const config = getSimulationConfig(mode, overrides);
  return runActionSimulations(state, config);
}

export function runSimulation(state, mode = "balanced", searchMode = "rollout", overrides = {}) {
  const config = getSimulationConfig(mode, overrides);
  if (searchMode === "mcts") {
    return runMctsSearch(state, config);
  }
  return runActionSimulations(state, config);
}

export function getSimulationConfig(mode = "balanced", overrides = {}) {
  const base = COMPUTE_MODES[mode] ?? COMPUTE_MODES.balanced;
  return {
    ...base,
    rollouts: Math.max(1, Math.floor(overrides.rollouts ?? base.rollouts)),
    horizon: Math.max(1, Math.floor(overrides.horizon ?? base.horizon)),
    mctsIterations: Math.max(
      1,
      Math.floor(overrides.mctsIterations ?? base.mctsIterations),
    ),
    mctsDepth: Math.max(1, Math.floor(overrides.mctsDepth ?? base.mctsDepth)),
  };
}

export function runActionSimulations(state, options = {}) {
  const actions = getLegalActions(state);
  const rollouts = Math.max(1, Math.floor(options.rollouts ?? 96));
  const horizon = Math.max(1, Math.floor(options.horizon ?? 8));
  const results = new Map();

  for (const action of actions) {
    const values = [];
    for (let sampleIndex = 0; sampleIndex < rollouts; sampleIndex += 1) {
      const seed = makeSeed(state.seed, action.key, sampleIndex);
      const rng = seededRandom(seed);
      const projected = evaluateAction(state, action).projectedState;
      const value = rollout(projected, horizon, rng);
      values.push(value);
    }

    const sum = values.reduce((total, value) => total + value, 0);
    results.set(action.key, {
      actionKey: action.key,
      kind: "rollout",
      mean: sum / values.length,
      min: Math.min(...values),
      max: Math.max(...values),
      samples: values.length,
      horizon,
    });
  }

  return results;
}

export function runMctsSearch(state, options = {}) {
  const iterations = Math.max(1, Math.floor(options.mctsIterations ?? 420));
  const maxDepth = Math.max(1, Math.floor(options.mctsDepth ?? 8));
  const root = createNode(cloneRunState(state), null, null, 0);
  const rng = seededRandom(makeSeed(state.seed, "mcts", iterations + maxDepth));

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    let node = root;

    while (node.untriedActions.length === 0 && node.children.length > 0 && node.depth < maxDepth) {
      node = selectBestUcbChild(node);
    }

    if (node.untriedActions.length > 0 && node.depth < maxDepth) {
      node = expandNode(node, rng);
    }

    const terminalValue = rollout(node.state, maxDepth - node.depth, rng);
    backpropagate(node, terminalValue);
  }

  return summarizeMcts(root, state, maxDepth, iterations);
}

function createNode(state, parent, action, depth) {
  return {
    state,
    parent,
    action,
    depth,
    visits: 0,
    totalUtility: 0,
    children: [],
    untriedActions: getLegalActions(state),
  };
}

function selectBestUcbChild(node) {
  const parentVisits = Math.max(1, node.visits);
  return node.children
    .map((child) => {
      const averageUtility = child.visits > 0 ? child.totalUtility / child.visits / 1000 : 0;
      const exploration =
        child.visits > 0
          ? UCB_EXPLORATION * Math.sqrt(Math.log(parentVisits) / child.visits)
          : Number.POSITIVE_INFINITY;
      return { child, ucb: averageUtility + exploration };
    })
    .sort((a, b) => b.ucb - a.ucb)[0].child;
}

function expandNode(node, rng) {
  const actionIndex = Math.floor(rng() * node.untriedActions.length);
  const [action] = node.untriedActions.splice(actionIndex, 1);
  const projected = evaluateAction(node.state, action).projectedState;
  const child = createNode(projected, node, action, node.depth + 1);
  node.children.push(child);
  return child;
}

function backpropagate(node, utility) {
  let cursor = node;
  while (cursor) {
    cursor.visits += 1;
    cursor.totalUtility += utility;
    cursor = cursor.parent;
  }
}

function summarizeMcts(root, state, maxDepth, iterations) {
  const results = new Map();
  const baseline = scoreState(state);
  const rootActions = getLegalActions(state);

  for (const action of rootActions) {
    const child = root.children.find((candidate) => candidate.action?.key === action.key);
    if (child) {
      const mean = child.totalUtility / Math.max(1, child.visits);
      results.set(action.key, {
        actionKey: action.key,
        kind: "mcts",
        mean,
        min: mean,
        max: mean,
        visits: child.visits,
        samples: child.visits,
        horizon: maxDepth,
        iterations,
        averageUtility: mean,
        ucbExploration: UCB_EXPLORATION,
      });
    } else {
      const fallbackState = evaluateAction(state, action).projectedState;
      const mean = scoreState(fallbackState);
      results.set(action.key, {
        actionKey: action.key,
        kind: "mcts",
        mean,
        min: mean,
        max: mean,
        visits: 0,
        samples: 0,
        horizon: maxDepth,
        iterations,
        averageUtility: mean,
        ucbExploration: UCB_EXPLORATION,
        baseline,
      });
    }
  }

  return results;
}

function rollout(startState, horizon, rng) {
  let state = cloneRunState(startState);

  for (let step = 0; step < horizon; step += 1) {
    if (state.phase === "beacon") {
      const offered = generateSuggestedOffer(
        {
          ...state,
          seed: makeSeed(state.seed, "offer", step + Math.floor(rng() * 10000)),
        },
        `rollout-${step}`,
      );
      state = setGeneratedOffer(state, offered);
    }

    const actions = getLegalActions(state);
    if (actions.length === 0) {
      break;
    }

    const chosen = chooseRolloutAction(state, actions, rng);
    state = evaluateAction(state, chosen).projectedState;
  }

  return scoreState(state);
}

function chooseRolloutAction(state, actions, rng) {
  const scored = actions
    .map((action) => ({
      action,
      score:
        evaluateAction(state, action).score +
        rng() * 34 -
        (action.type === "reroll" ? rng() * 18 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  if (scored.length === 1 || rng() < 0.78) {
    return scored[0].action;
  }
  if (rng() < 0.92) {
    return scored[Math.min(1, scored.length - 1)].action;
  }
  return scored[Math.floor(rng() * Math.min(3, scored.length))].action;
}

function cloneRunState(state) {
  return JSON.parse(JSON.stringify(state));
}

function makeSeed(seed, key, offset) {
  const text = `${seed}:${key}:${offset}`;
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let value = seed || 1;
  return () => {
    value = Math.imul(value ^ (value >>> 15), 1 | value);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
