# Per-turn checkpointing and rollback

Type: grilling
Status: open

## Question

Claude Code checkpoints and Codex snapshots are table stakes in 2026. Worktrees make this cheap for Relay: should every agent turn snapshot the worktree (git commit/stash under a ref namespace), with one-click revert-to-turn in the UI? Decide the snapshot mechanism, retention, UX (revert vs restore-and-branch), and interaction with the diff-review flow.
