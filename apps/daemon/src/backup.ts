import { join } from "node:path";
import { backupStore, restoreStore, type BackupResult } from "@relay/local-store";
export { backupStore, restoreStore }; export type { BackupResult };
export async function backupDaemonStore(daemonHome: string, backupDir?: string): Promise<BackupResult> {
  return backupStore(join(daemonHome, "relay-kernel.sqlite"), backupDir ?? join(daemonHome, "backups"));
}
export async function restoreDaemonStore(backupPath: string, daemonHome: string): Promise<boolean> {
  return restoreStore(backupPath, join(daemonHome, "relay-kernel.sqlite"));
}
