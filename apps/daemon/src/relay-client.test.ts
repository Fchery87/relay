import { describe, expect, test } from "bun:test";

import type { MachineRegistration } from "@relay/shared";

import { MachineReporter } from "./relay-client";
import type { CanaryTelemetry } from "./runtime-mode";

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

  test("forwards bounded canary telemetry with the heartbeat", async () => {
    let received: CanaryTelemetry | undefined;
    const reporter = new MachineReporter({
      gateway: {
        async heartbeat({ telemetry }) {
          received = telemetry;
        },
        async registerMachine(_machine) {
          return "machine-id-1";
        },
      },
      registration,
    });
    const telemetry: CanaryTelemetry = {
      activeLeases: 1,
      authFailures: 0,
      duplicateCommands: 0,
      fallbackActivations: 2,
      mode: "kernel",
      pendingEffects: 0,
      projectionBacklog: 0,
      projectionDivergences: 0,
      projectionGaps: 0,
      recoverableFailures: 0,
      sandboxViolations: 0,
      unrecoverableFailures: 0,
    };
    await reporter.connect();
    await reporter.heartbeatOnce(telemetry);
    expect(received).toEqual(telemetry);
  });
});
