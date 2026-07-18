import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "@relay/shared";
import type { ExtensionScope } from "./extension-paths";

export interface SlashCommand {
  argumentHint?: string;
  description: string;
  model?: string;
  name: string;
  scope: ExtensionScope;
  template: string;
}

const MAX_COMMANDS = 100;
const MAX_TEMPLATE_BYTES = 10 * 1024; // 10KB

export async function loadSlashCommands(roots: Array<{ root: string; scope: ExtensionScope }>): Promise<SlashCommand[]> {
  const byName = new Map<string, SlashCommand>();

  for (const { root, scope } of roots) {
    let entries: string[];
    try { entries = await readdir(root); } catch { continue; }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      if (byName.size >= MAX_COMMANDS) break;
      const name = entry.slice(0, -3); // strip .md
      if (!/^[a-z0-9][a-z0-9:_-]*$/i.test(name)) continue;
      // Skip if already defined (first scope wins)
      if (byName.has(name)) continue;
      const filePath = join(root, entry);
      try {
        const raw = await readFile(filePath, "utf8");
        if (Buffer.byteLength(raw) > MAX_TEMPLATE_BYTES) {
          console.warn(`Slash command template exceeds ${MAX_TEMPLATE_BYTES} bytes: ${filePath}`);
          continue;
        }
        const { attributes, body } = parseFrontmatter(raw);
        if (!attributes.description) continue; // description is required
        byName.set(name, {
          argumentHint: attributes["argument-hint"],
          description: attributes.description,
          model: attributes.model,
          name,
          scope,
          template: body.trim(),
        });
      } catch (error) {
        console.warn(`Failed to load slash command ${filePath}:`, error);
      }
    }
  }

  return [...byName.values()];
}

const SLASH_INVOCATION = /^\/([a-z0-9][a-z0-9:_-]*)(?:\s+([\s\S]*))?$/i;

export function parseSlashInvocation(text: string): { args: string; name: string } | undefined {
  const match = SLASH_INVOCATION.exec(text.trim());
  const name = match?.[1];
  if (!match || name === undefined) return undefined;
  return { args: match[2] ?? "", name };
}

export function expandCommand({ args, template }: { args: string; template: string }): string {
  const positional = args.trim().split(/\s+/);
  let result = template;
  for (let i = 1; i <= 9; i++) {
    result = result.replaceAll(`$${i}`, positional[i - 1] ?? "");
  }
  result = result.replaceAll("$ARGUMENTS", args);
  return result;
}
