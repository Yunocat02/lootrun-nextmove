"use client";

import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  BEACON_IDS,
  BEACONS,
  COMPUTE_MODES,
  MISSION_IDS,
  MISSIONS,
  PLAYER_PROFILES,
  RULESET_VERSION,
  SEARCH_MODES,
  SOURCE_LINKS,
  TRIAL_IDS,
  TRIALS,
} from "./rules.mjs";
import {
  createInitialRunState,
  formatTimer,
  getBeaconChoiceCount,
  getCurrentTimerSeconds,
  rankActions,
  rankMissions,
  rankTrials,
  runReducer,
} from "./engine.mjs";
import { runSimulation } from "./simulator.mjs";
import {
  canRunMainThreadFallback,
  createTimeoutFallbackResult,
  simulationEntriesToMap,
} from "./simulationWorkerCore.mjs";

const STORAGE_KEY = "yunyun-lootrun-advisor-state";

function useWorkerSimulation(analysisState, controls) {
  const [result, setResult] = useState({
    simulation: new Map(),
    pending: false,
    source: "heuristic",
    error: null,
  });
  const workerRef = useRef(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const id = requestIdRef.current + 1;
    requestIdRef.current = id;
    let fallbackTimer = null;

    if (!controls.enabled) {
      // Waiting state intentionally resets stale worker output when the offer is incomplete.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResult({
        simulation: new Map(),
        pending: false,
        source: "waiting",
        error: null,
      });
      return undefined;
    }

    const request = {
      id,
      state: analysisState,
      computeMode: controls.computeMode,
      searchMode: controls.searchMode,
      mctsIterations: controls.mctsIterations,
      mctsDepth: controls.mctsDepth,
    };

    function runFallback(message) {
      if (canRunMainThreadFallback(request.computeMode)) {
        const simulation = runSimulation(
          request.state,
          request.computeMode,
          request.searchMode,
          request,
        );
        setResult({
          simulation,
          pending: false,
          source: "main-thread fallback",
          error: message,
        });
        return;
      }

      setResult((previous) => createTimeoutFallbackResult(previous, request.computeMode));
    }

    if (typeof Worker === "undefined") {
      runFallback("Worker unavailable.");
      return undefined;
    }

    try {
      if (!workerRef.current) {
        workerRef.current = new Worker(new URL("./simulation.worker.js", import.meta.url), {
          type: "module",
        });
      }

      const worker = workerRef.current;
      fallbackTimer = window.setTimeout(
        () => {
          if (id !== requestIdRef.current) {
            return;
          }
          runFallback("Worker did not respond in time.");
        },
        request.computeMode === "max" || request.computeMode === "deep" ? 12000 : 5000,
      );
      worker.onmessage = (event) => {
        if (event.data?.id !== requestIdRef.current) {
          return;
        }
        if (fallbackTimer) {
          window.clearTimeout(fallbackTimer);
        }
        if (!event.data.ok) {
          runFallback(event.data.message);
          return;
        }
        setResult({
          simulation: simulationEntriesToMap(event.data.entries),
          pending: false,
          source: "worker",
          error: null,
        });
      };
      worker.onerror = () => {
        if (fallbackTimer) {
          window.clearTimeout(fallbackTimer);
        }
        runFallback("Worker failed.");
      };
      setResult((previous) => ({
        ...previous,
        pending: true,
        source: "worker",
        error: null,
      }));
      worker.postMessage(request);
    } catch (error) {
      runFallback(error instanceof Error ? error.message : "Worker unavailable.");
    }

    return () => {
      if (fallbackTimer) {
        window.clearTimeout(fallbackTimer);
      }
    };
  }, [
    analysisState,
    controls.enabled,
    controls.computeMode,
    controls.searchMode,
    controls.mctsIterations,
    controls.mctsDepth,
  ]);

  useEffect(
    () => () => {
      workerRef.current?.terminate();
    },
    [],
  );

  return result;
}

