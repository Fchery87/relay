/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";
import { createAuthenticatedProject } from "./test_helpers";

const modules = import.meta.glob("./**/*.ts");

test("canonical tool workspace hints must match the authorized project path", async () => {
  const t = convexTest(schema, modules);
  const { owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "running", title: "kernel tool" }));

  await expect(owner.mutation(api.commands.inbox.submitToInbox, {
    commandId: "cmd-unsafe-project-path",
    correlationId: "corr-unsafe-project-path",
    kind: "turn.send",
    payloadJson: JSON.stringify({ projectPath: "/other-repository", prompt: "read a file", turnId: "turn-1" }),
    runId: threadId,
    threadId,
  })).rejects.toThrow(/projectPath must match the authorized project/);
});

test("claimed commands carry the authorized project path for daemon workspace resolution", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "running", title: "kernel tool" }));

  await owner.mutation(api.commands.inbox.submitToInbox, {
    commandId: "cmd-authorized-project-path",
    correlationId: "corr-authorized-project-path",
    kind: "run.create",
    payloadJson: JSON.stringify({ projectId }),
    threadId,
  });

  const claimed = await t.mutation(api.commands.inbox.claimBatch, { deviceToken, leaseDurationMs: 30_000, limit: 5 });
  expect(claimed).toHaveLength(1);
  expect(claimed[0]).toMatchObject({ projectPath: "/repo" });
});
