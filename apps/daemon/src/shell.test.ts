import { expect, test } from "bun:test";

import { shellInvocation } from "./shell";

test("uses bash login commands on unix", () => {
  expect(shellInvocation({ command: "bun test", platform: "linux" })).toEqual({ executable: "bash", args: ["-lc", "bun test"] });
});

test("uses PowerShell on Windows", () => {
  expect(shellInvocation({ command: "bun test", platform: "win32" })).toEqual({ executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", "bun test"] });
});
