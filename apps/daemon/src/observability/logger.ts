import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
export type LogRecord = Readonly<{ level: "debug" | "info" | "warn" | "error"; message: string; correlationId?: string; causationId?: string; timestamp: number }>;
export class NdjsonLogger { constructor(private readonly path: string) {} async write(record: Omit<LogRecord, "timestamp">): Promise<void> { await mkdir(dirname(this.path), { recursive: true }); const safe = { ...record, message: record.message.replace(/(sk-|ghp_|Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[REDACTED]"), timestamp: Date.now() }; await appendFile(this.path, `${JSON.stringify(safe)}\n`); } }