export default function LootrunAdvisor() {
  const [state, dispatch] = useReducer(runReducer, undefined, createInitialRunState);
  const [hydrated, setHydrated] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        dispatch({ type: "HYDRATE", state: JSON.parse(saved) });
      }
    } catch {
      window.localStorage.removeItem(STORAGE_KEY);
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }, [hydrated, state]);

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, []);

  const timerSeconds = getCurrentTimerSeconds(state, now);
  const beaconChoiceCount = getBeaconChoiceCount(state);
  const beaconOfferReady =
    state.phase !== "beacon" || state.offered.length >= beaconChoiceCount;
  const remainingBeaconChoices = Math.max(0, beaconChoiceCount - state.offered.length);
  const analysisTimerSeconds = Math.floor(state.clock.timerSeconds / 15) * 15;
  const analysisState = useMemo(
    () => ({
      ...state,
      clock: {
        running: false,
        startedAt: null,
        timerSeconds: analysisTimerSeconds,
      },
    }),
    [state, analysisTimerSeconds],
  );

  const simulationResult = useWorkerSimulation(analysisState, {
    enabled: beaconOfferReady,
    computeMode: state.computeMode,
    searchMode: state.searchMode,
    mctsIterations: state.mctsIterations,
    mctsDepth: state.mctsDepth,
  });

  const rankedActions = useMemo(
    () => {
      if (state.phase === "beacon" && (!beaconOfferReady || simulationResult.pending)) {
        return [];
      }
      return rankActions(analysisState, simulationResult.simulation);
    },
    [
      analysisState,
      beaconOfferReady,
      simulationResult.pending,
      simulationResult.simulation,
      state.phase,
    ],
  );

  const missionRanks = useMemo(() => rankMissions(analysisState), [analysisState]);
  const trialRanks = useMemo(() => rankTrials(analysisState), [analysisState]);
  const currentBest = rankedActions[0];

  function handleAction(action) {
    const base = { now: Date.now() };
    if (action.type === "beacon") {
      dispatch({
        ...base,
        type: "PICK_BEACON",
        beaconId: action.beaconId,
        vibrant: action.vibrant,
      });
    }
    if (action.type === "reroll") {
      dispatch({ ...base, type: "REROLL_BEACONS" });
    }
    if (action.type === "mission") {
      dispatch({ ...base, type: "CHOOSE_MISSION", missionId: action.missionId });
    }
    if (action.type === "trial") {
      dispatch({ ...base, type: "CHOOSE_TRIAL", trialId: action.trialId });
    }
  }

  return (
    <main className="app-shell">
      <header className="hero">
        <div className="hero-copy">
          <p className="eyebrow">Wynncraft Lootrun</p>
          <h1>YunYun Lootrun Advisor</h1>
          <p className="subtitle">
            Manual next-move advisor for Wynncraft lootruns. Enter the beacons
            you see in game, then let the guide-tuned engine rank your next move.
          </p>
          <div className="hero-tags">
            <span>{RULESET_VERSION}</span>
            <span>Manual companion</span>
            <span>No game automation</span>
          </div>
        </div>
        <TimerPanel
          timerSeconds={timerSeconds}
          running={state.clock.running}
          canUndo={state.history.length > 0}
          onSetTimer={(seconds) =>
            dispatch({ type: "SET_TIMER", seconds, now: Date.now() })
          }
          onToggleRunning={() =>
            dispatch({
              type: state.clock.running ? "PAUSE_CLOCK" : "START_CLOCK",
              now: Date.now(),
            })
          }
          onUndo={() => dispatch({ type: "UNDO", now: Date.now() })}
          onReset={() => dispatch({ type: "RESET" })}
        />
      </header>

      <section className="status-grid">
        <Metric label="Challenge" value={`${state.challenge}/${state.maxChallenges}`} />
        <Metric label="Pulls" value={state.pulls} />
        <Metric label="Beacon Reroll" value={state.beaconRerolls} />
        <Metric label="End Reroll" value={state.rewardRerolls} />
        <Metric label="Sacrifice" value={state.sacrifices} />
        <Metric label="Red Debt" value={`${state.redDebt.noTimeChallenges}/${state.redDebt.secondsLost}s`} />
        <Metric label="Observed" value={state.observedOffers.length} />
        <Metric label="Phase" value={state.phase} />
      </section>

      <section className="workspace-grid">
        <aside className="input-column">
          {state.phase === "mission" ? (
            <ChoicePanel
              title="Mission Board"
              subtitle="Ranks missions for the current run state"
              ranks={missionRanks}
              table={MISSIONS}
              idKey="missionId"
              offered={state.offeredMissions}
              options={MISSION_IDS}
              onSetOffered={(index, missionId) =>
                dispatch({ type: "SET_OFFERED_MISSION", index, missionId })
              }
              onPick={handleAction}
            />
          ) : state.phase === "trial" ? (
            <ChoicePanel
              title="Trial Board"
              subtitle="Pick the highest EV trial that is still survivable"
              ranks={trialRanks}
              table={TRIALS}
              idKey="trialId"
              offered={state.offeredTrials}
              options={TRIAL_IDS}
              onSetOffered={(index, trialId) =>
                dispatch({ type: "SET_OFFERED_TRIAL", index, trialId })
              }
              onPick={handleAction}
            />
          ) : (
            <BeaconPanel
              state={state}
              onSetBeacon={(index, beaconId) =>
                dispatch({ type: "SET_OFFERED_BEACON", index, beaconId })
              }
              onToggleVibrant={(index) =>
                dispatch({ type: "TOGGLE_OFFERED_VIBRANT", index })
              }
              onAddBeacon={(beaconId) =>
                dispatch({ type: "ADD_OFFERED_BEACON", beaconId })
              }
              onRemoveBeacon={(index) =>
                dispatch({ type: "REMOVE_OFFERED_BEACON", index })
              }
              onClearBeacons={() => dispatch({ type: "CLEAR_OFFERED_BEACONS" })}
            />
          )}

        </aside>

        <div className="decision-column">
          <BestMovePanel
            action={currentBest}
            rankedActions={rankedActions}
            phase={state.phase}
            onPick={handleAction}
            missionRanks={missionRanks}
            trialRanks={trialRanks}
            simulationResult={simulationResult}
            decisionState={{
              ready: beaconOfferReady && !simulationResult.pending,
              statusText: getDecisionStatusText(
                beaconOfferReady,
                simulationResult,
                remainingBeaconChoices,
              ),
              message: getDecisionMessage(
                beaconOfferReady,
                simulationResult.pending,
                remainingBeaconChoices,
              ),
            }}
          />
          <MissionTrialPreview
            missionRanks={missionRanks}
            trialRanks={trialRanks}
            onPick={handleAction}
          />
        </div>

        <aside className="side-column">
          <TuningPanel state={state} dispatch={dispatch} />
          <ComboPanel dispatch={dispatch} state={state} timerSeconds={timerSeconds} />
          <LogPanel entries={state.log} />
          <SourcePanel />
        </aside>
      </section>
      <footer className="app-footer">
        <span>
          YunYun Lootrun Advisor is an unofficial manual companion for Wynncraft
          players. It does not read game memory, send packets, automate clicks,
          or require a mod.
        </span>
      </footer>
    </main>
  );
}

