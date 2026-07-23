/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

test("release evidence is stored server-side and replaces the active record atomically", async () => {
  const t = convexTest(schema, modules);
  const input = {
    backupRehearsal: true,
    canaryRollout: true,
    kernelReady: true,
    productionAcceptance: true,
    providerConformance: true,
    releaseWindow: true,
    rehearsalHash: "rehearsal-v1",
    shadowParity: true,
    supportedOsConformance: true,
    zeroLegacyActivations: true,
  } as const;

  await t.mutation(internal.narrow.recordReleaseEvidence, input);
  await t.mutation(internal.narrow.recordReleaseEvidence, { ...input, rehearsalHash: "rehearsal-v2" });

  await expect(t.run((ctx) => ctx.db.query("releaseEvidence").collect())).resolves.toHaveLength(1);
  await expect(t.run((ctx) => ctx.db.query("releaseEvidence").unique())).resolves.toMatchObject({
    evidenceId: "active",
    rehearsalHash: "rehearsal-v2",
  });
});

test("narrowing refuses live execution without server-stored release evidence", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("projectionSnapshots", {
      runId: "run-narrow-proof",
      sequence: 1,
      snapshotJson: "{}",
      updatedAt: 1,
    });
  });

  await expect(
    t.mutation(internal.narrow.narrowProjections, {
      dryRun: false,
      rehearsalHash: "rehearsal-not-recorded",
    }),
  ).rejects.toThrow(/server-stored release evidence/i);
});

test("narrowing refuses a release record unless every irreversible gate is green", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("projectionSnapshots", {
      runId: "run-narrow-proof",
      sequence: 1,
      snapshotJson: "{}",
      updatedAt: 1,
    });
    await ctx.db.insert("releaseEvidence", {
      evidenceId: "active",
      backupRehearsal: true,
      canaryRollout: true,
      kernelReady: true,
      productionAcceptance: true,
      providerConformance: false,
      recordedAt: 1,
      releaseWindow: true,
      rehearsalHash: "rehearsal-recorded",
      shadowParity: true,
      supportedOsConformance: true,
      zeroLegacyActivations: true,
    });
  });

  await expect(
    t.mutation(internal.narrow.narrowProjections, {
      dryRun: false,
      rehearsalHash: "rehearsal-recorded",
    }),
  ).rejects.toThrow(/provider conformance/i);
});

test("a complete dry run reports readiness but live contraction remains a separate operation", async () => {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("projectionSnapshots", {
      runId: "run-narrow-proof",
      sequence: 1,
      snapshotJson: "{}",
      updatedAt: 1,
    });
    await ctx.db.insert("projectionEvents", {
      eventId: "event-narrow-proof",
      occurredAt: 1,
      payloadJson: "{}",
      publishedAt: 1,
      runId: "run-narrow-proof",
      sequence: 1,
      type: "run.created",
    });
    await ctx.db.insert("releaseEvidence", {
      evidenceId: "active",
      backupRehearsal: true,
      canaryRollout: true,
      kernelReady: true,
      productionAcceptance: true,
      providerConformance: true,
      recordedAt: 1,
      releaseWindow: true,
      rehearsalHash: "rehearsal-recorded",
      shadowParity: true,
      supportedOsConformance: true,
      zeroLegacyActivations: true,
    });
  });

  await expect(
    t.mutation(internal.narrow.narrowProjections, {
      dryRun: true,
      rehearsalHash: "rehearsal-recorded",
    }),
  ).resolves.toMatchObject({
    dryRun: true,
    gapCount: 0,
    missingGates: [],
    ready: true,
    rehearsalMatches: true,
  });

  await expect(
    t.mutation(internal.narrow.narrowProjections, {
      dryRun: false,
      rehearsalHash: "rehearsal-recorded",
    }),
  ).rejects.toThrow(/live schema contraction is disabled/i);
});
