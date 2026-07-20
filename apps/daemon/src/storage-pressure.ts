export type StoragePressure = Readonly<{ freeBytes: number; totalBytes: number; activeRecoveryBytes: number }>;
export function storageAdmission(input: StoragePressure): { allowMutation: boolean; reason?: string } { if (input.freeBytes < Math.max(256 * 1024 * 1024, input.activeRecoveryBytes * 2)) return { allowMutation: false, reason: "storage_pressure" }; return { allowMutation: true }; }
