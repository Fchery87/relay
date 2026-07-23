# Local-store maintenance

The daemon's SQLite execution store has two bounded operator surfaces:

- `createDiagnosticExport` / `writeDiagnosticExport` in `@relay/local-store`
  produce an anonymized, payload-free state dump. Run, event, and diagnostic
  identifiers are not exported verbatim; diagnostic messages are secret- and
  path-redacted, and the file is written with mode `0600`.
- `enforceRetention` applies the default retention policy transactionally.
  Terminal event history and acknowledged outbox rows may be pruned, active
  runs and unacknowledged outbox rows are retained, and superseded history
  snapshots are removed. Checkpoint rows are removed only after their `gc`
  marker has already been set by workspace/ref cleanup. Retention never marks
  a live Git ref as collectible; callers use `markCheckpointForGc` only after
  the ref has been removed.

The kernel daemon runs maintenance on its periodic health interval. It reports
database size and retention activity in the local structured health log. A
vacuum is performed when the configured storage-pressure warning or critical
threshold is reached (or when explicitly requested by the API).

The default windows are 90 days for terminal events and checkpoints, 30 days
for diagnostics, history snapshots, and quarantined events, and 7 days for
acknowledged projection outbox rows. These are local-store policy defaults,
not a replacement for any hosted audit-retention requirement. Event pruning
also requires a valid, hash-verified history snapshot covering the run's final
sequence. `VACUUM` is explicit (`vacuum: true`) so a heartbeat never blocks on
a full-database rewrite; the daemon's periodic pass performs bounded retention
and reports pressure, while operators can compact during a maintenance window.
When filesystem free space falls below the recovery reserve, the kernel pauses
new command claims until space is available; existing claimed work is allowed
to converge or fail through its normal lease path.
