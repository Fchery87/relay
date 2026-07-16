import { expect, test, describe } from "bun:test";
import { openMemoryStore } from "@relay/local-store";
import { WorkspaceManager } from "./workspace-manager";
import { CheckpointManager } from "./checkpoint-manager";

describe("WorkspaceManager", () => {
  test("creates and retrieves a workspace record", () => {
    const db = openMemoryStore();
    const mgr = new WorkspaceManager(db);
    const record = mgr.create({
      runId: "run-1" as never,
      repoPath: "/tmp/repo",
      worktreePath: "/tmp/repo-wt",
      baseCommit: "abc123",
    });
    expect(`${record.runId}`).toBe("run-1");
    expect(record.permissionProfile).toBe("workspace-write");

    const loaded = mgr.get("run-1");
    expect(loaded?.repoPath).toBe("/tmp/repo");
  });

  test("marks workspace as cleaned up", () => {
    const db = openMemoryStore();
    const mgr = new WorkspaceManager(db);
    mgr.create({ runId: "run-1" as never, repoPath: "/x", worktreePath: "/x-wt", baseCommit: "deadbeef" });
    mgr.markCleanedUp("run-1");
    const r = mgr.get("run-1");
    expect(r?.cleanedUp).toBeTruthy();
  });

  test("reconcile returns active workspaces", () => {
    const db = openMemoryStore();
    const mgr = new WorkspaceManager(db);
    mgr.create({ runId: "run-1" as never, repoPath: "/a", worktreePath: "/a-wt", baseCommit: "111" });
    mgr.create({ runId: "run-2" as never, repoPath: "/b", worktreePath: "/b-wt", baseCommit: "222" });
    mgr.markCleanedUp("run-2");
    const reconciled = mgr.reconcile();
    expect(reconciled).toHaveLength(1); // run-2 is cleaned up
    expect(`${reconciled[0]!.record.runId}`).toBe("run-1");
  });
});

describe("CheckpointManager", () => {
  test("idempotent capture — same turn returns existing checkpoint", () => {
    const db = openMemoryStore();
    const mgr = new CheckpointManager(db);
    const c1 = mgr.capture({ runId: "run-1", turnId: "turn-1", commit: "abc", ref: "refs/relay/checkpoints/run-1/turn-1" });
    expect(c1.commit).toBe("abc");
    // Same turn, different commit — should return original (idempotent)
    const c2 = mgr.capture({ runId: "run-1", turnId: "turn-1", commit: "xyz", ref: "refs/relay/checkpoints/run-1/turn-1" });
    expect(c2.commit).toBe("abc");
    expect(c2.checkpointId).toBe(c1.checkpointId);
  });

  test("lists checkpoints ordered by creation", () => {
    const db = openMemoryStore();
    const mgr = new CheckpointManager(db);
    mgr.capture({ runId: "run-1", turnId: "turn-1", commit: "a", ref: "refs/relay/ck/a" });
    mgr.capture({ runId: "run-1", turnId: "turn-2", commit: "b", ref: "refs/relay/ck/b" });
    const list = mgr.list("run-1");
    expect(list).toHaveLength(2);
    expect(list[0]!.turnId).toBe("turn-1");
    expect(list[1]!.turnId).toBe("turn-2");
  });

  test("marks checkpoint for GC", () => {
    const db = openMemoryStore();
    const mgr = new CheckpointManager(db);
    const ck = mgr.capture({ runId: "run-1", turnId: "turn-1", commit: "abc", ref: "refs/relay/ck" });
    mgr.markGc(ck.checkpointId as string);
    const loaded = mgr.get(ck.checkpointId as string);
    expect(loaded?.gc).toBeTruthy();
  });

  test("restore returns the checkpoint record", () => {
    const db = openMemoryStore();
    const mgr = new CheckpointManager(db);
    const ck = mgr.capture({ runId: "run-1", turnId: "turn-1", commit: "abc", ref: "refs/relay/ck" });
    const restored = mgr.restore(ck.checkpointId as string);
    expect(restored?.commit).toBe("abc");
  });
});
