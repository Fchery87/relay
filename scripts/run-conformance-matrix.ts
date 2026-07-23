import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const commands = [
  ["bun", "run", "typecheck"],
  ["bun", "run", "test"],
  ["bun", "run", "test:e2e:harness"],
  ["bun", "run", "build"],
  ["bun", "run", "bundle:check"],
  ["bun", "run", "codex:schema:check"],
  ["bun", "run", "security:gate"],
] as const;

const SUPPORTED_PLATFORMS = new Set(["linux", "darwin", "win32"]);

export type ConformanceEvidence = {
  readonly schemaVersion: 1;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly platform: string;
  readonly arch: string;
  readonly runtime: string;
  readonly status: "pass" | "fail";
  readonly commands: ReadonlyArray<string>;
  readonly failedCommand?: string;
};

export function isSupportedConformancePlatform(platform: string): boolean {
  return SUPPORTED_PLATFORMS.has(platform);
}

export function createConformanceEvidence(input: {
  commands: ReadonlyArray<string>;
  platform: string;
  arch: string;
  runtime: string;
  status: ConformanceEvidence["status"];
  failedCommand?: string;
  startedAt?: string;
  finishedAt?: string;
}): ConformanceEvidence {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    startedAt: input.startedAt ?? now,
    finishedAt: input.finishedAt ?? now,
    platform: input.platform,
    arch: input.arch,
    runtime: input.runtime,
    status: input.status,
    commands: [...input.commands],
    ...(input.failedCommand === undefined ? {} : { failedCommand: input.failedCommand }),
  };
}

async function writeConformanceEvidence(path: string, evidence: ConformanceEvidence): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function evidencePath(): string | undefined {
  for (const [index, argument] of Bun.argv.entries()) {
    if (argument === "--evidence" && Bun.argv[index + 1]) return Bun.argv[index + 1];
    if (argument.startsWith("--evidence=")) return argument.slice("--evidence=".length);
  }
  return Bun.env.RELAY_CONFORMANCE_EVIDENCE_PATH;
}

async function recordEvidence(evidence: ConformanceEvidence): Promise<void> {
  const path = evidencePath();
  if (path) await writeConformanceEvidence(path, evidence);
  console.log(JSON.stringify(evidence, null, 2));
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  const commandNames = commands.map((command) => command.join(" "));
  const platform = process.platform;

  if (!isSupportedConformancePlatform(platform)) {
    const evidence = createConformanceEvidence({
      commands: commandNames,
      failedCommand: `unsupported-platform:${platform}`,
      platform,
      arch: process.arch,
      runtime: Bun.version,
      startedAt,
      status: "fail",
    });
    await recordEvidence(evidence);
    console.error(`Conformance failed: unsupported platform ${platform}`);
    process.exitCode = 78;
    return;
  }

  for (const command of commands) {
    const env = command[2] === "test" ? { ...Bun.env, RELAY_REQUIRE_MCP_FIXTURES: "1" } : Bun.env;
    const proc = Bun.spawnSync([...command], { stdout: "inherit", stderr: "inherit", env });
    if (proc.exitCode !== 0) {
      const evidence = createConformanceEvidence({
        commands: commandNames,
        failedCommand: command.join(" "),
        platform,
        arch: process.arch,
        runtime: Bun.version,
        startedAt,
        status: "fail",
      });
      await recordEvidence(evidence);
      console.error(`Conformance failed: ${command.join(" ")}`);
      process.exitCode = proc.exitCode ?? 1;
      return;
    }
  }

  await recordEvidence(createConformanceEvidence({
    commands: commandNames,
    platform,
    arch: process.arch,
    runtime: Bun.version,
    startedAt,
    status: "pass",
  }));
}

if (import.meta.main) await main();
