import { expect, test } from "bun:test";

import { resolveCodexHarnessHome } from "./codex-harness-home";

test("Codex harness defaults to an isolated home", () => {
  expect(resolveCodexHarnessHome("/tmp/daemon-home")).toEqual({
    path: "/tmp/daemon-home/codex-home",
    isolated: true,
  });
});

test("Codex harness accepts an explicit authenticated home only when requested", () => {
  expect(resolveCodexHarnessHome("/tmp/daemon-home", "/home/user/.codex")).toEqual({
    path: "/home/user/.codex",
    isolated: false,
  });
});
