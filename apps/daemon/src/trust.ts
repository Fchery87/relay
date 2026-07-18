import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type TrustDecision = "trusted" | "untrusted";
export type TrustState = TrustDecision | "unknown";

interface TrustRecord {
  decision: TrustDecision;
  decidedAt: number;
}

export class TrustStore {
  #daemonHome: string;
  #cache: Map<string, TrustState> | null = null;

  constructor({ daemonHome }: { daemonHome: string }) {
    this.#daemonHome = daemonHome;
  }

  async get(projectPath: string): Promise<TrustState> {
    const records = await this.#load();
    this.#cache = new Map(Object.entries(records).map(([path, rec]) => [path, rec.decision as TrustState]));
    return this.#cache.get(projectPath) ?? "unknown";
  }

  async set(projectPath: string, decision: TrustDecision): Promise<void> {
    const records = await this.#load();
    records[projectPath] = { decision, decidedAt: Date.now() };
    await this.#save(records);
    if (this.#cache) this.#cache.set(projectPath, decision);
  }

  #filePath(): string {
    return join(this.#daemonHome, "trust.json");
  }

  async #load(): Promise<Record<string, TrustRecord>> {
    try {
      const raw = await readFile(this.#filePath(), "utf8");
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }

  async #save(records: Record<string, TrustRecord>): Promise<void> {
    const tmp = join(this.#daemonHome, `trust.${randomUUID()}.tmp`);
    await writeFile(tmp, JSON.stringify(records), { mode: 0o600 });
    await rename(tmp, this.#filePath());
  }
}
