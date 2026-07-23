/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

test("schema narrowing readiness is available only through the internal maintenance boundary", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("projectionSnapshots", {
      runId: "run-schema-narrow",
      sequence: 1,
      snapshotJson: "{}",
      updatedAt: 1,
    });
    await ctx.db.insert("projectionEvents", {
      eventId: "event-schema-narrow",
      occurredAt: 1,
      payloadJson: "{}",
      publishedAt: 1,
      runId: "run-schema-narrow",
      sequence: 1,
      type: "run.created",
    });
  });

  await expect(t.query(internal.schema_narrow.checkNarrowReadiness, {})).resolves.toEqual({
    projectionHasEvents: true,
    projectionHasSnapshots: true,
    readyToNarrow: true,
  });
});
