import { expect, test, describe } from "bun:test";
import { ClientRuntime, type ClientConfig } from "./client-runtime";
import type { RunSnapshot, EventEnvelope, CanonicalEventType } from "@relay/contracts";

function snap(sequence = 0): RunSnapshot {
  return {
    runId: "run-1" as never,
    status: "running",
    sequence,
    streamVersion: sequence,
    restartCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ev(seq: number, type = "assistant.delta", payload: any = { text: "hi" }): any {
  return { eventId: `ev-${seq}`, sequence: seq, streamVersion: seq, type, runId: "run-1", correlationId: "corr-1", occurredAt: Date.now(), payload };
}

function cfg(overrides: Record<string, unknown> = {}): ClientConfig {
  return {
    fetchSnapshot: async () => snap(0),
    fetchEvents: async (_rid: string, after: number) =>
      [ev(1), ev(2)].filter((e: { sequence: number }) => e.sequence > after),
    submitCommand: async () => snap(2),
    ...overrides,
  } as unknown as ClientConfig;
}

describe("ClientRuntime", () => {
  test("connects to a run and applies events after snapshot", async () => {
    const rt = new ClientRuntime(cfg());
    const state = await rt.connect("run-1");
    expect(state.snapshot).toBeDefined();
    expect(state.cursor).toBe(2);
    expect(state.terminal).toBe(false);
  });

  test("reconnects without missing events", async () => {
    const fetchCalls: number[] = [];
    const rt = new ClientRuntime(cfg({
      fetchEvents: async (_rid: string, after: number) => {
        fetchCalls.push(after as number);
        return [ev(1), ev(2)].filter((e: { sequence: number }) => e.sequence > (after as number));
      },
    }));
    await rt.connect("run-1");
    const state = await rt.resume("run-1");
    expect(fetchCalls[fetchCalls.length - 1]).toBe(state.cursor);
  });

  test("detects terminal status", async () => {
    let terminalStatus = "";
    const rt = new ClientRuntime(cfg({
      fetchEvents: async () => [ev(1, "run.stopped")],
      onTerminal: (status: string) => { terminalStatus = status; },
    }));
    const state = await rt.connect("run-1");
    expect(state.terminal).toBe(true);
    expect(terminalStatus).toBe("run.stopped");
  });

  test("submits command and applies resulting events", async () => {
    let submittedKind = "";
    const rt = new ClientRuntime(cfg({
      submitCommand: async (cmd: { kind: string }) => {
        submittedKind = cmd.kind;
        return snap(1);
      },
    }));
    const state = await rt.submit("run-1", "turn.send", { prompt: "hello" });
    expect(submittedKind).toBe("turn.send");
    // submitCommand returns snap(1), then catchUp applies ev(2) → cursor 2
    expect(state.cursor).toBe(2);
  });

  test("duplicate events are skipped", async () => {
    const seen: number[] = [];
    const rt = new ClientRuntime(cfg({
      fetchEvents: async () => [ev(1), ev(1), ev(2)],
      onEvent: (e: { sequence: number }) => seen.push(e.sequence),
    }));
    await rt.connect("run-1");
    expect(seen).toEqual([1, 2]);
  });

  test("rejects a sequence gap instead of advancing the cursor", async () => {
    const rt = new ClientRuntime(cfg({ fetchEvents: async () => [ev(2)] }));
    await expect(rt.connect("run-1")).rejects.toThrow("Projection gap");
  });

  test("does not treat turn completion as run termination", async () => {
    const rt = new ClientRuntime(cfg({ fetchEvents: async () => [ev(1, "turn.completed")] }));
    const state = await rt.connect("run-1");
    expect(state.terminal).toBe(false);
  });
});
