import { useEffect, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useMutation, useQuery } from "convex/react";
import { makeFunctionReference } from "convex/server";
import { DiffView } from "./diff-view";
import { GovernancePanel, type Approval, type AuditEntry } from "./governance-panel";
import { DEFAULT_MODEL_ID, type ThinkingLevel } from "@relay/shared";
import { EMPTY_USAGE_SUMMARY, type UsageSummary } from "./usage-panel";
import { ThreadMessages, ThreadRunControls, type ThreadCheckpoint, type ThreadMessage, type ThreadStatus } from "./thread-messages";
import { CheckpointComparison } from "./checkpoint-comparison";
import { type SubagentRun } from "./subagent-panel";
import { PlanPanel, type PlanArtifact, type PlanPhase } from "./plan-panel";
import { McpElicitationCards, type McpElicitation } from "./mcp-elicitation-card";
import { type ThreadEvent } from "./thread-activity";
import { resolveHandoffStage } from "./handoff-trace";
import { Composer } from "./composer";
import { InspectorPanel } from "./inspector";
import { TerminalDrawer } from "./terminal-drawer";
import { createThreadRef, legacyRunData, updatePermissionProfileRef, type LegacyRunSummary, type PermissionProfile } from "./run-data";
import { resolveWorkbenchView } from "./router";
import { WorkbenchTabs, type WorkbenchTab } from "./workbench-tabs";
import { formatOutgoingMessage, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS, type TextAttachment } from "./message-attachments";
import { GitActionConfirmation, type GitAction } from "./git-action-confirmation";
import { ContextInspector } from "./context-inspector";

const listThreads = legacyRunData.listRuns;
const listMessages = makeFunctionReference<"query", { threadId: string }, ThreadMessage[]>("conversations:listThreadMessages");
const sendUserMessage = makeFunctionReference<"mutation", { content: string; threadId: string }, string>("conversations:sendUserMessage");
const listEvents = makeFunctionReference<"query", { threadId: string }, ThreadEvent[]>("events:list");
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
const listSubagentTree = makeFunctionReference<"query", { threadId: string }, SubagentRun[]>("subagents:listTree");
const getPlan = makeFunctionReference<"query", { threadId: string }, PlanArtifact | null>("plans:getForThread");
const updatePlanModels = makeFunctionReference<"mutation", { buildModelId: string; planModelId: string; threadId: string }, null>("plans:updateModelPair");
const updatePlanDraft = makeFunctionReference<"mutation", { content: string; expectedRevision: number; threadId: string }, null>("plans:updateDraft");
const approvePlan = makeFunctionReference<"mutation", { content: string; expectedRevision: number; threadId: string }, null>("plans:approve");
const listMcpElicitations = makeFunctionReference<"query", { threadId: string }, McpElicitation[]>("mcp_elicitations:listForThread");
const submitMcpElicitation = makeFunctionReference<"mutation", { elicitationId: string; responseJson: string }, null>("mcp_elicitations:submit");
const cancelMcpElicitation = makeFunctionReference<"mutation", { elicitationId: string }, null>("mcp_elicitations:cancel");

const STAGE_LABELS: Record<ReturnType<typeof resolveHandoffStage>, string> = {
  deliver: "Deliver",
  execute: "Execute",
  plan: "Plan",
  request: "Request",
  review: "Review",
};

