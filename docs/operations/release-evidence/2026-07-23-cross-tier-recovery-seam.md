# Evidence — cross-tier recovery seam, first live proof

Records the first live exercise of `apps/daemon/src/cross-tier-recovery.e2e.test.ts`
against a real, isolated, throwaway self-hosted Convex backend — see
[backup-recovery.md](../backup-recovery.md) for the general evidence format
and [2026-07-23-baseline.md](2026-07-23-baseline.md) for the prior snapshot.

## What this proves

A real client command (submitted the way the browser will once cut over —
see `apps/web/src/run-data.ts`'s `submitCanonicalCommand`, not yet wired to
a caller) travels through the real `commands/inbox:submitToInbox` mutation,
is claimed by a real `KernelDaemon` via the real `createConvexCommandSource`,
processed through the real local orchestration engine, and published back
to Convex via the real `createConvexProjectionSink` — with **no fakes and
no `convex-test` simulator anywhere in the path**. Covers: `run.create`,
`run.resume`, `turn.send` with streaming (scripted/fallback provider),
projection landing with a contiguous no-gap event sequence, a reconnecting
client resuming from a mid-stream cursor without gaps or duplicates, and a
daemon restart (fresh `KernelDaemon` instance, same local SQLite, same
backend) converging without duplicating the `run.create` effect.

## Two real, previously-undetected bugs found and fixed

Both existed in code shipped and "complete" per prior sessions' ticket
checkmarks — neither was ever caught because prior tests exercised these
code paths only through fakes, never over a real network round-trip:

1. **`convex-command-source.ts` / `convex-projection-sink.ts`**: their
   `fetchMutation` helper read `(ref as { _name: string })._name` to get a
   Convex function's dotted path from a `FunctionReference` — but
   `makeFunctionReference()` stores the name under an internal symbol, not
   a `_name` property. Every real call from these two files sent
   `path: undefined` to Convex, which rejected it as `BadJsonBody`. This
   means **the kernel daemon's real command-claim loop and real projection
   publish loop had never successfully executed a single RPC against a
   real backend**, despite `claimBatch`/`completeCommand`/`renewLease`/
   `appendEvents`/`upsertSnapshot`/`advanceCursor` all being individually
   unit-tested against fakes. Fixed by switching to the official
   `getFunctionName()` export from `convex/server`.
2. **`run.create` didn't preserve the canonical run ID.** `submitToInbox`
   assigns a canonical run ID (defaulting to the thread ID) to every
   command, but `KernelDaemon`'s `run.create` handler called
   `runtime.createRun({ projectId })` without it, and
   `OrchestrationEngine.createRun` always generated a fresh random ID.
   A `run.resume`/`turn.send` referencing the canonical ID could never
   find the locally-created run (`run_not_found`). This directly
   contradicts the "one canonical run ID survives every tier" invariant
   already marked done under "Expand to one canonical command and run
   identity" — that ticket's own tests never drove a real `run.create`
   through the real command inbox, only through direct `HarnessRuntime`
   calls that don't go through `submitToInbox` at all. Fixed by adding an
   optional `runId` to `CreateRunInput`/`OrchestrationEngine.createRun`
   and threading the command's canonical `runId` through in
   `KernelDaemon.processCommand`'s `run.create` case.

## Versions and topology

- Commit: (recorded at commit time in the accompanying git history)
- Backend: pinned per
  [self-hosted-convex-pin.json](../self-hosted-convex-pin.json), started
  fresh/isolated per test run (not the pinned dev instance — a throwaway
  instance built the same way, from the same installed binary)
- Topology: D1/D2/D3 per [ADR 0005](../../adr/0005-convex-production-topology.md)
  and [convex-history-migration-decision.md](../convex-history-migration-decision.md)
  — local development only, no live production

## Residual risks / not yet covered

- Approval, steer/interrupt, and checkpoint scenarios are not yet exercised
  against the real seam (only create/resume/send/streaming/reconnect/restart).
- The fault-injection matrix this ticket also asks for — duplicate/
  conflicting commands, lease expiry, stale completion, lost response, and
  projection duplicate/reorder/partial publication, **injected against the
  real seam** — is not yet built. Equivalent scenarios exist against fakes
  (`kernel-daemon.lease-renewal.test.ts`, `kernel-daemon.projection-outbox.test.ts`).
- A real LLM provider (as opposed to the scripted/fallback provider) is not
  exercised; "protected jobs cover the real provider" is only partially
  true — the protected CI job (`.github/workflows/ci.yml`,
  `cross-tier-recovery`, `workflow_dispatch`-only) covers the real
  self-hosted backend but not a real model provider.
- No workspace/git-worktree path was exercised (`adapterDeps.resolveProjectRoot`
  wasn't configured for this test's `KernelDaemon`) — checkpoint and
  subagent commands, which require it, are untested against the real seam.
