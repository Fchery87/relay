import { expect, test } from "bun:test";

import { pairDevice } from "./connect";

test("stores a device token only after the browser claims its pairing code", async () => {
  const starts: Array<{ code: string; deviceToken: string }> = [];
  const writes: Array<{ daemonHome: string; deploymentUrl: string; deviceToken: string }> = [];
  const output: string[] = [];

  await pairDevice({
    daemonHome: "/tmp/relay",
    deploymentUrl: "https://relay.convex.cloud",
    deviceToken: "device-token",
    generateCode: () => "pairing-code",
    output: (line) => output.push(line),
    pollIntervalMs: 0,
    start: async (input) => {
      starts.push(input);
    },
    waitForClaim: async () => ({ status: "claimed" }),
    writeCredentials: async (input) => {
      writes.push(input);
    },
  });

  expect(starts).toEqual([{ code: "pairing-code", deviceToken: "device-token" }]);
  expect(writes).toEqual([{ daemonHome: "/tmp/relay", deploymentUrl: "https://relay.convex.cloud", deviceToken: "device-token" }]);
  expect(output).toEqual(["Pair this daemon in Relay with code: pairing-code"]);
});

test("does not persist credentials when the code expires", async () => {
  const writes: Array<{ daemonHome: string; deploymentUrl: string; deviceToken: string }> = [];

  await expect(
    pairDevice({
      daemonHome: "/tmp/relay",
      deploymentUrl: "https://relay.convex.cloud",
      deviceToken: "device-token",
      generateCode: () => "pairing-code",
      output: () => undefined,
      pollIntervalMs: 0,
      start: async () => undefined,
      waitForClaim: async () => ({ status: "expired" }),
      writeCredentials: async (input) => {
        writes.push(input);
      },
    }),
  ).rejects.toThrow("Pairing code expired");

  expect(writes).toEqual([]);
});
