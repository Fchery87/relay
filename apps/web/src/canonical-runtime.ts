import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { ClientRuntime, type CanonicalEventType, type ClientConfig, type ClientState, type EventEnvelope, type RunSnapshot } from "@relay/client-runtime";
import type { ProjectionEventDocument, ProjectionSnapshotDocument } from "./run-data";
import { getProjectionSnapshot, listProjectionEvents, ProjectionCursorManager } from "./run-data";
import type { ThreadMessage } from "./thread-messages";
import type { ThreadCheckpoint } from "./thread-messages";
import type { ThreadEvent } from "./thread-activity";
import type { Approval, AuditEntry } from "./governance-panel";
import type { UsageSummary } from "./usage-panel";
import type { DiffComment } from "./diff-utils";

export type ProjectionRunState = {
  readonly error?: string;
  readonly events?: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>;
  readonly state?: ClientState;
};

export function createCanonicalRuntime(config: ClientConfig): ClientRuntime { return new ClientRuntime(config); }
export type CanonicalClientState = ClientState;

/**
 * React bridge for the projection plane. Convex remains the transport, while
 * ClientRuntime owns ordering, reduction, cursor confirmation, and fail-closed
 * gap handling.
 */
export function useProjectionRun(runId: string | undefined): ProjectionRunState {
  const snapshot = useQuery(getProjectionSnapshot, runId ? { runId } : "skip");
  const events = useQuery(
    listProjectionEvents,
    runId ? { afterSequence: Math.max(0, (snapshot?.sequence ?? 0) - 200), limit: 200, runId } : "skip",
  );
  const [result, setResult] = useState<ProjectionRunState>({});

  useEffect(() => {
    if (!runId || !snapshot) {
      setResult({});
      return;
    }
    const config: ClientConfig = {
      fetchSnapshot: async () => decodeSnapshot(snapshot),
      fetchEvents: async () => (events ?? []).map(decodeEvent),
      submitCommand: async () => { throw new Error("Projection hook does not submit commands directly"); },
      cursorStore: {
        load: (cursorRunId) => new ProjectionCursorManager().load(cursorRunId)?.confirmedSequence,
        save: (cursorRunId, sequence) => new ProjectionCursorManager().save(cursorRunId, sequence),
      },
    };
    const runtime = createCanonicalRuntime(config);
    const decodedEvents = (events ?? []).map(decodeEvent);
    void runtime.connect(runId).then((state) => setResult({ events: decodedEvents, state })).catch((error: unknown) => {
      setResult({ error: error instanceof Error ? error.message : String(error) });
    });
  }, [events, runId, snapshot]);

  return result;
}

/** Convert the canonical event tail into the message shape used by the web surface. */
export function projectionEventsToMessages(events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>): ThreadMessage[] {
  const messages: ThreadMessage[] = [];
  const assistantByTurn = new Map<string, ThreadMessage>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const turnId = event.turnId as string | undefined;
    if (event.type === "turn.started" && turnId) {
      const prompt = event.payload && typeof event.payload === "object" ? (event.payload as { prompt?: unknown }).prompt : undefined;
      if (typeof prompt === "string") messages.push({ _id: `user:${turnId}`, content: prompt, role: "user", status: "complete" });
    }
    if (event.type === "assistant.delta" && turnId) {
      const text = event.payload && typeof event.payload === "object" ? (event.payload as { text?: unknown }).text : undefined;
      if (typeof text !== "string") continue;
      const existing = assistantByTurn.get(turnId);
      if (existing) existing.content += text;
      else {
        const message: ThreadMessage = { _id: `assistant:${turnId}`, content: text, role: "assistant", status: "streaming" };
        assistantByTurn.set(turnId, message);
        messages.push(message);
      }
    }
    if ((event.type === "assistant.completed" || event.type === "turn.completed" || event.type === "turn.failed") && turnId) {
      const message = assistantByTurn.get(turnId);
      if (message) message.status = event.type === "turn.failed" ? "complete" : "complete";
    }
  }
  return messages;
}

