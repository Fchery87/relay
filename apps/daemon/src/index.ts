import { hostname } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";

import { loadDaemonConfig } from "./config";
import { runQueuedTurn } from "./agent-loop";
import { runQueuedCommand } from "./command-worker";
import { DeepSeekChatProvider, OpenAIResponsesProvider, ScriptedModelProvider } from "./model-provider";
import { createConvexCommandGateway, createConvexConversationGateway, createConvexMachineGateway, MachineReporter } from "./relay-client";
import { ThreadWorktrees } from "./worktrees";

const config = loadDaemonConfig({ env: Bun.env, hostname });
const reporter = new MachineReporter({
  gateway: createConvexMachineGateway({ deploymentUrl: config.deploymentUrl }),
  registration: config.registration,
});

await reporter.connect();
console.info(`Relay daemon connected as ${config.registration.name}`);

setInterval(() => {
  void reporter.heartbeatOnce().catch((error: unknown) => {
    console.error("Relay heartbeat failed", error);
  });
}, config.heartbeatIntervalMs);

const conversationGateway = createConvexConversationGateway({ deploymentUrl: config.deploymentUrl });
const worktrees = new ThreadWorktrees({ daemonHome: Bun.env.RELAY_DAEMON_HOME ?? join(homedir(), ".relay") });
async function collectOrphanedWorktrees() {
  const activeThreadIds = new Set(await conversationGateway.listThreadIds());
  await worktrees.gc({ activeThreadIds });
}
await collectOrphanedWorktrees();
setInterval(() => void collectOrphanedWorktrees().catch((error: unknown) => console.error("Relay worktree GC failed", error)), 30_000);
const provider = Bun.env.RELAY_DEEPSEEK_API_KEY
  ? new DeepSeekChatProvider({ apiKey: Bun.env.RELAY_DEEPSEEK_API_KEY, model: Bun.env.RELAY_DEEPSEEK_MODEL ?? "deepseek-chat" })
  : Bun.env.RELAY_OPENAI_API_KEY
  ? new OpenAIResponsesProvider({ apiKey: Bun.env.RELAY_OPENAI_API_KEY, model: Bun.env.RELAY_OPENAI_MODEL ?? "gpt-4.1-mini" })
  : new ScriptedModelProvider({ chunks: ["Relay received your message."] });

setInterval(() => {
  void runQueuedTurn({
    deviceToken: config.registration.deviceToken,
    gateway: conversationGateway,
    provider,
    platform: config.registration.platform,
    resolveProjectRoot: (input) => worktrees.resolve(input),
  }).catch((error: unknown) => console.error("Relay turn failed", error));
}, 200);

const commandGateway = createConvexCommandGateway({ deploymentUrl: config.deploymentUrl });
setInterval(() => {
  void runQueuedCommand({ gateway: commandGateway, platform: config.registration.platform, resolveProjectRoot: (input) => worktrees.resolve(input) }).catch((error: unknown) => console.error("Relay command failed", error));
}, 200);
