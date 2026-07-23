// ---------------------------------------------------------------------------
// Operational wiring tests — verify that observability, security, supervisor,
// and SLO modules are correctly wired into the kernel daemon.
// ---------------------------------------------------------------------------

import { expect, test, describe } from "bun:test";
import { access, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  scanForSecrets,
  sanitizeForProjection,
} from "@relay/local-store";
import {
  Tracer,
  incrementMetric,
  getMetrics,
} from "@relay/local-store";
import {
  isCompatibleUpgrade,
  parseVersion,
} from "@relay/local-store";
import { SLO_DEFINITIONS } from "@relay/local-store";
import { LocalHarnessRuntime } from "@relay/harness-runtime";
import type {
  CodexSessionAdapter,
  NormalizedEvent,
} from "@relay/codex-app-server";
import { executeTurn, executeTurnViaCodex } from "./kernel-daemon";
import { ScriptedModelProvider } from "./model-provider";
import type { Policy } from "./policy";

describe("Codex kernel bridge", () => {
  test("waits for notifications that arrive after turn/start acceptance", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const created = await runtime.createRun({ projectId: "codex-bridge" });
    await runtime.resumeRun({ runId: created.runId });
    const turn = await runtime.sendTurn({
      runId: created.runId,
      prompt: "hello",
    });
    let handler: ((event: NormalizedEvent) => void) | undefined;
    const adapter = {
      activeThreadId: "thread-1",
      onEvent(next: (event: NormalizedEvent) => void) {
        handler = next;
        return () => {
          handler = undefined;
        };
      },
      async resumeThread() {},
      async startTurn() {
        setTimeout(() => {
          handler?.({
            type: "assistant.delta",
            payload: { text: "after acceptance" },
            providerThreadId: "thread-1",
            providerTurnId: "provider-turn-1",
          });
          handler?.({
            type: "turn.completed",
            payload: { summary: "done" },
            providerThreadId: "thread-1",
            providerTurnId: "provider-turn-1",
          });
        }, 0);
        return { turn: { id: "provider-turn-1" } };
      },
      close() {},
    } as unknown as CodexSessionAdapter;

    expect(
      await executeTurnViaCodex({
        runId: created.runId,
        turnId: turn.turnId,
        prompt: "hello",
        codexAdapter: adapter,
        runtime,
        threadId: "thread-1",
      }),
    ).toBe(true);

    const snapshot = await runtime.snapshot({ runId: created.runId });
    const types: string[] = [];
    for await (const event of runtime.observe({
      runId: created.runId,
      afterSequence: -1,
    })) {
      types.push(event.type);
      if (event.sequence >= snapshot.sequence) break;
    }
    expect(types).toContain("assistant.delta");
    expect(types).toContain("turn.completed");
    expect(snapshot.activeTurnId).toBeUndefined();
    await runtime.shutdown();
  });

  test("serializes two runs sharing one Codex adapter", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const first = await runtime.createRun({ projectId: "codex-first" });
    const second = await runtime.createRun({ projectId: "codex-second" });
    await runtime.resumeRun({ runId: first.runId });
    await runtime.resumeRun({ runId: second.runId });
    const firstTurn = await runtime.sendTurn({
      runId: first.runId,
      prompt: "first",
    });
    const secondTurn = await runtime.sendTurn({
      runId: second.runId,
      prompt: "second",
    });
    const handlers = new Set<(event: NormalizedEvent) => void>();
    const adapter = {
      activeThreadId: "thread-shared",
      onEvent(handler: (event: NormalizedEvent) => void) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      async resumeThread() {},
      async startTurn(_threadId: string, prompt: string) {
        const providerTurnId = `provider-${prompt}`;
        setTimeout(() => {
          for (const handler of handlers) {
            handler({
              type: "assistant.delta",
              payload: { text: prompt },
              providerThreadId: "thread-shared",
              providerTurnId,
            });
            handler({
              type: "turn.completed",
              payload: { summary: prompt },
              providerThreadId: "thread-shared",
              providerTurnId,
            });
          }
        }, 0);
        return { turn: { id: providerTurnId } };
      },
      close() {},
    } as unknown as CodexSessionAdapter;

    await Promise.all([
      executeTurnViaCodex({
        runId: first.runId,
        turnId: firstTurn.turnId,
        prompt: "first",
        codexAdapter: adapter,
        runtime,
        threadId: "thread-shared",
      }),
      executeTurnViaCodex({
        runId: second.runId,
        turnId: secondTurn.turnId,
        prompt: "second",
        codexAdapter: adapter,
        runtime,
        threadId: "thread-shared",
      }),
    ]);

    const deltas = async (runId: typeof first.runId) => {
      const snapshot = await runtime.snapshot({ runId });
      const texts: string[] = [];
      for await (const event of runtime.observe({
        runId,
        afterSequence: -1,
      })) {
        if (event.type === "assistant.delta") {
          texts.push((event.payload as { text: string }).text);
        }
        if (event.sequence >= snapshot.sequence) break;
      }
      return texts;
    };
    expect(await deltas(first.runId)).toEqual(["first"]);
    expect(await deltas(second.runId)).toEqual(["second"]);
    await runtime.shutdown();
  });

  test("rejects a late event from the prior native Codex turn", async () => {
    const runtime = LocalHarnessRuntime.memory();
    const first = await runtime.createRun({ projectId: "codex-late-first" });
    const second = await runtime.createRun({ projectId: "codex-late-second" });
    await runtime.resumeRun({ runId: first.runId });
    await runtime.resumeRun({ runId: second.runId });
    const firstTurn = await runtime.sendTurn({
      runId: first.runId,
      prompt: "first",
    });
    const secondTurn = await runtime.sendTurn({
      runId: second.runId,
      prompt: "second",
    });
    const handlers = new Set<(event: NormalizedEvent) => void>();
    let invocation = 0;
    const adapter = {
      activeThreadId: "thread-shared",
      onEvent(handler: (event: NormalizedEvent) => void) {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      async resumeThread() {},
      async startTurn() {
        invocation += 1;
        const providerTurnId = `provider-turn-${invocation}`;
        if (invocation === 1) {
          setTimeout(() => {
            for (const handler of handlers) {
              handler({
                type: "turn.completed",
                payload: { summary: "first complete" },
                providerThreadId: "thread-shared",
                providerTurnId,
              });
            }
          }, 0);
        } else {
          setTimeout(() => {
            for (const handler of handlers) {
              handler({
                type: "assistant.delta",
                payload: { text: "late from first" },
                providerThreadId: "thread-shared",
                providerTurnId: "provider-turn-1",
              });
              handler({
                type: "turn.completed",
                payload: { summary: "late first terminal" },
                providerThreadId: "thread-shared",
                providerTurnId: "provider-turn-1",
              });
              handler({
                type: "assistant.delta",
                payload: { text: "second only" },
                providerThreadId: "thread-shared",
                providerTurnId,
              });
              handler({
                type: "turn.completed",
                payload: { summary: "second complete" },
                providerThreadId: "thread-shared",
                providerTurnId,
              });
            }
          }, 0);
        }
        return { turn: { id: providerTurnId } };
      },
      close() {},
    } as unknown as CodexSessionAdapter;

    await Promise.all([
      executeTurnViaCodex({
        runId: first.runId,
        turnId: firstTurn.turnId,
        prompt: "first",
        codexAdapter: adapter,
        runtime,
        threadId: "thread-shared",
      }),
      executeTurnViaCodex({
        runId: second.runId,
        turnId: secondTurn.turnId,
        prompt: "second",
        codexAdapter: adapter,
        runtime,
        threadId: "thread-shared",
      }),
    ]);

    const snapshot = await runtime.snapshot({ runId: second.runId });
    const secondTexts: string[] = [];
    const secondTerminals: string[] = [];
    for await (const event of runtime.observe({
      runId: second.runId,
      afterSequence: -1,
    })) {
      if (event.type === "assistant.delta") {
        secondTexts.push((event.payload as { text: string }).text);
      }
      if (event.type === "turn.completed") {
        secondTerminals.push(
          (event.payload as { summary?: string }).summary ?? "",
        );
      }
      if (event.sequence >= snapshot.sequence) break;
    }
    expect(secondTexts).toEqual(["second only"]);
    expect(secondTerminals).toEqual(["second complete"]);
    await runtime.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Security wiring
// ---------------------------------------------------------------------------

describe("Security wiring", () => {
  test("scanForSecrets detects OpenAI API key", () => {
    const findings = scanForSecrets("Bearer sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]!).toContain("[REDACTED");
  });

  test("scanForSecrets detects Anthropic API key", () => {
    const findings = scanForSecrets("x-api-key: sk-ant-sid01-abcdefghijklmnopqrstuv");
    expect(findings.length).toBeGreaterThan(0);
  });

  test("scanForSecrets detects GitHub PAT", () => {
    const findings = scanForSecrets("token: ghp_abcdefghijklmnopqrstuvwxyz1234567890");
    expect(findings.length).toBeGreaterThan(0);
  });

  test("scanForSecrets detects private key header", () => {
    const findings = scanForSecrets("-----BEGIN RSA PRIVATE KEY-----");
    expect(findings.length).toBeGreaterThan(0);
  });

  test("scanForSecrets detects JWT tokens", () => {
    const findings = scanForSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U");
    expect(findings.length).toBeGreaterThan(0);
  });

  test("scanForSecrets returns empty for clean text", () => {
    const findings = scanForSecrets("Hello, please write a function to add two numbers.");
    expect(findings).toHaveLength(0);
  });

  test("sanitizeForProjection redacts secrets", () => {
    const sanitized = sanitizeForProjection("My key is sk-proj-abcdefghijklmnopqrstuvwxyz123456 and it's secret");
    expect(sanitized).not.toContain("sk-proj-");
    expect(sanitized).toContain("[REDACTED:api-key]");
  });

  test("sanitizeForProjection redacts GitHub tokens", () => {
    const sanitized = sanitizeForProjection("Use ghp_abcdefghijklmnopqrstuvwxyz1234567890 for auth");
    expect(sanitized).not.toContain("ghp_");
    expect(sanitized).toContain("[REDACTED:github-token]");
  });

  test("sanitizeForProjection redacts private keys", () => {
    const sanitized = sanitizeForProjection("-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD\n-----END RSA PRIVATE KEY-----");
    expect(sanitized).not.toContain("BEGIN RSA PRIVATE KEY");
    expect(sanitized).toContain("[REDACTED:private-key]");
  });
});

// ---------------------------------------------------------------------------
// Observability wiring
// ---------------------------------------------------------------------------

describe("Observability wiring", () => {
  test("Tracer creates and ends spans", () => {
    const tracer = new Tracer();
    const span = tracer.startSpan("test.span");
    expect(span.name).toBe("test.span");
    expect(span.endedAt).toBeUndefined();

    tracer.endSpan(span);
    // Re-fetch span from tracer (endedAt is mutated in place)
    const spans = tracer.getSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.endedAt).toBeDefined();
    expect(spans[0]!.endedAt!).toBeGreaterThan(0);
  });

  test("Tracer supports parent-child spans", () => {
    const tracer = new Tracer();
    const parent = tracer.startSpan("parent");
    const child = tracer.startSpan("child", parent.spanId);
    expect(child.parentSpanId).toBe(parent.spanId);
    tracer.endSpan(child);
    tracer.endSpan(parent);

    const spans = tracer.getSpans();
    expect(spans).toHaveLength(2);
  });

  test("Tracer tags are writable", () => {
    const tracer = new Tracer();
    const span = tracer.startSpan("tagged");
    span.tags["key"] = "value";
    expect(span.tags["key"]).toBe("value");
  });

  test("getMetrics returns current state with uptime", () => {
    const metrics = getMetrics();
    expect(metrics.uptimeMs).toBeGreaterThan(0);
    expect(typeof metrics.activeRuns).toBe("number");
  });

  test("incrementMetric increases activeRuns", () => {
    const before = getMetrics().activeRuns;
    incrementMetric("activeRuns");
    incrementMetric("activeRuns");
    const after = getMetrics().activeRuns;
    expect(after).toBe(before + 2);
  });

  test("incrementMetric increases completedRuns and eventsProcessed", () => {
    const beforeCompleted = getMetrics().completedRuns;
    const beforeEvents = getMetrics().eventsProcessed;
    incrementMetric("completedRuns");
    incrementMetric("eventsProcessed");
    expect(getMetrics().completedRuns).toBe(beforeCompleted + 1);
    expect(getMetrics().eventsProcessed).toBe(beforeEvents + 1);
  });
});

// ---------------------------------------------------------------------------
// SLO tracking
// ---------------------------------------------------------------------------

describe("SLO wiring", () => {
  test("SLO_DEFINITIONS has prompt-to-first-token-latency", () => {
    const slo = SLO_DEFINITIONS.find((s) => s.name === "prompt-to-first-token-latency");
    expect(slo).toBeDefined();
    expect(slo!.target).toBe(200);
    expect(slo!.unit).toBe("ms");
  });

  test("SLO_DEFINITIONS has command-output-chunk-latency", () => {
    const slo = SLO_DEFINITIONS.find((s) => s.name === "command-output-chunk-latency");
    expect(slo).toBeDefined();
    expect(slo!.target).toBe(200);
  });

  test("SLO_DEFINITIONS has event-append-throughput", () => {
    const slo = SLO_DEFINITIONS.find((s) => s.name === "event-append-throughput");
    expect(slo).toBeDefined();
  });

  test("all SLOs have positive targets", () => {
    for (const slo of SLO_DEFINITIONS) {
      expect(slo.target).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Supervisor / version compatibility
// ---------------------------------------------------------------------------

describe("Version compatibility", () => {
  test("parseVersion parses semver", () => {
    const v = parseVersion("1.2.3");
    expect(v.major).toBe(1);
    expect(v.minor).toBe(2);
    expect(v.patch).toBe(3);
    expect(v.schemaVersion).toBe(3);
  });

  test("isCompatibleUpgrade allows same version", () => {
    const v = parseVersion("2.0.0");
    expect(isCompatibleUpgrade(v, v)).toBe(true);
  });

  test("isCompatibleUpgrade allows minor bump with same schema", () => {
    const current = parseVersion("1.0.0");
    const target = { ...parseVersion("1.1.0"), schemaVersion: 3 };
    expect(isCompatibleUpgrade(current, target)).toBe(true);
  });

  test("isCompatibleUpgrade requires schema >= current for major bump", () => {
    const current = { ...parseVersion("1.0.0"), schemaVersion: 3 };
    const target = { ...parseVersion("2.0.0"), schemaVersion: 3 };
    expect(isCompatibleUpgrade(current, target)).toBe(true);
  });
});

describe("kernel tool bridge", () => {
  async function observeTypes(runtime: LocalHarnessRuntime, runId: string): Promise<string[]> {
    const snapshot = await runtime.snapshot({ runId: runId as never });
    const types: string[] = [];
    for await (const event of runtime.observe({ runId: runId as never, afterSequence: -1 })) {
      types.push(event.type);
      if (event.sequence >= snapshot.sequence) break;
    }
    return types;
  }

  test("executes an allowed provider tool through the sandbox and emits activity events", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-kernel-tool-allow-"));
    const runtime = LocalHarnessRuntime.memory();
    const created = await runtime.createRun({ projectId: "project", runId: "run-tool-allow" as never });
    await runtime.resumeRun({ runId: created.runId });
    const turn = await runtime.sendTurn({ runId: created.runId, prompt: "edit the file" });
    const decisions: string[] = [];
    const policy: Policy = { rules: [{ capability: "edit", decision: "allow", risk: "low" }] };
    let resolvedProjectPath = "";

    const succeeded = await executeTurn({
      governance: {
        recordDecision: async ({ decision }) => { decisions.push(decision); },
        requestApproval: async () => "deny",
      },
      platform: "linux",
      policy,
      prompt: "edit the file",
      provider: new ScriptedModelProvider({
        chunks: ["done"],
        toolCalls: [{ content: "changed", kind: "edit", path: "result.txt" }],
      }),
      projectPath: "project-registration-id",
      resolveProjectRoot: async ({ repoPath }) => {
        resolvedProjectPath = repoPath;
        return root;
      },
      runId: created.runId,
      runtime,
      turnId: turn.turnId,
    });

    expect(succeeded).toBe(true);
    expect(await readFile(join(root, "result.txt"), "utf8")).toBe("changed");
    expect(resolvedProjectPath).toBe("project-registration-id");
    expect(decisions).toEqual(["allow"]);
    const types = await observeTypes(runtime, created.runId);
    expect(types.indexOf("activity.started")).toBeGreaterThan(-1);
    expect(types.indexOf("activity.completed")).toBeGreaterThan(types.indexOf("activity.started"));
    expect(types.at(-1)).toBe("turn.completed");
    await runtime.shutdown();
  });

  test("denies a high-risk provider tool without changing the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "relay-kernel-tool-deny-"));
    const runtime = LocalHarnessRuntime.memory();
    const created = await runtime.createRun({ projectId: "project", runId: "run-tool-deny" as never });
    await runtime.resumeRun({ runId: created.runId });
    const turn = await runtime.sendTurn({ runId: created.runId, prompt: "remove the file" });
    const decisions: string[] = [];
    const policy: Policy = { rules: [{ capability: "exec", decision: "deny", risk: "high" }] };

    const succeeded = await executeTurn({
      governance: {
        recordDecision: async ({ decision }) => { decisions.push(decision); },
        requestApproval: async () => "deny",
      },
      platform: "linux",
      policy,
      prompt: "remove the file",
      provider: new ScriptedModelProvider({
        chunks: ["refused"],
        toolCalls: [{ command: "rm -f blocked.txt", kind: "bash" }],
      }),
      root,
      runId: created.runId,
      runtime,
      turnId: turn.turnId,
    });

    expect(succeeded).toBe(true);
    expect(decisions).toEqual(["deny"]);
    await expect(access(join(root, "blocked.txt"))).rejects.toThrow();
    const types = await observeTypes(runtime, created.runId);
    expect(types).toContain("activity.started");
    expect(types).toContain("activity.completed");
    expect(types.at(-1)).toBe("turn.completed");
    await runtime.shutdown();
  });
});
