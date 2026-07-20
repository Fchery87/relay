import type { SandboxExecutor, SandboxConfig, SandboxResult } from "./sandbox-executor";

export class WindowsPolicySandbox implements SandboxExecutor {
  available(): boolean {
    return process.platform === "win32";
  }

  async execute(command: string[], config: SandboxConfig): Promise<SandboxResult> {
    void command;
    config.audit?.({ phase: "denied", command, profile: config.permissionProfile, reason: "windows_enforcement_unavailable" });
    throw new Error(
      "Windows sandbox enforcement is unavailable; kernel execution fails closed until AppContainer/Job Object confinement is installed.",
    );
  }
}
