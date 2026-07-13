import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { DiffView } from "./diff-view";
import { GovernancePanel, type Approval, type AuditEntry } from "./governance-panel";
import { DEFAULT_MODEL_ID, type ThinkingLevel } from "@relay/shared";
import { ModelControls } from "./model-controls";
import { EMPTY_USAGE_SUMMARY, UsagePanel, type UsageSummary } from "./usage-panel";
import { ThreadMessages, ThreadRunControls, type ThreadCheckpoint, type ThreadMessage, type ThreadStatus } from "./thread-messages";
import { CheckpointComparison } from "./checkpoint-comparison";

const listThreads = makeFunctionReference<"query", { projectId: string }, Array<{ _id: string; modelId?: string; status: ThreadStatus; stopRequested?: boolean; thinkingLevel?: ThinkingLevel; title: string }>>("conversations:listProjectThreads");
const listMessages = makeFunctionReference<"query", { threadId: string }, ThreadMessage[]>("conversations:listThreadMessages");
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
const getThreadUsage = makeFunctionReference<"query", { threadId: string }, UsageSummary | null>("usage:forThread");
const setThreadBudget = makeFunctionReference<"mutation", { budgetUsd: number | null; threadId: string }, null>("usage:setBudget");
const requestThreadStop = makeFunctionReference<"mutation", { threadId: string }, null>("conversations:requestStop");
const listCheckpoints = makeFunctionReference<"query", { threadId: string }, ThreadCheckpoint[]>("checkpoints:listForThread");
const enqueueCheckpointRestore = makeFunctionReference<"mutation", { checkpointId: string; threadId: string }, string>("checkpoints:enqueueRestore");
const enqueueCheckpointComparison = makeFunctionReference<"mutation", { fromCheckpointId: string; threadId: string; toCheckpointId: string }, string>("checkpoints:enqueueComparison");
const latestCheckpointComparison = makeFunctionReference<"query", { threadId: string }, { _id: string; content?: string; status: "queued" | "running" | "complete" | "failed" } | null>("checkpoints:latestComparison");

