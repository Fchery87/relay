import { chmod, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

import { redactSecrets } from "../apps/daemon/src/observability/logger";
import type { CanaryTelemetry } from "../apps/daemon/src/runtime-mode";

export const CANARY_STAGES = ["developer", "internal", "small-production", "kernel-default"] as const;
export type CanaryStage = (typeof CANARY_STAGES)[number];

export function assertCanaryStageTransition(previous: CanaryStage | undefined, next: CanaryStage): void {
  if (previous === undefined || previous === next) return;
  const previousIndex = CANARY_STAGES.indexOf(previous);
  const nextIndex = CANARY_STAGES.indexOf(next);
  if (nextIndex !== previousIndex + 1) throw new Error(`Canary stage must advance from ${previous} to ${CANARY_STAGES[previousIndex + 1] ?? "completion"}; received ${next}`);
}

function isMissingEvidenceValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.length === 0 || normalized === "unknown" || normalized === "not-specified";
}

function hasRequiredEvidence(input: {
  commit: string;
  versions: CanaryEvidence["versions"];
  topology: CanaryEvidence["topology"];
  migrationState: string;
  testIds: ReadonlyArray<string>;
  telemetry?: CanaryTelemetry;
}): boolean {
  return !isMissingEvidenceValue(input.commit)
    && !isMissingEvidenceValue(input.versions.bun)
    && !isMissingEvidenceValue(input.versions.daemon)
    && !isMissingEvidenceValue(input.versions.backend)
    && !isMissingEvidenceValue(input.topology.backend)
    && !isMissingEvidenceValue(input.topology.deployment)
    && !isMissingEvidenceValue(input.topology.platform)
    && !isMissingEvidenceValue(input.migrationState)
    && input.testIds.length > 0
    && input.testIds.every((testId) => !isMissingEvidenceValue(testId))
    && hasCompleteTelemetry(input.telemetry);
}

const TELEMETRY_FIELDS = [
  "activeLeases",
  "authFailures",
  "crossOwnerResults",
  "duplicateCommands",
  "fallbackActivations",
  "pendingEffects",
  "projectionBacklog",
  "projectionDivergences",
  "projectionGaps",
  "recoverableFailures",
  "sandboxViolations",
  "unrecoverableFailures",
] as const satisfies ReadonlyArray<keyof CanaryTelemetry>;

function hasCompleteTelemetry(telemetry: CanaryTelemetry | undefined): telemetry is CanaryTelemetry {
  return telemetry !== undefined
    && (telemetry.mode === "legacy" || telemetry.mode === "shadow" || telemetry.mode === "kernel")
    && TELEMETRY_FIELDS.every((field) => Number.isFinite(telemetry[field]) && telemetry[field] >= 0);
}

function telemetryBlocksPromotion(telemetry: CanaryTelemetry | undefined): boolean {
  return telemetry === undefined || telemetry.duplicateCommands > 0 || telemetry.crossOwnerResults > 0
    || telemetry.projectionGaps > 0 || telemetry.projectionDivergences > 0
    || telemetry.sandboxViolations > 0 || telemetry.unrecoverableFailures > 0;
}

export type CanaryEvidence = {
  readonly schemaVersion: 1;
  readonly recordedAt: string;
  readonly stage: CanaryStage;
  readonly commit: string;
  readonly runtimeMode: "legacy" | "shadow" | "kernel";
  readonly versions: Readonly<{ bun: string; daemon: string; backend: string }>;
  readonly topology: Readonly<{ backend: string; deployment: string; platform: string }>;
  readonly migrationState: string;
  readonly testIds: ReadonlyArray<string>;
  readonly redactedFailures: ReadonlyArray<string>;
  readonly redactedLogs: ReadonlyArray<string>;
  readonly residualRisks: ReadonlyArray<string>;
  readonly telemetry?: CanaryTelemetry;
  readonly promotionBlocked: boolean;
};

export function createCanaryEvidence(input: {
  stage: CanaryStage;
  commit: string;
  runtimeMode: CanaryEvidence["runtimeMode"];
  versions: CanaryEvidence["versions"];
  topology: CanaryEvidence["topology"];
  migrationState: string;
  testIds: ReadonlyArray<string>;
  failures?: ReadonlyArray<string>;
  logs?: ReadonlyArray<string>;
  residualRisks: ReadonlyArray<string>;
  telemetry?: CanaryTelemetry;
}): CanaryEvidence {
  const failures = (input.failures ?? []).map(redactSecrets).map((failure) => failure.slice(0, 2_000));
  const logs = (input.logs ?? []).map(redactSecrets).map((log) => log.slice(0, 2_000));
  const promotionBlocked = !hasRequiredEvidence(input)
    || failures.length > 0 || telemetryBlocksPromotion(input.telemetry);
  return {
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    stage: input.stage,
    commit: input.commit.slice(0, 200),
    runtimeMode: input.runtimeMode,
    versions: {
      backend: input.versions.backend.slice(0, 200),
      bun: input.versions.bun.slice(0, 100),
      daemon: input.versions.daemon.slice(0, 100),
    },
    topology: {
      backend: input.topology.backend.slice(0, 200),
      deployment: input.topology.deployment.slice(0, 200),
      platform: input.topology.platform.slice(0, 100),
    },
    migrationState: input.migrationState.slice(0, 2_000),
    testIds: input.testIds.map((testId) => testId.slice(0, 200)).slice(0, 200),
    redactedFailures: failures.slice(0, 200),
    redactedLogs: logs.slice(0, 200),
    residualRisks: input.residualRisks.map((risk) => redactSecrets(risk).slice(0, 2_000)).slice(0, 200),
    ...(input.telemetry === undefined ? {} : { telemetry: input.telemetry }),
    promotionBlocked,
  };
}

