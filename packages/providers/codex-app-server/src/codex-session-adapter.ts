// ---------------------------------------------------------------------------
// Codex session adapter — bridges a Codex app-server transport into the
// Relay provider contract.
// ---------------------------------------------------------------------------
// Owns one CodexTransport + notification subscription. Translates
// Codex-native thread/turn/item lifecycle notifications into canonical
// Relay events via the existing normalizeCodexNotification table.
// ---------------------------------------------------------------------------

import type { CodexTransport, CodexTransportConfig } from "./codex-transport";
import { createCodexTransport } from "./codex-transport";
import { normalizeCodexNotification } from "./normalize-event";
import type { NormalizedEvent } from "./normalize-event";
import type { CodexServerNotification } from "./codex-transport";

// ---------------------------------------------------------------------------
// Session adapter types
// ---------------------------------------------------------------------------

export type SessionAdapterConfig = {
  transport: CodexTransportConfig;
  /** Called for every canonical event produced from Codex notifications. */
  onEvent?: (event: NormalizedEvent) => void;
  /** Whether to subscribe to thread notifications automatically. */
  autoSubscribe?: boolean;
  /** Resolve server-initiated approval/input/MCP requests durably. */
  onRequest?: (request: { method: string; params: unknown }) => Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>;
};

export type CodexSessionAdapter = {
  /** Start a new Codex thread. Returns the thread object. */
  startThread(params?: { model?: string; cwd?: string; ephemeral?: boolean }): Promise<unknown>;
  /** Resume an existing thread by ID. */
  resumeThread(threadId: string, params?: { model?: string; cwd?: string }): Promise<unknown>;
  /** Fork a thread (branch with copied history). */
  forkThread(threadId: string, params?: { ephemeral?: boolean }): Promise<unknown>;
  /** Begin a turn on the active thread. */
  startTurn(threadId: string, input: string, params?: { model?: string }): Promise<unknown>;
  /** Steer an in-flight turn. */
  steerTurn(threadId: string, steering: string): Promise<unknown>;
  /** Interrupt an in-flight turn. */
  interruptTurn(threadId: string, reason?: string): Promise<unknown>;
  /** Roll back a thread to before a specified turn. */
  rollbackThread(threadId: string, beforeTurnId: string): Promise<unknown>;
  /** Subscribe to session events. Returns unsubscribe function. */
  onEvent(handler: (event: NormalizedEvent) => void): () => void;
  /** The underlying transport. */
  readonly transport: CodexTransport;
  /** The current active thread ID, if any. */
  readonly activeThreadId: string | null;
  /** Shut down the session adapter (closes transport). */
  close(): void;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createCodexSessionAdapter(config: SessionAdapterConfig): CodexSessionAdapter {
  const transport = createCodexTransport(config.transport);
  const eventHandlers = new Set<(event: NormalizedEvent) => void>();
  let activeThreadId: string | null = null;
  let notificationUnsub: (() => void) | null = null;

  // Subscribe to Codex notifications and normalize them
  notificationUnsub = transport.onNotification((notification: CodexServerNotification) => {
    if (notification.method.startsWith("serverRequest/")) {
      const request = notification.params as unknown as { method?: string; params?: unknown; respond?: (result?: unknown, error?: { code: number; message: string; data?: unknown }) => void };
      const method = request.method ?? notification.method.slice("serverRequest/".length);
      const unhandled: { result?: unknown; error?: { code: number; message: string; data?: unknown } } = { error: { code: -32601, message: `Unhandled Codex server request: ${method}` } };
      void (config.onRequest
        ? config.onRequest({ method, params: request.params })
        : Promise.resolve(unhandled))
        .then((resolution) => request.respond?.(resolution.result, resolution.error))
        .catch((error) => request.respond?.(undefined, { code: -32603, message: error instanceof Error ? error.message : String(error) }));
      return;
    }
    const normalized = normalizeCodexNotification(
      { method: notification.method, params: notification.params as Record<string, unknown> | undefined },
      activeThreadId ?? "unknown",
      "codex" as never,
    );
    for (const ev of normalized) {
      config.onEvent?.(ev);
      for (const handler of eventHandlers) {
        try { handler(ev); } catch {}
      }
    }
  });

  return {
    async startThread(params = {}): Promise<unknown> {
      const result = await transport.request("thread/start", {
        model: params.model,
        cwd: params.cwd,
        ephemeral: params.ephemeral ?? false,
      });
      const thread = (result as { thread: { id: string } }).thread;
      if (thread?.id) activeThreadId = thread.id;
      return result;
    },

    async resumeThread(threadId: string, params = {}): Promise<unknown> {
      const result = await transport.request("thread/resume", {
        threadId,
        model: params.model,
        cwd: params.cwd,
      });
      activeThreadId = threadId;
      return result;
    },

    async forkThread(threadId: string, params = {}): Promise<unknown> {
      const result = await transport.request("thread/fork", {
        threadId,
        ephemeral: params.ephemeral ?? false,
      });
      const thread = (result as { thread: { id: string } }).thread;
      if (thread?.id) activeThreadId = thread.id;
      return result;
    },

    async startTurn(threadId: string, input: string, params = {}): Promise<unknown> {
      return transport.request("turn/start", {
        threadId,
        input: [{ type: "text", text: input }],
        model: params.model,
      });
    },

    async steerTurn(threadId: string, steering: string): Promise<unknown> {
      return transport.request("turn/steer", { threadId, steering });
    },

    async interruptTurn(threadId: string, reason = "user"): Promise<unknown> {
      return transport.request("turn/interrupt", { threadId, reason });
    },

    async rollbackThread(threadId: string, beforeTurnId: string): Promise<unknown> {
      return transport.request("thread/rollback", { threadId, beforeTurnId });
    },

    onEvent(handler: (event: NormalizedEvent) => void): () => void {
      eventHandlers.add(handler);
      return () => { eventHandlers.delete(handler); };
    },

    get transport(): CodexTransport { return transport; },
    get activeThreadId(): string | null { return activeThreadId; },

    close(): void {
      notificationUnsub?.();
      transport.close();
    },
  };
}
