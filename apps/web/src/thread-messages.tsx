export type ThreadStatus = "idle" | "queued" | "running" | "awaiting-approval" | "restoring" | "stopped" | "done" | "failed";

export type ThreadMessage = {
  _id: string;
  content: string;
  role: "assistant" | "user";
  status: "complete" | "queued" | "streaming";
};

export type ThreadCheckpoint = { _id: string; messageId: string };

export function ThreadMessages({ checkpoints = [], messages, onRestore }: { checkpoints?: readonly ThreadCheckpoint[]; messages: readonly ThreadMessage[]; onRestore?: (checkpointId: string) => Promise<unknown> }) {
  const checkpointByMessage = new Map(checkpoints.map((checkpoint) => [checkpoint.messageId, checkpoint]));
  return <div aria-live="polite" aria-relevant="additions text" className="messages" role="log">{messages.map((message) => {
    const checkpoint = checkpointByMessage.get(message._id);
    return <div className={`message message-${message.role}${message.status === "queued" ? " message-pending" : ""}`} key={message._id}>
    <span>{message.content || "..."}</span>
    {message.status === "queued" ? <span className="pending-label" role="status">Queued</span> : null}
    {checkpoint && onRestore ? <button aria-label="Restore checkpoint for this turn" className="checkpoint-restore" onClick={() => void onRestore(checkpoint._id)} type="button">Restore</button> : null}
  </div>;
  })}</div>;
}

export function ThreadRunControls({ onStop, status, stopRequested }: { onStop: () => Promise<unknown>; status: ThreadStatus; stopRequested: boolean }) {
  if (status === "restoring") return <span aria-live="polite" className="thread-stopped">Restoring...</span>;
  if (status === "stopped") return <span aria-live="polite" className="thread-stopped">Awaiting input</span>;
  if (status !== "running") return null;
  return <button className="stop-turn" disabled={stopRequested} onClick={() => void onStop()} type="button">{stopRequested ? "Stopping..." : "Stop"}</button>;
}
