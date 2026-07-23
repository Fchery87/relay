import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
export type LogRecord = Readonly<{ level: "debug" | "info" | "warn" | "error"; message: string; correlationId?: string; causationId?: string; timestamp: number }>;

// Provider API keys (sk-*, ghp_*, Bearer tokens), self-hosted Convex admin
// keys (`convex-self-hosted|<hex>`), and any structured field whose *name*
// signals a secret (deviceToken, instanceSecret, adminKey, ...) regardless
// of that field's value format — device tokens and instance secrets have no
// distinguishing prefix, so redacting by key name is the only reliable
// catch-all for them.
const KNOWN_SECRET_PATTERN = /(sk-|ghp_|Bearer\s+|convex-self-hosted\|)[A-Za-z0-9._|-]+/gi;
const NAMED_SECRET_FIELD_PATTERN = /((?:device[_-]?token|instance[_-]?secret|admin[_-]?key|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi;

export function redactSecrets(message: string): string {
  return message
    .replace(KNOWN_SECRET_PATTERN, "$1[REDACTED]")
    .replace(NAMED_SECRET_FIELD_PATTERN, "$1[REDACTED]");
}

export class NdjsonLogger { constructor(private readonly path: string) {} async write(record: Omit<LogRecord, "timestamp">): Promise<void> { await mkdir(dirname(this.path), { recursive: true }); const safe = { ...record, message: redactSecrets(record.message), timestamp: Date.now() }; await appendFile(this.path, `${JSON.stringify(safe)}\n`); } }
