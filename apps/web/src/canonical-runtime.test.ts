import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createCanonicalRuntime } from "./canonical-runtime";

test("active app uses projection runs and not the legacy boundary", () => {
  const app = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
  expect(app).toContain("canonicalRunData.listRuns");
  expect(app).not.toContain("legacyRunData");
});

test("canonical web runtime is backed by client runtime", () => {
  const runtime = createCanonicalRuntime({
    fetchSnapshot: async () => undefined,
    fetchEvents: async () => [],
    submitCommand: async () => { throw new Error("not used"); },
  });
  expect(runtime).toBeDefined();
});
