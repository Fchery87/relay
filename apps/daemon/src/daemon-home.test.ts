import { expect, test } from "bun:test";

import { resolveDaemonHome } from "./daemon-home";

test("uses an explicit daemon home when configured", () => {
  expect(resolveDaemonHome({ env: { RELAY_DAEMON_HOME: "/custom/relay" }, homeDirectory: "/home/alex", platform: "linux" })).toBe("/custom/relay");
});

test("uses the Linux XDG configuration directory", () => {
  expect(resolveDaemonHome({ env: { XDG_CONFIG_HOME: "/config" }, homeDirectory: "/home/alex", platform: "linux" })).toBe("/config/relay");
});

test("uses the macOS application support directory", () => {
  expect(resolveDaemonHome({ env: {}, homeDirectory: "/Users/alex", platform: "darwin" })).toBe("/Users/alex/Library/Application Support/Relay");
});

test("uses the Windows roaming application data directory", () => {
  expect(resolveDaemonHome({ env: { APPDATA: "C:/Users/alex/AppData/Roaming" }, homeDirectory: "C:/Users/alex", platform: "win32" })).toBe("C:/Users/alex/AppData/Roaming/Relay");
});
