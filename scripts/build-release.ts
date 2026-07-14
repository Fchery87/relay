import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { releaseTargets } from "./release-targets";

const outputDir = join(import.meta.dir, "..", "dist", "release");
const entrypoint = join(import.meta.dir, "..", "apps", "daemon", "src", "cli.ts");

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
await copyFile(join(import.meta.dir, "install.sh"), join(outputDir, "relay-install.sh"));
await copyFile(join(import.meta.dir, "install.ps1"), join(outputDir, "relay-install.ps1"));
