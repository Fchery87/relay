import { runConnect } from "./connect";
import { runDaemon } from "./index";

export type RelayCommand =
  | { command: "connect"; deploymentUrl?: string }
  | { command: "start" }
  | { command: "help" };

const usage = `Relay daemon\n\nUsage:\n  relay connect --url <convex-url>\n  relay start`;

export function parseCli(args: readonly string[]): RelayCommand {
  if (args.length === 0 || args[0] === "start") {
    if (args.length > 1) throw new Error("relay start does not accept arguments");
    return { command: "start" };
  }
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") return { command: "help" };
  if (args[0] !== "connect") throw new Error(`Unknown command: ${args[0]}`);
  if (args.length === 1) return { command: "connect" };
  if (args.length === 3 && args[1] === "--url") {
    const deploymentUrl = args[2];
    if (!deploymentUrl) throw new Error("--url requires a value");
    return { command: "connect", deploymentUrl };
  }
  throw new Error("Usage: relay connect --url <convex-url>");
}

export async function runCli(args: readonly string[], dependencies: { runConnect?: typeof runConnect; runDaemon?: () => Promise<void> } = {}): Promise<void> {
  const command = parseCli(args);
  if (command.command === "help") {
    console.info(usage);
    return;
  }
  if (command.command === "connect") {
    await (dependencies.runConnect ?? runConnect)({ deploymentUrl: command.deploymentUrl });
    return;
  }
  await (dependencies.runDaemon ?? runDaemon)();
}

if (import.meta.main) {
  runCli(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