export function projectionEventsToThreadEvents(events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>): ThreadEvent[] {
  return events.flatMap((event) => {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    if (event.type === "activity.completed" || event.type === "activity.failed") {
      return [{ _id: event.eventId as string, kind: "tool.completed", summary: String(payload.summary ?? payload.error ?? "Activity completed"), tool: String(payload.toolName ?? payload.kind ?? "activity") }];
    }
    if (event.type === "checkpoint.restored") return [{ _id: event.eventId as string, kind: "checkpoint.reverted", summary: "Checkpoint restored" }];
    return [];
  });
}

export function projectionEventsToCheckpoints(events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>): ThreadCheckpoint[] {
  return events.flatMap((event) => {
    if (event.type !== "checkpoint.captured") return [];
    const payload = event.payload && typeof event.payload === "object" ? event.payload as { checkpointId?: unknown; commit?: unknown; ref?: unknown } : {};
    const checkpointId = payload.checkpointId;
    if (typeof checkpointId !== "string") return [];
    return [{
      _id: checkpointId,
      commit: typeof payload.commit === "string" ? payload.commit : undefined,
      messageId: event.turnId as string ?? event.eventId as string,
      ref: typeof payload.ref === "string" ? payload.ref : undefined,
    }];
  });
}

export type ProjectionCheckpointComparison = {
  readonly _id: string;
  readonly content?: string;
  readonly status: "queued" | "running" | "complete" | "failed";
};

export function projectionEventsToDiff(events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>): string {
  const latest = [...events].reverse().find((event) => event.type === "workspace.diff.updated");
  if (!latest || !latest.payload || typeof latest.payload !== "object") return "No changes.";
  const content = (latest.payload as { content?: unknown }).content;
  return typeof content === "string" ? content : "No changes.";
}

export function projectionEventsToReviewComments(events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>): DiffComment[] {
  const comments = new Map<string, DiffComment>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    if (event.type === "review.comment.created") {
      if (typeof payload.commentId !== "string" || typeof payload.content !== "string" || typeof payload.filePath !== "string" || typeof payload.startLine !== "number" || typeof payload.endLine !== "number") continue;
      comments.set(payload.commentId, {
        _id: payload.commentId,
        content: payload.content,
        endLine: payload.endLine,
        filePath: payload.filePath,
        resolved: false,
        startLine: payload.startLine,
      });
    } else if (event.type === "review.comment.resolved" && typeof payload.commentId === "string") {
      const existing = comments.get(payload.commentId);
      if (existing) comments.set(payload.commentId, { ...existing, resolved: true });
    }
  }
  return [...comments.values()];
}

export type ProjectionGitAction = {
  readonly _id: string;
  readonly action: "stage" | "commit" | "push";
  readonly status: "queued" | "running" | "complete" | "failed";
};

export function projectionEventsToGitActions(events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>): ProjectionGitAction[] {
  const actions = new Map<string, ProjectionGitAction>();
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type !== "git.action.updated") continue;
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    if (typeof payload.actionId !== "string" || (payload.action !== "stage" && payload.action !== "commit" && payload.action !== "push") || (payload.status !== "running" && payload.status !== "complete" && payload.status !== "failed")) continue;
    actions.set(payload.actionId, { _id: payload.actionId, action: payload.action, status: payload.status });
  }
  return [...actions.values()];
}

export function projectionEventsToCheckpointComparison(events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>): ProjectionCheckpointComparison | null {
  const latest = [...events].reverse().find((event) => event.type === "checkpoint.compared");
  if (!latest) return null;
  const payload = latest.payload && typeof latest.payload === "object" ? latest.payload as { content?: unknown; fromCheckpointId?: unknown; toCheckpointId?: unknown } : {};
  const from = typeof payload.fromCheckpointId === "string" ? payload.fromCheckpointId : "from";
  const to = typeof payload.toCheckpointId === "string" ? payload.toCheckpointId : "to";
  return {
    _id: `comparison:${from}:${to}`,
    content: typeof payload.content === "string" ? payload.content : undefined,
    status: "complete",
  };
}

