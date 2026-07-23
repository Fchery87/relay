import { expect, test } from "bun:test";

import {
  assertPinnedCodexVersion,
  buildCodexSchemaCommands,
  parsePinnedCodexVersion,
} from "./codex-schema";

test("reads the pinned Codex CLI version from generated metadata", () => {
  expect(parsePinnedCodexVersion("codex-cli 0.144.3\nGenerated: 2026-07-17\n")).toBe("0.144.3");
});

test("rejects a generator version that does not match the checked-in pin", () => {
  expect(() => assertPinnedCodexVersion({ actual: "0.145.0", pinned: "0.144.3" })).toThrow("Codex CLI version mismatch");
  expect(() => assertPinnedCodexVersion({ actual: "0.144.3", pinned: "0.144.3" })).not.toThrow();
});

test("builds isolated TypeScript and JSON schema generation commands", () => {
  expect(buildCodexSchemaCommands({ codexPath: "codex", tsOutput: "/tmp/ts", jsonOutput: "/tmp/json" })).toEqual([
    ["codex", "app-server", "generate-ts", "--out", "/tmp/ts"],
    ["codex", "app-server", "generate-json-schema", "--out", "/tmp/json"],
  ]);
});
