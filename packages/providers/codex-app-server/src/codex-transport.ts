// ---------------------------------------------------------------------------
// Codex app-server stdio JSON-RPC 2.0 transport
// ---------------------------------------------------------------------------
// Spawns `codex app-server --stdio`, performs the initialize handshake,
// and then routes bidirectional messages with bounded-parallelism queues.
// ---------------------------------------------------------------------------

import { ProviderProcessLostError } from "@relay/provider-runtime";
import type { ServerRequest } from "./generated/ServerRequest";
import type { ServerNotification } from "./generated/ServerNotification";
import type { InitializeParams } from "./generated/InitializeParams";

// Re-export the generated types for downstream consumers
export type { ServerRequest, ServerNotification };
export type { InitializeParams };
export type { ThreadStartParams } from "./generated/v2/ThreadStartParams";
export type { ThreadStartResponse } from "./generated/v2/ThreadStartResponse";
export type { ThreadResumeParams } from "./generated/v2/ThreadResumeParams";
export type { ThreadResumeResponse } from "./generated/v2/ThreadResumeResponse";
export type { TurnStartParams } from "./generated/v2/TurnStartParams";
export type { TurnStartResponse } from "./generated/v2/TurnStartResponse";
export type { TurnSteerParams } from "./generated/v2/TurnSteerParams";
export type { TurnInterruptParams } from "./generated/v2/TurnInterruptParams";
export type { Thread } from "./generated/v2/Thread";
export type { Turn } from "./generated/v2/Turn";

export type { ServerNotification as CodexServerNotification } from "./generated/ServerNotification";

// ---------------------------------------------------------------------------
// JSON-RPC message types
// ---------------------------------------------------------------------------

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ---------------------------------------------------------------------------
// Transport config
// ---------------------------------------------------------------------------

export type CodexTransportConfig = {
  /** Path to the codex binary. Defaults to `codex`. */
  codexPath?: string;
  /** Client metadata sent in the initialize request. */
  clientInfo: { name: string; title?: string; version: string };
  /** Optional experimental API capabilities. */
  capabilities?: { experimentalApi?: boolean; optOutNotificationMethods?: string[] };
  /** Max pending outgoing requests before backpressure. */
  maxPendingRequests?: number;
  /** Max queued incoming messages before applying typed overload failure. */
  maxIncomingQueue?: number;
  /** Maximum stderr bytes retained for diagnostics. */
  maxStderrBytes?: number;
};