function TimerPanel({
  timerSeconds,
  running,
  canUndo,
  onSetTimer,
  onToggleRunning,
  onUndo,
  onReset,
}) {
  const percent = Math.min(100, (timerSeconds / 900) * 100);
  return (
    <section className="timer-panel" aria-label="Lootrun timer">
      <div className="timer-head">
        <span className="metric-label">Timer</span>
        <span className={running ? "live-dot on" : "live-dot"}>{running ? "LIVE" : "SYNC"}</span>
      </div>
      <strong className="timer-display">{formatTimer(timerSeconds)}</strong>
      <div className="timer-bar" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      <div className="button-row">
        <button className="tool-button primary" onClick={onToggleRunning}>
          {running ? "Pause" : "Start"}
        </button>
        <button className="tool-button" disabled={!canUndo} onClick={onUndo}>
          Undo
        </button>
        <button className="tool-button subtle" onClick={onReset}>
          Reset
        </button>
      </div>
      <div className="timer-controls">
        <button onClick={() => onSetTimer(timerSeconds - 60)}>-60</button>
        <button onClick={() => onSetTimer(timerSeconds + 60)}>+60</button>
        <input
          aria-label="timer seconds"
          type="number"
          min="0"
          max="1200"
          step="15"
          value={Math.round(timerSeconds)}
          onChange={(event) => onSetTimer(Number(event.target.value))}
        />
      </div>
    </section>
  );
}

