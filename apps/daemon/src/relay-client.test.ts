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
          return "machine-id-1";
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

  test("repeated heartbeats advance without project changes", async () => {
    const heartbeatCalls: string[] = [];
    const reporter = new MachineReporter({
      gateway: {
        async heartbeat({ deviceToken }) {
          heartbeatCalls.push(`heartbeat:${deviceToken}`);
        },
        async registerMachine(_machine) {
          return "machine-id-1";
        },
      },
      registration,
    });

    await reporter.connect();

    // Simulate several heartbeat intervals without any project change
    await reporter.heartbeatOnce();
    await reporter.heartbeatOnce();
    await reporter.heartbeatOnce();
    await reporter.heartbeatOnce();

    expect(heartbeatCalls).toEqual([
      "heartbeat:development-device-token",
      "heartbeat:development-device-token",
      "heartbeat:development-device-token",
      "heartbeat:development-device-token",
    ]);
  });
});
