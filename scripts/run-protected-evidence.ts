import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { redactSecrets } from "../apps/daemon/src/observability/logger";

const MAX_OUTPUT_LENGTH = 20_000;
const MAX_COMMAND_ARG_LENGTH = 2_000;

export type ProtectedRunEvidence = Readonly<{
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  platform: NodeJS.Platform;
  arch: string;
  runtime: string;
  command: ReadonlyArray<string>;
  status: "pass" | "fail";
  exitCode: number;
  stdout: string;
  stderr: string;
}>;

function bounded(value: string, limit: number): string {
  return redactSecrets(value).slice(-limit);
}

export async function captureProtectedRun(command: ReadonlyArray<string>): Promise<ProtectedRunEvidence> {
  if (command.length === 0 || command[0]?.trim().length === 0) throw new Error("protected command is required");
  const startedAt = new Date().toISOString();
  const child = Bun.spawn([...command], {
    env: Bun.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return {
    schemaVersion: 1,
    startedAt,
    finishedAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    runtime: Bun.version,
    command: command.map((argument) => bounded(argument, MAX_COMMAND_ARG_LENGTH)),
    status: exitCode === 0 ? "pass" : "fail",
    exitCode,
    stdout: bounded(stdout, MAX_OUTPUT_LENGTH),
    stderr: bounded(stderr, MAX_OUTPUT_LENGTH),
  };
}

export async function writeProtectedRunEvidence(path: string, evidence: ProtectedRunEvidence): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function valueAfter(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index < 0 ? undefined : argv[index + 1];
  if (index >= 0 && (!value || value.startsWith("--"))) throw new Error(`${flag} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const separator = Bun.argv.indexOf("--");
  if (separator < 0) throw new Error("protected command must follow --");
  const outputPath = valueAfter(Bun.argv.slice(0, separator), "--output");
  if (!outputPath) throw new Error("--output is required");
  const command = Bun.argv.slice(separator + 1);
  const evidence = await captureProtectedRun(command);
  await writeProtectedRunEvidence(outputPath, evidence);
  console.log(JSON.stringify({ output: outputPath, status: evidence.status, exitCode: evidence.exitCode }, null, 2));
  if (evidence.exitCode !== 0) process.exitCode = evidence.exitCode;
}

if (import.meta.main) await main();
