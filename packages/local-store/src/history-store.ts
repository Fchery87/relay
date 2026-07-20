import { createHash } from "node:crypto";
import type { HistorySnapshot } from "@relay/contracts";
import type { RunId } from "@relay/contracts";
import type { StoreDatabase } from "./database";

export class HistoryStore {
  constructor(private readonly db: StoreDatabase) {}
  save(snapshot: HistorySnapshot): string {
    const json = JSON.stringify(snapshot); const hash = createHash("sha256").update(json).digest("hex");
    this.db.run("INSERT INTO history_snapshots (run_id, through_sequence, hash, payload_json, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, through_sequence) DO UPDATE SET hash=excluded.hash, payload_json=excluded.payload_json", [snapshot.runId as string, snapshot.throughSequence, hash, json, Date.now()]);
    return hash;
  }
  latest(runId: RunId): { snapshot: HistorySnapshot; hash: string } | undefined {
    const row = this.db.query("SELECT payload_json, hash FROM history_snapshots WHERE run_id = ? ORDER BY through_sequence DESC LIMIT 1").get(runId as string) as { payload_json: string; hash: string } | null;
    if (!row) return undefined; const hash = createHash("sha256").update(row.payload_json).digest("hex"); if (hash !== row.hash) throw new Error("History snapshot hash mismatch"); return { snapshot: JSON.parse(row.payload_json), hash };
  }
}