/**
 * Validate the evidence that an operator is about to use for promotion.
 * Recording an incomplete record is useful for diagnostics, but it must not
 * be accepted as a stage predecessor or as promotion evidence.
 */
export function assertCanaryEvidenceReady(evidence: CanaryEvidence, expectedStage?: CanaryStage): void {
  if (evidence.schemaVersion !== 1) throw new Error("Canary evidence has an unsupported schema version");
  if (!CANARY_STAGES.includes(evidence.stage)) throw new Error(`Canary evidence has an invalid stage: ${evidence.stage}`);
  if (expectedStage !== undefined && evidence.stage !== expectedStage) {
    throw new Error(`Canary evidence stage ${evidence.stage} does not match ${expectedStage}`);
  }
  if (!hasRequiredEvidence(evidence)) throw new Error("Canary evidence is missing required evidence");
  const recomputedBlocked = evidence.redactedFailures.length > 0 || telemetryBlocksPromotion(evidence.telemetry);
  if (evidence.promotionBlocked || recomputedBlocked) throw new Error("Canary evidence promotion is blocked");
  if (evidence.runtimeMode !== "legacy" && evidence.runtimeMode !== "shadow" && evidence.runtimeMode !== "kernel") {
    throw new Error(`Canary evidence has an invalid runtime mode: ${evidence.runtimeMode}`);
  }
}

export async function writeCanaryEvidence(path: string, evidence: CanaryEvidence): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

async function gitCommit(): Promise<string> {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stderr: "ignore" });
  return new TextDecoder().decode(result.stdout).trim() || "unknown";
}

function valuesAfter(flag: string): string[] {
  const values: string[] = [];
  for (const [index, argument] of Bun.argv.entries()) {
    if (argument === flag && Bun.argv[index + 1]) values.push(Bun.argv[index + 1]!);
    else if (argument.startsWith(`${flag}=`)) values.push(argument.slice(flag.length + 1));
  }
  return values;
}

async function readCanaryTelemetry(path: string | undefined): Promise<CanaryTelemetry | undefined> {
  if (!path) return undefined;
  return JSON.parse(await readFile(path, "utf8")) as CanaryTelemetry;
}

async function main(): Promise<void> {
  const stage = valuesAfter("--stage")[0] as CanaryStage | undefined;
  if (!stage || !CANARY_STAGES.includes(stage)) throw new Error(`--stage must be one of: ${CANARY_STAGES.join(", ")}`);
  const output = valuesAfter("--output")[0] ?? "docs/operations/release-evidence/canary-latest.json";
  const previousPath = valuesAfter("--previous")[0];
  if (previousPath) {
    const previous = JSON.parse(await readFile(previousPath, "utf8")) as CanaryEvidence;
    assertCanaryEvidenceReady(previous);
    assertCanaryStageTransition(previous.stage, stage);
  }
  const runtimeMode = (valuesAfter("--runtime-mode")[0] ?? "kernel") as CanaryEvidence["runtimeMode"];
  if (runtimeMode !== "legacy" && runtimeMode !== "shadow" && runtimeMode !== "kernel") throw new Error("--runtime-mode must be legacy, shadow, or kernel");
  const evidence = createCanaryEvidence({
    commit: await gitCommit(),
    failures: valuesAfter("--failure"),
    logs: valuesAfter("--log"),
    migrationState: valuesAfter("--migration-state")[0] ?? "not-specified",
    residualRisks: valuesAfter("--risk"),
    runtimeMode,
    stage,
    testIds: valuesAfter("--test-id"),
    topology: {
      backend: valuesAfter("--backend")[0] ?? "self-hosted",
      deployment: valuesAfter("--deployment")[0] ?? "local",
      platform: process.platform,
    },
    versions: { backend: valuesAfter("--backend-version")[0] ?? "unknown", bun: Bun.version, daemon: "1.0.0" },
    telemetry: await readCanaryTelemetry(valuesAfter("--telemetry")[0]),
  });
  await writeCanaryEvidence(output, evidence);
  console.log(JSON.stringify({ output, promotionBlocked: evidence.promotionBlocked, stage: evidence.stage }));
  if (evidence.promotionBlocked) process.exitCode = 78;
}

if (import.meta.main) await main();
