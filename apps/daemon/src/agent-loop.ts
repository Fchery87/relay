import type { ModelProvider } from "./model-provider";

export interface ConversationGateway {
  appendAssistantText(input: { content: string; messageId: string }): Promise<unknown>;
  beginAssistantMessage(input: { threadId: string }): Promise<string>;
  claimQueuedMessage(input: { deviceToken: string }): Promise<{ content: string; threadId: string } | null>;
  completeAssistantMessage(input: { messageId: string; threadId: string }): Promise<unknown>;
}

export async function runQueuedTurn({
  deviceToken,
  gateway,
  provider,
}: {
  deviceToken: string;
  gateway: ConversationGateway;
  provider: ModelProvider;
}): Promise<boolean> {
  const queued = await gateway.claimQueuedMessage({ deviceToken });
  if (!queued) return false;

  const messageId = await gateway.beginAssistantMessage({ threadId: queued.threadId });
  let content = "";
  for await (const chunk of provider.streamReply({ prompt: queued.content })) {
    content += chunk;
    await gateway.appendAssistantText({ content, messageId });
  }
  await gateway.completeAssistantMessage({ messageId, threadId: queued.threadId });
  return true;
}
