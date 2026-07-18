import { expect, test } from "bun:test";

import { parseCli, runCli } from "./cli";

test("parses connect with an explicit Convex URL", () => {
  expect(parseCli(["connect", "--url", "https://relay.convex.cloud"])).toEqual({ command: "connect", deploymentUrl: "https://relay.convex.cloud" });
});

test("uses start when no command is supplied", () => {
  expect(parseCli([])).toEqual({ command: "start", yolo: false });
});

test("dispatches the default command to the daemon runtime", async () => {
  let started = false;

  await runCli([], { runDaemon: async () => { started = true; } });

  expect(started).toBeTrue();
});

test("rejects unknown commands", () => {
  expect(() => parseCli(["unknown"])).toThrow("Unknown command");
});

test("parses start --yolo and its long alias", () => {
  expect(parseCli(["start", "--yolo"])).toEqual({ command: "start", yolo: true });
  expect(parseCli(["start", "--dangerously-skip-permissions"])).toEqual({ command: "start", yolo: true });
  expect(parseCli(["start"])).toEqual({ command: "start", yolo: false });
  expect(parseCli([])).toEqual({ command: "start", yolo: false });
});

test("start with unknown option throws", () => {
  expect(() => parseCli(["start", "--foo"])).toThrow("Unknown option: --foo");
});

test("passes yolo flag to runDaemon", async () => {
  let yoloPassed: boolean | undefined;
  await runCli(["start", "--yolo"], { runDaemon: async (input) => { yoloPassed = input?.yolo; } });
  expect(yoloPassed).toBe(true);
});

test("parses project subcommands", () => {
  expect(parseCli(["project", "add"])).toEqual({ command: "project", subcommand: "add", path: undefined, name: undefined });
  expect(parseCli(["project", "add", "/repo", "--name", "my-repo"])).toEqual({ command: "project", subcommand: "add", name: "my-repo", path: "/repo" });
  expect(parseCli(["project", "remove", "/repo"])).toEqual({ command: "project", subcommand: "remove", path: "/repo" });
  expect(parseCli(["project", "list"])).toEqual({ command: "project", subcommand: "list" });
  expect(() => parseCli(["project", "remove"])).toThrow("requires a path");
  expect(() => parseCli(["project", "unknown"])).toThrow("Unknown project subcommand");
});
