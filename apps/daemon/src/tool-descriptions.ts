/** Human-readable descriptions for each tool, modeled on Claude Code's tool docs. */
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  bash: [
    "Execute a shell command in the project root directory.",
    "Use for: running tests, build commands, git operations, package managers, file system operations.",
    "Prefer specific, targeted commands over broad ones (e.g., 'npm test -- --grep failing-test' over 'npm test').",
    "Always quote paths with spaces or special characters.",
    "Commands run in a non-interactive shell — don't use interactive programs like vim or less.",
    "The default timeout is 120s; you can request up to 600s for long-running commands.",
    "Output is capped at 30KB (head 10KB + tail 20KB) — use intermediate files or filters for large outputs.",
    "Never run destructive commands without explicit user approval — 'rm -rf', 'sudo', 'git push --force' should be confirmed.",
  ].join("\n"),
  read: [
    "Read the contents of a file from the project filesystem.",
    "Returns up to 2000 lines (50KB) per call, with line numbers prefixed (e.g., '42→').",
    "Use the optional offset and limit parameters to read specific sections of large files.",
    "Always read a file before editing it — models produce better edits when they've seen the actual content.",
    "Use read to inspect configuration files, source code, logs, and documentation within the project.",
  ].join("\n"),
  edit: [
    "Write or overwrite a file in the project with the given content.",
    "For whole-file writes, provide the complete new content. For targeted edits, use str_replace instead.",
    "Creates the file if it doesn't exist; parent directories are created automatically.",
    "Paths are relative to the project root. Use forward slashes even on Windows.",
    "After editing, verify by reading the file back or running relevant tests.",
  ].join("\n"),
  str_replace: [
    "Replace a specific string in a file with new content — precise, targeted edits.",
    "The oldString must appear exactly once in the file (unless replaceAll is true).",
    "If oldString is empty and the file doesn't exist, the file is created with newString as content.",
    "Use this tool instead of write when you only need to change a few lines — it's safer and more precise.",
    "The tool reports whether the replacement succeeded and how many occurrences were replaced.",
  ].join("\n"),
  grep: [
    "Search file contents for a pattern using ripgrep (or grep as fallback).",
    "Returns matching lines with file paths and line numbers, capped at 200 matches and 20KB output.",
    "Use the optional path parameter to limit the search to a specific directory or file.",
    "Use the optional glob parameter to filter by file pattern (e.g., '*.ts', '*.{js,tsx}').",
    "Great for finding usages of a function, class, or string across the codebase.",
  ].join("\n"),
  glob: [
    "Find files matching a glob pattern in the project root.",
    "Returns up to 500 matching file paths, sorted by modification time (newest first).",
    "Use this tool to discover project structure, find configuration files, or locate specific file types.",
    "Patterns are relative to the project root. Common patterns: '**/*.test.ts', 'src/**/*.tsx', '*.json'.",
  ].join("\n"),
  task: [
    "Delegate a subtask to a specialized subagent with a specific role and capability set.",
    "Each subagent runs in its own context (fresh or forked) with a bounded number of turns.",
    "The role must be one of the exact names listed under AVAILABLE SUBAGENT ROLES in the system prompt (e.g., 'explore', 'build', 'reviewer').",
    "Capabilities must be a subset of the parent's allowed capabilities — escalation is blocked.",
    "Subagents can read, edit, execute commands, or delegate further (subject to depth limits).",
    "Results are returned as a summary with findings and artifacts.",
  ].join("\n"),
  web_search: [
    "Search the web for information using the model provider's native search capability.",
    "Returns AI-synthesized answers with source citations.",
    "Use for: looking up documentation, current events, API references, or any information not in the project files.",
    "Be specific in your query — include version numbers, dates, or context for better results.",
  ].join("\n"),
  web_fetch: [
    "Fetch and extract content from a URL.",
    "Returns the readable text content of the page (HTML is converted to markdown).",
    "Use the optional prompt parameter to focus extraction on specific information.",
    "Use for: reading documentation pages, API references, or any web content needed for the task.",
  ].join("\n"),
  skill: [
    "Load a skill's full instructions. Invoke when the current task matches a skill's description.",
    "Provide the skill name as listed in AVAILABLE SKILLS.",
    "The skill body is returned, which may contain file references relative to the skill's directory.",
  ].join("\n"),
  todo: [
    "Maintain the turn's task list. Rewrite the whole list each call.",
    "Exactly one item in_progress at a time. Use for tasks with 3+ steps.",
    "Items have status: pending, in_progress, or completed.",
    "The todo list is shown in the UI and helps track progress through complex tasks.",
  ].join("\n"),
};

export function getToolDescription(name: string): string {
  return TOOL_DESCRIPTIONS[name] ?? `Relay ${name} tool`;
}
