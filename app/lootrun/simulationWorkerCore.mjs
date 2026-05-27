import { runSimulation } from "./simulator.mjs";

export function canRunMainThreadFallback(computeMode) {
  return computeMode === "light" || computeMode === "balanced";
}

export function createTimeoutFallbackResult(previousResult, computeMode) {
  const hasPrevious =
    previousResult?.simulation instanceof Map && previousResult.simulation.size > 0;
  return {
    simulation: hasPrevious ? previousResult.simulation : new Map(),
    pending: false,
    source: hasPrevious ? "stale" : "heuristic",
    error:
      computeMode === "deep" || computeMode === "max"
        ? "Worker timeout. Showing previous or heuristic result."
        : "Worker timeout. Used main-thread fallback.",
  };
}

export function simulateForWorker(request) {
  const simulation = runSimulation(
    request.state,
    request.computeMode,
    request.searchMode,
    {
      mctsIterations: request.mctsIterations,
      mctsDepth: request.mctsDepth,
    },
  );

  return {
    id: request.id,
    ok: true,
    searchMode: request.searchMode,
    computeMode: request.computeMode,
    entries: [...simulation.entries()],
  };
}

export function simulationEntriesToMap(entries) {
  return new Map(Array.isArray(entries) ? entries : []);
}
