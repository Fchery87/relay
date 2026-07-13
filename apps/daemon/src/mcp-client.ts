import { mcpToolSchema, validateMcpToolSchema, type McpTool } from "@relay/shared";
import { z } from "zod";

const PROTOCOL_VERSION = "2026-07-28";
const MAX_RESPONSE_BYTES = 1_000_000;
const SCHEMA_TIMEOUT_MS = 5_000;
const clientMeta = { clientInfo: { name: "relay", version: "0.0.0" }, extensions: { "io.modelcontextprotocol/tasks": {} }, protocolVersion: PROTOCOL_VERSION };

export interface McpRequest { method: string; name?: string; params?: Record<string, unknown> }
export interface McpTransport { request(input: McpRequest): Promise<unknown>; close?(): Promise<void> }

const responseSchema = z.object({ error: z.object({ code: z.number(), message: z.string() }).optional(), id: z.union([z.number(), z.string()]), jsonrpc: z.literal("2.0"), result: z.unknown().optional() });
const discoverSchema = z.object({ capabilities: z.object({ tools: z.boolean().optional(), tasks: z.boolean().optional() }).passthrough() }).passthrough();
const toolsListSchema = z.object({ tools: z.array(mcpToolSchema).max(1_000), ttlMs: z.number().int().nonnegative().max(86_400_000).default(0) });
const taskResultSchema = z.object({ result: z.unknown().optional(), task: z.object({ id: z.string().max(1_000), status: z.enum(["working", "completed", "failed", "cancelled", "input_required"]) }) }).passthrough();
const inputRequiredSchema = z.object({ prompts: z.array(z.unknown()).max(100), requestState: z.string().max(100_000), type: z.literal("input_required") }).passthrough();

export class StreamableHttpTransport implements McpTransport {
  readonly #authToken?: string;
  readonly #authTokenProvider?: () => Promise<string>;
  readonly #fetcher: (input: string, init: RequestInit) => Promise<Response>;
  readonly #url: string;
  readonly #timeoutMs: number;
  #nextId = 1;

  constructor({ authToken, authTokenProvider, fetcher = (input, init) => fetch(input, init), timeoutMs = 30_000, url }: { authToken?: string; authTokenProvider?: () => Promise<string>; fetcher?: (input: string, init: RequestInit) => Promise<Response>; timeoutMs?: number; url: string }) {
    this.#authToken = authToken;
    this.#authTokenProvider = authTokenProvider;
    this.#fetcher = fetcher;
    this.#url = url;
    this.#timeoutMs = timeoutMs;
  }

