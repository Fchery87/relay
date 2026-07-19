import { Database } from "bun:sqlite";

// ---------------------------------------------------------------------------
// Migrations — embedded as TypeScript strings so compiled binaries have
// no dependency on loose migration files.
// ---------------------------------------------------------------------------

type Migration = {
  version: number;
  up: (db: Database) => void;
};

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version   INTEGER PRIMARY KEY,
          applied_at INTEGER NOT NULL
        );
      `);

      db.run(`
        CREATE TABLE IF NOT EXISTS run_snapshots (
          run_id         TEXT PRIMARY KEY,
          status         TEXT NOT NULL,
          sequence       INTEGER NOT NULL DEFAULT 0,
          stream_version INTEGER NOT NULL DEFAULT 0,
          payload_json   TEXT NOT NULL DEFAULT '{}',
          updated_at     INTEGER NOT NULL
        );
      `);

      db.run(`
        CREATE TABLE run_events (
          event_id        TEXT PRIMARY KEY,
          run_id          TEXT NOT NULL,
          sequence        INTEGER NOT NULL,
          stream_version  INTEGER NOT NULL,
          type            TEXT NOT NULL,
          payload_json    TEXT NOT NULL,
          correlation_id  TEXT NOT NULL,
          causation_id    TEXT,
          occurred_at     INTEGER NOT NULL,
          UNIQUE(run_id, stream_version)
        );
      `);
      db.run(`CREATE INDEX IF NOT EXISTS idx_run_events_run_seq ON run_events(run_id, sequence);`);

      db.run(`
        CREATE TABLE command_receipts (
          command_id    TEXT PRIMARY KEY,
          run_id        TEXT NOT NULL,
          completed_at  INTEGER NOT NULL,
          result_json   TEXT
        );
      `);

      db.run(`
        CREATE TABLE projection_outbox (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          event_id        TEXT NOT NULL,
          run_id          TEXT NOT NULL,
          sequence        INTEGER NOT NULL,
          type            TEXT NOT NULL,
          payload_json    TEXT NOT NULL,
          occurred_at     INTEGER NOT NULL,
          lease_owner     TEXT,
          lease_expires_at INTEGER,
          acknowledged    INTEGER NOT NULL DEFAULT 0,
          created_at      INTEGER NOT NULL
        );
      `);
      db.run(`CREATE INDEX IF NOT EXISTS idx_outbox_unacked ON projection_outbox(acknowledged, lease_expires_at);`);

      db.run(`
        CREATE TABLE provider_sessions (
          provider_instance_id TEXT NOT NULL,
          run_id               TEXT NOT NULL,
          provider_thread_id   TEXT,
          status               TEXT NOT NULL DEFAULT 'started',
          created_at           INTEGER NOT NULL,
          PRIMARY KEY (provider_instance_id, run_id)
        );
      `);

      db.run(`
        CREATE TABLE workspaces (
          run_id             TEXT PRIMARY KEY,
          repo_path          TEXT NOT NULL,
          worktree_path      TEXT NOT NULL,
          base_commit        TEXT NOT NULL DEFAULT '',
          permission_profile TEXT NOT NULL DEFAULT 'workspace-write',
          created_at         INTEGER NOT NULL
        );
      `);

      db.run(`
        CREATE TABLE leases (
          lease_key  TEXT PRIMARY KEY,
          owner      TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    up: (db) => {
      db.run(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          checkpoint_id TEXT PRIMARY KEY,
          run_id        TEXT NOT NULL,
          turn_id       TEXT NOT NULL,
          commit_sha    TEXT NOT NULL,
          ref           TEXT NOT NULL,
          created_at    INTEGER NOT NULL,
          gc            INTEGER NOT NULL DEFAULT 0
        );
      `);
      db.run(`CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints(run_id, turn_id);`);
    },
  },
  {
    version: 3,
    up: (db) => {
      db.run(`ALTER TABLE workspaces ADD COLUMN cleaned_up INTEGER DEFAULT NULL;`);
    },
  },
  {
    version: 4,
    up: (db) => {
      db.run(`ALTER TABLE run_events ADD COLUMN turn_id TEXT;`);
      db.run(`ALTER TABLE run_events ADD COLUMN provider_instance_id TEXT;`);
    },
  },
  {
    version: 5,
    up: (db) => {
      db.run(`
        CREATE TABLE effect_outbox (
          effect_id         TEXT PRIMARY KEY,
          run_id            TEXT NOT NULL,
          command_id        TEXT NOT NULL,
          effect_index      INTEGER NOT NULL,
          kind              TEXT NOT NULL,
          payload_json      TEXT NOT NULL,
          status            TEXT NOT NULL DEFAULT 'pending',
          attempts          INTEGER NOT NULL DEFAULT 0,
          retry_class       TEXT NOT NULL,
          lease_owner       TEXT,
          lease_expires_at  INTEGER,
          last_error        TEXT,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL,
          UNIQUE(command_id, effect_index)
        );
      `);
      db.run(`
        CREATE INDEX idx_effect_outbox_claim
        ON effect_outbox(status, lease_expires_at, created_at);
      `);
    },
  },
  {
    version: 6,
    up: (db) => {
      db.run(`
        CREATE TABLE run_turns (
          run_id     TEXT NOT NULL,
          turn_id    TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          PRIMARY KEY (run_id, turn_id)
        );
      `);
      db.run(`
        INSERT OR IGNORE INTO run_turns (run_id, turn_id, started_at)
        SELECT run_id, turn_id, MIN(occurred_at)
        FROM run_events
        WHERE type = 'turn.started' AND turn_id IS NOT NULL
        GROUP BY run_id, turn_id;
      `);
    },
  },
];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type StoreDatabase = Database;

/**
 * Open (or create) the kernel store database, applying any pending migrations.
 * Enables WAL journal mode and foreign keys.
 */
export function openStore(path: string): StoreDatabase {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/** Open an in-memory database (for tests). */
export function openMemoryStore(): StoreDatabase {
  const db = new Database(":memory:");
  db.run("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}

/** Apply pending migrations in a transaction. */
function migrate(db: Database): void {
  db.run(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version   INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );`,
  );

  const current = (
    db.query("SELECT MAX(version) AS v FROM schema_migrations").get() as
      | { v: number | null }
      | undefined
  )?.v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      m.up(db);
      db.run("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", [
        m.version,
        Date.now(),
      ]);
    })();
  }
}
