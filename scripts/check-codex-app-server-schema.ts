import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parsePinnedCodexVersion } from "./codex-schema";

const root = "packages/providers/codex-app-server/src/generated";
const files = (await readdir(root, { recursive: true })).filter((f) => /\.(ts|json)$/.test(f)).sort();
if (files.length === 0) throw new Error("Codex generated schema surface is empty");
const jsonFiles = files.filter((file) => file.endsWith(".json"));
if (jsonFiles.length === 0) throw new Error("Codex generated JSON schema surface is empty");
const pinnedVersion = parsePinnedCodexVersion(await Bun.file(join(root, "CODEX_VERSION.txt")).text());
const hash = createHash("sha256");
for (const file of files) hash.update(file).update(Buffer.from(await Bun.file(join(root, file)).arrayBuffer()));
console.log(`Codex schema surface checked: ${files.length} files (${jsonFiles.length} JSON), pinned=${pinnedVersion}, sha256=${hash.digest("hex")}`);
