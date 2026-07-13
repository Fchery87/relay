import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type GitResult = { exitCode: number; stderr: string; stdout: string };

async function runGit({ args, env, root }: { args: string[]; env?: Record<string, string>; root: string }): Promise<GitResult> {
  const process = Bun.spawn(["git", ...args], {
    cwd: root,
    env: { ...Bun.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  return { exitCode, stderr, stdout };
}

async function requireGit(input: Parameters<typeof runGit>[0]): Promise<string> {
  const result = await runGit(input);
  if (result.exitCode !== 0) throw new Error(`Git checkpoint operation failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function checkpointRef({ threadId, turnId }: { threadId: string; turnId: string }): string {
  assertRefSegment(threadId);
  assertRefSegment(turnId);
  return `refs/relay/checkpoints/${threadId}/${turnId}`;
}

function assertRefSegment(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) || value.includes("..")) throw new Error("Invalid checkpoint identifier");
}

export async function createCheckpoint({ root, threadId, turnId }: { root: string; threadId: string; turnId: string }): Promise<{ commit: string; ref: string }> {
  const directory = await mkdtemp(join(tmpdir(), "relay-checkpoint-index-"));
  const indexPath = join(directory, "index");
  const env = { GIT_INDEX_FILE: indexPath };
  const ref = checkpointRef({ threadId, turnId });
  try {
    await requireGit({ args: ["read-tree", "HEAD"], env, root });
    await requireGit({ args: ["add", "-A"], env, root });
    const tree = await requireGit({ args: ["write-tree"], env, root });
    const parent = await requireGit({ args: ["rev-parse", "HEAD"], root });
    const commit = await requireGit({ args: ["-c", "user.name=Relay", "-c", "user.email=relay@localhost", "commit-tree", tree, "-p", parent, "-m", `Relay checkpoint ${turnId}`], root });
    await requireGit({ args: ["update-ref", ref, commit], root });
    return { commit, ref };
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

export async function restoreCheckpoint({ commit, root }: { commit: string; root: string }): Promise<void> {
  await requireGit({ args: ["cat-file", "-e", `${commit}^{commit}`], root });
  await requireGit({ args: ["read-tree", "--reset", "-u", commit], root });
  await requireGit({ args: ["clean", "-fd"], root });
  await requireGit({ args: ["reset", "--mixed", "HEAD"], root });
}

export async function diffCheckpoints({ fromCommit, root, toCommit }: { fromCommit: string; root: string; toCommit: string }): Promise<string> {
  await requireGit({ args: ["cat-file", "-e", `${fromCommit}^{commit}`], root });
  await requireGit({ args: ["cat-file", "-e", `${toCommit}^{commit}`], root });
  const result = await runGit({ args: ["diff", "--no-ext-diff", fromCommit, toCommit], root });
  if (result.exitCode !== 0) throw new Error(`Git checkpoint operation failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export async function deleteCheckpointNamespace({ root, threadId }: { root: string; threadId: string }): Promise<void> {
  assertRefSegment(threadId);
  const refs = await requireGit({ args: ["for-each-ref", "--format=%(refname)", `refs/relay/checkpoints/${threadId}/`], root });
  for (const ref of refs.split("\n").filter(Boolean)) await requireGit({ args: ["update-ref", "-d", ref], root });
}
