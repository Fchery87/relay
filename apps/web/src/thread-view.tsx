import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";

const listThreads = makeFunctionReference<"query", { projectId: string }, Array<{ _id: string; title: string }>>("conversations:listProjectThreads");
const listMessages = makeFunctionReference<"query", { threadId: string }, Array<{ _id: string; content: string; role: "assistant" | "user"; status: string }>>("conversations:listThreadMessages");
const createThread = makeFunctionReference<"mutation", { projectId: string; title: string }, string>("conversations:createThread");
const sendUserMessage = makeFunctionReference<"mutation", { content: string; threadId: string }, string>("conversations:sendUserMessage");
const listEvents = makeFunctionReference<"query", { threadId: string }, Array<{ _id: string; kind: string; output?: string; summary?: string; tool?: string }>>("events:list");
const enqueueCommand = makeFunctionReference<"mutation", { command: string; threadId: string }, string>("commands:enqueue");

export function ThreadView({ projectId }: { projectId: string }) {
  const threads = useQuery(listThreads, { projectId });
  const create = useMutation(createThread);
  const send = useMutation(sendUserMessage);
  const enqueue = useMutation(enqueueCommand);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [content, setContent] = useState("");
  const [command, setCommand] = useState("");
  const activeThreadId = threadId ?? threads?.[0]?._id;
  const messages = useQuery(listMessages, activeThreadId ? { threadId: activeThreadId } : "skip");
  const events = useQuery(listEvents, activeThreadId ? { threadId: activeThreadId } : "skip");

  async function startThread() {
    setThreadId(await create({ projectId, title: "New conversation" }));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!activeThreadId || !content.trim()) return;
    await send({ content: content.trim(), threadId: activeThreadId });
    setContent("");
  }
  async function submitCommand(event: FormEvent) {
    event.preventDefault();
    if (!activeThreadId || !command.trim()) return;
    await enqueue({ command: command.trim(), threadId: activeThreadId });
    setCommand("");
  }

  return <section className="thread-view">
    <div className="thread-toolbar"><button onClick={() => void startThread()} type="button">New thread</button></div>
    {activeThreadId ? <>
      <div className="messages">{messages?.map((message) => <p className={`message message-${message.role}`} key={message._id}>{message.content || "..."}</p>)}</div>
      <div className="activity-layout">
        <section><h2>Activity</h2>{events?.filter((event) => event.kind === "tool.completed").map((event) => <p className="activity-line" key={event._id}>{event.tool}: {event.summary}</p>)}</section>
        <section className="terminal"><h2>Terminal</h2><pre>{events?.filter((event) => event.kind === "command.output").map((event) => event.output).join("") || "No command output."}</pre>
          <form className="command-form" onSubmit={(event) => void submitCommand(event)}><input aria-label="Command" onChange={(event) => setCommand(event.target.value)} value={command} /><button type="submit">Run</button></form>
        </section>
      </div>
      <form className="composer" onSubmit={(event) => void submit(event)}><textarea aria-label="Message" onChange={(event) => setContent(event.target.value)} value={content} /><button type="submit">Send</button></form>
    </> : <p className="workspace-state">Create a thread to begin.</p>}
  </section>;
}
