import { hostname } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadDaemonConfig } from "./config";
import { resolveDaemonHome } from "./daemon-home";
import { loadDeviceCredentials } from "./device-credentials";
import { listProjects } from "./project-store";
import { isDeviceTokenRejected } from "./device-auth";
import { KernelDaemon } from "./kernel-daemon";
import { resolveRuntimeMode, type RuntimeMode } from "./runtime-mode";
import { runQueuedTurn } from "./agent-loop";
import { runQueuedCommand } from "./command-worker";
import { runQueuedGitAction } from "./git-worker";
import { runQueuedCheckpointRestore } from "./checkpoint-worker";
import { runQueuedCheckpointComparison } from "./checkpoint-comparison-worker";
import { ScriptedModelProvider } from "./model-provider";
import { createConvexCheckpointComparisonGateway, createConvexCheckpointGateway, createConvexCommandGateway, createConvexConversationGateway, createConvexGitGateway, createConvexGovernanceGateway, createConvexMachineGateway, createConvexMcpServerGateway, createConvexProjectRequestGateway, createConvexSubagentGateway, MachineReporter } from "./relay-client";
import { createNestedSubagentWorktree, integrateNestedSubagentWorktree, resolveSubagentParentRoot, ThreadWorktrees } from "./worktrees";
import { runQueuedSubagent } from "./subagent-worker";
import { ALLOW_ALL_POLICY, loadPolicy } from "./policy";
import { LocalModelRouter } from "./catalog-provider-router";
import { McpRegistry } from "./mcp-registry";
import { runQueuedProjectRequest } from "./project-request-worker";
import { TrustStore } from "./trust";
import { loadSlashCommands } from "./slash-commands";
import { BUILTIN_COMMANDS } from "./builtin-commands";
import { resolveExtensionRoots } from "./extension-paths";

