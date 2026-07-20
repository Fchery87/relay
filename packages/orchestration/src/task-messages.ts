import type { EffectIntent, TaskId } from "@relay/contracts";
import type { TaskMessage } from "@relay/contracts";
import { assertTaskMessage } from "@relay/contracts";

/** Translate a parent task follow-up message into a child creation effect. */
export function followUpEffect(message: TaskMessage & { type: "follow-up" }): EffectIntent {
  assertTaskMessage(message);
  return { kind: "workflow.create_child", workflowKind: "follow-up", input: { taskId: message.taskId, text: message.text } };
}

/** Translate a cancel message into a durable completion effect. */
export function cancelEffect(message: TaskMessage & { type: "cancel" }): EffectIntent {
  assertTaskMessage(message);
  return { kind: "workflow.complete_child", childId: message.taskId as TaskId, result: { cancelled: true, reason: message.reason } };
}

/** Progress messages are diagnostic-only and do not generate effects. */
export function isDiagnosticMessage(message: TaskMessage): boolean {
  return message.type === "progress";
}
