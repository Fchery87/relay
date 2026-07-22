import { describe, expect, test } from "bun:test";
import { LocalHarnessRuntime } from "@relay/harness-runtime";

describe("shadow parity", () => {
  test("sandbox enforcement is disabled by default", () => {
    const runtime = LocalHarnessRuntime.memory();
    expect(runtime.sandboxEnabled).toBe(false);
  });

  test("sandbox enforcement is enabled when failClosed is true", () => {
    const runtime = LocalHarnessRuntime.memory({
      sandbox: {
        failClosed: true,
        workspaceRoots: ["/tmp/test-root"],
      },
    });
    expect(runtime.sandboxEnabled).toBe(true);
  });

  test("filterSandboxEnv returns unfiltered when no allowlist", () => {
    const runtime = LocalHarnessRuntime.memory();
    const env = { FOO: "bar", PATH: "/usr/bin" };
    expect(runtime.filterSandboxEnv(env)).toEqual(env);
  });

  test("filterSandboxEnv only passes allowlisted vars", () => {
    const runtime = LocalHarnessRuntime.memory({
      sandbox: {
        failClosed: true,
        workspaceRoots: ["/tmp"],
        envAllowlist: ["PATH"],
      },
    });
    const env = { FOO: "bar", PATH: "/usr/bin", SECRET: "s3cret" };
    const filtered = runtime.filterSandboxEnv(env);
    expect(filtered["PATH"]).toBe("/usr/bin");
    expect(filtered["FOO"]).toBeUndefined();
    expect(filtered["SECRET"]).toBeUndefined();
  });

  test("enforceSandboxPath throws for escaped paths when failClosed", async () => {
    const runtime = LocalHarnessRuntime.memory({
      sandbox: {
        failClosed: true,
        workspaceRoots: ["/tmp/safe"],
      },
    });
    // /etc/passwd should be outside workspace roots
    await expect(runtime.enforceSandboxPath("/etc/passwd")).rejects.toThrow(
      "Sandbox violation",
    );
  });
});
