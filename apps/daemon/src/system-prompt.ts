import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runCommand } from "./tools";
import type { Skill } from "./skills";

export interface SystemPromptContext {
  /** Project root directory */
  root: string;
  /** Machine platform (darwin, linux, win32) */
  platform: string;
  /** Loaded skills */
  skills?: Skill[];
}

export async function buildSystemPrompt({ root, platform, skills }: SystemPromptContext): Promise<string> {
  const blocks: string[] = [];

  // Identity
  blocks.push("You are Relay, an agent running on the user's machine. You have access to tools for reading files, editing files, running commands, searching the web, and delegating tasks to subagents.");

  // Behavioral rules
  const rules = [
    "BEHAVIORAL RULES:",
    "- Always read a file before editing it — never guess file contents.",
    "- Verify changes with commands when possible (e.g., run tests, check syntax).",
    "- Be concise in your final replies. Show your work, then summarize.",
    "- When you're unsure, ask clarifying questions or use read/search to find answers.",
    "- Prefer targeted edits (str_replace) over whole-file writes when possible.",
    "- After making changes, verify they work by reading back or running relevant commands.",
    "- Don't run destructive commands without explicit user confirmation.",
  ];
  if (skills && skills.length > 0) {
    rules.push("- For multi-step tasks, maintain a todo list with the todo tool and keep it current.");
  }
  blocks.push(rules.join("\n"));

  // Environment
  const envBlocks: string[] = [`Project root: ${root}`, `Platform: ${platform}`];
  try {
    const branch = await runCommand({ command: "git rev-parse --abbrev-ref HEAD", platform: platform as "linux" | "darwin" | "win32", root });
    envBlocks.push(`Git branch: ${branch.stdout.trim()}`);
  } catch { /* not a git repo */ }
  try {
    const status = await runCommand({ command: "git status --porcelain | head -20", platform: platform as "linux" | "darwin" | "win32", root });
    if (status.stdout.trim()) envBlocks.push(`Git status (first 20 changes):\n${status.stdout.trim()}`);
  } catch { /* not a git repo */ }

  blocks.push(`ENVIRONMENT:\n${envBlocks.join("\n")}`);

  // Project instructions
  for (const filename of ["AGENTS.md", "CLAUDE.md", ".relay/instructions.md"]) {
    try {
      const content = await readFile(join(root, filename), "utf8");
      const capped = content.length > 8000 ? content.slice(0, 8000) : content;
      blocks.push(`PROJECT INSTRUCTIONS (${filename}):\n${capped}`);
    } catch { /* file doesn't exist */ }
  }

  // Skills catalog
  if (skills && skills.length > 0) {
    const catalog = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    blocks.push(`AVAILABLE SKILLS:\n${catalog}\n\nIf a skill matches the task, call the skill tool before answering.`);
  }

  return blocks.join("\n\n");
}
