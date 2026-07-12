export type ThreadStatus = "idle" | "queued" | "running" | "awaiting-approval" | "stopped" | "done" | "failed";

export type ThreadMessage = {
  _id: string;
  content: string;
  role: "assistant" | "user";
  status: "complete" | "queued" | "streaming";
};

export function ThreadMessages({ messages }: { messages: readonly ThreadMessage[] }) {
  return <div aria-live="polite" aria-relevant="additions text" className="messages" role="log">{messages.map((message) => <p className={`message message-${message.role}${message.status === "queued" ? " message-pending" : ""}`} key={message._id}>
    {message.content || "..."}
    {message.status === "queued" ? <span className="pending-label" role="status">Queued</span> : null}
  </p>)}</div>;
}

export function ThreadRunControls({ onStop, status, stopRequested }: { onStop: () => Promise<unknown>; status: ThreadStatus; stopRequested: boolean }) {
  if (status === "stopped") return <span aria-live="polite" className="thread-stopped">Awaiting input</span>;
  if (status !== "running") return null;
  return <button className="stop-turn" disabled={stopRequested} onClick={() => void onStop()} type="button">{stopRequested ? "Stopping..." : "Stop"}</button>;
}