export function ThreadView({ projectId }: { projectId: string }) {
  const threads = useQuery(listThreads, { projectId });
  const create = useMutation(createThread);
  const send = useMutation(sendUserMessage);
  const enqueue = useMutation(enqueueCommand);
  const enqueueGit = useMutation(enqueueGitAction);
  const createComment = useMutation(createDiffComment);
  const resolve = useMutation(resolveApproval);
  const updateSelection = useMutation(updateModelSelection);
  const setBudget = useMutation(setThreadBudget);
  const stop = useMutation(requestThreadStop);
  const restoreCheckpoint = useMutation(enqueueCheckpointRestore);
  const compareCheckpoints = useMutation(enqueueCheckpointComparison);
  const [threadId, setThreadId] = useState<string | undefined>();
  const [content, setContent] = useState("");
  const [command, setCommand] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [showComparison, setShowComparison] = useState(false);
  const [requestedComparisonId, setRequestedComparisonId] = useState<string | undefined>();
  const activeThreadId = threadId ?? threads?.[0]?._id;
  const activeThread = threads?.find((thread) => thread._id === activeThreadId);
  const messages = useQuery(listMessages, activeThreadId ? { threadId: activeThreadId } : "skip");
  const events = useQuery(listEvents, activeThreadId ? { threadId: activeThreadId } : "skip");
  const diff = useQuery(latestDiff, activeThreadId ? { threadId: activeThreadId } : "skip");
  const gitActions = useQuery(listGitActions, activeThreadId ? { threadId: activeThreadId } : "skip");
  const diffComments = useQuery(listDiffComments, activeThreadId ? { threadId: activeThreadId } : "skip");
  const approvals = useQuery(listApprovals, activeThreadId ? { threadId: activeThreadId } : "skip");
  const audit = useQuery(listAudit, activeThreadId ? { threadId: activeThreadId } : "skip");
  const usage = useQuery(getThreadUsage, activeThreadId ? { threadId: activeThreadId } : "skip");
  const checkpoints = useQuery(listCheckpoints, activeThreadId ? { threadId: activeThreadId } : "skip");
  const comparison = useQuery(latestCheckpointComparison, activeThreadId ? { threadId: activeThreadId } : "skip");
  const activeComparison = comparison?._id === requestedComparisonId ? comparison : null;
  useEffect(() => {
    setShowComparison(false);
    setRequestedComparisonId(undefined);
  }, [activeThreadId]);

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
    <div className="thread-toolbar">{activeThreadId && activeThread ? <><ThreadRunControls onStop={() => stop({ threadId: activeThreadId })} status={activeThread.status} stopRequested={activeThread.stopRequested ?? false} /><UsagePanel key={`${activeThreadId}:${usage?.budgetUsd ?? "none"}`} onBudgetChange={(budgetUsd) => setBudget({ budgetUsd, threadId: activeThreadId })} value={usage ?? EMPTY_USAGE_SUMMARY} /><ModelControls modelId={activeThread.modelId ?? DEFAULT_MODEL_ID} onChange={(selection) => updateSelection({ ...selection, threadId: activeThreadId })} thinkingLevel={activeThread.thinkingLevel ?? "none"} /></> : null}<button onClick={() => void startThread()} type="button">New thread</button></div>
    {activeThreadId ? <>
      <GovernancePanel approvals={approvals ?? []} audit={audit ?? []} onResolve={(input) => resolve(input)} />
      <ThreadMessages checkpoints={checkpoints ?? []} messages={messages ?? []} onRestore={activeThread?.status === "running" || activeThread?.status === "awaiting-approval" || activeThread?.status === "restoring" ? undefined : (checkpointId) => restoreCheckpoint({ checkpointId, threadId: activeThreadId })} />
      <div className="activity-layout">
        <section><h2>Activity</h2>{events?.filter((event) => event.kind === "tool.completed" || event.kind === "checkpoint.reverted").map((event) => <p className="activity-line" key={event._id}>{event.kind === "checkpoint.reverted" ? "Checkpoint restored" : `${event.tool}: ${event.summary}`}</p>)}</section>
        <section className="terminal"><h2>Terminal</h2><pre>{events?.filter((event) => event.kind === "command.output").map((event) => event.output).join("") || "No command output."}</pre>
          <form className="command-form" onSubmit={(event) => void submitCommand(event)}><input aria-label="Command" onChange={(event) => setCommand(event.target.value)} value={command} /><button type="submit">Run</button></form>
        </section>
      </div>
      <section className="diff-panel"><h2>Changes</h2><CheckpointComparison checkpoints={checkpoints ?? []} onCompare={async (input) => { const comparisonId = await compareCheckpoints({ ...input, threadId: activeThreadId }); setRequestedComparisonId(comparisonId); setShowComparison(true); }} />{showComparison ? <button className="current-diff" onClick={() => setShowComparison(false)} type="button">Current changes</button> : null}<p aria-live="polite" className="comparison-status">{showComparison ? `Comparison: ${activeComparison?.status ?? "queued"}` : ""}</p><DiffView comments={showComparison ? [] : diffComments ?? []} content={showComparison && activeComparison?.status === "complete" ? activeComparison.content ?? "No differences." : diff?.content ?? "No changes."} onCreateComment={showComparison ? undefined : (input) => createComment({ ...input, threadId: activeThreadId })} />
        {!showComparison && diffComments?.some((comment) => !comment.resolved) ? <button className="address-comments" onClick={() => void send({ content: "Address the unresolved review comments.", threadId: activeThreadId })} type="button">Address comments</button> : null}
        <div className="ship-controls"><button onClick={() => void enqueueGit({ action: "stage", threadId: activeThreadId })} type="button">Stage all</button><input aria-label="Commit message" onChange={(event) => setCommitMessage(event.target.value)} value={commitMessage} /><button disabled={!commitMessage.trim()} onClick={() => void enqueueGit({ action: "commit", message: commitMessage.trim(), threadId: activeThreadId })} type="button">Commit</button><button onClick={() => void enqueueGit({ action: "push", threadId: activeThreadId })} type="button">Push</button></div>
        <p className="ship-status" aria-live="polite">{gitActions?.at(-1) ? `${gitActions.at(-1)?.action}: ${gitActions.at(-1)?.status}` : "No Git actions yet."}</p>
      </section>
      <form className="composer" onSubmit={(event) => void submit(event)}><textarea aria-label="Message" onChange={(event) => setContent(event.target.value)} value={content} /><button type="submit">Send</button></form>
    </> : <p className="workspace-state">Create a thread to begin.</p>}
  </section>;
}
