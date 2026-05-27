import { simulateForWorker } from "./simulationWorkerCore.mjs";

self.addEventListener("message", (event) => {
  try {
    self.postMessage(simulateForWorker(event.data));
  } catch (error) {
    self.postMessage({
      id: event.data?.id,
      ok: false,
      message: error instanceof Error ? error.message : "Worker simulation failed.",
    });
  }
});
