type Envelope = { id: number; method: string; params?: Record<string, unknown> };

export function fixtureResult(request: Envelope): unknown {
  if (request.method === "server/discover") return { capabilities: { tasks: true, tools: true } };
  if (request.method === "tools/list") return { tools: [{ annotations: { risk: "low" }, description: "Echo text", inputSchema: { properties: { text: { type: "string" } }, required: ["text"], type: "object" }, name: "echo" }], ttlMs: 10_000 };
  if (request.method === "tools/call") return { content: [{ text: String((request.params?.arguments as Record<string, unknown> | undefined)?.text ?? ""), type: "text" }] };
  throw new Error(`Unsupported fixture method ${request.method}`);
}

if (import.meta.main) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const bytes of Bun.stdin.stream()) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const request = JSON.parse(line) as Envelope;
      process.stdout.write(`${JSON.stringify({ id: request.id, jsonrpc: "2.0", result: fixtureResult(request) })}\n`);
    }
  }
}
