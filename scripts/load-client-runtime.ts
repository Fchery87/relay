import { ClientRuntime } from "../packages/client-runtime/src/client-runtime";
const event = (sequence: number) => ({ eventId: `e${sequence}`, sequence, streamVersion: sequence, type: "assistant.delta", runId: "load", correlationId: "c", occurredAt: sequence, payload: { text: "x" } } as any);
const events = Array.from({ length: 1000 }, (_, i) => event(i + 1));
const runtime = new ClientRuntime({ fetchSnapshot: async () => ({ runId: "load", status: "running", sequence: 0, streamVersion: 0, restartCount: 0, createdAt: 1, updatedAt: 1 } as any), fetchEvents: async () => events, submitCommand: async () => { throw new Error("not used"); } });
const start = performance.now(); await runtime.connect("load"); const durationMs = performance.now() - start;
console.log(JSON.stringify({ events: 1000, durationMs, targetMs: 2000, passed: durationMs < 2000 })); if (durationMs >= 2000) process.exit(1);
