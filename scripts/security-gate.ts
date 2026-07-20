import { readdir } from "node:fs/promises";
import { join } from "node:path";

const forbidden = ["test.todo(\"escape suite", "return true; // Stub"];
const roots = ["apps", "packages", "convex"];
let findings: string[] = [];
for (const root of roots) {
  try {
    const entries = await readdir(root, { recursive: true });
    for (const entry of entries) {
      if (!/\.(ts|tsx|js|jsx)$/.test(entry)) continue;
      const path = join(root, entry);
      const text = await Bun.file(path).text();
      for (const needle of forbidden) if (text.includes(needle)) findings.push(`${path}: contains prohibited pattern ${needle}`);
    }
  } catch {}
}
if (findings.length) { console.error(findings.join("\n")); process.exit(1); }
console.log("Security gate passed: no prohibited scaffold or known unsafe patterns detected.");
