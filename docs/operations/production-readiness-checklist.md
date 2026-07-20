# Production readiness checklist

- [ ] Pair browser and daemon; verify owner/machine/project authorization.
- [ ] Run two isolated runs and confirm no cross-run events or artifacts.
- [ ] Exercise steering, approval allow/deny, checkpoint capture/restore, stale cursor recovery.
- [ ] Exercise provider and daemon restart during start, stream, approval, and terminal phases.
- [ ] Run three child tasks, inspect results, select integration, and verify conflicts are surfaced.
- [ ] Verify redacted history/artifact/handoff export.
- [ ] Run crash, sandbox, security, conformance, acceptance, and bundle gates.
- [ ] Record a real release-window rollback rehearsal before schema narrowing or legacy deletion.
