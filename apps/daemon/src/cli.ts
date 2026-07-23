import { runConnect } from "./connect";
import { runDaemon } from "./index";
import { addProject, listProjects, removeProject } from "./project-store";
import { tmpdir, homedir } from "node:os";
import { resolveDaemonHome } from "./daemon-home";
import { basename, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { exportDaemonDiagnostics } from "./diagnostics";

export type RelayCommand =
  | { command: "connect"; deploymentUrl?: string }
  | { command: "start"; yolo: boolean }
  | { command: "project"; subcommand: "add" | "remove" | "list"; path?: string; name?: string }
  | { command: "help" }
  | { command: "doctor" }
  | { command: "diagnostics"; subcommand: "export"; path?: string };

const usage = `Relay daemon

Usage:
  relay connect --url <convex-url>
  relay start [--yolo | --dangerously-skip-permissions]
  relay project add [path] [--name <name>]
  relay project remove <path>
  relay project list
  relay doctor
  relay diagnostics export [path]`;

export function parseCli(args: readonly string[]): RelayCommand {
  if (args.length === 0 || args[0] === "start") {
    const yolo = args.includes("--yolo") || args.includes("--dangerously-skip-permissions");
    if (args.length > 1) {
      for (const arg of args.slice(1)) {
        if (arg !== "--yolo" && arg !== "--dangerously-skip-permissions") throw new Error(`Unknown option: ${arg}`);
      }
    }
    return { command: "start", yolo };
  }
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") return { command: "help" };
  if (args[0] === "doctor") return { command: "doctor" };
  if (args[0] === "diagnostics") {
    if (args[1] !== "export" || args.length > 3) throw new Error("Usage: relay diagnostics export [path]");
    return { command: "diagnostics", subcommand: "export", path: args[2] };
  }
  if (args[0] === "project") {
    const subcommand = args[1];
    if (subcommand === "add") {
      let name: string | undefined;
      let path: string | undefined;
      const remaining = args.slice(2);
      for (let i = 0; i < remaining.length; i++) {
        if (remaining[i] === "--name" && i + 1 < remaining.length) {
          name = remaining[i + 1]!;
          i++;
        } else if (!path) {
          path = remaining[i];
        }
      }
      return { command: "project", subcommand: "add", path, name };
    }
    if (subcommand === "remove") {
      if (args.length < 3) throw new Error("relay project remove requires a path");
      return { command: "project", subcommand: "remove", path: args[2] };
    }
    if (subcommand === "list") return { command: "project", subcommand: "list" };
    throw new Error(`Unknown project subcommand: ${subcommand}`);
  }
  if (args[0] !== "connect") throw new Error(`Unknown command: ${args[0]}`);
  if (args.length === 1) return { command: "connect" };
  if (args.length === 3 && args[1] === "--url") {
    const deploymentUrl = args[2];
    if (!deploymentUrl) throw new Error("--url requires a value");
    return { command: "connect", deploymentUrl };
  }
  throw new Error("Usage: relay connect --url <convex-url>");
}

export async function runCli(args: readonly string[], dependencies: { runConnect?: typeof runConnect; runDaemon?: (input?: { yolo?: boolean }) => Promise<void>; runDiagnostics?: (path?: string) => Promise<void> } = {}): Promise<void> {
  const command = parseCli(args);
  if (command.command === "help") { console.info(usage); return; }
  if (command.command === "doctor") { console.info(JSON.stringify({ ok: true, runtime: "kernel", platform: process.platform, bun: Bun.version })); return; }
  if (command.command === "diagnostics") { await (dependencies.runDiagnostics ?? exportDaemonDiagnostics)(command.path); return; }
  if (command.command === "connect") {
    await (dependencies.runConnect ?? runConnect)({ deploymentUrl: command.deploymentUrl });
    return;
  }
  if (command.command === "project") {
    const daemonHome = resolveDaemonHome({ env: Bun.env, homeDirectory: homedir(), platform: process.platform });
    if (command.subcommand === "list") {
      const projects = await listProjects({ daemonHome, env: Bun.env });
      for (const project of projects) console.info(`${project.name}\t${project.path}`);
      return;
    }
    if (command.subcommand === "add") {
      const resolvedPath = resolve(command.path ?? process.cwd());
      const name = command.name ?? basename(resolvedPath);
      const dirStat = await stat(resolvedPath);
      if (!dirStat.isDirectory()) throw new Error(`${resolvedPath} is not a directory`);
      await addProject({ daemonHome, env: Bun.env, name, path: resolvedPath });
      console.info(`Added project: ${name} (${resolvedPath})`);
      return;
    }
    if (command.subcommand === "remove") {
      await removeProject({ daemonHome, env: Bun.env, path: command.path! });
      console.info(`Removed project: ${command.path}`);
      return;
    }
    throw new Error(`Unknown project subcommand: ${(command as { subcommand: string }).subcommand}`);
  }
  await (dependencies.runDaemon ?? runDaemon)({ yolo: (command as { yolo: boolean }).yolo });
}

if (import.meta.main) {
  runCli(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
