/** JSON-RPC 2.0 peer abstraction for stdio-based provider transports. */
export type JsonRpcRequest = Readonly<{ jsonrpc: "2.0"; id: number | string; method: string; params?: unknown }>;
export type JsonRpcNotification = Readonly<{ jsonrpc: "2.0"; method: string; params?: unknown }>;
export type JsonRpcResponse = Readonly<{ jsonrpc: "2.0"; id: number | string; result?: unknown; error?: { code: number; message: string; data?: unknown } }>;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isRequest(msg: JsonRpcMessage): msg is JsonRpcRequest { return "id" in msg && "method" in msg && !("result" in msg) && !("error" in msg); }
export function isNotification(msg: JsonRpcMessage): msg is JsonRpcNotification { return "method" in msg && !("id" in msg) && !("result" in msg) && !("error" in msg); }
export function isResponse(msg: JsonRpcMessage): msg is JsonRpcResponse { return "id" in msg && ("result" in msg || "error" in msg); }
export function parseMessage(line: string): JsonRpcMessage { try { const parsed = JSON.parse(line); if (parsed?.jsonrpc !== "2.0") throw new Error("Not a JSON-RPC 2.0 message"); return parsed as JsonRpcMessage; } catch (e) { throw new Error(`Invalid JSON-RPC message: ${e instanceof Error ? e.message : String(e)}`); } }
export function formatRequest(id: number | string, method: string, params?: unknown): string { return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"; }
export function formatNotification(method: string, params?: unknown): string { return JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"; }
export function formatResponse(id: number | string, result?: unknown, error?: { code: number; message: string; data?: unknown }): string { return JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }) + "\n"; }
