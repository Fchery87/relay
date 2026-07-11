async function runGit({ args, root }: { args: string[]; root: string }) {
  const process = Bun.spawn(["git", ...args], { cwd: root, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stderr, stdout };
}

export async function computeDiff({ root, startCommit }: { root: string; startCommit: string }): Promise<string> {
  const result = await runGit({ args: ["diff", "--no-ext-diff", startCommit], root });
  if (result.exitCode !== 0) throw new Error(`Failed to compute diff: ${result.stderr}`);
  const untracked = await runGit({ args: ["ls-files", "--others", "--exclude-standard", "-z"], root });
  if (untracked.exitCode !== 0) throw new Error(`Failed to list untracked files: ${untracked.stderr}`);

  const additions: string[] = [];
  for (const path of untracked.stdout.split("\0").filter(Boolean)) {
    const addition = await runGit({ args: ["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", path], root });
    if (addition.exitCode !== 0 && addition.exitCode !== 1) throw new Error(`Failed to diff untracked file: ${addition.stderr}`);
    additions.push(addition.stdout);
  }
  return [result.stdout, ...additions].filter(Boolean).join("\n");
}

export async function stageAll({ root }: { root: string }): Promise<void> {
  const result = await runGit({ args: ["add", "-A"], root });
  if (result.exitCode !== 0) throw new Error(`Failed to stage files: ${result.stderr}`);
}

export async function commitChanges({ message, root }: { message: string; root: string }): Promise<string> {
  const result = await runGit({ args: ["commit", "-m", message], root });
  if (result.exitCode !== 0) throw new Error(`Failed to commit: ${result.stderr}`);
  return (await runGit({ args: ["rev-parse", "HEAD"], root })).stdout.trim();
}

export async function pushChanges({ root }: { root: string }): Promise<void> {
  const result = await runGit({ args: ["push"], root });
  if (result.exitCode !== 0) throw new Error(`Failed to push: ${result.stderr}`);
}
