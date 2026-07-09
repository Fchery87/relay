# Per-turn checkpointing and rollback

Type: grilling
Status: resolved

## Question

Claude Code checkpoints and Codex snapshots are table stakes in 2026. Worktrees make this cheap for Relay: should every agent turn snapshot the worktree (git commit/stash under a ref namespace), with one-click revert-to-turn in the UI? Decide the snapshot mechanism, retention, UX (revert vs restore-and-branch), and interaction with the diff-review flow.

## Answer

Ref-namespace commits (approved 2026-07-09). After every mutating turn the daemon commits worktree state to `refs/relay/checkpoints/<thread>/<turn>` — invisible to normal branch listings; the worktree stays detached-HEAD. Revert-to-turn from the thread timeline restores the files and records a checkpoint-revert event; reverting is a restore, not a destroy — later checkpoints remain until thread GC, when the whole ref namespace is deleted. The diff view can diff any two checkpoints, and the thread's cumulative diff remains against the starting commit.