export function ThreadView({
  capabilityCeiling = [],
  inspectorOpen,
  machineName,
  onToggleInspector,
  onToggleSidebar,
  onToggleTerminal,
  projectId,
  projectName,
  requestedThreadId,
  terminalOpen,
}: {
  capabilityCeiling?: ReadonlyArray<"read" | "edit" | "exec" | "task">;
  inspectorOpen: boolean;
  machineName: string;
  onToggleInspector: () => void;
  onToggleSidebar: () => void;
  onToggleTerminal: () => void;
  projectId: string;
  projectName: string;
  requestedThreadId?: string;
  terminalOpen: boolean;
}) {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { view?: unknown };
  const threads = useQuery(listThreads, { projectId }) as LegacyRunSummary[] | undefined;
  const create = useMutation(createThreadRef);
  const send = useMutation(sendUserMessage);
  const enqueue = useMutation(enqueueCommand);
  const enqueueGit = useMutation(enqueueGitAction);
  const createComment = useMutation(createDiffComment);
  const resolve = useMutation(resolveApproval);
  const updateSelection = useMutation(updateModelSelection);
  const updatePermission = useMutation(updatePermissionProfileRef);
  const setBudget = useMutation(setThreadBudget);
  const stop = useMutation(requestThreadStop);
  const restoreCheckpoint = useMutation(enqueueCheckpointRestore);
  const compareCheckpoints = useMutation(enqueueCheckpointComparison);
  const savePlanModels = useMutation(updatePlanModels);
  const savePlanDraft = useMutation(updatePlanDraft);
  const approve = useMutation(approvePlan);
  const submitElicitation = useMutation(submitMcpElicitation);
  const cancelElicitation = useMutation(cancelMcpElicitation);
  const [content, setContent] = useState("");
  const [command, setCommand] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [pendingGitAction, setPendingGitAction] = useState<GitAction>();
  const [showComparison, setShowComparison] = useState(false);
  const [requestedComparisonId, setRequestedComparisonId] = useState<string | undefined>();
  const requestedView = resolveWorkbenchView(search.view);
  const [toolSurface, setToolSurfaceState] = useState<WorkbenchTab>(requestedView ?? "session");
  const [showMobileTools, setShowMobileTools] = useState(false);
  const [attachments, setAttachments] = useState<ReadonlyArray<TextAttachment>>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [isSubmittingDirective, setIsSubmittingDirective] = useState(false);
  const [directiveReceipt, setDirectiveReceipt] = useState<"accepted" | "failed" | undefined>();
  const activeThreadId = requestedThreadId ?? threads?.[0]?._id;
  const activeThread = threads?.find((thread) => thread._id === activeThreadId);
  const requestedThreadMissing = Boolean(requestedThreadId && threads && !activeThread);
  const isPlanRun = activeThread?.mode === "plan";
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
  const subagentRuns = useQuery(listSubagentTree, activeThreadId ? { threadId: activeThreadId } : "skip");
  const plan = useQuery(getPlan, isPlanRun && activeThreadId ? { threadId: activeThreadId } : "skip");
  const mcpElicitations = useQuery(listMcpElicitations, activeThreadId ? { threadId: activeThreadId } : "skip");
  useEffect(() => {
    setShowComparison(false);
    setShowMobileTools(false);
    setRequestedComparisonId(undefined);
    if (requestedView) setToolSurfaceState(requestedView);
    else if (isPlanRun) setToolSurfaceState("plan");
  }, [activeThreadId, isPlanRun, requestedView]);

  function setToolSurface(view: WorkbenchTab) {
    setToolSurfaceState(view);
    void navigate({ to: requestedThreadId ? "/projects/$projectId/threads/$threadId" : "/projects/$projectId", params: requestedThreadId ? { projectId, threadId: requestedThreadId } : { projectId }, search: { view }, replace: true });
  }

  async function startThread(mode: "chat" | "plan" = "chat") {
    const threadId = await create({ mode, projectId, title: mode === "plan" ? "Untitled plan" : "Untitled task" });
    void navigate({ to: "/projects/$projectId/threads/$threadId", params: { projectId, threadId }, search: { view: mode === "plan" ? "plan" : "session" } });
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const outgoingContent = formatOutgoingMessage(content, attachments);
    if (!activeThreadId || !outgoingContent) return;
    if (isSubmittingDirective) return;
    setIsSubmittingDirective(true);
    setDirectiveReceipt(undefined);
    try {
      await send({ content: outgoingContent, threadId: activeThreadId });
      setContent("");
      setAttachments([]);
      setAttachmentError(undefined);
      setDirectiveReceipt("accepted");
    } catch {
      setDirectiveReceipt("failed");
    } finally {
      setIsSubmittingDirective(false);
    }
  }
  async function attachFiles(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const availableSlots = MAX_ATTACHMENTS - attachments.length;
    const selectedFiles = Array.from(input.files ?? []).slice(0, availableSlots);
    const oversizedFile = selectedFiles.find((file) => file.size > MAX_ATTACHMENT_BYTES);

    if (availableSlots === 0) {
      setAttachmentError(`Attach up to ${MAX_ATTACHMENTS} files.`);
    } else if (oversizedFile) {
      setAttachmentError(`${oversizedFile.name} exceeds the 128 KB text-file limit.`);
    } else {
      const selectedAttachments = await Promise.all(selectedFiles.map(async (file) => ({ content: await file.text(), name: file.name })));
      setAttachments((current) => [...current, ...selectedAttachments].slice(0, MAX_ATTACHMENTS));
      setAttachmentError(undefined);
    }
    input.value = "";
  }
  async function submitCommand(event: FormEvent) {
    event.preventDefault();
    if (!activeThreadId || !command.trim()) return;
    await enqueue({ command: command.trim(), threadId: activeThreadId });
    setCommand("");
  }

  const hasPlan = isPlanRun && activeThread?.planPhase !== undefined;
  const activeToolSurface = toolSurface === "plan" && !hasPlan ? "session" : toolSurface;
  const pendingApprovalCount = (approvals ?? []).filter((approval) => approval.decision === "pending").length;
  const currentStage = activeThread ? resolveHandoffStage({
    hasPendingApproval: pendingApprovalCount > 0,
    mode: activeThread.mode ?? "chat",
    planPhase: activeThread.planPhase,
    status: activeThread.status,
  }) : "request";

  const activeStatus = activeThread?.status ?? "idle";
  const latestGitAction = gitActions?.at(-1);
  const needsOperator = activeStatus === "awaiting-approval" || (isPlanRun && activeThread?.planPhase === "review");
  const permissionProfile: PermissionProfile = activeThread?.permissionProfile ?? "workspace-write";

  if (requestedThreadMissing) return <section className="task-empty-state" role="status"><span aria-hidden="true" className="empty-contact">◇</span><h2>Run not available</h2><p>This run is unavailable or does not belong to the selected project.</p><button onClick={() => void navigate({ to: "/projects/$projectId", params: { projectId }, search: {} })} type="button">View project runs</button></section>;

  const inspector = activeThread ? (
    <InspectorPanel
      capabilityCeiling={capabilityCeiling}
      currentStage={currentStage}
      machineName={machineName}
      onBudgetChange={activeThreadId ? (budgetUsd) => setBudget({ budgetUsd, threadId: activeThreadId }) : undefined}
      onShowApprovals={() => setToolSurface("session")}
      pendingApprovalCount={pendingApprovalCount}
      permissionProfile={permissionProfile}
      projectName={projectName}
      subagentRuns={subagentRuns ?? []}
      usage={usage ?? EMPTY_USAGE_SUMMARY}
    />
  ) : null;

  return <section className="thread-view">
    <header className="run-bar">
      <button aria-label="Toggle sidebar" className="run-bar-toggle" onClick={onToggleSidebar} title="Toggle sidebar (⌘B)" type="button"><span aria-hidden="true">▤</span></button>
      <div className="run-bar-identity">
        <h1>{activeThread?.title ?? "No active task"}</h1>
        {activeThread ? (
          <span className="run-bar-status" data-needs-operator={needsOperator || undefined} data-thread-status={activeThread.status}>
            <span aria-hidden="true">●</span> {activeThread.status.replace("-", " ")} · {STAGE_LABELS[currentStage]}
          </span>
        ) : (
          <span className="run-bar-status">Create a task to begin</span>
        )}
      </div>
      <div className="run-bar-actions">
        {activeThreadId && activeThread ? <ThreadRunControls onStop={() => stop({ threadId: activeThreadId })} status={activeThread.status} stopRequested={activeThread.stopRequested ?? false} /> : null}
        <button aria-label="Toggle terminal drawer" aria-pressed={terminalOpen} className="run-bar-toggle" onClick={onToggleTerminal} title="Toggle terminal (⌘J)" type="button"><span aria-hidden="true">▥</span></button>
        <button aria-label="Toggle inspector" aria-pressed={inspectorOpen} className="run-bar-toggle" onClick={onToggleInspector} title="Toggle inspector (⌘I)" type="button"><span aria-hidden="true">▦</span></button>
      </div>
    </header>
    {activeThreadId ? <>
      <WorkbenchTabs active={activeToolSurface} onChange={setToolSurface} showPlan={hasPlan} />
      <div className="thread-workbench" data-inspector-open={inspectorOpen}>
        <div className="task-canvas-column">
          <section aria-label="Task canvas" aria-labelledby={`workbench-tab-${activeToolSurface}`} className="run-surface" id="workbench-panel" role="tabpanel">
            {activeToolSurface === "session" ? <>
              <McpElicitationCards items={mcpElicitations ?? []} onCancel={(elicitationId) => cancelElicitation({ elicitationId })} onSubmit={(input) => submitElicitation(input)} />
              <GovernancePanel approvals={approvals ?? []} audit={audit ?? []} onResolve={(input) => resolve(input)} />
              <ThreadMessages checkpoints={checkpoints ?? []} messages={messages ?? []} onRestore={activeThread?.status === "running" || activeThread?.status === "awaiting-approval" || activeThread?.status === "restoring" ? undefined : (checkpointId) => restoreCheckpoint({ checkpointId, threadId: activeThreadId })} />
            </> : null}
            {activeToolSurface === "changes" ? <section className="diff-panel"><header className="panel-heading"><div><span>Review workspace</span><h2>Changes</h2></div><strong>{diffComments?.filter((comment) => !comment.resolved).length ?? 0} unresolved</strong></header><CheckpointComparison checkpoints={checkpoints ?? []} onCompare={async (input) => { const comparisonId = await compareCheckpoints({ ...input, threadId: activeThreadId }); setRequestedComparisonId(comparisonId); setShowComparison(true); }} />{showComparison ? <button className="current-diff" onClick={() => setShowComparison(false)} type="button">Current changes</button> : null}<p aria-live="polite" className="comparison-status">{showComparison ? `Comparison: ${activeComparison?.status ?? "queued"}` : ""}</p><DiffView comments={showComparison ? [] : diffComments ?? []} content={showComparison && activeComparison?.status === "complete" ? activeComparison.content ?? "No differences." : diff?.content ?? "No changes."} onCreateComment={showComparison ? undefined : (input) => createComment({ ...input, threadId: activeThreadId })} />
              {!showComparison && diffComments?.some((comment) => !comment.resolved) ? <button className="address-comments" onClick={() => void send({ content: "Address the unresolved review comments.", threadId: activeThreadId })} type="button">Address comments</button> : null}
              <div className="ship-controls"><button onClick={() => setPendingGitAction("stage")} type="button">Stage all</button><input aria-label="Commit message" onChange={(event) => setCommitMessage(event.target.value)} placeholder="Commit message" value={commitMessage} /><button disabled={!commitMessage.trim()} onClick={() => setPendingGitAction("commit")} type="button">Commit</button><button onClick={() => setPendingGitAction("push")} type="button">Push</button></div>
              <p className="ship-status" aria-live="polite">{latestGitAction ? `${latestGitAction.action}: ${latestGitAction.status}` : "No Git actions yet."}</p>
            </section> : null}
            {activeToolSurface === "plan" && isPlanRun && activeThread?.planPhase ? <PlanPanel buildModelId={activeThread.buildModelId ?? DEFAULT_MODEL_ID} canConfigureModels={activeThread.status === "idle"} onApprove={(input) => approve({ ...input, threadId: activeThreadId })} onModelPairChange={(input) => savePlanModels({ ...input, threadId: activeThreadId })} onUpdateDraft={(input) => savePlanDraft({ ...input, threadId: activeThreadId })} plan={plan ?? null} planModelId={activeThread.planModelId ?? DEFAULT_MODEL_ID} phase={activeThread?.planPhase ?? "planning"} /> : null}
          </section>
          <TerminalDrawer command={command} events={events ?? []} onCommandChange={setCommand} onSubmitCommand={submitCommand} open={terminalOpen} />
          {isPlanRun && activeThread?.planPhase === "review" ? null : (
            <Composer
              attachmentError={attachmentError}
              attachments={attachments}
              content={content}
              isPlanRun={isPlanRun}
              isSubmitting={isSubmittingDirective}
              modelId={activeThread?.modelId ?? DEFAULT_MODEL_ID}
              onAttachFiles={attachFiles}
              onContentChange={setContent}
              onModelChange={(selection) => activeThreadId ? updateSelection({ ...selection, threadId: activeThreadId }) : Promise.resolve(null)}
              onPermissionChange={(profile) => activeThreadId ? updatePermission({ permissionProfile: profile, threadId: activeThreadId }) : Promise.resolve(null)}
              onRemoveAttachment={(index) => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}
              onSubmit={submit}
              permissionProfile={permissionProfile}
              receipt={directiveReceipt}
              status={activeStatus}
              thinkingLevel={activeThread?.thinkingLevel ?? "none"}
            />
          )}
        </div>
        <button aria-controls="contextual-workbench" aria-expanded={showMobileTools} className="mobile-tools-toggle" onClick={() => setShowMobileTools((open) => !open)} type="button">{showMobileTools ? "Hide inspector" : "Inspect run"}</button>
        {inspectorOpen ? (
          <aside aria-label="Context inspector" className="tool-surface context-inspector" id="contextual-workbench">
            <header className="inspector-heading"><div><span>Inspector</span><strong>{activeThread?.title ?? "Run context"}</strong></div></header>
            {inspector}
          </aside>
        ) : null}
        <ContextInspector open={showMobileTools} onClose={() => setShowMobileTools(false)} title="Run context">
          {inspector}
        </ContextInspector>
      </div>
      <GitActionConfirmation action={pendingGitAction} commitMessage={commitMessage} onCancel={() => setPendingGitAction(undefined)} onConfirm={() => { if (!pendingGitAction) return; void enqueueGit({ action: pendingGitAction, message: pendingGitAction === "commit" ? commitMessage.trim() : undefined, threadId: activeThreadId }).finally(() => setPendingGitAction(undefined)); }} projectName={projectName} />
    </> : <div className="task-empty-state"><span aria-hidden="true" className="empty-contact">◇</span><h2>No active task</h2><p>Start a task to direct Relay across this repository and machine.</p><div><button className="button-primary" onClick={() => void startThread()} type="button">New task</button><button onClick={() => void startThread("plan")} type="button">Start with a plan</button></div></div>}
  </section>;
}
