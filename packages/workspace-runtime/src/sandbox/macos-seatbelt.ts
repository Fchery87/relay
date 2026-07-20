import type { SandboxExecutor, SandboxConfig, SandboxResult } from "./sandbox-executor";
import { validateCommand } from "./sandbox-executor";
import { spawnSync } from "node:child_process";

export class MacOSSeatbeltSandbox implements SandboxExecutor {
  available(): boolean {
    if (process.platform !== "darwin") return false;
    try { return spawnSync("sandbox-exec", ["-h"], { timeout: 5_000 }).error === undefined; } catch { return false; }
  }

  async execute(command: string[], config: SandboxConfig): Promise<SandboxResult> {
    const validation = validateCommand(command, config.permissionProfile);
    if (!validation.allowed) { config.audit?.({ phase: "denied", command, profile: config.permissionProfile, reason: validation.reason }); throw new Error(`Sandbox policy denied command: ${validation.reason}`); }
    if (!this.available()) throw new Error("macOS Seatbelt enforcement is unavailable");
    // Emit a minimal Seatbelt profile via sandbox-exec
    const profile = `
      (version 1)
      (deny default)
      (allow file-read* (subpath "${config.worktreePath}"))
      (allow file-read* (subpath "${config.tempDir}"))
      ${config.permissionProfile === "read-only" ? "" : `(allow file-write* (subpath "${config.worktreePath}"))`}
      (allow file-write* (subpath "${config.tempDir}"))
      (deny file-read* (subpath "/proc"))
      (deny network*)
      (allow process-fork)
      (allow sysctl-read)
    `;

    return new Promise((resolve, reject) => {
      config.audit?.({ phase: "start", command, profile: config.permissionProfile });
      const proc = spawnSync("sandbox-exec", ["-p", profile, ...command], {
        timeout: config.timeoutMs ?? 60_000,
        maxBuffer: config.maxOutputBytes ?? 10 * 1024 * 1024,
        env: config.environment ?? { PATH: "/usr/bin:/bin" },
      });
      config.audit?.({ phase: "complete", command, profile: config.permissionProfile, exitCode: proc.status ?? 1 });
      if (proc.error) { reject(proc.error); return; }

      resolve({
        exitCode: proc.status ?? 1,
        stdout: proc.stdout?.toString() ?? "",
        stderr: proc.stderr?.toString() ?? "",
        sandboxed: true,
      });
    });
  }
}
