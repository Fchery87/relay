import type { SandboxExecutor, SandboxConfig, SandboxResult } from "./sandbox-executor";
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
      "--bind", config.worktreePath, config.worktreePath,
      "--bind", config.tempDir, "/tmp",
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
      const proc = spawnSync(bwrapArgs[0]!, bwrapArgs.slice(1), {
        timeout: 60_000,
        maxBuffer: 10 * 1024 * 1024,
      });

      resolve({
        exitCode: proc.status ?? 1,
        stdout: proc.stdout?.toString() ?? "",
        stderr: proc.stderr?.toString() ?? "",
        sandboxed: true,
      });
    });
  }
}
