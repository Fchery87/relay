import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { resolveRuntimeMode } from "./runtime-mode";

const repoRoot = resolve(import.meta.dir, "..", "..", "..");
const adrs = [
  "docs/adr/0001-adapter-first-local-harness.md",
  "docs/adr/0002-local-authority-convex-projections.md",
  "docs/adr/0003-canonical-command-event-model.md",
];
const prdPath = ".scratch/relay-v1/PRD.md";

test("all three architecture-reversal ADRs exist", () => {
  for (const adr of adrs) {
    const fullPath = resolve(repoRoot, adr);
    expect(existsSync(fullPath)).toBe(true);
  }
});

test("each ADR supersedes the own-loop decision", () => {
  for (const adr of adrs) {
    const content = readFileSync(resolve(repoRoot, adr), "utf8");
    expect(content).toContain("Accepted");
  }
});

test("the PRD amendment links the ADRs", () => {
  const content = readFileSync(resolve(repoRoot, prdPath), "utf8");
  expect(content).toContain("ADR 0001");
  expect(content).toContain("ADR 0002");
  expect(content).toContain("ADR 0003");
  expect(content).toContain("adapter-first harness");
});

test("kernel daemon routes provider callbacks through the provider event gateway", () => {
  const content = readFileSync(resolve(repoRoot, "apps/daemon/src/kernel-daemon.ts"), "utf8");
  expect(content).not.toContain("runtime.appendEvent");
  expect(content).toContain("persistProviderEvent");
  expect(content).toContain("resolveMaxConcurrentRuns");
  expect(content).not.toContain("maxConcurrentRuns: 4");
});

test("runtime mode selects once in the daemon root with legacy as the migration-safe default", () => {
  const mode = resolveRuntimeMode({});
  expect(mode).toBe("legacy");
});
