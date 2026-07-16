import type { SandboxExecutor, SandboxConfig, SandboxResult } from "./sandbox-executor";
import { spawnSync } from "node:child_process";

export class MacOSSeatbeltSandbox implements SandboxExecutor {
  available(): boolean {
    // Seatbelt is available on macOS 10.5+
    return process.platform === "darwin";
  }

  async execute(command: string[], config: SandboxConfig): Promise<SandboxResult> {
    // Emit a minimal Seatbelt profile via sandbox-exec
    const profile = `
      (version 1)
      (deny default)
      (allow file-read* (subpath "${config.worktreePath}"))
      (allow file-read* (subpath "${config.tempDir}"))
      (allow file-write* (subpath "${config.tempDir}"))
      (allow process-fork)
      (allow sysctl-read)
    `;

    return new Promise((resolve) => {
      const proc = spawnSync("sandbox-exec", ["-p", profile, ...command], {
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
