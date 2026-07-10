import type { MachinePlatform } from "@relay/shared";

export function shellInvocation({ command, platform }: { command: string; platform: MachinePlatform }) {
  return platform === "win32"
    ? { executable: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", command] }
    : { executable: "bash", args: ["-lc", command] };
}
