import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { ArtifactId, ArtifactMetadata, ArtifactWrite, EventId, RunId } from "@relay/contracts";
import type { StoreDatabase } from "./database";

const PREVIEW_BYTES = 512;
const HASH_RE = /^[a-f0-9]{64}$/;
type Row = { artifact_id: string; run_id: string; producing_event_id: string; media_type: string; byte_length: number; sha256: string; preview: string; storage_path: string; created_at: number };

export class ArtifactStore {
  constructor(private readonly db: StoreDatabase, private readonly root: string) {}
  async put(input: ArtifactWrite): Promise<ArtifactMetadata> {
    if (input.signal?.aborted) throw new DOMException("Artifact write cancelled", "AbortError");
    const hash = createHash("sha256").update(input.content).digest("hex");
    const existing = this.db.query("SELECT * FROM artifacts WHERE artifact_id = ?").get(hash) as Row | null;
    if (existing) {
      this.db.run("INSERT OR IGNORE INTO artifact_owners (artifact_id, run_id, producing_event_id, created_at) VALUES (?, ?, ?, ?)", [hash, input.runId as string, input.producingEventId as string, Date.now()]);
      return { ...toMetadata(existing), runId: input.runId, producingEventId: input.producingEventId };
    }
    const path = artifactPath(this.root, hash); await mkdir(join(this.root, hash.slice(0, 2)), { recursive: true });
    const temp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      await writeFile(temp, input.content, { flag: "wx" }); await rename(temp, path);
      const row = { artifactId: hash, runId: input.runId as string, producingEventId: input.producingEventId as string, mediaType: input.mediaType, byteLength: input.content.byteLength, sha256: hash, preview: preview(input.content), storagePath: path, createdAt: Date.now() };
      this.db.run("INSERT OR IGNORE INTO artifacts (artifact_id, run_id, producing_event_id, media_type, byte_length, sha256, preview, storage_path, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", Object.values(row));
      this.db.run("INSERT OR IGNORE INTO artifact_owners (artifact_id, run_id, producing_event_id, created_at) VALUES (?, ?, ?, ?)", [hash, input.runId as string, input.producingEventId as string, row.createdAt]);
      return toMetadata(this.db.query("SELECT * FROM artifacts WHERE artifact_id = ?").get(hash) as Row);
    } catch (error) { await rm(temp, { force: true }); throw error; }
  }
  async read(id: ArtifactId, signal?: AbortSignal): Promise<Uint8Array> { const row = this.row(id); if (signal?.aborted) throw new DOMException("Artifact read cancelled", "AbortError"); const bytes = new Uint8Array(await readFile(row.storage_path)); if (createHash("sha256").update(bytes).digest("hex") !== row.sha256) throw new Error("Artifact hash verification failed"); return bytes; }
  async readOwned(runId: RunId, id: ArtifactId, signal?: AbortSignal): Promise<Uint8Array> { if (!this.db.query("SELECT 1 FROM artifact_owners WHERE artifact_id = ? AND run_id = ? LIMIT 1").get(id, runId as string)) throw new Error("Artifact is not owned by run"); return this.read(id, signal); }
  list(runId: RunId, cursor = "", limit = 50): { items: ArtifactMetadata[]; nextCursor?: string } { if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("Invalid artifact page limit"); const rows = this.db.query("SELECT a.*, o.run_id AS owner_run_id, o.producing_event_id AS owner_event_id FROM artifact_owners o JOIN artifacts a ON a.artifact_id = o.artifact_id WHERE o.run_id = ? AND a.artifact_id > ? ORDER BY a.artifact_id LIMIT ?").all(runId as string, cursor, limit + 1) as (Row & { owner_run_id: string; owner_event_id: string })[]; const more = rows.length > limit; const items = (more ? rows.slice(0, limit) : rows).map(row => ({ ...toMetadata(row), runId: row.owner_run_id as RunId, producingEventId: row.owner_event_id as EventId })); return { items, ...(more ? { nextCursor: items.at(-1)!.artifactId } : {}) }; }
  private row(id: ArtifactId): Row { if (!HASH_RE.test(id)) throw new Error("Invalid artifact id"); const row = this.db.query("SELECT * FROM artifacts WHERE artifact_id = ?").get(id) as Row | null; if (!row) throw new Error("Artifact not found"); return row; }
}
function artifactPath(root: string, hash: string): string { const base = resolve(root); const path = resolve(base, hash.slice(0, 2), hash); if (!path.startsWith(base + sep)) throw new Error("Artifact path escaped root"); return path; }
function preview(content: Uint8Array): string { return Buffer.from(content.slice(0, PREVIEW_BYTES)).toString("utf8").replace(/[\u0000-\u001f\u007f]/g, " "); }
function toMetadata(row: Row): ArtifactMetadata { return { artifactId: row.artifact_id as ArtifactId, runId: row.run_id as RunId, producingEventId: row.producing_event_id as EventId, mediaType: row.media_type, byteLength: row.byte_length, sha256: row.sha256, preview: row.preview, available: true, createdAt: row.created_at }; }
