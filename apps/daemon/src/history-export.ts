import type { ArtifactMetadata, HistorySnapshot, OperatorInboxItem, RunSnapshot } from "@relay/contracts";

export type HandoffPackage = Readonly<{ schemaVersion: 1; snapshot: RunSnapshot; history: HistorySnapshot; artifacts: readonly ArtifactMetadata[]; unresolved: readonly OperatorInboxItem[]; exportedAt: number }>;
const SECRET = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|Bearer\s+[A-Za-z0-9._-]+)/g;
export function exportHandoff(input: Omit<HandoffPackage, "schemaVersion" | "exportedAt">): HandoffPackage {
  const clean = JSON.parse(JSON.stringify(input).replace(SECRET, "[REDACTED]")) as typeof input;
  return { schemaVersion: 1, ...clean, exportedAt: Date.now() };
}
