import type { ProviderInstanceId } from "@relay/contracts";
import type { CanonicalEvent } from "@relay/contracts";

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

type NormalizedCanonicalEvent =
  CanonicalEvent extends infer TEvent
    ? TEvent extends CanonicalEvent
      ? Pick<TEvent, "type" | "payload">
      : never
    : never;

/**
 * A canonical event plus the native scope that produced it.
 *
 * The native identifiers are deliberately kept outside the canonical payload:
 * the daemon uses them as an ingress fence before assigning Relay run/turn
 * identity, and they are never persisted as canonical event data.
 */
export type NormalizedEvent = NormalizedCanonicalEvent & {
  readonly providerThreadId?: string;
  readonly providerTurnId?: string;
};

/**
 * Normalize a Codex app-server notification into zero or more canonical events.
 * Unknown notifications produce a diagnostic record — they never crash.
 */
export function normalizeCodexNotification(
  notification: CodexNotification,
  _runId: string,
  providerInstanceId: ProviderInstanceId,
): NormalizedEvent[] {
  const params = notification.params;
  const nestedTurn =
    params?.turn !== null && typeof params?.turn === "object"
      ? (params.turn as Record<string, unknown>)
      : undefined;
  const providerThreadId =
    typeof params?.threadId === "string" ? params.threadId : undefined;
  const providerTurnId =
    typeof params?.turnId === "string"
      ? params.turnId
      : typeof nestedTurn?.id === "string"
        ? nestedTurn.id
        : undefined;
  return normalizeCanonicalNotification(notification, providerInstanceId).map(
    (event) => ({
      ...event,
      ...(providerThreadId === undefined ? {} : { providerThreadId }),
      ...(providerTurnId === undefined ? {} : { providerTurnId }),
    }),
  );
}

function normalizeCanonicalNotification(
  notification: CodexNotification,
  providerInstanceId: ProviderInstanceId,
): NormalizedCanonicalEvent[] {
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
            activityId: (notification.params?.activityId ?? "") as never,
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
            activityId: (notification.params?.activityId ?? "") as never,
            content: notification.params?.content ?? "",
          },
        },
      ];

    case "activity/completed":
      return [
        {
          type: "activity.completed",
          payload: {
            activityId: (notification.params?.activityId ?? "") as never,
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
            activityId: (notification.params?.activityId ?? "") as never,
            error: notification.params?.error ?? "unknown",
          },
        },
      ];

    case "approval/requested":
      return [
        {
          type: "approval.requested",
          payload: {
            approvalId: (notification.params?.approvalId ?? "") as never,
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
            approvalId: (notification.params?.approvalId ?? "") as never,
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
            error: String(
              (notification.params as Record<string, unknown> | undefined)?.message ??
                "Codex app-server error",
            ),
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
      // Unknown notifications are retained in local transport diagnostics only.
      // They must never fabricate canonical user-visible activity.
      return [];
  }
}
