import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@relay/shared";
import type { ExtensionScope } from "./extension-paths";

export interface Skill {
  body: string;
  description: string;
  directory: string;
  name: string;
  scope: ExtensionScope;
}

const MAX_SKILLS = 50;
const MAX_DESC_LENGTH = 500;
const MAX_BODY_BYTES = 32 * 1024; // 32KB

export async function loadSkills(roots: Array<{ root: string; scope: ExtensionScope }>): Promise<Skill[]> {
  const byName = new Map<string, Skill>();

  for (const { root, scope } of roots) {
    let entries: string[];
    try { entries = await readdir(root); } catch { continue; }
    for (const entry of entries) {
      if (byName.size >= MAX_SKILLS) break;
      const skillDir = join(root, entry);
      try {
        const dirStat = await stat(skillDir);
        if (!dirStat.isDirectory()) continue;
      } catch { continue; }
      if (byName.has(entry)) continue; // first scope wins
      const skillFile = join(skillDir, "SKILL.md");
      try {
        const raw = await readFile(skillFile, "utf8");
        if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
          console.warn(`Skill body exceeds ${MAX_BODY_BYTES} bytes: ${skillFile}`);
          continue;
        }
        const { attributes, body } = parseFrontmatter(raw);
        const description = attributes.description;
        if (!description) {
          console.warn(`Skill missing description: ${skillFile}`);
          continue;
        }
        if (description.length > MAX_DESC_LENGTH) {
          console.warn(`Skill description exceeds ${MAX_DESC_LENGTH} chars: ${skillFile}`);
          continue;
        }
        byName.set(entry, {
          body: body.trim(),
          description,
          directory: skillDir,
          name: entry,
          scope,
        });
      } catch { /* file doesn't exist or can't be read */ }
    }
  }

  return [...byName.values()];
}
