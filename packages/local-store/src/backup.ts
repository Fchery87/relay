/**
 * Local SQLite backup and restore for the daemon's execution state.
 *
 * Backups capture the complete SQLite/WAL store to a timestamped archive.
 * Restores validate the backup checksum before replacing the active database.
 */

import { copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, basename } from "node:path";

export type BackupManifest = {
  /** ISO timestamp of the backup. */
  readonly createdAt: string;
  /** SHA-256 of the backup archive. */
  readonly checksum: string;
  /** Absolute path to the backed-up database file. */
  readonly dbPath: string;
  /** Size in bytes at backup time. */
  readonly sizeBytes: number;
  /** Daemon version recorded at backup time. */
  readonly daemonVersion: string;
};

/**
 * Create a timestamped backup of the daemon-local SQLite database.
 * Writes the backup to `backups/` under `daemonHome` and returns a manifest.
 */
export async function backupLocalStore(params: {
  daemonHome: string;
  daemonVersion: string;
  /** Absolute path to the active SQLite database. */
  dbPath: string;
}): Promise<BackupManifest> {
  const backupsDir = join(params.daemonHome, "backups");
  await mkdir(backupsDir, { mode: 0o700, recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupName = `relay-kernel-${timestamp}.sqlite`;
  const backupPath = join(backupsDir, backupName);

  await copyFile(params.dbPath, backupPath);

  const { size } = await stat(backupPath);
  const content = await readFile(backupPath);
  const checksum = createHash("sha256").update(content).digest("hex");

  const manifest: BackupManifest = {
    createdAt: new Date().toISOString(),
    checksum,
    dbPath: backupPath,
    sizeBytes: size,
    daemonVersion: params.daemonVersion,
  };

  const manifestPath = join(backupsDir, `${backupName}.manifest.json`);
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });

  return manifest;
}

/**
 * Restore a backup into the active database path.
 * Validates the checksum before overwriting.
 */
export async function restoreLocalStore(params: {
  backupPath: string;
  checksum: string;
  /** Destination path for the restored database. */
  restoreToPath: string;
}): Promise<void> {
  const content = await readFile(params.backupPath);
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== params.checksum) {
    throw new Error(
      `Backup checksum mismatch: expected ${params.checksum}, got ${actual}`,
    );
  }

  const tmpPath = `${params.restoreToPath}.restore-${Date.now()}`;
  await writeFile(tmpPath, content, { mode: 0o600 });
  await rename(tmpPath, params.restoreToPath);
}

/**
 * Validate a backup without restoring.
 * Returns true if the backup is readable and the checksum matches.
 */
export async function validateBackup(params: {
  backupPath: string;
  checksum: string;
}): Promise<boolean> {
  try {
    const content = await readFile(params.backupPath);
    const actual = createHash("sha256").update(content).digest("hex");
    return actual === params.checksum;
  } catch {
    return false;
  }
}

/**
 * List all available backups in the daemon's backup directory.
 */
export async function listBackups(params: {
  daemonHome: string;
}): Promise<ReadonlyArray<BackupManifest>> {
  const backupsDir = join(params.daemonHome, "backups");
  try {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(backupsDir);
    const manifests: BackupManifest[] = [];
    for (const entry of entries) {
      if (entry.endsWith(".manifest.json")) {
        try {
          const content = await readFile(join(backupsDir, entry), "utf8");
          manifests.push(JSON.parse(content) as BackupManifest);
        } catch {
          // Skip corrupt manifests
        }
      }
    }
    return manifests;
  } catch {
    return [];
  }
}
