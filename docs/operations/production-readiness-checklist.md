# Production readiness checklist

- [x] Pair browser and daemon; verify owner/machine/project authorization (real isolated cross-tier fixture and Convex owner-isolation tests).
- [x] Run two isolated runs and confirm no cross-run events or artifacts (`cross-tier-recovery.e2e.test.ts`, 13/13 protected run); repeat in the supervised hosted acceptance profile before production promotion.
- [x] Exercise steering, approval allow/deny, checkpoint capture/restore, stale cursor recovery (kernel control/checkpoint tests and live seam evidence).
- [x] Exercise daemon and backend restart during run creation and projection recovery (`cross-tier-recovery.e2e.test.ts`).
- [ ] Exercise a credentialed provider restart during start, stream, approval, and terminal phases (`real-codex-harness` protected gate).
- [x] Run three child tasks, inspect results, select integration, and verify conflicts are surfaced (durable workflow/reviewer-jury coverage).
- [x] Verify redacted history/artifact/handoff export.
- [x] Run crash, sandbox, security, conformance, acceptance, and bundle gates locally; hosted OS/provider rows remain release evidence gates.
- [ ] Record a real release-window rollback rehearsal before schema narrowing or legacy deletion.
