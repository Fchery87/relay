import { describe, expect, test } from "bun:test";
import {
  BackgroundShellManager,
  type BackgroundShellResult,
} from "./background-shells";

async function waitForExit(
  manager: BackgroundShellManager,
  shellId: string,
  timeoutMs = 2_000,
): Promise<BackgroundShellResult> {
  const deadline = Date.now() + timeoutMs;
  let output = "";
  while (Date.now() < deadline) {
    const result = await manager.read({ shellId });
    output += result.output;
    if (result.exited) return { ...result, output };
    await Bun.sleep(10);
  }
  throw new Error(`Shell ${shellId} did not exit within ${timeoutMs}ms`);
}

describe("BackgroundShellManager", () => {
  test("start returns shellId and read returns output", async () => {
    const mgr = new BackgroundShellManager();
    const { shellId } = await mgr.start({ command: "echo hello", platform: "linux" });
    const result = await waitForExit(mgr, shellId);
    expect(result.exited).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("hello");
  });

  test("kill stops a running shell", async () => {
    const mgr = new BackgroundShellManager();
    const { shellId } = await mgr.start({ command: "sleep 10", platform: "linux" });
    await mgr.kill({ shellId });
    const result = await waitForExit(mgr, shellId);
    expect(result.exited).toBe(true);
  });

  test("drainExitNotifications reports exited shells", async () => {
    const mgr = new BackgroundShellManager();
    const { shellId } = await mgr.start({ command: "echo done", platform: "linux" });
    await waitForExit(mgr, shellId);
    const notifications = mgr.drainExitNotifications();
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[0]).toContain("exit");
  });

  test("max 8 concurrent shells", async () => {
    const mgr = new BackgroundShellManager();
    try {
      for (let i = 0; i < 8; i++) {
        await mgr.start({ command: "sleep 60", platform: "linux" });
      }
      await expect(mgr.start({ command: "sleep 1", platform: "linux" })).rejects.toThrow("Maximum");
    } finally {
      await mgr.shutdown();
    }
  });
});
