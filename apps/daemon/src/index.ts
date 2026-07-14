import { hostname } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadDaemonConfig } from "./config";
import { resolveDaemonHome } from "./daemon-home";
import { loadDeviceCredentials } from "./device-credentials";
import { isDeviceTokenRejected } from "./device-auth";
import { runQueuedTurn } from "./agent-loop";
import { runQueuedCommand } from "./command-worker";
import { runQueuedGitAction } from "./git-worker";
import { runQueuedCheckpointRestore } from "./checkpoint-worker";
import { runQueuedCheckpointComparison } from "./checkpoint-comparison-worker";
import { ScriptedModelProvider } from "./model-provider";
import { createConvexCheckpointComparisonGateway, createConvexCheckpointGateway, createConvexCommandGateway, createConvexConversationGateway, createConvexGitGateway, createConvexGovernanceGateway, createConvexMachineGateway, createConvexMcpServerGateway, createConvexSubagentGateway, MachineReporter } from "./relay-client";
import { createNestedSubagentWorktree, integrateNestedSubagentWorktree, resolveSubagentParentRoot, ThreadWorktrees } from "./worktrees";
import { runQueuedSubagent } from "./subagent-worker";
import { loadPolicy } from "./policy";
import { LocalModelRouter } from "./catalog-provider-router";
import { McpRegistry } from "./mcp-registry";

export async function runDaemon(): Promise<void> {
const daemonHome = resolveDaemonHome({ env: Bun.env, homeDirectory: homedir(), platform: process.platform });
const storedCredentials = await loadDeviceCredentials({ daemonHome });
const config = loadDaemonConfig({ env: Bun.env, hostname, storedDeploymentUrl: storedCredentials?.deploymentUrl, storedDeviceToken: storedCredentials?.deviceToken });
const reporter = new MachineReporter({
  gateway: createConvexMachineGateway({ deploymentUrl: config.deploymentUrl }),
  registration: config.registration,
});

await reporter.connect();
console.info(`Relay daemon connected as ${config.registration.name}`);

setInterval(() => {
  void reporter.heartbeatOnce().catch((error: unknown) => {
    if (isDeviceTokenRejected(error)) {
      console.error("Relay device token is no longer active; stopping daemon.");
      void shutdown();
      return;
    }
    console.error("Relay heartbeat failed", error);
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
await subagentGateway.setCapabilityCeiling([...new Set(policy.rules.filter((rule) => rule.decision !== "deny").map((rule) => rule.capability))]);
let subagentRunning = false;
setInterval(() => {
  if (subagentRunning) return;
  subagentRunning = true;
  void runQueuedSubagent({ artifactRoot: daemonHome, createWriterRoot: (input) => createNestedSubagentWorktree({ daemonHome, ...input }), gateway: subagentGateway, governance, integrateWriterRoot: (input) => integrateNestedSubagentWorktree({ daemonHome, ...input }), platform: config.registration.platform, policy, provider, resolveParentRoot: (input) => resolveSubagentParentRoot({ daemonHome, ...input }), resolveProjectRoot: (input) => worktrees.resolve(input) })
    .catch((error: unknown) => console.error("Relay subagent failed", error))
    .finally(() => { subagentRunning = false; });
}, 200);
let nestedSubagentRunning = false;
setInterval(() => {
  if (nestedSubagentRunning) return;
  nestedSubagentRunning = true;
  void runQueuedSubagent({ artifactRoot: daemonHome, createWriterRoot: (input) => createNestedSubagentWorktree({ daemonHome, ...input }), gateway: nestedSubagentGateway, governance, integrateWriterRoot: (input) => integrateNestedSubagentWorktree({ daemonHome, ...input }), platform: config.registration.platform, policy, provider, resolveParentRoot: (input) => resolveSubagentParentRoot({ daemonHome, ...input }), resolveProjectRoot: (input) => worktrees.resolve(input) })
    .catch((error: unknown) => console.error("Relay nested subagent failed", error))
    .finally(() => { nestedSubagentRunning = false; });
}, 200);

setInterval(() => {
  void runQueuedTurn({
    deviceToken: config.registration.deviceToken,
    gateway: conversationGateway,
    governance,
    mcp,
    policy,
    provider,
    platform: config.registration.platform,
    resolveProjectRoot: (input) => worktrees.resolve(input),
  }).catch((error: unknown) => console.error("Relay turn failed", error));
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
  void runQueuedCommand({ gateway: commandGateway, governance, platform: config.registration.platform, policy, resolveProjectRoot: (input) => worktrees.resolve(input) })
    .catch((error: unknown) => console.error("Relay command failed", error))
    .finally(() => { commandRunning = false; });
}, 200);
}

if (import.meta.main) {
  runDaemon().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
