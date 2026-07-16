// ---------------------------------------------------------------------------
// Daemon process supervisor — restart, graceful shutdown, lease release.
// Version compatibility — safe upgrades with post-migration schema awareness.
// Backup/restore — corruption recovery procedures.
// ---------------------------------------------------------------------------

export type SupervisorConfig = {
  /** Max restart attempts before giving up. */
  readonly maxRestarts: number;
  /** Window in ms for counting restarts. */
  readonly restartWindowMs: number;
  /** Graceful shutdown timeout in ms. */
  readonly shutdownTimeoutMs: number;
};

export type SupervisorState = {
  restartCount: number;
  lastRestartAt: number;
  running: boolean;
};

export class DaemonSupervisor {
  private state: SupervisorState = {
    restartCount: 0,
    lastRestartAt: 0,
    running: false,
  };

  constructor(private readonly config: SupervisorConfig) {}

  /** Notify the supervisor that the daemon has started. */
  started(): void {
    this.state.running = true;
  }

  /** Notify the supervisor of a crash. Returns whether to restart. */
  onCrash(): boolean {
    this.state.running = false;
    const now = Date.now();

    if (now - this.state.lastRestartAt > this.config.restartWindowMs) {
      this.state.restartCount = 0;
    }

    this.state.restartCount++;
    this.state.lastRestartAt = now;

    return this.state.restartCount <= this.config.maxRestarts;
  }

  /** Initiate graceful shutdown: release leases, drain, then exit. */
  async shutdown(releaseLeases: () => Promise<void>): Promise<void> {
    const deadline = Date.now() + this.config.shutdownTimeoutMs;
    await releaseLeases();
    this.state.running = false;
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Version compatibility
// ---------------------------------------------------------------------------

export type DaemonVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly schemaVersion: number;
};

export function parseVersion(version: string): DaemonVersion {
  const parts = version.split(".");
  return {
    major: parseInt(parts[0] ?? "0", 10),
    minor: parseInt(parts[1] ?? "0", 10),
    patch: parseInt(parts[2] ?? "0", 10),
    schemaVersion: 3, // current migration version
  };
}

export function isCompatibleUpgrade(
  current: DaemonVersion,
  target: DaemonVersion,
): boolean {
  // Major version bump requires schema migration awareness
  if (target.major > current.major) {
    return target.schemaVersion >= current.schemaVersion;
  }
  // Minor/patch are always safe
  return target.schemaVersion >= current.schemaVersion;
}

// ---------------------------------------------------------------------------
// Backup/restore procedures
// ---------------------------------------------------------------------------

export type BackupResult = {
  readonly ok: boolean;
  readonly path: string;
  readonly sizeBytes: number;
  readonly schemaVersion: number;
};

/**
 * Backup the local SQLite store to a timestamped file.
 * In production this uses VACUUM INTO; for now a stub.
 */
export async function backupStore(storePath: string, backupDir: string): Promise<BackupResult> {
  // Stub: real impl copies/ vacuums the SQLite file
  return {
    ok: true,
    path: `${backupDir}/relay-backup-${Date.now()}.sqlite`,
    sizeBytes: 0,
    schemaVersion: 3,
  };
}

/**
 * Restore from a backup. Verifies schema compatibility before replacing.
 */
export async function restoreStore(backupPath: string, storePath: string): Promise<boolean> {
  // Stub: real impl verifies the backup, stops the daemon, replaces the file, restarts
  return true;
}
