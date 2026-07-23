import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { releaseTargets } from "./release-targets";

const outputDir = join(import.meta.dir, "..", "dist", "release");
const entrypoint = join(import.meta.dir, "..", "apps", "daemon", "src", "cli.ts");
const signingKeyPath = Bun.env.RELAY_RELEASE_SIGNING_KEY_PATH;
if (!signingKeyPath) {
  throw new Error("RELAY_RELEASE_SIGNING_KEY_PATH is required; refusing to produce unsigned release artifacts");
}

async function run(command: string[]): Promise<void> {
  const child = Bun.spawn(command, { stderr: "inherit", stdout: "inherit" });
  if ((await child.exited) !== 0) throw new Error(`Release build failed: ${command.join(" ")}`);
}

await rm(outputDir, { force: true, recursive: true });
await mkdir(outputDir, { recursive: true });

for (const target of releaseTargets) {
  await run(["bun", "build", "--compile", `--target=${target.bunTarget}`, entrypoint, "--outfile", join(outputDir, target.fileName)]);
}

const checksumLines = await Promise.all(releaseTargets.map(async ({ fileName }) => {
  const contents = await readFile(join(outputDir, fileName));
  return `${createHash("sha256").update(contents).digest("hex")}  ${fileName}`;
}));
await writeFile(join(outputDir, "checksums.txt"), `${checksumLines.sort().join("\n")}\n`);
await run(["openssl", "dgst", "-sha256", "-sign", signingKeyPath, "-out", join(outputDir, "checksums.txt.sig"), join(outputDir, "checksums.txt")]);
await run(["openssl", "pkey", "-pubout", "-in", signingKeyPath, "-out", join(outputDir, "release-public-key.pem")]);
const packageJson = JSON.parse(await readFile(join(import.meta.dir, "..", "package.json"), "utf8")) as { version?: string };
const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { stderr: "ignore" });
await writeFile(join(outputDir, "release.json"), `${JSON.stringify({
  artifactSet: "relay-daemon",
  commit: new TextDecoder().decode(commit.stdout).trim(),
  signature: "RSA/ECDSA/Ed25519-SHA256 checksums.txt.sig",
  version: Bun.env.RELAY_RELEASE_VERSION ?? packageJson.version ?? "unknown",
  builtAt: new Date().toISOString(),
}, null, 2)}\n`);
await copyFile(join(import.meta.dir, "install.sh"), join(outputDir, "relay-install.sh"));
await copyFile(join(import.meta.dir, "install.ps1"), join(outputDir, "relay-install.ps1"));
