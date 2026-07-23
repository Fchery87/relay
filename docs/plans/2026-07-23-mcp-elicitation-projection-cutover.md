# MCP Elicitation Projection Cutover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Move the MCP elicitation card from legacy Convex reads and writes to canonical activity events and inbox commands whenever projection mode is enabled, while retaining the legacy path as the rollback boundary.

**Architecture:** The existing Convex elicitation record remains the daemon-side wait/response authority for this slice. The daemon emits a canonical `activity.started` event when the record is created, then `activity.completed` or `activity.failed` when the response/cancellation is observed. The browser derives card state from the canonical event tail. Submit and cancel enter through the canonical command inbox and the daemon invokes the existing authorized Convex mutations.

**Tech Stack:** TypeScript, Bun tests, React/Vite, Convex HTTP mutations and queries, canonical projection events.

### Task 1: Prove the projection reducer

- Add a failing web test for pending, submitted, and cancelled MCP elicitation activity lifecycles.
- Implement the pure event-to-card reducer with bounded prompt payloads and stable elicitation IDs.

### Task 2: Wire canonical MCP commands and daemon lifecycle events

- Add inbox command kinds and daemon dispatch for elicitation resolve/cancel.
- Extend the daemon Convex gateway with authorized submit/cancel operations.
- Emit canonical activity events around the existing MCP wait lifecycle, including the persisted elicitation ID and prompt metadata.
- Add daemon tests for command routing and event emission.

### Task 3: Cut over the browser with rollback gating

- Skip the legacy elicitation query in projection mode.
- Render reducer output and submit/cancel through canonical commands only in projection mode.
- Keep legacy query/mutation behavior unchanged when the flag is disabled.

### Task 4: Verify and record evidence

- Run focused reducer, daemon, and browser tests.
- Run package typechecks and the full suite; record the remaining protected/canary gates in release evidence and ticket notes.
- Commit the slice as one reviewable change.
