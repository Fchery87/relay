import type { ProviderInstanceId } from "@relay/contracts";
import type { CanonicalEvent, CanonicalEventType } from "@relay/contracts";

// ---------------------------------------------------------------------------
// Codex app-server event normalization — table-driven mapping from
// Codex-native notifications to canonical harness events.
// Unknown notifications become bounded diagnostic records, never crashes.
// ---------------------------------------------------------------------------

const MAX_PROJECTION_STRING_BYTES = 16_384;
const MAX_PROJECTION_PAYLOAD_KEYS = 40;

function sanitizeString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= MAX_PROJECTION_STRING_BYTES) return value;
  return new TextDecoder().decode(bytes.slice(0, MAX_PROJECTION_STRING_BYTES)) + "…[truncated]";
}

export function sanitizeProjectionPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const keys = Object.keys(payload).slice(0, MAX_PROJECTION_PAYLOAD_KEYS);
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string") out[key] = sanitizeString(value);
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "boolean") out[key] = value;
    else if (value === null) out[key] = null;
  }
  return out;
}

export type CodexNotification = {
  readonly method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly params?: Record<string, any>;
};

export type NormalizedEvent = {
  readonly type: CanonicalEventType;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly payload: Record<string, any>;
};

/**
 * Normalize a Codex app-server notification into zero or more canonical events.
 * Unknown notifications produce a diagnostic record — they never crash.
 */
export function normalizeCodexNotification(
  notification: CodexNotification,
  runId: string,
  providerInstanceId: ProviderInstanceId,
): NormalizedEvent[] {
  switch (notification.method) {
    case "thread/created":
      return [
        {
          type: "provider.session.started",
          payload: {
            providerInstanceId,
            providerThreadId: notification.params?.threadId,
          },
        },
        { type: "run.started", payload: {} },
      ];

    case "thread/resumed":
      return [
        {
          type: "provider.session.resumed",
          payload: {
            providerInstanceId,
            providerThreadId: notification.params?.threadId ?? "",
          },
        },
        { type: "run.started", payload: {} },
      ];

    case "thread/stopped":
      return [
        {
          type: "provider.session.stopped",
          payload: { providerInstanceId, reason: "completed" },
        },
      ];

    case "turn/started":
      return [
        {
          type: "turn.started",
          payload: { prompt: notification.params?.prompt ?? "" },
        },
      ];

    case "turn/steered":
      return [
        {
          type: "turn.steered",
          payload: { steering: notification.params?.steering ?? "" },
        },
      ];

    case "turn/completed":
      return [
        {
          type: "turn.completed",
          payload: { summary: notification.params?.summary },
        },
      ];

    case "turn/interrupted":
      return [
        {
          type: "turn.interrupted",
          payload: { reason: notification.params?.reason ?? "user" },
        },
      ];

    case "turn/failed":
      return [
        {
          type: "turn.failed",
          payload: { error: notification.params?.error ?? "unknown" },
        },
      ];

    case "agent/text-delta":
      return [
        {
          type: "assistant.delta",
          payload: { text: notification.params?.text ?? "" },
        },
      ];

    case "agent/completed":
      return [{ type: "assistant.completed", payload: {} }];

    case "activity/started":
      return [
        {
          type: "activity.started",
          payload: {
            activityId: notification.params?.activityId ?? "",
            kind: notification.params?.kind ?? "unknown",
            toolName: notification.params?.toolName,
          },
        },
      ];

    case "activity/delta":
      return [
        {
          type: "activity.delta",
          payload: {
            activityId: notification.params?.activityId ?? "",
            content: notification.params?.content ?? "",
          },
        },
      ];

    case "activity/completed":
      return [
        {
          type: "activity.completed",
          payload: {
            activityId: notification.params?.activityId ?? "",
            summary: notification.params?.summary,
            result: notification.params?.result,
          },
        },
      ];

    case "activity/failed":
      return [
        {
          type: "activity.failed",
          payload: {
            activityId: notification.params?.activityId ?? "",
            error: notification.params?.error ?? "unknown",
          },
        },
      ];

    case "approval/requested":
      return [
        {
          type: "approval.requested",
          payload: {
            approvalId: notification.params?.approvalId ?? "",
            capability: notification.params?.capability ?? "unknown",
            risk: notification.params?.risk ?? "unknown",
            details: notification.params?.details ?? "",
          },
        },
      ];

    case "approval/resolved":
      return [
        {
          type: "approval.resolved",
          payload: {
            approvalId: notification.params?.approvalId ?? "",
            resolution: notification.params?.resolution ?? "allow",
          },
        },
      ];

    case "usage/recorded":
      return [
        {
          type: "usage.recorded",
          payload: {
            inputTokens: notification.params?.inputTokens ?? 0,
            outputTokens: notification.params?.outputTokens ?? 0,
            cacheReadTokens: notification.params?.cacheReadTokens ?? 0,
            cacheWriteTokens: notification.params?.cacheWriteTokens ?? 0,
            thinkingTokens: notification.params?.thinkingTokens ?? 0,
            modelId: notification.params?.modelId ?? "unknown",
          },
        },
      ];

    case "error":
      return [
        {
          type: "turn.failed",
          payload: {
            error: (notification.params as Record<string, unknown> | undefined)?.message ?? "Codex app-server error",
          },
        },
      ];

    case "thread/closed":
      return [
        {
          type: "provider.session.stopped",
          payload: { providerInstanceId, reason: "completed" },
        },
      ];

    default:
      // Unknown notifications become bounded diagnostics — never crash.
      return [
        {
          type: "activity.delta" as CanonicalEventType,
          payload: {
            activityId: `diag-${notification.method}`,
            content: `[Codex diagnostic] Unrecognized notification: ${notification.method}`,
          },
        },
      ];
  }
}
