import { useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { DiffView } from "./diff-view";
import { GovernancePanel, type Approval, type AuditEntry } from "./governance-panel";
import { DEFAULT_MODEL_ID, type ThinkingLevel } from "@relay/shared";
import { ModelControls } from "./model-controls";

const listThreads = makeFunctionReference<"query", { projectId: string }, Array<{ _id: string; modelId?: string; thinkingLevel?: ThinkingLevel; title: string }>>("conversations:listProjectThreads");
const listMessages = makeFunctionReference<"query", { threadId: string }, Array<{ _id: string; content: string; role: "assistant" | "user"; status: string }>>("conversations:listThreadMessages");
const createThread = makeFunctionReference<"mutation", { projectId: string; title: string }, string>("conversations:createThread");
const sendUserMessage = makeFunctionReference<"mutation", { content: string; threadId: string }, string>("conversations:sendUserMessage");
const listEvents = makeFunctionReference<"query", { threadId: string }, Array<{ _id: string; kind: string; output?: string; summary?: string; tool?: string }>>("events:list");
const enqueueCommand = makeFunctionReference<"mutation", { command: string; threadId: string }, string>("commands:enqueue");
const latestDiff = makeFunctionReference<"query", { threadId: string }, { content: string } | null>("diffs:latest");
const enqueueGitAction = makeFunctionReference<"mutation", { action: "stage" | "commit" | "push"; message?: string; threadId: string }, string>("git_actions:enqueue");
const listGitActions = makeFunctionReference<"query", { threadId: string }, Array<{ _id: string; action: "stage" | "commit" | "push"; status: "queued" | "running" | "complete" | "failed" }>>("git_actions:listForThread");
const listDiffComments = makeFunctionReference<"query", { threadId: string }, Array<{ _id: string; content: string; endLine: number; filePath: string; resolved: boolean; startLine: number }>>("diff_comments:listForThread");
const createDiffComment = makeFunctionReference<"mutation", { content: string; endLine: number; filePath: string; startLine: number; threadId: string }, string>("diff_comments:create");
const listApprovals = makeFunctionReference<"query", { threadId: string }, Approval[]>("approvals:listForThread");
const resolveApproval = makeFunctionReference<"mutation", { approvalId: string; decision: "allow" | "deny" }, null>("approvals:resolve");
const listAudit = makeFunctionReference<"query", { threadId: string }, AuditEntry[]>("audit_log:listForThread");
const updateModelSelection = makeFunctionReference<"mutation", { modelId: string; thinkingLevel: ThinkingLevel; threadId: string }, null>("conversations:updateModelSelection");

export function ThreadView({ projectId }: { projectId: string }) {
  const threads = useQuery(listThreads, { projectId });
  const create = useMutation(createThread);
  const send = useMutation(sendUserMessage);
  const enqueue = useMutation(enqueueCommand);
  const enqueueGit = useMutation(enqueueGitAction);
  const createComment = useMutation(createDiffComment);
  const resolve = useMutation(resolveApproval);
  const updateSelection = useMutation(updateModelSelection);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [content, setContent] = useState("");
  const [command, setCommand] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const activeThreadId = threadId ?? threads?.[0]?._id;
  const activeThread = threads?.find((thread) => thread._id === activeThreadId);
  const messages = useQuery(listMessages, activeThreadId ? { threadId: activeThreadId } : "skip");
  const events = useQuery(listEvents, activeThreadId ? { threadId: activeThreadId } : "skip");
  const diff = useQuery(latestDiff, activeThreadId ? { threadId: activeThreadId } : "skip");
  const gitActions = useQuery(listGitActions, activeThreadId ? { threadId: activeThreadId } : "skip");
  const diffComments = useQuery(listDiffComments, activeThreadId ? { threadId: activeThreadId } : "skip");
  const approvals = useQuery(listApprovals, activeThreadId ? { threadId: activeThreadId } : "skip");
  const audit = useQuery(listAudit, activeThreadId ? { threadId: activeThreadId } : "skip");

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
    <div className="thread-toolbar">{activeThreadId ? <ModelControls modelId={activeThread?.modelId ?? DEFAULT_MODEL_ID} onChange={(selection) => updateSelection({ ...selection, threadId: activeThreadId })} thinkingLevel={activeThread?.thinkingLevel ?? "none"} /> : null}<button onClick={() => void startThread()} type="button">New thread</button></div>
    {activeThreadId ? <>
      <GovernancePanel approvals={approvals ?? []} audit={audit ?? []} onResolve={(input) => resolve(input)} />
      <div className="messages">{messages?.map((message) => <p className={`message message-${message.role}`} key={message._id}>{message.content || "..."}</p>)}</div>
      <div className="activity-layout">
        <section><h2>Activity</h2>{events?.filter((event) => event.kind === "tool.completed").map((event) => <p className="activity-line" key={event._id}>{event.tool}: {event.summary}</p>)}</section>
        <section className="terminal"><h2>Terminal</h2><pre>{events?.filter((event) => event.kind === "command.output").map((event) => event.output).join("") || "No command output."}</pre>
          <form className="command-form" onSubmit={(event) => void submitCommand(event)}><input aria-label="Command" onChange={(event) => setCommand(event.target.value)} value={command} /><button type="submit">Run</button></form>
        </section>
      </div>
      <section className="diff-panel"><h2>Changes</h2><DiffView comments={diffComments ?? []} content={diff?.content ?? "No changes."} onCreateComment={(input) => createComment({ ...input, threadId: activeThreadId })} />
        {diffComments?.some((comment) => !comment.resolved) ? <button className="address-comments" onClick={() => void send({ content: "Address the unresolved review comments.", threadId: activeThreadId })} type="button">Address comments</button> : null}
        <div className="ship-controls"><button onClick={() => void enqueueGit({ action: "stage", threadId: activeThreadId })} type="button">Stage all</button><input aria-label="Commit message" onChange={(event) => setCommitMessage(event.target.value)} value={commitMessage} /><button disabled={!commitMessage.trim()} onClick={() => void enqueueGit({ action: "commit", message: commitMessage.trim(), threadId: activeThreadId })} type="button">Commit</button><button onClick={() => void enqueueGit({ action: "push", threadId: activeThreadId })} type="button">Push</button></div>
        <p className="ship-status" aria-live="polite">{gitActions?.at(-1) ? `${gitActions.at(-1)?.action}: ${gitActions.at(-1)?.status}` : "No Git actions yet."}</p>
      </section>
      <form className="composer" onSubmit={(event) => void submit(event)}><textarea aria-label="Message" onChange={(event) => setContent(event.target.value)} value={content} /><button type="submit">Send</button></form>
    </> : <p className="workspace-state">Create a thread to begin.</p>}
  </section>;
}
