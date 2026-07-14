import { expect, test } from "bun:test";

import { releaseTargets } from "./release-targets";

test("declares the five production daemon artifacts", () => {
  expect(releaseTargets.map((target) => target.fileName)).toEqual([
    "relay-darwin-arm64",
    "relay-darwin-x64",
    "relay-linux-arm64",
    "relay-linux-x64",
    "relay-windows-x64.exe",
  ]);
});
