import { expect, test } from "bun:test";

import { machinePlatformSchema } from "@relay/shared";

import { loadDaemonConfig } from "./config";

test("loads daemon registration from environment", () => {
  expect(
    loadDaemonConfig({
      env: {
        RELAY_CONVEX_URL: "https://relay.convex.cloud",
        RELAY_DEVICE_TOKEN: "development-device-token",
        RELAY_PROJECTS: '[{"name":"relay","path":"/workspace/relay"}]',
      },
      hostname: () => "dev-machine",
    }),
  ).toEqual({
    deploymentUrl: "https://relay.convex.cloud",
    heartbeatIntervalMs: 10_000,
    registration: {
      daemonVersion: "0.0.0-dev",
      deviceToken: "development-device-token",
      name: "dev-machine",
      platform: machinePlatformSchema.parse(process.platform),
      projects: [{ name: "relay", path: "/workspace/relay" }],
    },
  });
});

test("prefers the paired device token over the development environment fallback", () => {
  const config = loadDaemonConfig({
    env: {
      RELAY_CONVEX_URL: "https://relay.convex.cloud",
      RELAY_DEVICE_TOKEN: "development-device-token",
      RELAY_PROJECTS: '[{"name":"relay","path":"/workspace/relay"}]',
    },
    hostname: () => "dev-machine",
    storedDeviceToken: "paired-device-token",
  });

  expect(config.registration.deviceToken).toBe("paired-device-token");
});
