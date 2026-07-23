import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createDiagnosticExport } from "./diagnostics";
import { openMemoryStore } from "./database";
import { enforceRetention, type RetentionPolicy } from "./retention";

const POLICY: RetentionPolicy = {
  terminalEventMs: 100,
  diagnosticsMs: 100,
  acknowledgedOutboxMs: 100,
  checkpointMs: 100,
  historySnapshotMs: 100,
  quarantinedEventMs: 100,
};

describe("local-store operations", () => {
  test("exports bounded anonymized diagnostics without persisted payloads or raw IDs", () => {
    const db = openMemoryStore();
    db.run("INSERT INTO run_snapshots (run_id,status,sequence,stream_version,payload_json,updated_at) VALUES (?,?,?,?,?,?)", [
      "run-secret-123", "failed", 2, 2, JSON.stringify({ runId: "run-secret-123", prompt: "private" }), 900,
    ]);
    db.run("INSERT INTO run_events (event_id,run_id,sequence,stream_version,type,payload_json,correlation_id,occurred_at) VALUES (?,?,?,?,?,?,?,?)", [
      "event-secret-123", "run-secret-123", 1, 1, "run.created", JSON.stringify({ apiKey: "sk-abcdefghijklmnopqrstuvwxyz" }), "corr-secret", 800,
    ]);
    db.run("INSERT INTO run_diagnostics (diagnostic_id,run_id,kind,message,created_at) VALUES (?,?,?,?,?)", [
      "diag-secret-123", "run-secret-123", "persisted_record_corrupt", "failed at /home/user/project with sk-abcdefghijklmnopqrstuvwxyz", 900,
    ]);

    const report = createDiagnosticExport(db, { now: 1_000, exportId: "export-1" });
    const serialized = JSON.stringify(report);
    expect(report.redaction).toBe("anonymized-v1");
    expect(report.runs.items[0]).toMatchObject({ status: "failed", eventCount: 1 });
    expect(report.runs.items[0]?.id).not.toContain("run-secret-123");
    expect(serialized).not.toContain("run-secret-123");
    expect(serialized).not.toContain("event-secret-123");
    expect(serialized).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(serialized).not.toContain("/home/user/project");
    expect(report.diagnostics[0]?.message).toContain("[PATH]");
    db.close();
  });

  test("retains active and unacknowledged work while pruning terminal history", () => {
    const db = openMemoryStore();
    const now = 1_000;
    db.run("INSERT INTO run_snapshots (run_id,status,sequence,stream_version,payload_json,updated_at) VALUES (?,?,?,?,?,?)", [
      "terminal", "completed", 2, 2, JSON.stringify({ runId: "terminal", status: "completed" }), 700,
    ]);
    db.run("INSERT INTO run_snapshots (run_id,status,sequence,stream_version,payload_json,updated_at) VALUES (?,?,?,?,?,?)", [
      "active", "running", 1, 1, JSON.stringify({ runId: "active", status: "running" }), 700,
    ]);
    for (const [eventId, runId, sequence, streamVersion, occurredAt] of [["old-terminal", "terminal", 1, 1, 700], ["old-active", "active", 1, 1, 700], ["unacked-terminal", "terminal", 2, 2, 700]] as const) {
      db.run("INSERT INTO run_events (event_id,run_id,sequence,stream_version,type,payload_json,correlation_id,occurred_at) VALUES (?,?,?,?,?,?,?,?)", [eventId, runId, sequence, streamVersion, "run.started", "{}", `corr-${eventId}`, occurredAt]);
    }
    db.run("INSERT INTO projection_outbox (event_id,run_id,sequence,type,payload_json,occurred_at,acknowledged,created_at) VALUES (?,?,?,?,?,?,?,?)", ["old-terminal", "terminal", 1, "run.started", "{}", 700, 1, 700]);
    db.run("INSERT INTO projection_outbox (event_id,run_id,sequence,type,payload_json,occurred_at,acknowledged,created_at) VALUES (?,?,?,?,?,?,?,?)", ["old-active", "active", 1, "run.started", "{}", 700, 1, 700]);
    db.run("INSERT INTO projection_outbox (event_id,run_id,sequence,type,payload_json,occurred_at,acknowledged,created_at) VALUES (?,?,?,?,?,?,?,?)", ["unacked-terminal", "terminal", 2, "run.started", "{}", 700, 0, 700]);
    db.run("INSERT INTO run_diagnostics (diagnostic_id,run_id,kind,message,created_at) VALUES (?,?,?,?,?)", ["old-diag", "terminal", "persisted_record_corrupt", "old", 700]);
    db.run("INSERT INTO checkpoints (checkpoint_id,run_id,turn_id,commit_sha,ref,created_at,gc) VALUES (?,?,?,?,?,?,?)", ["checkpoint-1", "terminal", "turn-1", "abc", "refs/relay/checkpoint-1", 700, 0]);
    db.run("INSERT INTO checkpoints (checkpoint_id,run_id,turn_id,commit_sha,ref,created_at,gc) VALUES (?,?,?,?,?,?,?)", ["checkpoint-gc", "terminal", "turn-0", "def", "refs/relay/checkpoint-gc", 700, 1]);
    const historyHash = createHash("sha256").update("{}").digest("hex");
    db.run("INSERT INTO history_snapshots (run_id,through_sequence,hash,payload_json,created_at) VALUES (?,?,?,?,?)", ["terminal", 1, historyHash, "{}", 700]);
    db.run("INSERT INTO history_snapshots (run_id,through_sequence,hash,payload_json,created_at) VALUES (?,?,?,?,?)", ["terminal", 2, historyHash, "{}", 900]);
    db.run("INSERT INTO quarantined_run_events (event_id,run_id,sequence,stream_version,type,payload_json,correlation_id,occurred_at,diagnostic_id,quarantined_at) VALUES (?,?,?,?,?,?,?,?,?,?)", ["quarantined-1", "terminal", 1, 1, "run.started", "{}", "corr", 700, "diag", 700]);

    const first = enforceRetention(db, { now, policy: POLICY });
    expect(first.deletedEvents).toBe(1);
    expect(first.deletedCheckpoints).toBe(1);
    expect(db.query("SELECT event_id FROM run_events ORDER BY event_id").all()).toEqual([
      { event_id: "old-active" },
      { event_id: "unacked-terminal" },
    ]);
    expect((db.query("SELECT COUNT(*) AS count FROM run_diagnostics").get() as { count: number }).count).toBe(0);

    db.run("INSERT INTO checkpoints (checkpoint_id,run_id,turn_id,commit_sha,ref,created_at,gc) VALUES (?,?,?,?,?,?,?)", ["checkpoint-gc-2", "terminal", "turn-0", "ghi", "refs/relay/checkpoint-gc-2", 700, 1]);
    const second = enforceRetention(db, { now, policy: POLICY });
    expect(second.deletedCheckpoints).toBe(1);
    expect((db.query("SELECT COUNT(*) AS count FROM history_snapshots WHERE through_sequence = 1").get() as { count: number }).count).toBe(0);
    expect((db.query("SELECT COUNT(*) AS count FROM quarantined_run_events").get() as { count: number }).count).toBe(0);
    db.close();
  });
});
