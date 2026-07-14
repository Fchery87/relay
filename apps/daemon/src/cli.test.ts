import { expect, test } from "bun:test";

import { parseCli, runCli } from "./cli";

test("parses connect with an explicit Convex URL", () => {
  expect(parseCli(["connect", "--url", "https://relay.convex.cloud"])).toEqual({ command: "connect", deploymentUrl: "https://relay.convex.cloud" });
});

test("uses start when no command is supplied", () => {
  expect(parseCli([])).toEqual({ command: "start" });
});

test("dispatches the default command to the daemon runtime", async () => {
  let started = false;

  await runCli([], { runDaemon: async () => { started = true; } });

  expect(started).toBeTrue();
});

test("rejects unknown commands", () => {
  expect(() => parseCli(["unknown"])).toThrow("Unknown command");
});