export function projectionEventsToApprovals(events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>): Approval[] {
  const approvals = new Map<string, Approval>();
  for (const event of events) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    const approvalId = String(payload.approvalId ?? "");
    if (!approvalId) continue;
    if (event.type === "approval.requested") approvals.set(approvalId, { _id: approvalId, capability: normalizeCapability(payload.capability), decision: "pending", risk: normalizeRisk(payload.risk), summary: String(payload.details ?? "Approval required") });
    if (event.type === "approval.resolved") {
      const existing = approvals.get(approvalId);
      if (existing) approvals.set(approvalId, { ...existing, decision: payload.resolution === "allow" ? "allow" : "deny" });
    }
  }
  return [...approvals.values()];
}

export function projectionEventsToAudit(events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>): AuditEntry[] {
  return projectionEventsToApprovals(events)
    .filter((approval) => approval.decision !== "pending")
    .map((approval) => ({ _id: `audit:${approval._id}`, capability: approval.capability, decision: approval.decision === "allow" ? "allow" : "deny", risk: approval.risk, summary: approval.summary }));
}

export function projectionEventsToUsage(events: ReadonlyArray<EventEnvelope<CanonicalEventType, unknown>>, budgetUsd: number | null | undefined = null): UsageSummary {
  const records = events.flatMap((event) => {
    if (event.type !== "usage.recorded") return [];
    const payload = event.payload as { cacheReadTokens: number; cacheWriteTokens: number; inputTokens: number; modelId: string; outputTokens: number; thinkingTokens: number };
    return [{ _creationTime: event.occurredAt, _id: event.eventId as string, cacheReadTokens: payload.cacheReadTokens, cacheWriteTokens: payload.cacheWriteTokens, callId: event.eventId as string, costUsd: 0, inputTokens: payload.inputTokens, messageId: event.turnId as string ?? event.eventId as string, modelId: payload.modelId, outputTokens: payload.outputTokens, role: "assistant", thinkingTokens: payload.thinkingTokens, threadId: event.runId as string }];
  });
  return {
    budgetUsd: budgetUsd ?? null,
    records,
    totals: {
      cacheReadTokens: records.reduce((sum, record) => sum + record.cacheReadTokens, 0),
      cacheWriteTokens: records.reduce((sum, record) => sum + record.cacheWriteTokens, 0),
      costUsd: 0,
      inputTokens: records.reduce((sum, record) => sum + record.inputTokens, 0),
      outputTokens: records.reduce((sum, record) => sum + record.outputTokens, 0),
      thinkingTokens: records.reduce((sum, record) => sum + (record.thinkingTokens ?? 0), 0),
      thinkingTokensUnavailableCalls: records.filter((record) => record.thinkingTokens === null).length,
    },
    truncated: false,
  };
}

function normalizeCapability(value: unknown): Approval["capability"] { return value === "read" || value === "edit" || value === "exec" || value === "task" ? value : "task"; }
function normalizeRisk(value: unknown): Approval["risk"] { return value === "low" || value === "high" || value === "critical" ? value : "high"; }

function decodeSnapshot(document: ProjectionSnapshotDocument): RunSnapshot {
  const parsed = JSON.parse(document.snapshotJson) as RunSnapshot;
  return {
    ...parsed,
    projectId: parsed.projectId ?? document.projectId as never,
    runId: document.runId as never,
    sequence: document.sequence,
    streamVersion: parsed.streamVersion ?? document.sequence,
  };
}

function decodeEvent(document: ProjectionEventDocument): EventEnvelope<CanonicalEventType, unknown> {
  return {
    eventId: document.eventId as never,
    occurredAt: document.occurredAt,
    payload: JSON.parse(document.payloadJson) as unknown,
    runId: document.runId as never,
    sequence: document.sequence,
    streamVersion: document.streamVersion ?? document.sequence,
    type: document.type as CanonicalEventType,
    correlationId: `projection:${document.runId}` as never,
  };
}