function Metric({ label, value }) {
  return (
    <div className="metric">
      <span className="metric-label">{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function BestMovePanel({
  action,
  rankedActions,
  phase,
  onPick,
  missionRanks,
  trialRanks,
  simulationResult,
  decisionState,
}) {
  const ranking =
    phase === "mission"
      ? missionRanks.map((rank) => ({ ...rank, type: "mission" }))
      : phase === "trial"
        ? trialRanks.map((rank) => ({ ...rank, type: "trial" }))
        : rankedActions;
  const fallback = ranking[0] ?? action;

  return (
    <section className="decision-panel">
      <div className="panel-heading decision-head">
        <div>
          <p className="eyebrow">Decision</p>
          <h2>Recommended Next Move</h2>
        </div>
        <span className="phase-badge">{formatPhaseLabel(phase)}</span>
      </div>

      {!decisionState.ready ? (
        <>
          <div className="score-line">
            <span>{decisionState.statusText}</span>
          </div>
          <div className="empty-state decision-waiting">{decisionState.message}</div>
        </>
      ) : fallback ? (
        <>
          <div className="score-line">
            <span>{decisionState.statusText}</span>
            <span>{ranking.length} ranked choices</span>
            <span>Best confidence {Math.round((fallback.confidence ?? 0.55) * 100)}%</span>
          </div>
          {simulationResult.error ? (
            <p className="warning-line">{simulationResult.error}</p>
          ) : null}
          <div className="callout">
            <strong>Top reason:</strong> {fallback.reasons[0]}
          </div>
          <div className="ranking-list">
            {ranking.slice(0, 8).map((rank, index) => (
              <RankedRow
                action={rank}
                index={index}
                key={rank.key}
                onPick={() => onPick(rank)}
              />
            ))}
          </div>
        </>
      ) : (
        <p className="muted">Edit the offered beacons or reset the run.</p>
      )}
    </section>
  );
}

function BeaconPanel({
  state,
  onSetBeacon,
  onToggleVibrant,
  onAddBeacon,
  onRemoveBeacon,
  onClearBeacons,
}) {
  const choiceCount = getBeaconChoiceCount(state);
  const [activeSlot, setActiveSlot] = useState(0);
  const canAppend = state.offered.length < choiceCount;
  const appending = canAppend && activeSlot >= state.offered.length;
  const targetSlot =
    state.offered.length === 0 ? 0 : Math.min(activeSlot, state.offered.length - 1);

  function handlePickerBeacon(beaconId) {
    const duplicateSlot = state.offered.findIndex((item) => item.id === beaconId);
    if (duplicateSlot >= 0 && (appending || duplicateSlot !== targetSlot)) {
      return;
    }

    if (appending || state.offered.length === 0) {
      onAddBeacon(beaconId);
      setActiveSlot(
        state.offered.length + 1 < choiceCount
          ? state.offered.length + 1
          : Math.max(0, state.offered.length),
      );
      return;
    }

    onSetBeacon(targetSlot, beaconId);
    setActiveSlot(
      targetSlot + 1 < state.offered.length
        ? targetSlot + 1
        : canAppend
          ? state.offered.length
          : targetSlot,
    );
  }

  return (
    <section className="panel controls-panel">
      <div className="panel-heading compact">
        <div>
          <p className="eyebrow">Input</p>
          <h2>Current Beacons</h2>
        </div>
        <div className="heading-actions">
          <span className="pill">{state.offered.length} / {choiceCount}</span>
        </div>
      </div>

      <div className="beacon-picker">
        {BEACON_IDS.map((beaconId) => {
          const beacon = BEACONS[beaconId];
          const usedByAnotherSlot =
            appending || state.offered.length === 0
              ? state.offered.some((item) => item.id === beaconId)
              : state.offered.some(
                  (item, index) => item.id === beaconId && index !== targetSlot,
                );
          return (
            <button
              className={beaconId === "rainbow" ? "beacon-btn rainbow-beacon" : "beacon-btn"}
              disabled={usedByAnotherSlot}
              key={beaconId}
              onClick={() => handlePickerBeacon(beaconId)}
              style={getBeaconButtonStyle(beaconId)}
              title={beacon.extraNotes ? `${beacon.effect} ${beacon.extraNotes}` : beacon.effect}
              type="button"
            >
              <span
                className="dot"
                style={getBeaconToneStyle(beaconId)}
                aria-hidden="true"
              />
              <strong>{beacon.shortName}</strong>
              <small>{beacon.effect}</small>
            </button>
          );
        })}
      </div>

      <div className="section-title">
        <span>Current offer</span>
        <div className="button-row compact">
          <button className="tool-button" disabled={state.offered.length === 0} onClick={onClearBeacons}>
            Clear
          </button>
        </div>
      </div>

      <div className="offer-list beacon-editor">
        {state.offered.length === 0 ? (
          <div className="empty-state">Pick beacons above to build the current offer.</div>
        ) : null}
        {state.offered.map((item, index) => (
          <div
            className={index === targetSlot ? "beacon-row active" : "beacon-row"}
            key={`${item.id}-${index}`}
            onClick={() => setActiveSlot(index)}
          >
            <span
              className="beacon-swatch"
              style={getBeaconToneStyle(item.id)}
              aria-hidden="true"
            />
            <select
              value={item.id}
              onChange={(event) => onSetBeacon(index, event.target.value)}
            >
              {BEACON_IDS.map((beaconId) => (
                <option
                  disabled={state.offered.some(
                    (offer, offerIndex) => offer.id === beaconId && offerIndex !== index,
                  )}
                  key={beaconId}
                  value={beaconId}
                >
                  {BEACONS[beaconId].name}
                </option>
              ))}
            </select>
            <label className="check-label">
              <input
                type="checkbox"
                checked={item.vibrant}
                onChange={() => onToggleVibrant(index)}
              />
              Vibrant
            </label>
            <button
              className="icon-button"
              onClick={(event) => {
                event.stopPropagation();
                onRemoveBeacon(index);
                setActiveSlot(Math.max(0, index - 1));
              }}
              aria-label="remove beacon"
            >
              -
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function MissionTrialPreview({ missionRanks, trialRanks, onPick }) {
  return (
    <section className="panel mission-zone">
      <div className="panel-heading compact">
        <div>
          <p className="eyebrow">Mission / Trial ranking</p>
          <h2>Quest Timing Preview</h2>
        </div>
      </div>
      <div className="preview-grid">
        <div>
          <h3>Missions</h3>
          <div className="mini-rank-list">
            {missionRanks.slice(0, 3).map((action, index) => (
              <button
                className="mini-rank"
                key={action.key}
                onClick={() => onPick({ ...action, type: "mission" })}
              >
                <span>{index + 1}</span>
                <strong>{getActionTitle(action)}</strong>
                <small>{Math.round(action.score)}</small>
              </button>
            ))}
          </div>
        </div>
        <div>
          <h3>Trials</h3>
          <div className="mini-rank-list">
            {trialRanks.slice(0, 3).map((action, index) => (
              <button
                className="mini-rank"
                key={action.key}
                onClick={() => onPick({ ...action, type: "trial" })}
              >
                <span>{index + 1}</span>
                <strong>{getActionTitle(action)}</strong>
                <small>{Math.round(action.score)}</small>
              </button>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ChoicePanel({
  title,
  subtitle,
  ranks,
  table,
  idKey,
  offered,
  options,
  onSetOffered,
  onPick,
}) {
  return (
    <section className="panel">
      <div className="panel-heading compact">
        <div>
          <p className="eyebrow">Input</p>
          <h2>{title}</h2>
          <p className="muted tight">{subtitle}</p>
        </div>
      </div>
      <div className="choice-slots">
        {offered.map((id, index) => (
          <select
            key={`${id}-${index}`}
            value={id}
            onChange={(event) => onSetOffered(index, event.target.value)}
          >
            {options.map((optionId) => (
              <option key={optionId} value={optionId}>
                {table[optionId].name}
              </option>
            ))}
          </select>
        ))}
      </div>
      <div className="rank-list">
        {ranks.slice(0, 8).map((action, index) => (
          <RankedRow
            action={action}
            index={index}
            key={action.key}
            onPick={() => onPick({ ...action, type: idKey === "missionId" ? "mission" : "trial" })}
          />
        ))}
      </div>
    </section>
  );
}

function RankedRow({ action, index, onPick }) {
  const beacon = action.beaconId ? BEACONS[action.beaconId] : null;
  return (
    <article className={index === 0 ? "rank-row top-ranked" : "rank-row"}>
      <div className="rank-badge">{index + 1}</div>
      {beacon ? (
        <span
          className="beacon-swatch"
          style={getBeaconToneStyle(action.beaconId)}
          aria-hidden="true"
        />
      ) : (
        <span className="beacon-swatch ghost" aria-hidden="true" />
      )}
      <div className="rank-copy">
        <strong>{getActionTitle(action)}</strong>
        <span>{action.reasons[0]}</span>
        <div className="rank-reasons">
          {action.reasons.slice(1, 4).map((reason) => (
            <small key={reason}>{reason}</small>
          ))}
        </div>
      </div>
      <div className="rank-score">
        <span>{Math.round(action.score)}</span>
        <small>{Math.round((action.confidence ?? 0.55) * 100)}%</small>
      </div>
      <button className="mini-button" onClick={onPick}>
        Pick
      </button>
    </article>
  );
}

function TuningPanel({ state, dispatch }) {
  return (
    <section className="panel side-panel">
      <div className="panel-heading compact">
        <div>
          <p className="eyebrow">Optimizer</p>
          <h2>Decision Engine</h2>
        </div>
      </div>
      <div className="optimizer-flags">
        <span>Worker simulation</span>
        <span>Monte Carlo</span>
        <span>MCTS tree search</span>
      </div>
      <label className="field-label">
        Search model
        <select
          value={state.searchMode}
          onChange={(event) =>
            dispatch({ type: "SET_SEARCH_MODE", mode: event.target.value, skipHistory: true })
          }
        >
          {Object.entries(SEARCH_MODES).map(([id, mode]) => (
            <option key={id} value={id}>
              {mode.label} ({mode.optionHint})
            </option>
          ))}
        </select>
      </label>
      <label className="field-label">
        Compute
        <select
          value={state.computeMode}
          onChange={(event) =>
            dispatch({ type: "SET_COMPUTE_MODE", mode: event.target.value, skipHistory: true })
          }
        >
          {Object.entries(COMPUTE_MODES).map(([id, mode]) => (
            <option key={id} value={id}>
              {mode.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field-label">
        Profile
        <select
          value={state.profile}
          onChange={(event) =>
            dispatch({ type: "SET_PROFILE", profile: event.target.value, skipHistory: true })
          }
        >
          {Object.entries(PLAYER_PROFILES).map(([id, profile]) => (
            <option key={id} value={id}>
              {profile.label} ({profile.optionHint})
            </option>
          ))}
        </select>
      </label>
      {state.searchMode === "mcts" ? (
        <div className="mcts-grid">
          <label className="field-label">
            MCTS iterations
            <input
              type="number"
              min="40"
              max="8000"
              step="20"
              value={state.mctsIterations}
              onChange={(event) =>
                dispatch({
                  type: "SET_MCTS_ITERATIONS",
                  value: Number(event.target.value),
                  skipHistory: true,
                })
              }
            />
          </label>
          <label className="field-label">
            MCTS depth
            <input
              type="number"
              min="2"
              max="24"
              step="1"
              value={state.mctsDepth}
              onChange={(event) =>
                dispatch({
                  type: "SET_MCTS_DEPTH",
                  value: Number(event.target.value),
                  skipHistory: true,
                })
              }
            />
          </label>
        </div>
      ) : null}
      <p className="setting-summary">{formatSearchModeSummary(state)}</p>
      <p className="muted tight">{COMPUTE_MODES[state.computeMode].description}</p>
      <p className="muted tight">{SEARCH_MODES[state.searchMode].description}</p>
    </section>
  );
}

function ComboPanel({ dispatch, state, timerSeconds }) {
  const activeMission = state.activeMission ? MISSIONS[state.activeMission] : null;
  const activeTrial = state.activeTrial ? TRIALS[state.activeTrial] : null;
  const orangeText = state.effects.orangeChoices.length
    ? state.effects.orangeChoices
        .map((effect) => `+${effect.extra}/${effect.remaining}`)
        .join(", ")
    : "none";

  return (
    <section className="panel side-panel">
      <div className="panel-heading compact">
        <div>
          <p className="eyebrow">Run State</p>
          <h2>Combo Tracker</h2>
        </div>
      </div>
      <div className="combo-grid">
        <span>Aqua</span>
        <strong>+{state.effects.aquaBoost * 100}%</strong>
        <span>Rainbow</span>
        <strong>{state.effects.rainbowVibrant}</strong>
        <span>Orange</span>
        <strong>{orangeText}</strong>
        <span>Boon</span>
        <strong>
          {state.boons} / {state.boonPotency}%
        </strong>
        <span>Curse</span>
        <strong>{state.curses}</strong>
        <span>Red Debt</span>
        <strong>
          {state.redDebt.noTimeChallenges} / {state.redDebt.secondsLost}s
        </strong>
        <span>Observed Offers</span>
        <strong>{state.observedOffers.length}</strong>
        <span>Clock</span>
        <strong>{timerSeconds < 240 ? "Danger" : "Stable"}</strong>
      </div>
      <div className="active-tags">
        <span>{activeMission ? activeMission.name : "No mission"}</span>
        <span>{activeTrial ? activeTrial.name : "No trial"}</span>
      </div>
      {activeMission || activeTrial ? (
        <div className="button-row combo-actions">
          <button
            className="tool-button"
            disabled={!activeMission}
            onClick={() =>
              dispatch({
                type: "COMPLETE_MISSION",
                missionId: state.activeMission,
                now: Date.now(),
              })
            }
          >
            Complete Mission
          </button>
          <button
            className="tool-button"
            disabled={!activeTrial}
            onClick={() =>
              dispatch({
                type: "COMPLETE_TRIAL",
                trialId: state.activeTrial,
                now: Date.now(),
              })
            }
          >
            Complete Trial
          </button>
        </div>
      ) : null}
      {state.effects.aquaBoost > 0 ? (
        <div className="button-row combo-actions">
          <button
            className="tool-button subtle"
            onClick={() =>
              dispatch({
                type: "CLEAR_AQUA",
                now: Date.now(),
              })
            }
          >
            Clear Aqua
          </button>
        </div>
      ) : null}
    </section>
  );
}

function LogPanel({ entries }) {
  return (
    <section className="panel side-panel">
      <div className="panel-heading compact">
        <div>
          <p className="eyebrow">History</p>
          <h2>Run Log</h2>
        </div>
      </div>
      <ol className="run-log">
        {entries.length ? (
          entries.slice(-8).map((entry, index) => <li key={`${entry}-${index}`}>{entry}</li>)
        ) : (
          <li className="muted">No actions yet</li>
        )}
      </ol>
    </section>
  );
}

function SourcePanel() {
  return (
    <section className="panel side-panel sources">
      <div className="panel-heading compact">
        <div>
          <p className="eyebrow">Ruleset</p>
          <h2>Guide Basis</h2>
        </div>
      </div>
      {SOURCE_LINKS.map((source) =>
        source.href ? (
          <a key={source.href} href={source.href} target="_blank" rel="noreferrer">
            {source.label}
          </a>
        ) : (
          <span key={source.label}>{source.label}</span>
        ),
      )}
      <p className="muted tight">
        Beacon rates are estimated and calibrated from offers entered during the
        current run.
      </p>
    </section>
  );
}

function getActionTitle(action) {
  if (!action) {
    return "";
  }
  if (action.type === "reroll") {
    return "Reroll";
  }
  if (action.beaconId) {
    const beacon = BEACONS[action.beaconId];
    return `${beacon.name}${action.vibrant ? " Vibrant" : ""}`;
  }
  if (action.missionId) {
    return MISSIONS[action.missionId].name;
  }
  if (action.trialId) {
    return TRIALS[action.trialId].name;
  }
  return "Unknown";
}

function formatSearchModeSummary(state) {
  const mode = COMPUTE_MODES[state.computeMode];
  if (state.searchMode === "rollout") {
    return `Rollout: ${mode.rollouts} rollouts / horizon ${mode.horizon}`;
  }
  return `MCTS: ${state.mctsIterations} iterations / depth ${state.mctsDepth}`;
}

function getDecisionStatusText(offerReady, simulationResult, remainingChoices) {
  if (!offerReady) {
    return `Waiting for ${remainingChoices} more beacon${remainingChoices === 1 ? "" : "s"}`;
  }
  if (simulationResult.pending) {
    return "Thinking...";
  }
  return `${simulationResult.source} ready`;
}

function getDecisionMessage(offerReady, pending, remainingChoices) {
  if (!offerReady) {
    return `Fill Current offer completely before the advisor starts thinking. Pick ${remainingChoices} more beacon${remainingChoices === 1 ? "" : "s"}.`;
  }
  if (pending) {
    return "Thinking in the background. Rankings will appear when the worker finishes.";
  }
  return "";
}

function formatPhaseLabel(phase) {
  if (phase === "mission") {
    return "Mission";
  }
  if (phase === "trial") {
    return "Trial";
  }
  return "Beacon";
}

function getBeaconToneStyle(beaconId) {
  if (beaconId === "rainbow") {
    return {
      background: "linear-gradient(90deg, #ff5b7a, #ffd166, #62e36f, #55e6ff, #b57bff)",
      color: "#ffffff",
    };
  }
  const tone = BEACONS[beaconId]?.tone ?? "#94a3b8";
  return {
    background: tone,
    color: tone,
  };
}

function getBeaconButtonStyle(beaconId) {
  if (beaconId !== "rainbow") {
    return undefined;
  }
  return {
    background:
      "linear-gradient(90deg, rgba(255, 91, 122, 0.2), rgba(255, 209, 102, 0.16), rgba(98, 227, 111, 0.16), rgba(85, 230, 255, 0.18), rgba(181, 123, 255, 0.2)), rgba(255, 255, 255, 0.05)",
    borderColor: "rgba(255, 255, 255, 0.22)",
  };
}
