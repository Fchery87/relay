/** A built-in command that expands to a prompt template and runs as a normal turn. */
export interface PromptBuiltinCommand {
  argumentHint?: string;
  description: string;
  kind: "prompt";
  name: string;
  template: string;
}

/** A built-in command handled by the daemon/web without a normal model turn. */
export interface ActionBuiltinCommand {
  action: "compact" | "context" | "rewind" | "plan" | "help";
  argumentHint?: string;
  description: string;
  kind: "action";
  name: string;
}

export type BuiltinCommand = PromptBuiltinCommand | ActionBuiltinCommand;

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  {
    description: "Scan the repo and create or refresh AGENTS.md with project conventions",
    kind: "prompt",
    name: "init",
    template: `Scan this repository (README, package.json, build scripts, configuration files, source structure) and create or refresh AGENTS.md.

Instructions:
- Keep AGENTS.md under 200 lines.
- Include only non-obvious facts that help future agents work in this project.
- Document: build/test commands, code conventions, architecture decisions, key patterns, and gotchas.
- If AGENTS.md already exists, suggest specific improvements — do not rewrite from scratch unless asked.
- If the user passed extra instructions, follow them: $ARGUMENTS`,
  },
  {
    description: "Review the current working diff for correctness and style",
    kind: "prompt",
    name: "review",
    template: `Review the current working diff. Run \`git diff\` and \`git diff --staged\` to see changes.

Report findings by severity:
- **Critical**: bugs, security issues, data loss risks
- **High**: logic errors, broken invariants, missing error handling
- **Medium**: style violations, unclear naming, missing tests
- **Low**: nitpicks, formatting, typos

For each finding include a \`file:line\` reference. Be constructive — suggest fixes, not just criticism.

$ARGUMENTS`,
  },
  {
    description: "Stage related changes and create a conventional commit",
    kind: "prompt",
    name: "commit",
    template: `Stage related changes and create a conventional commit.

Rules:
- Never use \`--force\` with git push.
- Never amend commits that belong to other authors.
- Write a conventional commit message: type(scope): description.
- Include the relevant file changes and a brief explanation of why.
- If there are unrelated changes, only stage what belongs together — suggest the user handle the rest separately.

$ARGUMENTS`,
  },
  {
    description: "Push the branch and open a PR with a change summary",
    kind: "prompt",
    name: "pr",
    template: `Push the current branch and open a pull request.

Steps:
1. Push the branch: \`git push -u origin HEAD\`
2. Collect the commit messages on this branch (vs. the base branch) and summarize the change.
3. Run \`gh pr create --title "<summary>" --body "<detailed body>"\` with the summary.

If \`gh\` is not installed or authenticated, tell the user and suggest they install it.

$ARGUMENTS`,
  },
  {
    description: "Detect and run the project's test suite, report failures",
    kind: "prompt",
    name: "test",
    template: `Detect the project's test runner from package.json or configuration files, then run the test suite.

Instructions:
- Look at package.json scripts, Makefile, or config files to determine the test command.
- Run the suite. If it passes, summarize the results.
- If there are failures, report each one with file:line and the error message.
- Only fix failures if the user explicitly asked you to. By default, just report.

$ARGUMENTS`,
  },
  {
    action: "compact",
    description: "Manually compact the conversation history",
    kind: "action",
    name: "compact",
  },
  {
    action: "context",
    description: "Report context usage breakdown",
    kind: "action",
    name: "context",
  },
  {
    action: "rewind",
    description: "Restore the latest checkpoint",
    kind: "action",
    name: "rewind",
  },
  {
    action: "plan",
    description: "Switch the thread to planning mode",
    kind: "action",
    name: "plan",
  },
  {
    action: "help",
    argumentHint: "[command]",
    description: "List all available commands with descriptions",
    kind: "action",
    name: "help",
  },
];

export function getBuiltinCommand(name: string): BuiltinCommand | undefined {
  return BUILTIN_COMMANDS.find((c) => c.name === name);
}

export function isBuiltinCommand(name: string): boolean {
  return BUILTIN_COMMANDS.some((c) => c.name === name);
}
