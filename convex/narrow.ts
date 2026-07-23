import { v } from "convex/values";
import { internalMutationGeneric } from "convex/server";

const ACTIVE_EVIDENCE_ID = "active";

const releaseEvidenceArgs = {
  backupRehearsal: v.boolean(),
  canaryRollout: v.boolean(),
  kernelReady: v.boolean(),
  productionAcceptance: v.boolean(),
  providerConformance: v.boolean(),
  releaseWindow: v.boolean(),
  rehearsalHash: v.string(),
  shadowParity: v.boolean(),
  supportedOsConformance: v.boolean(),
  zeroLegacyActivations: v.boolean(),
};

const REQUIRED_RELEASE_GATES = [
  ["backupRehearsal", "backup rehearsal"],
  ["canaryRollout", "canary rollout"],
  ["kernelReady", "kernel readiness"],
  ["productionAcceptance", "production acceptance"],
  ["providerConformance", "provider conformance"],
  ["releaseWindow", "release window"],
  ["shadowParity", "shadow parity"],
  ["supportedOsConformance", "supported OS conformance"],
  ["zeroLegacyActivations", "zero legacy activations"],
] as const;

type ReleaseEvidence = {
  readonly backupRehearsal: boolean;
  readonly canaryRollout: boolean;
  readonly kernelReady: boolean;
  readonly productionAcceptance: boolean;
  readonly providerConformance: boolean;
  readonly releaseWindow: boolean;
  readonly rehearsalHash: string;
  readonly shadowParity: boolean;
  readonly supportedOsConformance: boolean;
  readonly zeroLegacyActivations: boolean;
};

function missingReleaseGates(evidence: ReleaseEvidence | null): string[] {
  if (!evidence) return ["server-stored release evidence"];
  return REQUIRED_RELEASE_GATES
    .filter(([field]) => !evidence[field])
    .map(([, label]) => label);
}

/**
 * Persist the deployment proof used by the internal narrowing guard.
 *
 * This is intentionally internal-only. The deployment/release controller is
 * the authority that records evidence after its protected checks complete.
 */
export const recordReleaseEvidence = internalMutationGeneric({
  args: releaseEvidenceArgs,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("releaseEvidence")
      .withIndex("by_evidence_id", (q) => q.eq("evidenceId", ACTIVE_EVIDENCE_ID))
      .unique();
    const evidence = {
      ...args,
      evidenceId: ACTIVE_EVIDENCE_ID,
      recordedAt: Date.now(),
    };
    if (existing) {
      await ctx.db.replace(existing._id, evidence);
      return existing._id;
    }
    return await ctx.db.insert("releaseEvidence", evidence);
  },
});

// ---------------------------------------------------------------------------
// Narrow migration — the final, irreversible contraction.
// Internal-only: only a protected release controller can invoke this mutation.
// ---------------------------------------------------------------------------

export const narrowProjections = internalMutationGeneric({
  args: {
    /** Must be a verified dry-run before live execution. */
    dryRun: v.boolean(),
    /** Must match the server-stored rehearsal backup hash. */
    rehearsalHash: v.string(),
  },
  handler: async (ctx, args) => {
    const evidence = await ctx.db
      .query("releaseEvidence")
      .withIndex("by_evidence_id", (q) => q.eq("evidenceId", ACTIVE_EVIDENCE_ID))
      .unique();
    const missingGates = missingReleaseGates(evidence);
    const rehearsalMatches = evidence?.rehearsalHash === args.rehearsalHash;

    // Collect all projection snapshots for verification
    const snapshots = await ctx.db.query("projectionSnapshots").take(1000);
    const events = await ctx.db.query("projectionEvents").take(1000);

    // Verification: ensure no sequence gaps
    const byRun = new Map<string, number[]>();
    for (const ev of events) {
      const seqs = byRun.get(ev.runId) ?? [];
      seqs.push(ev.sequence);
      byRun.set(ev.runId, seqs);
    }

    const gaps: string[] = [];
    for (const [runId, seqs] of byRun) {
      seqs.sort((a, b) => a - b);
      for (let i = 1; i < seqs.length; i++) {
        if (seqs[i]! !== seqs[i - 1]! + 1) {
          gaps.push(`Gap in run ${runId}: after ${seqs[i - 1]}, got ${seqs[i]}`);
          break;
        }
      }
    }

    if (args.dryRun) {
      return {
        dryRun: true,
        snapshotCount: snapshots.length,
        eventCount: events.length,
        gapCount: gaps.length,
        gaps: gaps.slice(0, 10),
        missingGates,
        rehearsalMatches,
        ready: gaps.length === 0 && missingGates.length === 0 && rehearsalMatches,
      };
    }

    if (missingGates.length > 0) {
      throw new Error(`Narrow refused: ${missingGates.join(", ")} gate is not verified.`);
    }
    if (!rehearsalMatches) {
      throw new Error("Narrow refused: rehearsal hash does not match server-stored release evidence.");
    }
    if (gaps.length > 0) {
      throw new Error(`Narrow refused: ${gaps.length} sequence gaps found.`);
    }
    if (snapshots.length === 0 || events.length === 0) {
      throw new Error("Narrow refused: projection snapshots and events are not fully backfilled.");
    }

    // Live contraction is a separate, irreversible deployment operation. Keep
    // this guard until a protected release controller records the full window
    // and rollback rehearsal; this function must never claim a simulated
    // cleanup was production narrowing.
    throw new Error("Narrow refused: live schema contraction is disabled until the final release operation.");

  },
});
