import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { redactSecrets } from "../apps/daemon/src/observability/logger";

const MAX_TEXT_LENGTH = 2_000;
const MAX_ITEMS = 200;

const GATE_KEYS = [
  "backupRehearsal",
  "canaryRollout",
  "kernelReady",
  "productionAcceptance",
  "providerConformance",
  "releaseWindow",
  "shadowParity",
  "supportedOsConformance",
  "zeroLegacyActivations",
] as const;

export type ReleaseGates = Readonly<{
  [Key in (typeof GATE_KEYS)[number]]: boolean;
}>;

export type ReleaseEvidenceInput = Readonly<{
  commit: string;
  gates: ReleaseGates;
  migrationState: string;
  residualRisks: ReadonlyArray<string>;
  sourceArtifacts: ReadonlyArray<string>;
  testIds: ReadonlyArray<string>;
  topology: Readonly<{ backend: string; deployment: string; platform: string }>;
  versions: Readonly<{ backend: string; bun: string; daemon: string }>;
  failures?: ReadonlyArray<string>;
  logs?: ReadonlyArray<string>;
  recordedAt?: string;
}>;

export type ReleaseEvidence = Readonly<{
  schemaVersion: 1;
  recordedAt: string;
  commit: string;
  gates: ReleaseGates;
  migrationState: string;
  versions: Readonly<{ backend: string; bun: string; daemon: string }>;
  topology: Readonly<{ backend: string; deployment: string; platform: string }>;
  sourceArtifacts: ReadonlyArray<string>;
  testIds: ReadonlyArray<string>;
  redactedFailures: ReadonlyArray<string>;
  redactedLogs: ReadonlyArray<string>;
  residualRisks: ReadonlyArray<string>;
  promotionBlocked: boolean;
}>;

