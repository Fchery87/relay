# Slash Catalog Projection Cutover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Remove the projection-mode browser dependency on the legacy slash-command catalog query by publishing the project-filtered catalog in a canonical run configuration event.

**Architecture:** The kernel resolves the trusted built-in, user, and project catalog at `run.create`, appends it as a bounded `run.configuration.updated` payload, and the browser derives the composer catalog from the projection event tail. Legacy mode retains the existing Convex catalog query as the rollback boundary.

**Tech Stack:** TypeScript, Bun tests, React/Vite, canonical projection events, local slash-command loader.

### Task 1: Prove the pure catalog reducer

- Add a failing web test for catalog extraction from canonical configuration events.
- Implement bounded, shape-checked catalog projection.

### Task 2: Publish the catalog from kernel run creation

- Add a slash-catalog resolver adapter dependency.
- Resolve the trusted catalog for the authorized project and append it after `run.created`.
- Test that run creation projects the catalog without affecting run identity.

### Task 3: Cut over the browser with rollback gating

- Skip the legacy slash catalog query in projection mode.
- Feed the composer projected commands while retaining the legacy query in rollback mode.

### Task 4: Verify and record evidence

- Run focused reducer, daemon, browser, typecheck, and full-suite checks.
- Update release evidence and ticket notes, then commit the slice.
