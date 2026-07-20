import type { SandboxExecutor, SandboxConfig, SandboxResult } from "./sandbox-executor";
import { validateCommand } from "./sandbox-executor";
import { spawnSync } from "node:child_process";

export class LinuxBubblewrapSandbox implements SandboxExecutor {
  available(): boolean {
    try {
      const result = spawnSync("bwrap", ["--version"], { timeout: 5_000 });
      return result.status === 0;
    } catch {
      return false;
    }
  }

  async execute(command: string[], config: SandboxConfig): Promise<SandboxResult> {
    const validation = validateCommand(command, config.permissionProfile);
    if (!validation.allowed) { config.audit?.({ phase: "denied", command, profile: config.permissionProfile, reason: validation.reason }); throw new Error(`Sandbox policy denied command: ${validation.reason}`); }
    if (!this.available()) {
      throw new Error("bubblewrap is not available — kernel mode requires it");
    }

    // Build a bubblewrap command that confines to worktree + temp
    const bwrapArgs: string[] = [
      "bwrap",
      "--ro-bind", "/usr", "/usr",
      "--ro-bind", "/lib", "/lib",
      "--ro-bind", "/lib64", "/lib64",
      "--ro-bind", "/bin", "/bin",
      config.permissionProfile === "read-only" ? "--ro-bind" : "--bind", config.worktreePath, config.worktreePath,
      "--bind", config.tempDir, "/relay-tmp",
      "--clearenv",
      "--proc", "/proc",
      "--dev", "/dev",
      "--unshare-net",
      "--unshare-ipc",
      "--unshare-pid",
      "--die-with-parent",
      "--",
      ...command,
    ];

    return new Promise((resolve, reject) => {
      config.audit?.({ phase: "start", command, profile: config.permissionProfile });
      const proc = spawnSync(bwrapArgs[0]!, bwrapArgs.slice(1), {
        timeout: config.timeoutMs ?? 60_000,
        maxBuffer: config.maxOutputBytes ?? 10 * 1024 * 1024,
        env: { PATH: "/usr/bin:/bin", TMPDIR: "/relay-tmp", ...config.environment },
      });
      config.audit?.({ phase: "complete", command, profile: config.permissionProfile, exitCode: proc.status ?? 1 });

      resolve({
        exitCode: proc.status ?? 1,
        stdout: proc.stdout?.toString() ?? "",
        stderr: proc.stderr?.toString() ?? "",
        sandboxed: true,
      });
    });
  }
}
