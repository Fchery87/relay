import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { runCommand } from "./tools";
import { createCheckpoint, deleteCheckpointNamespace } from "./checkpoints";

export async function assertGitAvailable(): Promise<void> {
  const result = await runCommand({ command: "git --version", platform: process.platform === "win32" ? "win32" : "linux", root: process.cwd() });
  if (result.exitCode !== 0) throw new Error("Relay requires git on PATH");
}

export async function createThreadWorktree({ daemonHome, repoPath, threadId }: { daemonHome: string; repoPath: string; threadId: string }): Promise<string> {
  await assertGitAvailable();
  const parent = join(daemonHome, "worktrees");
  const target = join(parent, threadId);
  await mkdir(parent, { recursive: true });
  const result = await runCommand({ command: `git worktree add --detach ${JSON.stringify(target)} HEAD`, platform: process.platform === "win32" ? "win32" : "linux", root: repoPath });
  if (result.exitCode !== 0) throw new Error(`Failed to create worktree: ${result.stderr}`);
  return target;
}

export async function createNestedSubagentWorktree({ daemonHome, parentRoot, runId, threadId }: { daemonHome: string; parentRoot: string; runId: string; threadId: string }): Promise<string> {
  await assertGitAvailable();
  const snapshot = await createCheckpoint({ root: parentRoot, threadId, turnId: `subagent-${runId}` });
  const parent = join(daemonHome, "subagents", threadId);
  const target = join(parent, runId);
  await mkdir(parent, { recursive: true });
  const result = await runCommand({ command: `git worktree add --detach ${JSON.stringify(target)} ${snapshot.commit}`, platform: process.platform === "win32" ? "win32" : "linux", root: parentRoot });
  if (result.exitCode !== 0) throw new Error(`Failed to create subagent worktree: ${result.stderr}`);
  return target;
}

export async function integrateNestedSubagentWorktree({ daemonHome, parentRoot, runId, threadId, writerRoot }: { daemonHome: string; parentRoot: string; runId: string; threadId: string; writerRoot: string }): Promise<string | null> {
  const completed = await createCheckpoint({ root: writerRoot, threadId, turnId: `subagent-result-${runId}` });
  const diff = await runCommand({ command: `git diff --binary HEAD ${completed.commit}`, platform: process.platform === "win32" ? "win32" : "linux", root: writerRoot });
  if (diff.exitCode !== 0) throw new Error(`Failed to collect subagent changes: ${diff.stderr}`);
  if (!diff.stdout.trim()) return null;
  const directory = join(daemonHome, "artifacts");
  const patchPath = join(directory, `${runId}.patch`);
  await mkdir(directory, { recursive: true });
  await writeFile(patchPath, diff.stdout, "utf8");
  const applied = await runCommand({ command: `git apply --whitespace=nowarn ${JSON.stringify(patchPath)}`, platform: process.platform === "win32" ? "win32" : "linux", root: parentRoot });
  if (applied.exitCode !== 0) throw new Error(`Failed to apply subagent changes: ${applied.stderr}`);
  return `relay-artifacts/${runId}.patch`;
}

export async function resolveSubagentParentRoot({ daemonHome, fallbackRoot, parentRunId, threadId }: { daemonHome: string; fallbackRoot: string; parentRunId?: string; threadId: string }): Promise<string> {
  if (!parentRunId) return fallbackRoot;
  const candidate = join(daemonHome, "subagents", threadId, parentRunId);
  try { await access(candidate); return candidate; } catch { return fallbackRoot; }
}

export async function removeThreadWorktree({ repoPath, worktreePath }: { repoPath: string; worktreePath: string }): Promise<void> {
  const result = await runCommand({ command: `git worktree remove --force ${JSON.stringify(worktreePath)}`, platform: process.platform === "win32" ? "win32" : "linux", root: repoPath });
  if (result.exitCode !== 0) throw new Error(`Failed to remove worktree: ${result.stderr}`);
}

export class ThreadWorktrees {
  readonly #daemonHome: string;
  readonly #entries = new Map<string, { repoPath: string; worktreePath: string }>();
  #loaded = false;

  constructor({ daemonHome }: { daemonHome: string }) { this.#daemonHome = daemonHome; }

  async resolve({ repoPath, threadId }: { repoPath: string; threadId: string }): Promise<string> {
    await this.#load();
    const existing = this.#entries.get(threadId);
    if (existing) return existing.worktreePath;
    const created = await createThreadWorktree({ daemonHome: this.#daemonHome, repoPath, threadId });
    this.#entries.set(threadId, { repoPath, worktreePath: created });
    await this.#save();
    return created;
  }

  async threadIds(): Promise<string[]> {
    await this.#load();
    return [...this.#entries.keys()];
  }

  async gc({ activeThreadIds }: { activeThreadIds: ReadonlySet<string> }): Promise<void> {
    await this.#load();
    for (const [threadId, entry] of this.#entries) {
      if (activeThreadIds.has(threadId)) continue;
      const subagentRoot = join(this.#daemonHome, "subagents", threadId);
      try {
        for (const runId of await readdir(subagentRoot)) await removeThreadWorktree({ repoPath: entry.repoPath, worktreePath: join(subagentRoot, runId) });
        await rm(subagentRoot, { force: true, recursive: true });
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      }
      await deleteCheckpointNamespace({ root: entry.worktreePath, threadId });
      await removeThreadWorktree(entry);
      this.#entries.delete(threadId);
    }
    await this.#save();
  }

  async #load(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const raw: unknown = JSON.parse(await readFile(join(this.#daemonHome, "worktrees.json"), "utf8"));
      if (Array.isArray(raw)) for (const entry of raw) {
        if (typeof entry === "object" && entry && "threadId" in entry && "repoPath" in entry && "worktreePath" in entry && typeof entry.threadId === "string" && typeof entry.repoPath === "string" && typeof entry.worktreePath === "string") this.#entries.set(entry.threadId, { repoPath: entry.repoPath, worktreePath: entry.worktreePath });
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
    }
  }

  async #save(): Promise<void> {
    await mkdir(this.#daemonHome, { recursive: true });
    const entries = [...this.#entries].map(([threadId, entry]) => ({ threadId, ...entry }));
    await writeFile(join(this.#daemonHome, "worktrees.json"), JSON.stringify(entries), "utf8");
  }
}
