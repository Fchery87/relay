import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertReleaseEvidenceReady,
  createReleaseEvidence,
  parseReleaseEvidenceInput,
  writeReleaseEvidence,
} from "./release-evidence";

const gates = {
  backupRehearsal: true,
  canaryRollout: true,
  kernelReady: true,
  productionAcceptance: true,
  providerConformance: true,
  releaseWindow: true,
  shadowParity: true,
  supportedOsConformance: true,
  zeroLegacyActivations: true,
};

function completeInput() {
  return {
    commit: "abc123",
    gates,
    migrationState: "widened-compatible",
    rehearsalHash: "sha256:backup-rehearsal",
    residualRisks: ["credentialed provider was run in protected CI"],
    sourceArtifacts: ["conformance-ubuntu-latest", "backup-manifest.json"],
    testIds: ["conformance-linux", "restore-acceptance", "cross-tier-recovery"],
    topology: { backend: "self-hosted", deployment: "production-canary", platform: "linux" },
    versions: { backend: "local_backend@pinned", bun: "1.3.14", daemon: "1.0.0" },
  };
}

test("release evidence accepts a complete, fully gated record", () => {
  const evidence = createReleaseEvidence(completeInput());

  expect(evidence).toMatchObject({
    schemaVersion: 1,
    commit: "abc123",
    gates,
    promotionBlocked: false,
  });
  expect(() => assertReleaseEvidenceReady(evidence)).not.toThrow();
});

test("release evidence blocks incomplete facts and false gates", () => {
  const evidence = createReleaseEvidence({
    ...completeInput(),
    gates: { ...gates, backupRehearsal: false },
    testIds: [],
  });

  expect(evidence.promotionBlocked).toBe(true);
  expect(() => assertReleaseEvidenceReady(evidence)).toThrow("missing required facts");
  expect(() => assertReleaseEvidenceReady(createReleaseEvidence({
    ...completeInput(),
    gates: { ...gates, backupRehearsal: false },
  }))).toThrow("blocked by a gate");
});

test("release evidence requires supervised canary rollout evidence", () => {
  const evidence = createReleaseEvidence({
    ...completeInput(),
    gates: { ...gates, canaryRollout: false },
  });

  expect(evidence.promotionBlocked).toBe(true);
  expect(() => assertReleaseEvidenceReady(evidence)).toThrow("blocked by a gate");
});

test("release evidence redacts and bounds failures and logs", () => {
  const evidence = createReleaseEvidence({
    ...completeInput(),
    failures: ["provider failed with sk-test-secret"],
    logs: [`Bearer sk-log-secret ${"x".repeat(3_000)}`],
  });

  expect(evidence.promotionBlocked).toBe(true);
  expect(evidence.redactedFailures[0]).not.toContain("sk-test-secret");
  expect(evidence.redactedLogs[0]).not.toContain("sk-log-secret");
  expect(evidence.redactedLogs[0]?.length).toBeLessThanOrEqual(2_000);
});

test("release evidence sanitizes caller-supplied metadata before writing", () => {
  const evidence = createReleaseEvidence({ ...completeInput(), recordedAt: "Bearer sk-recorded-secret" });

  expect(evidence.recordedAt).not.toContain("sk-recorded-secret");
  expect(() => assertReleaseEvidenceReady(evidence)).not.toThrow();
});

test("serialized release evidence input rejects unknown gate values", () => {
  expect(() => parseReleaseEvidenceInput({
    ...completeInput(),
    gates: { ...gates, providerConformance: "true" },
  })).toThrow("providerConformance");
});

test("serialized release evidence requires a backup rehearsal hash", () => {
  const { rehearsalHash: _, ...withoutHash } = completeInput();
  expect(() => parseReleaseEvidenceInput(withoutHash)).toThrow("rehearsalHash");
});

test("serialized release evidence rejects unredacted or oversized diagnostic fields", () => {
  const evidence = createReleaseEvidence(completeInput());

  expect(() => assertReleaseEvidenceReady({
    ...evidence,
    redactedFailures: ["failed with sk-secret"],
  })).toThrow("redactedFailures");
  expect(() => assertReleaseEvidenceReady({
    ...evidence,
    redactedLogs: ["x".repeat(2_001)],
  })).toThrow("redactedLogs");
});

test("release evidence writer persists a mode-restricted JSON record", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-release-evidence-test-"));
  const output = join(root, "nested", "release.json");
  try {
    await writeReleaseEvidence(output, createReleaseEvidence(completeInput()));
    const written = JSON.parse(await readFile(output, "utf8")) as { schemaVersion?: number; promotionBlocked?: boolean };
    expect(written).toMatchObject({ schemaVersion: 1, promotionBlocked: false });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release evidence CLI writes a blocked record and exits fail-closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-release-evidence-cli-test-"));
  const input = join(root, "facts.json");
  const output = join(root, "release.json");
  try {
    await writeFile(input, JSON.stringify({ ...completeInput(), failures: ["provider unavailable"] }));
    const process = Bun.spawn(["bun", "run", join(import.meta.dir, "release-evidence.ts"), "--input", input, "--output", output], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await process.exited;
    expect(exitCode).toBe(78);
    const written = JSON.parse(await readFile(output, "utf8")) as { promotionBlocked?: boolean };
    expect(written.promotionBlocked).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
