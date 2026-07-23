import { readFile } from "node:fs/promises";

import { redactSecrets } from "../apps/daemon/src/observability/logger";
import { assertReleaseEvidenceReady, type ReleaseEvidence } from "./release-evidence";

export type ConvexReleaseEvidenceArgs = Readonly<{
  backupRehearsal: boolean;
  canaryRollout: boolean;
  kernelReady: boolean;
  productionAcceptance: boolean;
  providerConformance: boolean;
  releaseWindow: boolean;
  rehearsalHash: string;
  shadowParity: boolean;
  supportedOsConformance: boolean;
  zeroLegacyActivations: boolean;
}>;

/** Convert the validated release record into the internal Convex mutation shape. */
export function toConvexReleaseEvidenceArgs(value: unknown): ConvexReleaseEvidenceArgs {
  assertReleaseEvidenceReady(value);
  const evidence = value as ReleaseEvidence;
  return {
    ...evidence.gates,
    rehearsalHash: evidence.rehearsalHash,
  };
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (value?.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function main(): Promise<void> {
  const inputPath = flagValue(Bun.argv, "--input");
  if (!inputPath) throw new Error("--input is required");
  const deploymentUrl = Bun.env.CONVEX_SELF_HOSTED_URL;
  const adminKey = Bun.env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  if (!deploymentUrl || !adminKey) {
    throw new Error("CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY are required");
  }

  const evidence = JSON.parse(await readFile(inputPath, "utf8")) as unknown;
  const args = toConvexReleaseEvidenceArgs(evidence);
  const child = Bun.spawn(
    ["bunx", "convex", "run", "narrow:recordReleaseEvidence", JSON.stringify(args)],
    {
      cwd: process.cwd(),
      env: {
        ...Bun.env,
        CONVEX_DEPLOYMENT: undefined,
        CONVEX_SELF_HOSTED_URL: deploymentUrl,
        CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`recording release evidence failed: ${redactSecrets(stderr || stdout).slice(0, 2_000)}`);
  }
  console.log(redactSecrets(stdout).slice(0, 2_000));
}

if (import.meta.main) await main();
