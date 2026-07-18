import { shellInvocation } from "./shell";

export interface BackgroundShellResult {
  exited: boolean;
  exitCode?: number;
  output: string;
}

export class BackgroundShellManager {
  #shells = new Map<string, { command: string; cursor: number; buffer: string; exited: boolean; exitCode?: number; process: ReturnType<typeof Bun.spawn> }>();
  #notifications: string[] = [];
  readonly maxConcurrent = 8;

  async start({ command, platform, root }: { command: string; platform: string; root?: string }): Promise<{ shellId: string }> {
    if (this.#shells.size >= this.maxConcurrent) throw new Error(`Maximum ${this.maxConcurrent} concurrent background shells reached`);
    const shellId = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const inv = shellInvocation({ command, platform: platform as "linux" | "darwin" | "win32" });
    const proc = Bun.spawn({
      cmd: [inv.executable, ...inv.args],
      cwd: root,
      stderr: "pipe",
      stdout: "pipe",
    });
    const entry = { buffer: "", command, cursor: 0, exited: false, process: proc };
    this.#shells.set(shellId, entry);
    void this.#monitor(shellId, entry);
    return { shellId };
  }

  async read({ shellId }: { shellId: string }): Promise<BackgroundShellResult> {
    const entry = this.#shells.get(shellId);
    if (!entry) throw new Error(`Unknown shell: ${shellId}`);
    const newOutput = entry.buffer.slice(entry.cursor);
    entry.cursor = entry.buffer.length;
    return { exited: entry.exited, exitCode: entry.exitCode, output: newOutput };
  }

  async kill({ shellId }: { shellId: string }): Promise<void> {
    const entry = this.#shells.get(shellId);
    if (!entry) throw new Error(`Unknown shell: ${shellId}`);
    entry.process.kill();
    entry.exited = true;
  }

  drainExitNotifications(): string[] {
    const result = this.#notifications.splice(0);
    return result;
  }

  async shutdown(): Promise<void> {
    for (const entry of this.#shells.values()) entry.process.kill();
    this.#shells.clear();
  }

  async #monitor(shellId: string, entry: { process: ReturnType<typeof Bun.spawn>; command: string; buffer: string; exited: boolean; exitCode?: number }): Promise<void> {
    try {
      const stdout = entry.process.stdout;
      if (stdout && typeof stdout !== "number") {
        const reader = stdout.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          entry.buffer += new TextDecoder().decode(value);
        }
      }
      const exitCode = await entry.process.exited;
      entry.exitCode = exitCode;
    } catch { /* process died */ }
    entry.exited = true;
    this.#notifications.push(`Background shell ${shellId} (\`${entry.command}\`) exited with code ${entry.exitCode ?? "unknown"}`);
  }
}