export async function runDaemon({ yolo = false }: { yolo?: boolean } = {}): Promise<void> {
const runtimeMode: RuntimeMode = resolveRuntimeMode(Bun.env);
const daemonHome = resolveDaemonHome({ env: Bun.env, homeDirectory: homedir(), platform: process.platform });
const storedCredentials = await loadDeviceCredentials({ daemonHome });
const projects = await listProjects({ daemonHome, env: Bun.env });
const config = loadDaemonConfig({ env: Bun.env, hostname, projects, storedDeploymentUrl: storedCredentials?.deploymentUrl, storedDeviceToken: storedCredentials?.deviceToken });
const reporter = new MachineReporter({
  gateway: createConvexMachineGateway({ deploymentUrl: config.deploymentUrl }),
  registration: config.registration,
});

const yoloMode = yolo || Bun.env.RELAY_YOLO === "1";

await reporter.connect();
if (yoloMode) console.warn("⚠️  YOLO MODE: all permission checks are bypassed. Every tool call is auto-approved.");
console.info(`Relay daemon connected as ${config.registration.name} (mode: ${runtimeMode})`);

// ---------------------------------------------------------------------------
// Setup: gateways, governance, policy, worktrees, provider, MCP
// (shared by legacy and kernel paths)
// ---------------------------------------------------------------------------

setInterval(() => {
  void reporter.heartbeatOnce().catch((error: unknown) => {
    if (isDeviceTokenRejected(error)) {
      console.error("Relay device token is no longer active; stopping daemon.");
      void shutdown();
      return;
    }
    console.error("Relay heartbeat failed", error);
  });
  void listProjects({ daemonHome, env: Bun.env }).then((current) => {
    void reporter.syncProjects(current).catch((error: unknown) => console.error("Relay project sync failed", error));
  });
}, config.heartbeatIntervalMs);

const conversationGateway = createConvexConversationGateway({ deploymentUrl: config.deploymentUrl, deviceToken: config.registration.deviceToken });
const governance = createConvexGovernanceGateway({ deploymentUrl: config.deploymentUrl, deviceToken: config.registration.deviceToken });
const policy = await loadPolicy({ path: Bun.env.RELAY_POLICY_PATH ?? join(import.meta.dir, "..", "policy.json") });
const worktrees = new ThreadWorktrees({ daemonHome });
async function collectOrphanedWorktrees() {
  const activeThreadIds = new Set(await conversationGateway.listThreadIds());
  await worktrees.gc({ activeThreadIds });
}
await collectOrphanedWorktrees();
setInterval(() => void collectOrphanedWorktrees().catch((error: unknown) => console.error("Relay worktree GC failed", error)), 30_000);
const provider = new LocalModelRouter({ env: Bun.env, fallbackProvider: new ScriptedModelProvider({ chunks: ["Relay received your message."] }) });
const mcp = new McpRegistry({ env: Bun.env, gateway: createConvexMcpServerGateway({ deploymentUrl: config.deploymentUrl, deviceToken: config.registration.deviceToken }), governance });

// -- Runtime mode branch ----------------------------------------------------
if (runtimeMode === "kernel") {
  const kernelDaemon = new KernelDaemon({
    daemonHome,
    deploymentUrl: config.deploymentUrl,
    deviceToken: config.registration.deviceToken,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    machineName: config.registration.name,
    adapterDeps: {
      resolveProjectRoot: (input) => worktrees.resolve(input),
      governance,
      policy,
      platform: config.registration.platform,
    },
  });
  await kernelDaemon.start();
  return; // kernel daemon owns the event loop; never returns until shutdown
}

if (runtimeMode === "shadow") {
  console.info("Shadow mode: running legacy + kernel side-by-side");
  const kernelDaemon = new KernelDaemon({
    daemonHome,
    deploymentUrl: config.deploymentUrl,
    deviceToken: config.registration.deviceToken,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    machineName: `${config.registration.name}-shadow`,
    adapterDeps: {
      resolveProjectRoot: (input) => worktrees.resolve(input),
      governance,
      policy,
      platform: config.registration.platform,
    },
  });
  void kernelDaemon.start().catch((error: unknown) =>
    console.error("Kernel daemon (shadow) crashed:", error),
  );
  // Fall through to legacy loop below
}

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await mcp.close();
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
const subagentGateway = createConvexSubagentGateway({ deploymentUrl: config.deploymentUrl, deviceToken: config.registration.deviceToken, depth: 1 });
const nestedSubagentGateway = createConvexSubagentGateway({ deploymentUrl: config.deploymentUrl, deviceToken: config.registration.deviceToken, depth: 2 });
await subagentGateway.seedDefaults();
const subagentPolicy = yoloMode ? ALLOW_ALL_POLICY : policy;
await subagentGateway.setCapabilityCeiling([...new Set(policy.rules.filter((rule) => rule.decision !== "deny" && rule.capability !== "search").map((rule) => rule.capability as "read" | "edit" | "exec" | "task"))]);
let subagentRunning = false;
setInterval(() => {
  if (subagentRunning) return;
  subagentRunning = true;
  void runQueuedSubagent({ artifactRoot: daemonHome, createWriterRoot: (input) => createNestedSubagentWorktree({ daemonHome, ...input }), gateway: subagentGateway, governance, integrateWriterRoot: (input) => integrateNestedSubagentWorktree({ daemonHome, ...input }), platform: config.registration.platform, policy: subagentPolicy, provider, resolveParentRoot: (input) => resolveSubagentParentRoot({ daemonHome, ...input }), resolveProjectRoot: (input) => worktrees.resolve(input) })
    .catch((error: unknown) => console.error("Relay subagent failed", error))
    .finally(() => { subagentRunning = false; });
}, 200);
let nestedSubagentRunning = false;
setInterval(() => {
  if (nestedSubagentRunning) return;
  nestedSubagentRunning = true;
  void runQueuedSubagent({ artifactRoot: daemonHome, createWriterRoot: (input) => createNestedSubagentWorktree({ daemonHome, ...input }), gateway: nestedSubagentGateway, governance, integrateWriterRoot: (input) => integrateNestedSubagentWorktree({ daemonHome, ...input }), platform: config.registration.platform, policy: subagentPolicy, provider, resolveParentRoot: (input) => resolveSubagentParentRoot({ daemonHome, ...input }), resolveProjectRoot: (input) => worktrees.resolve(input) })
    .catch((error: unknown) => console.error("Relay nested subagent failed", error))
    .finally(() => { nestedSubagentRunning = false; });
}, 200);

let turnRunning = false;
setInterval(() => {
  if (turnRunning) return;
  turnRunning = true;
  void runQueuedTurn({
    deviceToken: config.registration.deviceToken,
    gateway: conversationGateway,
    governance,
    mcp,
    policy: subagentPolicy,
    provider,
    platform: config.registration.platform,
    resolveProjectRoot: (input) => worktrees.resolve(input),
    resolveSlashCommands: async ({ projectPath }) => {
      const userCommands = await loadSlashCommands([{ root: join(daemonHome, "commands"), scope: "user" }]);
      const trustState = await trustStore.get(projectPath);
      if (trustState !== "trusted") return userCommands;
      const projectCommands = await loadSlashCommands([{ root: join(projectPath, ".relay", "commands"), scope: "project" }]);
      return [...projectCommands, ...userCommands];
    },
    trustStore,
    yolo: yoloMode,
  })
    .catch((error: unknown) => console.error("Relay turn failed", error))
    .finally(() => { turnRunning = false; });
}, 200);

const checkpointComparisonGateway = createConvexCheckpointComparisonGateway({ deploymentUrl: config.deploymentUrl, deviceToken: config.registration.deviceToken });
let checkpointComparisonRunning = false;
setInterval(() => {
  if (checkpointComparisonRunning) return;
  checkpointComparisonRunning = true;
  void runQueuedCheckpointComparison({ gateway: checkpointComparisonGateway, resolveProjectRoot: (input) => worktrees.resolve(input) })
    .catch((error: unknown) => console.error("Relay checkpoint comparison failed", error))
    .finally(() => { checkpointComparisonRunning = false; });
}, 200);
const gitGateway = createConvexGitGateway({ deploymentUrl: config.deploymentUrl, deviceToken: config.registration.deviceToken });
let gitActionRunning = false;
setInterval(() => {
  if (gitActionRunning) return;
  gitActionRunning = true;
  void runQueuedGitAction({ gateway: gitGateway, resolveProjectRoot: (input) => worktrees.resolve(input) })
    .catch((error: unknown) => console.error("Relay git action failed", error))
    .finally(() => { gitActionRunning = false; });
}, 200);

const checkpointGateway = createConvexCheckpointGateway({ deploymentUrl: config.deploymentUrl, deviceToken: config.registration.deviceToken });
let checkpointRestoreRunning = false;
setInterval(() => {
  if (checkpointRestoreRunning) return;
  checkpointRestoreRunning = true;
  void runQueuedCheckpointRestore({ gateway: checkpointGateway, resolveProjectRoot: (input) => worktrees.resolve(input) })
    .catch((error: unknown) => console.error("Relay checkpoint restore failed", error))
    .finally(() => { checkpointRestoreRunning = false; });
}, 200);

const commandGateway = createConvexCommandGateway({ deploymentUrl: config.deploymentUrl, deviceToken: config.registration.deviceToken });
let commandRunning = false;
setInterval(() => {
  if (commandRunning) return;
  commandRunning = true;
  void runQueuedCommand({ gateway: commandGateway, governance, platform: config.registration.platform, policy: subagentPolicy, resolveProjectRoot: (input) => worktrees.resolve(input) })
    .catch((error: unknown) => console.error("Relay command failed", error))
    .finally(() => { commandRunning = false; });
}, 200);

const projectRequestGateway = createConvexProjectRequestGateway({ deploymentUrl: config.deploymentUrl, deviceToken: config.registration.deviceToken });
const trustStore = new TrustStore({ daemonHome });

async function publishCatalog() {
  try {
    const projects = await listProjects({ daemonHome, env: Bun.env });
    const commands: Array<{ argumentHint?: string; description: string; name: string; projectPath?: string; scope: "builtin" | "project" | "user" | "skill" }> = [];

    // Built-in commands
    for (const cmd of BUILTIN_COMMANDS) {
      commands.push({ argumentHint: cmd.argumentHint, description: cmd.description, name: cmd.name, scope: "builtin" });
    }

    // User commands
    const userRoot = join(daemonHome, "commands");
    const userCommands = await loadSlashCommands([{ root: userRoot, scope: "user" }]);
    for (const cmd of userCommands) commands.push({ argumentHint: cmd.argumentHint, description: cmd.description, name: cmd.name, scope: "user" });

    // Project commands (trust-gated)
    for (const project of projects) {
      const trustState = await trustStore.get(project.path);
      if (trustState === "trusted") {
        const projectRoot = join(project.path, ".relay", "commands");
        const projectCommands = await loadSlashCommands([{ root: projectRoot, scope: "project" }]);
        for (const cmd of projectCommands) commands.push({ argumentHint: cmd.argumentHint, description: cmd.description, name: cmd.name, projectPath: project.path, scope: "project" });
      }
    }

    await (conversationGateway as any).publishCommandCatalog?.(commands);
  } catch (error) { console.warn("Failed to publish command catalog:", error); }
}

// Publish catalog on startup
void publishCatalog();

// Republish catalog periodically (e.g., when trust state changes or new commands are added)
setInterval(() => { void publishCatalog(); }, 60_000);

let projectRequestRunning = false;
setInterval(() => {
  if (projectRequestRunning) return;
  projectRequestRunning = true;
  void runQueuedProjectRequest({ daemonHome, env: Bun.env, gateway: projectRequestGateway })
    .catch((error: unknown) => console.error("Relay project request worker failed", error))
    .finally(() => { projectRequestRunning = false; });
}, 5_000);
}

if (import.meta.main) {
  runDaemon().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