// ---------------------------------------------------------------------------
// Transport state
// ---------------------------------------------------------------------------

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type CodexTransport = {
  /** Send a request and wait for the response. */
  request(method: string, params?: unknown): Promise<unknown>;
  /** Send a notification (no response expected). */
  notify(method: string, params?: unknown): void;
  /** Subscribe to incoming server→client notifications. */
  onNotification(handler: (notification: ServerNotification) => void): () => void;
  /** Respond to a server-initiated request without losing its native id. */
  respond(id: number | string, result?: unknown, error?: { code: number; message: string; data?: unknown }): void;
  /** Graceful shutdown. */
  close(): void;
  /** Whether the transport is connected/alive. */
  readonly connected: boolean;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function filteredEnvironment(): Record<string, string> {
  const allowed = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME"];
  const environment: Record<string, string> = {};
  for (const key of allowed) { const value = Bun.env[key]; if (value) environment[key] = value; }
  return environment;
}

export function createCodexTransport(config: CodexTransportConfig): CodexTransport {
  const codexPath = config.codexPath ?? "codex";
  const maxPending = config.maxPendingRequests ?? 32;
  const maxIncoming = config.maxIncomingQueue ?? 256;
  const requestTimeoutMs = 120_000; // 2 minutes

  let nextId = 1;
  const pending = new Map<number | string, PendingRequest>();
  const notificationHandlers = new Set<(notification: ServerNotification) => void>();
  let process: ReturnType<typeof Bun.spawn> | null = null;
  let connected = false;
  let buffer = "";
  let incomingQueueSize = 0;
  let stderrBytes = 0;
  const maxStderrBytes = config.maxStderrBytes ?? 64 * 1024;

  // Spawn the child process
  process = Bun.spawn({
    cmd: [codexPath, "app-server", "--stdio"],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: filteredEnvironment(),
  });

  // Read stderr asynchronously and log
  void (async () => {
    const decoder = new TextDecoder();
    const reader = process!.stderr as ReadableStream<Uint8Array>;
    const streamReader = reader.getReader();
    while (true) {
      const { done, value } = await streamReader.read();
      if (done) break;
      const remaining = Math.max(0, maxStderrBytes - stderrBytes);
      const text = decoder.decode(value, { stream: true }).slice(0, remaining);
      stderrBytes += new TextEncoder().encode(text).byteLength;
      if (text.trim()) console.warn("[codex stderr]", text.trim());
    }
  })();

  // Read stdout lines
  void (async () => {
    const decoder = new TextDecoder();
    const reader = process!.stdout as ReadableStream<Uint8Array>;
    const streamReader = reader.getReader();
    while (true) {
      const { done, value } = await streamReader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (incomingQueueSize >= maxIncoming) {
          connected = false;
          const error = new ProviderProcessLostError("Codex transport overloaded");
          for (const [, p] of pending) { clearTimeout(p.timer); p.reject(error); }
          pending.clear();
          try { process?.kill(); } catch {}
          return;
        }
        incomingQueueSize++;
        try {
          const msg: JsonRpcMessage = JSON.parse(trimmed);
          queueMicrotask(() => {
            incomingQueueSize--;
            handleMessage(msg);
          });
        } catch {
          const error = new ProviderProcessLostError("Malformed JSON-RPC message from Codex");
          for (const [, p] of pending) { clearTimeout(p.timer); p.reject(error); }
          pending.clear();
          try { process?.kill(); } catch {}
        }
      }
    }
    // Process exited; mark disconnected
    connected = false;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new ProviderProcessLostError("Codex process exited"));
    }
    pending.clear();
  })();

  function respond(id: number | string, result?: unknown, error?: { code: number; message: string; data?: unknown }): void {
    if (!process || !connected) throw new Error("Codex transport disconnected");
    sendRaw(error ? { jsonrpc: "2.0", id, error } : { jsonrpc: "2.0", id, result });
  }

  function sendRaw(msg: JsonRpcMessage): void {
    if (!process?.stdin) throw new Error("Codex process not available");
    const line = JSON.stringify(msg) + "\n";
    (process.stdin as { write(data: Uint8Array): void }).write(new TextEncoder().encode(line));
  }

  function handleMessage(msg: JsonRpcMessage): void {
    // Response to our request
    if ("id" in msg && ("result" in msg || "error" in msg)) {
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(msg.id);
      if ("error" in msg && msg.error) {
        p.reject(new Error(`JSON-RPC error ${msg.error.code}: ${msg.error.message}`));
      } else {
        p.resolve((msg as JsonRpcResponse).result);
      }
      return;
    }

    // Server→client request (needs our response)
    if ("id" in msg && "method" in msg) {
      const serverReq = msg as JsonRpcRequest;
      for (const handler of notificationHandlers) {
        try {
          handler({
            method: `serverRequest/${serverReq.method}`,
            params: { ...serverReq, respond: (result?: unknown, error?: { code: number; message: string; data?: unknown }) => respond(serverReq.id, result, error) },
          } as unknown as ServerNotification);
        } catch { /* swallow */ }
      }
      return;
    }

    // Server→client notification (no id)
    if ("method" in msg && !("id" in msg)) {
      const notification = msg as JsonRpcNotification;
      for (const handler of notificationHandlers) {
        try {
          handler(notification as unknown as ServerNotification);
        } catch { /* swallow */ }
      }
      return;
    }
  }

  // Fire the handshake
  async function doHandshake(): Promise<void> {
    const initParams: InitializeParams = {
      clientInfo: {
        name: config.clientInfo.name,
        title: config.clientInfo.title ?? null,
        version: config.clientInfo.version,
      },
      capabilities: (config.capabilities ?? { experimentalApi: true }) as InitializeParams["capabilities"],
    };

    const result = await internalRequest("initialize", initParams);
    console.info("[codex transport] initialized:", JSON.stringify(result).slice(0, 200));
    sendRaw({ jsonrpc: "2.0", method: "initialized" } as JsonRpcNotification);
    connected = true;
  }

  function internalRequest(method: string, params?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!process) return reject(new Error("Codex process not available"));
      if (pending.size >= maxPending) return reject(new Error(`Codex request capacity exceeded (${maxPending})`));
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Request timeout: ${method}`));
      }, requestTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      sendRaw({ jsonrpc: "2.0", id, method, params });
    });
  }

  const readyPromise = doHandshake();

  return {
    async request(method: string, params?: unknown): Promise<unknown> {
      await readyPromise;
      if (!connected) throw new Error("Codex transport disconnected");
      return internalRequest(method, params);
    },

    respond,

    notify(method: string, params?: unknown): void {
      if (!connected || !process) return;
      readyPromise
        .then(() => sendRaw({ jsonrpc: "2.0", method, params } as JsonRpcNotification))
        .catch(() => {});
    },

    onNotification(handler: (notification: ServerNotification) => void): () => void {
      notificationHandlers.add(handler);
      return () => { notificationHandlers.delete(handler); };
    },

    close(): void {
      connected = false;
      if (process) {
        try { process.kill(); } catch {}
        process = null;
      }
      for (const [, p] of pending) {
        clearTimeout(p.timer);
        p.reject(new Error("Transport closed"));
      }
      pending.clear();
    },

    get connected(): boolean { return connected; },
  };
}
