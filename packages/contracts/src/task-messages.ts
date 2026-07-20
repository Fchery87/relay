import type { ArtifactId } from "./artifacts";
import type { TaskId } from "./tasks";
export type TaskMessage =
  | Readonly<{ type: "follow-up"; taskId: TaskId; text: string; createdAt: number }>
  | Readonly<{ type: "progress"; taskId: TaskId; completed: number; total: number; detail: string; createdAt: number }>
  | Readonly<{ type: "cancel"; taskId: TaskId; reason: string; createdAt: number }>
  | Readonly<{ type: "failed"; taskId: TaskId; error: string; createdAt: number }>
  | Readonly<{ type: "result"; taskId: TaskId; artifacts: readonly ArtifactId[]; summary: string; createdAt: number }>;
export function assertTaskMessage(message: TaskMessage): void { if (!message.taskId || !Number.isFinite(message.createdAt)) throw new Error("Invalid task message"); if (message.type === "progress" && (message.completed < 0 || message.total < message.completed)) throw new Error("Invalid task progress"); }
