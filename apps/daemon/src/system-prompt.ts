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
  /** Effective model id for this turn (e.g. "deepseek/deepseek-v4-flash") */
  modelId?: string;
  /** Plan-mode phase for this turn, when the thread is a plan run */
  planPhase?: "planning" | "building" | "complete";
  /** Subagent roles available to the task tool */
  subagentRoles?: ReadonlyArray<{ description: string; name: string }>;
}

export async function buildSystemPrompt({ root, platform, skills, modelId, planPhase, subagentRoles }: SystemPromptContext): Promise<string> {
  const blocks: string[] = [];

  // Identity
  const identity = modelId
    ? `You are Relay, an agent running on the user's machine, powered by the model \`${modelId}\`. State this model id accurately if asked what model or provider you are — do not guess a different one.`
    : "You are Relay, an agent running on the user's machine.";
  blocks.push(`${identity} You have access to tools for reading files, editing files, running commands, searching the web, and delegating tasks to subagents.`);

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

  // Plan-mode phase
  if (planPhase === "planning") {
    blocks.push([
      "PLAN MODE — PLANNING PHASE:",
      "You are in the read-only planning phase. Investigate with read, grep, glob, web_search, and web_fetch, then produce an ordered, verifiable implementation plan as your reply.",
      "Mutating tools (edit, str_replace, bash, task) are refused in this phase — do not attempt them; plan the changes instead.",
      "A good plan lists concrete steps with the files involved and how each step will be verified.",
    ].join("\n"));
  } else if (planPhase === "building") {
    blocks.push([
      "PLAN MODE — BUILDING PHASE:",
      "An approved plan exists for this thread (see the conversation). Execute it step by step with your full toolset, verifying each step as the plan specifies before moving on.",
      "If reality contradicts the plan, say so and adapt — do not silently diverge.",
    ].join("\n"));
  }

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

  // Project instructions. AGENTS.md and CLAUDE.md are alternative names for
  // the same convention — load whichever exists first, not both.
  const instructionFiles: string[] = [];
  for (const filename of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      await readFile(join(root, filename), "utf8");
      instructionFiles.push(filename);
      break;
    } catch { /* file doesn't exist */ }
  }
  instructionFiles.push(".relay/instructions.md");
  for (const filename of instructionFiles) {
    try {
      const content = await readFile(join(root, filename), "utf8");
      const capped = content.length > 8000 ? `${content.slice(0, 8000)}\n[…truncated at 8000 characters]` : content;
      blocks.push(`PROJECT INSTRUCTIONS (${filename}):\n${capped}`);
    } catch { /* file doesn't exist */ }
  }

  // Subagent role catalog for the task tool
  if (subagentRoles && subagentRoles.length > 0) {
    const catalog = subagentRoles.map((r) => `- ${r.name}: ${r.description}`).join("\n");
    blocks.push(`AVAILABLE SUBAGENT ROLES (for the task tool — use these exact role names):\n${catalog}`);
  }

  // Skills catalog
  if (skills && skills.length > 0) {
    const catalog = skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
    blocks.push(`AVAILABLE SKILLS:\n${catalog}\n\nIf a skill matches the task, call the skill tool before answering.`);
  }

  return blocks.join("\n\n");
}
