import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runQueuedCommand } from "./command-worker";
import type { Policy } from "./policy";

test("a denied high-risk queued command is refused without execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-command-deny-"));
  await writeFile(join(root, "keep.txt"), "keep");
  const output: string[] = [];
  const statuses: string[] = [];
  const approvals: string[] = [];
  const audit: string[] = [];
  const policy: Policy = { rules: [{ capability: "exec", decision: "ask", risk: "high" }] };

  await runQueuedCommand({
    gateway: {
      appendOutput: async ({ output: chunk }) => { output.push(chunk); },
      claim: async () => ({ command: "rm -f keep.txt", commandId: "command", projectPath: root, threadId: "thread" }),
      complete: async ({ status }) => { statuses.push(status); },
    },
    governance: {
      recordDecision: async ({ decision }) => { audit.push(decision); },
      requestApproval: async ({ summary }) => {
        approvals.push(summary);
        audit.push("ask", "deny");
        return "deny";
      },
    },
    platform: "linux",
    policy,
  });

  expect(await readFile(join(root, "keep.txt"), "utf8")).toBe("keep");
  expect(JSON.parse(output[0] ?? "")).toMatchObject({ kind: "tool_refusal", reason: "approval_denied" });
  expect(statuses).toEqual(["failed"]);
  expect(approvals).toEqual(["rm -f keep.txt"]);
  expect(audit).toEqual(["ask", "deny"]);
});

test("flushes the first command output chunk within the 200 ms latency budget", async () => {
  const outputTimes: number[] = [];
  const startedAt = Date.now();
  await runQueuedCommand({
    gateway: {
      appendOutput: async () => { outputTimes.push(Date.now()); },
      claim: async () => ({ command: "printf first; sleep 0.25; printf second", commandId: "command", projectPath: "/tmp", threadId: "thread" }),
      complete: async () => undefined,
    },
    governance: { recordDecision: async () => undefined, requestApproval: async () => "allow" },
    platform: "linux",
    policy: { rules: [{ capability: "exec", decision: "allow", risk: "low" }] },
  });

  expect(outputTimes[0]! - startedAt).toBeLessThanOrEqual(500);
});
