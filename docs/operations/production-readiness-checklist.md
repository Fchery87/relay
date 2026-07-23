# Production readiness checklist

- [x] Pair browser and daemon; verify owner/machine/project authorization (real isolated cross-tier fixture and Convex owner-isolation tests).
- [ ] Run two isolated runs and confirm no cross-run events or artifacts (repeat in the supervised hosted acceptance profile).
- [x] Exercise steering, approval allow/deny, checkpoint capture/restore, stale cursor recovery (kernel control/checkpoint tests and live seam evidence).
- [ ] Exercise provider and daemon restart during start, stream, approval, and terminal phases.
- [x] Run three child tasks, inspect results, select integration, and verify conflicts are surfaced (durable workflow/reviewer-jury coverage).
- [x] Verify redacted history/artifact/handoff export.
- [x] Run crash, sandbox, security, conformance, acceptance, and bundle gates locally; hosted OS/provider rows remain release evidence gates.
- [ ] Record a real release-window rollback rehearsal before schema narrowing or legacy deletion.
