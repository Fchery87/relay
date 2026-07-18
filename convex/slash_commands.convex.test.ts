/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";
import { createAuthenticatedProject } from "./test_helpers";

const modules = import.meta.glob("./**/*.ts");

test("publishCatalog resolves project-scoped commands by path, not a raw path string as an id", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "idle", title: "task" }));

  await t.mutation(api.slash_commands.publishCatalog, {
    commands: [
      { description: "Show help", name: "help", scope: "builtin" },
      { description: "Run the project's release script", name: "release", projectPath: "/repo", scope: "project" },
    ],
    deviceToken,
  });

  const commands = await owner.query(api.slash_commands.listForThread, { threadId });
  expect(commands).toMatchObject([
    { name: "help", scope: "builtin" },
    { name: "release", scope: "project" },
  ]);
});

test("publishCatalog is idempotent — republishing replaces the prior catalog for the machine", async () => {
  const t = convexTest(schema, modules);
  const { deviceToken, owner, projectId } = await createAuthenticatedProject(t);
  const threadId = await t.run((ctx) => ctx.db.insert("threads", { projectId, status: "idle", title: "task" }));

  await t.mutation(api.slash_commands.publishCatalog, { commands: [{ description: "First", name: "one", scope: "builtin" }], deviceToken });
  await t.mutation(api.slash_commands.publishCatalog, { commands: [{ description: "Second", name: "two", scope: "builtin" }], deviceToken });

  const commands = await owner.query(api.slash_commands.listForThread, { threadId });
  expect(commands).toMatchObject([{ name: "two" }]);
});