  async request({ method, name = "relay", params = {} }: McpRequest): Promise<unknown> {
    const id = this.#nextId++;
    const headers = new Headers({ "Content-Type": "application/json", "Mcp-Method": method, "Mcp-Name": name });
    const authToken = this.#authTokenProvider ? await this.#authTokenProvider() : this.#authToken;
    if (authToken) headers.set("Authorization", `Bearer ${authToken}`);
    const abortController = new AbortController();
    const response = await withTimeout(this.#fetcher(this.#url, { body: JSON.stringify({ id, jsonrpc: "2.0", method, params: { ...params, _meta: clientMeta } }), headers, method: "POST", signal: abortController.signal }), this.#timeoutMs, () => abortController.abort());
    if (!response.ok) throw new Error(`MCP HTTP request failed: ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > MAX_RESPONSE_BYTES) throw new Error("MCP HTTP response exceeds size limit");
    const body = await readBoundedBody(response, this.#timeoutMs);
    return parseResponse(JSON.parse(body), id);
  }
}

type PendingRequest = { reject(error: Error): void; resolve(value: unknown): void };

export class StdioTransport implements McpTransport {
  readonly #pending = new Map<number, PendingRequest>();
  readonly #process: Bun.Subprocess<"pipe", "pipe", "inherit">;
  readonly #timeoutMs: number;
  #nextId = 1;
  #closedError: Error | null = null;

  constructor({ args = [], command, cwd, env, timeoutMs = 30_000 }: { args?: string[]; command: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number }) {
    this.#process = Bun.spawn([command, ...args], { cwd, env, stderr: "inherit", stdin: "pipe", stdout: "pipe" });
    void this.#readResponses();
    this.#timeoutMs = timeoutMs;
  }

  async request({ method, params = {} }: McpRequest): Promise<unknown> {
    if (this.#closedError) throw this.#closedError;
    const id = this.#nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { reject, resolve }));
    this.#process.stdin.write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params: { ...params, _meta: clientMeta } })}\n`);
    await withTimeout(Promise.resolve(this.#process.stdin.flush()), this.#timeoutMs, () => this.#process.kill());
    try { return await withTimeout(result, this.#timeoutMs); }
    finally { this.#pending.delete(id); }
  }

  async close(): Promise<void> {
    this.#process.stdin.end();
    this.#process.kill();
    await this.#process.exited;
  }

  async #readResponses(): Promise<void> {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const bytes of this.#process.stdout) {
        buffer += decoder.decode(bytes, { stream: true });
        if (new TextEncoder().encode(buffer).byteLength > MAX_RESPONSE_BYTES) throw new Error("MCP stdio response exceeds size limit");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const envelope = responseSchema.parse(JSON.parse(line));
          if (typeof envelope.id !== "number") continue;
          const pending = this.#pending.get(envelope.id);
          if (!pending) continue;
          this.#pending.delete(envelope.id);
          try { pending.resolve(parseResponse(envelope, envelope.id)); }
          catch (error) { pending.reject(error instanceof Error ? error : new Error(String(error))); }
        }
      }
      throw new Error(`MCP stdio server exited with code ${await this.#process.exited}`);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      this.#closedError = failure;
      this.#process.kill();
      for (const pending of this.#pending.values()) pending.reject(failure);
      this.#pending.clear();
    }
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { onTimeout?.(); reject(new Error(`MCP request timed out after ${timeoutMs}ms`)); }, timeoutMs); });
  try { return await Promise.race([operation, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

async function readBoundedBody(response: Response, timeoutMs: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    return await withTimeout((async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error("MCP HTTP response exceeds size limit");
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(bytes);
    })(), timeoutMs, () => { void reader.cancel(); });
  } finally { reader.releaseLock(); }
}

export class McpClient {
  readonly #now: () => number;
  readonly #serverId: string;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #transport: McpTransport;
  #capabilities: z.infer<typeof discoverSchema>["capabilities"] | null = null;
  #tools: McpTool[] = [];
  #toolsExpireAt = 0;
  readonly #inputSchemas = new Map<string, Record<string, unknown>>();
  readonly #outputSchemas = new Map<string, Record<string, unknown>>();

  constructor({ now = Date.now, serverId, sleep = Bun.sleep, transport }: { now?: () => number; serverId: string; sleep?: (milliseconds: number) => Promise<void>; transport: McpTransport }) {
    this.#now = now;
    this.#serverId = serverId;
    this.#sleep = sleep;
    this.#transport = transport;
  }

  async discover(): Promise<z.infer<typeof discoverSchema>["capabilities"]> {
    if (this.#capabilities) return this.#capabilities;
    this.#capabilities = discoverSchema.parse(await this.#transport.request({ method: "server/discover" })).capabilities;
    return this.#capabilities;
  }

  async listTools(): Promise<McpTool[]> {
    await this.discover();
    if (this.#tools.length > 0 && this.#now() < this.#toolsExpireAt) return this.#tools;
    const result = toolsListSchema.parse(await this.#transport.request({ method: "tools/list" }));
    const inputSchemas = new Map<string, Record<string, unknown>>();
    const outputSchemas = new Map<string, Record<string, unknown>>();
    const tools = result.tools.map((tool) => {
      const inputSchema = validateMcpToolSchema(tool.inputSchema);
      inputSchemas.set(tool.name, inputSchema);
      const outputSchema = tool.outputSchema ? validateMcpToolSchema(tool.outputSchema) : undefined;
      if (outputSchema) outputSchemas.set(tool.name, outputSchema);
      return { ...tool, inputSchema, outputSchema };
    });
    await schemaWorker.compile(tools.flatMap((tool) => tool.outputSchema ? [tool.inputSchema, tool.outputSchema] : [tool.inputSchema]));
    this.#inputSchemas.clear();
    this.#outputSchemas.clear();
    for (const [name, schema] of inputSchemas) this.#inputSchemas.set(name, schema);
    for (const [name, schema] of outputSchemas) this.#outputSchemas.set(name, schema);
    this.#tools = tools;
    this.#toolsExpireAt = this.#now() + result.ttlMs;
    return this.#tools;
  }

  async callTool({ arguments: toolArguments, name, onInputRequired, onTaskStatus }: { arguments: Record<string, unknown>; name: string; onInputRequired?: (input: { prompts: unknown[] }) => Promise<Record<string, unknown>>; onTaskStatus?: (task: { id: string; status: string }) => Promise<void> | void }): Promise<unknown> {
    const tool = (await this.listTools()).find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`Unknown MCP tool ${this.#serverId}/${name}`);
    const inputSchema = this.#inputSchemas.get(name);
    if (!inputSchema) throw new Error(`Missing input schema for MCP tool ${this.#serverId}/${name}`);
    const inputValidation = await schemaWorker.validate({ schema: inputSchema, value: toolArguments });
    if (!inputValidation.valid) throw new Error(`Invalid arguments for MCP tool ${this.#serverId}/${name}: ${inputValidation.errors}`);
    let result = await this.#transport.request({ method: "tools/call", name, params: { arguments: toolArguments, name } });
    for (let round = 0; round < 10; round += 1) {
      const required = inputRequiredSchema.safeParse(result);
      if (!required.success) break;
      if (!onInputRequired) throw new Error(`MCP tool ${this.#serverId}/${name} requires user input`);
      const inputResponses = await onInputRequired({ prompts: required.data.prompts });
      result = await this.#transport.request({ method: "tools/call", name, params: { arguments: toolArguments, inputResponses, name, requestState: required.data.requestState } });
    }
    if (inputRequiredSchema.safeParse(result).success) throw new Error(`MCP tool ${this.#serverId}/${name} exceeded elicitation round limit`);
    const taskResult = taskResultSchema.safeParse(result);
    if (!taskResult.success) return this.#validateOutput(name, result);
    let task = taskResult.data.task;
    await onTaskStatus?.(task);
    const deadline = this.#now() + 30_000;
    for (;;) {
      if (task.status === "completed") return this.#validateOutput(name, taskResult.data.result);
      if (task.status === "failed" || task.status === "cancelled") throw new Error(`MCP task ${task.id} ${task.status}`);
      if (this.#now() >= deadline) throw new Error(`MCP task ${task.id} timed out`);
      await this.#sleep(250);
      const next = taskResultSchema.parse(await this.#transport.request({ method: "tasks/get", name: task.id, params: { taskId: task.id } }));
      task = next.task;
      await onTaskStatus?.(task);
      if (task.status === "completed") return this.#validateOutput(name, next.result);
      if (task.status === "failed" || task.status === "cancelled") throw new Error(`MCP task ${task.id} ${task.status}`);
    }
  }

  cancelTask(taskId: string): Promise<unknown> { return this.#transport.request({ method: "tasks/cancel", name: taskId, params: { taskId } }); }
  updateTask({ taskId, update }: { taskId: string; update: Record<string, unknown> }): Promise<unknown> { return this.#transport.request({ method: "tasks/update", name: taskId, params: { taskId, update } }); }

  async #validateOutput(name: string, result: unknown): Promise<unknown> {
    const schema = this.#outputSchemas.get(name);
    if (!schema) return result;
    const structuredContent = typeof result === "object" && result !== null && "structuredContent" in result ? result.structuredContent : result;
    const validation = await schemaWorker.validate({ schema, value: structuredContent });
    if (!validation.valid) throw new Error(`Invalid output for MCP tool ${this.#serverId}/${name}: ${validation.errors}`);
    return result;
  }
}

type ValidationResult = { errors: string; valid: boolean };
type PendingValidation = { reject(error: Error): void; resolve(result: ValidationResult): void; timer: ReturnType<typeof setTimeout> };

class BoundedSchemaWorker {
  #nextId = 1;
  #pending = new Map<number, PendingValidation>();
  #state: Promise<Worker> | null = null;

  async compile(schemas: Record<string, unknown>[]): Promise<void> { await this.#request({ kind: "compile", schemas }); }
  validate({ schema, value }: { schema: Record<string, unknown>; value: unknown }): Promise<ValidationResult> { return this.#request({ kind: "validate", schema, value }); }

  async #request(payload: { kind: "compile"; schemas: Record<string, unknown>[] } | { kind: "validate"; schema: Record<string, unknown>; value: unknown }): Promise<ValidationResult> {
    const worker = await this.#worker();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#reset(new Error("MCP schema validation timed out")); }, SCHEMA_TIMEOUT_MS);
      this.#pending.set(id, { reject, resolve, timer });
      worker.postMessage({ ...payload, id });
    });
  }

  #worker(): Promise<Worker> {
    if (this.#state) return this.#state;
    this.#state = new Promise((resolve, reject) => {
      const worker = new Worker(new URL("./mcp-schema-worker.ts", import.meta.url).href);
      const startupTimer = setTimeout(() => { worker.terminate(); this.#state = null; reject(new Error("MCP schema validator failed to start")); }, 30_000);
      worker.onmessage = (event: MessageEvent<{ error?: string; errors?: string; id?: number; kind?: "ready"; valid?: boolean }>) => {
        if (event.data.kind === "ready") { clearTimeout(startupTimer); resolve(worker); return; }
        if (event.data.id === undefined) return;
        const pending = this.#pending.get(event.data.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.#pending.delete(event.data.id);
        if (event.data.error) pending.reject(new Error(event.data.error));
        else pending.resolve({ errors: event.data.errors ?? "", valid: event.data.valid === true });
      };
      worker.onerror = (event) => { clearTimeout(startupTimer); this.#reset(new Error(event.message)); reject(new Error(event.message)); };
    });
    return this.#state;
  }

  #reset(error: Error): void {
    void this.#state?.then((worker) => worker.terminate(), () => undefined);
    this.#state = null;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
  }
}

const schemaWorker = new BoundedSchemaWorker();

function parseResponse(value: unknown, expectedId: number): unknown {
  const response = responseSchema.parse(value);
  if (response.id !== expectedId) throw new Error("MCP response id mismatch");
  if (response.error) throw new Error(`MCP error ${response.error.code}: ${response.error.message}`);
  if (!("result" in response)) throw new Error("MCP response omitted result");
  return response.result;
}
