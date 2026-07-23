# Kernel Turn Capabilities Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close the first independently testable portion of the documented kernel-mode capability gap by executing provider tool calls through Relay governance and the sandbox, with canonical activity events visible to projections.

**Architecture:** Keep `HarnessRuntime` as the transition owner and preserve the existing provider reactor as the effect boundary. The kernel turn executor will consume optional provider tool calls after the provider stream, resolve the run's workspace through the adapter dependency, and invoke `executeGovernedToolCall`; tool lifecycle is recorded as canonical `activity.*` events through the runtime. This increment supports policy allow/deny and audit recording, while approval suspension, in-flight cancellation/steering, and automatic checkpoints remain explicit follow-up increments because they need asynchronous per-run orchestration.

**Tech Stack:** TypeScript, Bun tests, `@relay/harness-runtime`, `ScriptedModelProvider`, `executeGovernedToolCall`, local sandbox/tool executor, canonical event validation.

### Task 1: Track the capability-gap increments

**Files:**
- Modify: `tickets.md`
- Modify: `docs/operations/kernel-mode-capability-gaps.md`

**Step 1: Add a dedicated capability-gap section**

Record the five increments separately: governed tool execution, approval suspension/resolution, true in-flight steering, true interrupt cancellation, and orchestration-owned checkpoint capture. Mark only the tool-execution increment complete after its tests pass.

**Step 2: Document the boundary of this increment**

State that policy allow/deny and audit recording are supported here, while an `ask` decision remains deferred until the daemon can process approval resolution concurrently with the provider effect.

### Task 2: Add failing kernel turn tests

**Files:**
- Modify: `apps/daemon/src/kernel-daemon.wiring.test.ts`

**Step 1: Test an allowed provider tool call**

Use a `ScriptedModelProvider` with a real file-edit call and an in-memory `LocalHarnessRuntime`. Assert the file changes, the governance audit receives an allow decision, and the observed stream contains `activity.started` and `activity.completed` before `turn.completed`.

**Step 2: Test a denied provider tool call**

Use a high-risk command and a policy that denies it. Assert the command has no filesystem effect, governance records deny, and the stream contains an activity completion describing the refusal before the turn completes.

**Step 3: Run the focused test and confirm RED**

Run: `bun test apps/daemon/src/kernel-daemon.wiring.test.ts`

Expected: FAIL because the kernel turn executor does not currently consume provider tool calls or emit tool activity.

### Task 3: Implement the governed kernel tool bridge

**Files:**
- Modify: `apps/daemon/src/kernel-daemon.ts`
- Modify: `apps/daemon/src/model-provider.ts` only if type narrowing requires it
- Modify: `packages/contracts/src/commands.ts`
- Modify: `convex/schema.ts`
- Modify: `convex/commands/inbox.ts`
- Add: `convex/commands-inbox.convex.test.ts`

**Step 1: Add explicit turn-executor dependencies**

Pass optional governance, policy, platform, and workspace-root resolution into the executor. If tool calls are present without those dependencies, fail the turn closed rather than executing outside the configured workspace.

**Step 2: Consume provider tool calls**

After the stream completes, call the provider's optional `toolCalls` method with the prompt. For each call, emit `activity.started`, execute through `executeGovernedToolCall`, stream bounded output as `activity.delta`, and emit `activity.completed` with the result/refusal. Persist failures as `activity.failed` and keep the terminal turn event ordering valid.

**Step 3: Wire the daemon adapter dependencies**

Use `adapterDeps.resolveProjectRoot`, `adapterDeps.governance`, `adapterDeps.policy`, and `adapterDeps.platform`, deriving the canonical run ID as the tool thread identity. Tool-capable production configurations must provide a resolver and governance/policy dependencies.

Bind the optional project-path hint at Convex ingress to the authorized
thread's project path, persist that authorized path on the command, and return
it with the daemon claim before workspace resolution.

**Step 4: Run focused tests and typecheck**

Run: `bun test apps/daemon/src/kernel-daemon.wiring.test.ts` and `cd apps/daemon && bunx tsc --noEmit -p tsconfig.json`.

Expected: PASS.

### Task 4: Update evidence and verify the remaining boundary

**Files:**
- Modify: `docs/operations/kernel-mode-capability-gaps.md`
- Modify: `docs/operations/release-evidence/2026-07-23-cross-tier-recovery-seam.md`
- Modify: `tickets.md`

Record the completed tool-execution evidence and keep approval suspension, true steering/interrupt cancellation, and auto-checkpoint capture open and blocking shadow parity for those behaviors.

### Task 5: Full verification and commit

Run: `bun run typecheck`, `bun run test`, `bun run build`, `bun run security:gate`, `bun run bundle:check`, and `git diff --check`.

Review the diff for scope and correctness, then commit the implementation and evidence update on the current branch.
