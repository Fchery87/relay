import { describe, expect, test } from "bun:test";

import type { MachineRegistration } from "@relay/shared";

import { MachineReporter } from "./relay-client";

const registration: MachineRegistration = {
  deviceToken: "development-device-token",
  name: "dev-machine",
  platform: "linux",
  daemonVersion: "0.0.0-dev",
  projects: [{ name: "relay", path: "/workspace/relay" }],
};

describe("MachineReporter", () => {
  test("registers once then sends heartbeat mutations", async () => {
    const calls: string[] = [];
    const reporter = new MachineReporter({
      gateway: {
        async heartbeat({ deviceToken }) {
          calls.push(`heartbeat:${deviceToken}`);
        },
        async registerMachine(machine) {
          calls.push(`register:${machine.name}`);
        },
      },
      registration,
    });

    await reporter.connect();
    await reporter.heartbeatOnce();

    expect(calls).toEqual([
      "register:dev-machine",
      "heartbeat:development-device-token",
    ]);
  });
});
