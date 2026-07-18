export type GitPreview = {
  action: "stage" | "commit" | "push";
  repoPath: string;
  head: string;
  branch: string;
  porcelain: string;
  stateHash: string;
  createdAt: number;
  expiresAt: number;
};

async function runGit({ args, root }: { args: string[]; root: string }) {
  const process = Bun.spawn(["git", ...args], { cwd: root, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stderr, stdout };
}

async function sha256Hex(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compute an authoritative preview of the worktree state for a pending Git action. */
export async function computeGitPreview({ action, root }: { action: "stage" | "commit" | "push"; root: string }): Promise<GitPreview> {
  const [headResult, branchResult, porcelainResult] = await Promise.all([
    runGit({ args: ["rev-parse", "HEAD"], root }),
    runGit({ args: ["rev-parse", "--abbrev-ref", "HEAD"], root }),
    runGit({ args: ["status", "--porcelain"], root }),
  ]);
  const head = headResult.exitCode === 0 ? headResult.stdout.trim() : "unborn";
  const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : "HEAD";
  const porcelain = porcelainResult.exitCode === 0 ? porcelainResult.stdout : "";
  const raw = [action, root, head, branch, porcelain].join("|");
  const stateHash = await sha256Hex(raw);
  const createdAt = Date.now();
  return { action, repoPath: root, head, branch, porcelain, stateHash, createdAt, expiresAt: createdAt + 60_000 };
}

/** Verify the live worktree still matches the preview. Rejects if stale, mismatched, or expired. */
export async function verifyGitPreview(preview: GitPreview): Promise<boolean> {
  if (Date.now() > preview.expiresAt) throw new Error("Git preview expired");
  const fresh = await computeGitPreview({ action: preview.action, root: preview.repoPath });
  if (fresh.stateHash !== preview.stateHash) throw new Error("Git state changed since preview — action rejected");
  return true;
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
