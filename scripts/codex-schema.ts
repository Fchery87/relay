import { readFile, rm, mkdir, cp } from "node:fs/promises";
import { join, resolve } from "node:path";

export type CodexSchemaCommandOptions = Readonly<{
  codexPath: string;
  tsOutput: string;
  jsonOutput: string;
}>;

export function parsePinnedCodexVersion(metadata: string): string {
  const match = metadata.match(/^codex-cli\s+(\S+)\s*$/m);
  if (!match?.[1]) throw new Error("Pinned Codex metadata does not contain a codex-cli version");
  return match[1];
}

export function assertPinnedCodexVersion({ actual, pinned }: { actual: string; pinned: string }): void {
  const normalized = actual.trim().replace(/^codex-cli\s+/, "");
  if (normalized !== pinned) {
    throw new Error(`Codex CLI version mismatch: pinned ${pinned}, installed ${normalized}`);
  }
}

export function buildCodexSchemaCommands(options: CodexSchemaCommandOptions): readonly (readonly string[])[] {
  return [
    [options.codexPath, "app-server", "generate-ts", "--out", options.tsOutput],
    [options.codexPath, "app-server", "generate-json-schema", "--out", options.jsonOutput],
  ];
}

export async function generateCodexSchemas({
  codexPath = "codex",
  generatedDirectory = resolve(import.meta.dir, "../packages/providers/codex-app-server/src/generated"),
  pinnedVersionFile = join(generatedDirectory, "CODEX_VERSION.txt"),
  run = runCommand,
}: {
  codexPath?: string;
  generatedDirectory?: string;
  pinnedVersionFile?: string;
  run?: (command: readonly string[]) => Promise<void>;
} = {}): Promise<void> {
  const pinned = parsePinnedCodexVersion(await readFile(pinnedVersionFile, "utf8"));
  const versionOutput = await captureCommand([codexPath, "--version"]);
  assertPinnedCodexVersion({ actual: versionOutput, pinned });

  const staging = `${generatedDirectory}.staging-${process.pid}`;
  await rm(staging, { force: true, recursive: true });
  await mkdir(staging, { recursive: true });
  try {
    const [tsOutput, jsonOutput] = [join(staging, "ts"), join(staging, "json")];
    for (const command of buildCodexSchemaCommands({ codexPath, tsOutput, jsonOutput })) await run(command);
    await rm(generatedDirectory, { force: true, recursive: true });
    await mkdir(generatedDirectory, { recursive: true });
    await cp(tsOutput, generatedDirectory, { recursive: true });
    await cp(jsonOutput, join(generatedDirectory, "json-schema"), { recursive: true });
    await Bun.write(join(generatedDirectory, "CODEX_VERSION.txt"), [
      `codex-cli ${pinned}`,
      `Generated: ${new Date().toISOString().slice(0, 10)}`,
      "Commands: codex app-server generate-ts and generate-json-schema",
      "Do not hand-edit generated files; rerun bun run codex:schema:generate.",
      "",
    ].join("\n"));
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
}

async function captureCommand(command: readonly string[]): Promise<string> {
  const child = Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (status !== 0) throw new Error(`Codex version check failed (${status}): ${stderr.trim() || command.join(" ")}`);
  return stdout.trim();
}

async function runCommand(command: readonly string[]): Promise<void> {
  const child = Bun.spawn([...command], { stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Codex schema generation failed: ${command.join(" ")}`);
}

if (import.meta.main) {
  await generateCodexSchemas();
  console.log("Codex TypeScript and JSON schemas generated successfully.");
}