type RecordValue = { readonly [key: string]: unknown };

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function readString(record: RecordValue, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function readStringArray(record: RecordValue, key: string): ReadonlyArray<string> {
  const value = record[key];
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${key} must be an array of strings`);
  }
  return value;
}

function readOptionalStringArray(record: RecordValue, key: string): ReadonlyArray<string> | undefined {
  if (record[key] === undefined) return undefined;
  return readStringArray(record, key);
}

function assertSafeText(value: string, key: string): void {
  if (value.length > MAX_TEXT_LENGTH) throw new Error(`${key} contains an oversized value`);
  if (redactSecrets(value) !== value) throw new Error(`${key} contains an unredacted secret`);
}

function assertSafeTextArray(values: ReadonlyArray<string>, key: string): void {
  if (values.length > MAX_ITEMS) throw new Error(`${key} exceeds the maximum item count`);
  for (const value of values) assertSafeText(value, key);
}

function readBoolean(record: RecordValue, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

function readGates(value: unknown): ReleaseGates {
  const record = readRecord(value, "gates");
  return {
    backupRehearsal: readBoolean(record, "backupRehearsal"),
    canaryRollout: readBoolean(record, "canaryRollout"),
    kernelReady: readBoolean(record, "kernelReady"),
    productionAcceptance: readBoolean(record, "productionAcceptance"),
    providerConformance: readBoolean(record, "providerConformance"),
    releaseWindow: readBoolean(record, "releaseWindow"),
    shadowParity: readBoolean(record, "shadowParity"),
    supportedOsConformance: readBoolean(record, "supportedOsConformance"),
    zeroLegacyActivations: readBoolean(record, "zeroLegacyActivations"),
  };
}

function readVersions(value: unknown): ReleaseEvidenceInput["versions"] {
  const record = readRecord(value, "versions");
  return { backend: readString(record, "backend"), bun: readString(record, "bun"), daemon: readString(record, "daemon") };
}

function readTopology(value: unknown): ReleaseEvidenceInput["topology"] {
  const record = readRecord(value, "topology");
  return { backend: readString(record, "backend"), deployment: readString(record, "deployment"), platform: readString(record, "platform") };
}

/** Validate untrusted JSON before it becomes a release-evidence input. */
export function parseReleaseEvidenceInput(value: unknown): ReleaseEvidenceInput {
  const record = readRecord(value, "release evidence input");
  const failures = readOptionalStringArray(record, "failures");
  const logs = readOptionalStringArray(record, "logs");
  return {
    commit: readString(record, "commit"),
    gates: readGates(record.gates),
    migrationState: readString(record, "migrationState"),
    residualRisks: readStringArray(record, "residualRisks"),
    sourceArtifacts: readStringArray(record, "sourceArtifacts"),
    testIds: readStringArray(record, "testIds"),
    topology: readTopology(record.topology),
    versions: readVersions(record.versions),
    ...(failures === undefined ? {} : { failures }),
    ...(logs === undefined ? {} : { logs }),
    ...(record.recordedAt === undefined ? {} : { recordedAt: readString(record, "recordedAt") }),
  };
}

function boundedRedacted(values: ReadonlyArray<string> | undefined): ReadonlyArray<string> {
  return (values ?? []).map((value) => redactSecrets(value).slice(0, MAX_TEXT_LENGTH)).slice(0, MAX_ITEMS);
}

function hasCompleteFacts(input: Pick<ReleaseEvidenceInput, "commit" | "migrationState" | "residualRisks" | "sourceArtifacts" | "testIds" | "topology" | "versions">): boolean {
  return [
    input.commit,
    input.migrationState,
    input.topology.backend,
    input.topology.deployment,
    input.topology.platform,
    input.versions.backend,
    input.versions.bun,
    input.versions.daemon,
  ].every((value) => value.trim().length > 0)
    && input.sourceArtifacts.length > 0
    && input.sourceArtifacts.every((value) => value.trim().length > 0)
    && input.testIds.length > 0
    && input.testIds.every((value) => value.trim().length > 0)
    && input.residualRisks.every((value) => value.trim().length > 0);
}

function allGatesPass(gates: ReleaseGates): boolean {
  return GATE_KEYS.every((key) => gates[key]);
}

export function createReleaseEvidence(input: ReleaseEvidenceInput): ReleaseEvidence {
  const redactedFailures = boundedRedacted(input.failures);
  const redactedLogs = boundedRedacted(input.logs);
  const residualRisks = boundedRedacted(input.residualRisks);
  const promotionBlocked = !hasCompleteFacts(input)
    || !allGatesPass(input.gates)
    || redactedFailures.length > 0;

  return {
    schemaVersion: 1,
    recordedAt: redactSecrets(input.recordedAt ?? new Date().toISOString()).slice(0, MAX_TEXT_LENGTH),
    commit: redactSecrets(input.commit).slice(0, MAX_TEXT_LENGTH),
    gates: { ...input.gates },
    migrationState: redactSecrets(input.migrationState).slice(0, MAX_TEXT_LENGTH),
    versions: {
      backend: redactSecrets(input.versions.backend).slice(0, MAX_TEXT_LENGTH),
      bun: redactSecrets(input.versions.bun).slice(0, MAX_TEXT_LENGTH),
      daemon: redactSecrets(input.versions.daemon).slice(0, MAX_TEXT_LENGTH),
    },
    topology: {
      backend: redactSecrets(input.topology.backend).slice(0, MAX_TEXT_LENGTH),
      deployment: redactSecrets(input.topology.deployment).slice(0, MAX_TEXT_LENGTH),
      platform: redactSecrets(input.topology.platform).slice(0, MAX_TEXT_LENGTH),
    },
    sourceArtifacts: boundedRedacted(input.sourceArtifacts),
    testIds: boundedRedacted(input.testIds),
    redactedFailures,
    redactedLogs,
    residualRisks,
    promotionBlocked,
  };
}

function readReleaseEvidence(value: unknown): ReleaseEvidence {
  const record = readRecord(value, "release evidence");
  if (record.schemaVersion !== 1) throw new Error("release evidence has an unsupported schema version");
  if (typeof record.recordedAt !== "string" || record.recordedAt.trim().length === 0) throw new Error("recordedAt must be a non-empty string");
  assertSafeText(record.recordedAt, "recordedAt");
  const gates = readGates(record.gates);
  const failures = readStringArray(record, "redactedFailures");
  const logs = readStringArray(record, "redactedLogs");
  const residualRisks = readStringArray(record, "residualRisks");
  const sourceArtifacts = readStringArray(record, "sourceArtifacts");
  const testIds = readStringArray(record, "testIds");
  assertSafeTextArray(failures, "redactedFailures");
  assertSafeTextArray(logs, "redactedLogs");
  assertSafeTextArray(residualRisks, "residualRisks");
  assertSafeTextArray(sourceArtifacts, "sourceArtifacts");
  assertSafeTextArray(testIds, "testIds");
  const commit = readString(record, "commit");
  const migrationState = readString(record, "migrationState");
  assertSafeText(commit, "commit");
  assertSafeText(migrationState, "migrationState");
  const versions = readVersions(record.versions);
  assertSafeText(versions.backend, "versions.backend");
  assertSafeText(versions.bun, "versions.bun");
  assertSafeText(versions.daemon, "versions.daemon");
  const topology = readTopology(record.topology);
  assertSafeText(topology.backend, "topology.backend");
  assertSafeText(topology.deployment, "topology.deployment");
  assertSafeText(topology.platform, "topology.platform");
  if (typeof record.promotionBlocked !== "boolean") throw new Error("promotionBlocked must be a boolean");
  return {
    schemaVersion: 1,
    recordedAt: record.recordedAt,
    commit,
    gates,
    migrationState,
    versions,
    topology,
    sourceArtifacts,
    testIds,
    redactedFailures: failures,
    redactedLogs: logs,
    residualRisks,
    promotionBlocked: record.promotionBlocked,
  };
}

/** Require every fact and irreversible gate before a record can promote. */
export function assertReleaseEvidenceReady(value: unknown): asserts value is ReleaseEvidence {
  const evidence = readReleaseEvidence(value);
  if (!hasCompleteFacts(evidence)) throw new Error("release evidence is missing required facts");
  if (!allGatesPass(evidence.gates)) throw new Error("release evidence promotion is blocked by a gate");
  if (evidence.redactedFailures.length > 0 || evidence.promotionBlocked) throw new Error("release evidence promotion is blocked");
}

export async function writeReleaseEvidence(path: string, evidence: ReleaseEvidence): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function valuesAfter(argv: readonly string[], flag: string): ReadonlyArray<string> {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === flag) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      values.push(value);
      index += 1;
    } else if (argument.startsWith(`${flag}=`)) {
      values.push(argument.slice(flag.length + 1));
    }
  }
  return values;
}

async function main(): Promise<void> {
  const inputPath = valuesAfter(Bun.argv, "--input")[0];
  if (!inputPath) throw new Error("--input is required");
  const outputPath = valuesAfter(Bun.argv, "--output")[0] ?? "docs/operations/release-evidence/release-latest.json";
  const rawInput: unknown = JSON.parse(await readFile(inputPath, "utf8"));
  const parsedInput = parseReleaseEvidenceInput(rawInput);
  const evidence = createReleaseEvidence({
    ...parsedInput,
    failures: [...(parsedInput.failures ?? []), ...valuesAfter(Bun.argv, "--failure")],
    logs: [...(parsedInput.logs ?? []), ...valuesAfter(Bun.argv, "--log")],
  });
  await writeReleaseEvidence(outputPath, evidence);
  console.log(JSON.stringify({ output: outputPath, promotionBlocked: evidence.promotionBlocked }, null, 2));
  if (evidence.promotionBlocked) process.exitCode = 78;
}

if (import.meta.main) await main();
