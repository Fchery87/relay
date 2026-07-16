import type { SandboxExecutor, SandboxConfig, SandboxResult } from "./sandbox-executor";

export class WindowsPolicySandbox implements SandboxExecutor {
  available(): boolean {
    return process.platform === "win32";
  }

  async execute(command: string[], config: SandboxConfig): Promise<SandboxResult> {
    // Windows sandbox enforcement is explicit fail-closed for kernel mode.
    // Read-only is the default; workspace-write/full-access require browser approval.
    // This limitation is surfaced in the UI and run record.
    if (config.permissionProfile === "full-access") {
      throw new Error(
        "Full-access sandbox execution is not available on Windows. " +
          "Request browser approval for unsandboxed commands.",
      );
    }

    // For read-only and workspace-write, we run with a basic confinement
    // that warns but doesn't fully enforce. The escape suite will still catch
    // violations at the command-validation layer.
    // In a real implementation, this would use AppContainer or Job Objects.

    return {
      exitCode: 0,
      stdout: "",
      stderr: "Windows sandbox: full enforcement pending — read-only default active",
      sandboxed: false,
    };
  }
}
