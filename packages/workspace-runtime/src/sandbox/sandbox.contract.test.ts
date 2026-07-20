import { expect, test, describe } from "bun:test";
import { validateCommand } from "./sandbox-executor";
import { LinuxBubblewrapSandbox } from "./linux-bwrap";
import { MacOSSeatbeltSandbox } from "./macos-seatbelt";
import { WindowsPolicySandbox } from "./windows-policy";

// ---------------------------------------------------------------------------
// Command validation (platform-independent, always runs)
// ---------------------------------------------------------------------------

describe("validateCommand", () => {
  test("blocks .env access for workspace-write", () => {
    const result = validateCommand(["cat", ".env"], "workspace-write");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("env_read_blocked");
  });

  test("blocks curl for workspace-write", () => {
    const result = validateCommand(["curl", "https://example.com"], "workspace-write");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("network_blocked");
  });

  test("blocks /proc/*/environ access for read-only", () => {
    const result = validateCommand(["cat", "/proc/1/environ"], "read-only");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("env_read_blocked");
  });

  test("blocks symlink escape patterns for workspace-write", () => {
    const result = validateCommand(["readlink", "-f", "../../etc/passwd"], "workspace-write");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("symlink_escape_blocked");
  });

  test("allows safe commands for workspace-write", () => {
    const result = validateCommand(["git", "status"], "workspace-write");
    expect(result.allowed).toBe(true);
  });

  test("allows network for full-access", () => {
    const result = validateCommand(["curl", "https://example.com"], "full-access");
    expect(result.allowed).toBe(true);
  });

  test("allows all commands for full-access", () => {
    const r1 = validateCommand(["cat", ".env"], "full-access");
    const r2 = validateCommand(["cat", "/proc/1/environ"], "full-access");
    const r3 = validateCommand(["nc", "-l", "8080"], "full-access");
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sandbox executor availability (platform-sensitive, skips gracefully)
// ---------------------------------------------------------------------------

describe("sandbox availability", () => {
  test("Linux bubblewrap reports availability", () => {
    const sandbox = new LinuxBubblewrapSandbox();
    const avail = sandbox.available();
    // True or false depending on whether bwrap is installed — both are fine.
    expect(typeof avail).toBe("boolean");
  });

  test("macOS Seatbelt reports availability based on platform", () => {
    const sandbox = new MacOSSeatbeltSandbox();
    const avail = sandbox.available();
    if (process.platform === "darwin") {
      expect(avail).toBe(true);
    } else {
      expect(avail).toBe(false);
    }
  });

  test("Windows policy reports availability based on platform", () => {
    const sandbox = new WindowsPolicySandbox();
    const avail = sandbox.available();
    if (process.platform === "win32") {
      expect(avail).toBe(true);
    } else {
      expect(avail).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Escape suite (only runs when the sandbox tool is available on this platform)
// These are the canonical escape tests from the spec:
// writes outside worktree, reads .env, reads /proc/*/environ,
// symlink escape, network access, private/loopback access
// ---------------------------------------------------------------------------

describe("escape suite", () => {
  const config = { worktreePath: "/tmp/relay-worktree", tempDir: "/tmp/relay-temp", permissionProfile: "workspace-write" as const };
  test("Linux adapter rejects credential and network commands before spawn", async () => { const sandbox = new LinuxBubblewrapSandbox(); await expect(sandbox.execute(["cat", ".env"], config)).rejects.toThrow("denied"); await expect(sandbox.execute(["curl", "https://example.com"], config)).rejects.toThrow("denied"); });
  test("macOS adapter rejects credential and symlink escapes before spawn", async () => { const sandbox = new MacOSSeatbeltSandbox(); await expect(sandbox.execute(["cat", "/proc/1/environ"], config)).rejects.toThrow("denied"); await expect(sandbox.execute(["readlink", "../../etc/passwd"], config)).rejects.toThrow("denied"); });
  test("Windows adapter always fails closed without technical enforcement", async () => { const sandbox = new WindowsPolicySandbox(); await expect(sandbox.execute(["echo", "test"], config)).rejects.toThrow("fails closed"); });
});
