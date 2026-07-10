import { hostname } from "node:os";

import { loadDaemonConfig } from "./config";
import { runQueuedTurn } from "./agent-loop";
import { DeepSeekChatProvider, OpenAIResponsesProvider, ScriptedModelProvider } from "./model-provider";
import { createConvexConversationGateway, createConvexMachineGateway, MachineReporter } from "./relay-client";

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
  }).catch((error: unknown) => console.error("Relay turn failed", error));
}, 200);
