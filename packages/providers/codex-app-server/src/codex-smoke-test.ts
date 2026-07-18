// ---------------------------------------------------------------------------
// Codex app-server smoke test — conditionally runs when RELAY_CODEX_ENABLED=1.
// Skips in ordinary CI. Verifies initialization, ephemeral thread creation,
// simple turn round-trip, and normalized event output.
// ---------------------------------------------------------------------------

import { expect, test, afterAll } from "bun:test";
import { createCodexSessionAdapter } from "./codex-session-adapter";
import type { NormalizedEvent } from "./normalize-event";

test("codex smoke test", async () => {
  if (Bun.env.RELAY_CODEX_ENABLED !== "1") {
    console.log("RELAY_CODEX_ENABLED is not '1' — skipping Codex smoke test");
    return;
  }

  const adapters: Array<ReturnType<typeof createCodexSessionAdapter>> = [];
  let testFailed = false;

  afterAll(() => {
    for (const a of adapters) {
      try { a.close(); } catch {}
    }
  });

  const adapter = createCodexSessionAdapter({
    transport: {
      clientInfo: { name: "relay-smoke-test", title: "Relay Smoke Test", version: "0.0.0" },
      capabilities: { experimentalApi: true },
    },
  });
  adapters.push(adapter);

  // Wait for transport to initialize (handshake happens in createCodexTransport)
  expect(adapter.transport.connected).toBe(true);

  // Start a minimal ephemeral thread
  const threadResult = (await adapter.startThread({ ephemeral: true })) as {
    thread: { id: string; ephemeral: boolean };
  };
  expect(threadResult.thread.id).toBeTruthy();
  expect(threadResult.thread.ephemeral).toBe(true);

  const threadId = threadResult.thread.id;
  expect(adapter.activeThreadId).toBe(threadId);

  // Collect normalized events
  const events: Array<{ type: string; payload: unknown }> = [];
  const unsub = adapter.onEvent((ev: NormalizedEvent) => {
    events.push({ type: ev.type, payload: ev.payload });
  });

  // Start a simple turn
  await adapter.startTurn(threadId, "say hello world");

  // Poll for events up to 30 seconds
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (events.some((e) => e.type === "turn.completed")) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  unsub();

  // Verify minimum expected events
  const types = events.map((e) => e.type);
  expect(types).toContain("provider.session.started");
  expect(types).toContain("run.started");
  expect(types).toContain("turn.started");
  expect(types).toContain("assistant.delta");
  expect(types).toContain("turn.completed");

  // Close cleanly
  adapter.close();
}, 45_000);
