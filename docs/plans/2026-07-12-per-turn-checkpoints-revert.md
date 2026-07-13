# Per-turn Checkpoints and Revert

## Scope

Every agent turn that executes an edit or shell tool captures the resulting worktree in a hidden Git ref. Users can restore a checkpoint from the message timeline and compare any two retained checkpoints. Thread garbage collection deletes the thread's checkpoint ref namespace.

## Git model

- Checkpoints live at `refs/relay/checkpoints/<thread>/<assistant-message>`.
- Snapshotting uses a temporary Git index, `write-tree`, and `commit-tree`; detached `HEAD` and the worktree's real index do not move.
- Restore loads the selected commit tree into the worktree, removes later untracked files, then resets the index to `HEAD`. Later checkpoint refs remain intact.
- Comparisons use `git diff <from-commit> <to-commit>` and never mutate the worktree.

## Coordination

- Enqueueing a restore transactionally moves the thread to `restoring`.
- Conversation, command, and Git-action claims refuse restoring threads. New messages remain queued without changing the restore lease.
- Restore actions have expiring leases so another daemon poll can reclaim work after a crash.
- Completion is device-scoped, records `checkpoint.reverted`, refreshes the cumulative diff, and returns the thread to `queued` when a message arrived during restore.
- Mutated turns checkpoint in a finalizer, including Stop, provider errors, missing usage, and usage persistence failures.

## Persistence and UI

Convex stores checkpoint-to-message metadata, restore actions, comparison actions, and timeline events. Assistant messages with checkpoints expose a Restore command. The Changes section can compare any two turns and return to the current cumulative diff. Thread deletion cascades checkpoint records and actions; daemon worktree GC deletes the Git ref namespace.

## Verification

- Git tests cover tracked/untracked capture, detached-HEAD preservation, restore, retained later refs, comparisons, and namespace GC.
- Convex tests cover machine ownership, restore serialization, stale lease reclaim, queued-message behavior, scoped completion, event recording, comparisons, and deletion cleanup.
- Daemon tests cover successful, stopped, and failed mutating turns plus restore/comparison workers.
- A Convex-backed end-to-end test runs an agent edit, records a checkpoint, enqueues and claims restore, restores the file, snapshots the diff, and records the timeline event.
