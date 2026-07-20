import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const root = "packages/providers/codex-app-server/src/generated";
const files = (await readdir(root, { recursive: true })).filter((f) => /\.(ts|json)$/.test(f)).sort();
if (files.length === 0) throw new Error("Codex generated schema surface is empty");
const hash = createHash("sha256");
for (const file of files) hash.update(file).update(Buffer.from(await Bun.file(join(root, file)).arrayBuffer()));
console.log(`Codex schema surface checked: ${files.length} files, sha256=${hash.digest("hex")}`);
