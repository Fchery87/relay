import { expect, test } from "bun:test";

import {
  CONFORMANCE_COMMANDS,
  createConformanceEvidence,
  isSupportedConformancePlatform,
} from "./run-conformance-matrix";

test("conformance evidence captures a passing matrix profile", () => {
  const evidence = createConformanceEvidence({
    commands: ["bun run typecheck", "bun run test"],
    platform: "linux",
    arch: "x64",
    runtime: "1.3.14",
    status: "pass",
  });

  expect(evidence).toMatchObject({
    schemaVersion: 1,
    platform: "linux",
    status: "pass",
    commands: ["bun run typecheck", "bun run test"],
  });
  expect(evidence.finishedAt).toBeTypeOf("string");
});

test("conformance evidence records a failed command", () => {
  const evidence = createConformanceEvidence({
    commands: ["bun run typecheck"],
    failedCommand: "bun run typecheck",
    platform: "darwin",
    arch: "arm64",
    runtime: "1.3.14",
    status: "fail",
  });

  expect(evidence).toMatchObject({
    failedCommand: "bun run typecheck",
    platform: "darwin",
    status: "fail",
  });
});

test("unsupported platforms fail the matrix before execution", () => {
  expect(isSupportedConformancePlatform("linux")).toBe(true);
  expect(isSupportedConformancePlatform("darwin")).toBe(true);
  expect(isSupportedConformancePlatform("win32")).toBe(true);
  expect(isSupportedConformancePlatform("aix")).toBe(false);
});

test("conformance matrix includes the root operational script suite", () => {
  expect(CONFORMANCE_COMMANDS.some((command) => command.join(" ") === "bun test scripts")).toBe(true);
});
