# Machine-Readable Release Evidence Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a fail-closed, machine-readable release-evidence contract that can record backup, conformance, provider, canary, and rollback facts without manufacturing production readiness.

**Architecture:** A small TypeScript boundary validates a JSON evidence document at creation time and again before promotion. The document carries explicit gate booleans, bounded identifying facts, test IDs, residual risks, and redacted failure text; missing facts or any false gate make the record promotion-blocking. The CLI writes mode-0600 evidence for operator workflows, while existing conformance and canary evidence remain independently reusable inputs.

**Tech Stack:** Bun, TypeScript, `bun:test`, existing Relay evidence/redaction helpers.

### Task 1: Define the evidence contract and regression cases

**Files:**
- Create: `scripts/release-evidence.test.ts`
- Create: `docs/operations/release-evidence/schema.md`

**Step 1: Write failing tests**

Cover a complete unblocked record, missing required facts, false release gates,
secret redaction/bounds, and validation of a serialized record.

**Step 2: Run the focused test**

Run: `bun test scripts/release-evidence.test.ts`

Expected: fail because the evidence module does not exist yet.

### Task 2: Implement the evidence boundary

**Files:**
- Create: `scripts/release-evidence.ts`

**Step 1: Implement the smallest API required by the tests**

Add typed evidence and gate models, `createReleaseEvidence`,
`assertReleaseEvidenceReady`, and a mode-0600 writer. Keep external JSON as
`unknown` until validated; reject malformed or incomplete input.

**Step 2: Add the CLI**

Accept `--input`, `--output`, and optional bounded `--failure`/`--log` values.
Write a record even when blocked, print its status, and exit 78 when it cannot
be used for promotion.

**Step 3: Run focused tests**

Run: `bun test scripts/release-evidence.test.ts`

Expected: all evidence tests pass.

### Task 3: Integrate operator documentation and scripts

**Files:**
- Modify: `package.json`
- Modify: `docs/operations/backup-recovery.md`
- Modify: `docs/operations/production-readiness-checklist.md`

Add `release:evidence`, document the JSON contract and fail-closed exit code,
and identify the record as a container for real operator evidence rather than
as proof that the currently open hosted/release gates have passed.

### Task 4: Verify and commit

Run the focused evidence tests, workspace typecheck, full package/Convex suite,
`git diff --check`, and the existing conformance matrix. Review the diff for
secret leakage and false-positive gate transitions, then commit the complete
slice.
