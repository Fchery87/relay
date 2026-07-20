export type RetentionPolicy = Readonly<{ terminalEventMs: number; diagnosticsMs: number; acknowledgedOutboxMs: number }>;
export const DEFAULT_RETENTION: RetentionPolicy = { terminalEventMs: 90 * 86_400_000, diagnosticsMs: 30 * 86_400_000, acknowledgedOutboxMs: 7 * 86_400_000 };
export function validateRetention(policy: RetentionPolicy): void { for (const [name, value] of Object.entries(policy)) if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid retention ${name}`); }
