import { useState, type FormEvent } from "react";

export type McpElicitation = { _id: string; promptsJson: string; serverId: string; status: "pending" | "submitted" | "cancelled"; toolName: string };

export function McpElicitationCards({ items, onCancel, onSubmit }: { items: McpElicitation[]; onCancel?(elicitationId: string): Promise<unknown> | unknown; onSubmit(input: { elicitationId: string; responseJson: string }): Promise<unknown> | unknown }) {
  return <>{items.filter((item) => item.status === "pending").map((item) => <McpElicitationCard item={item} key={item._id} onCancel={onCancel} onSubmit={onSubmit} />)}</>;
}

function McpElicitationCard({ item, onCancel, onSubmit }: { item: McpElicitation; onCancel?(elicitationId: string): Promise<unknown> | unknown; onSubmit(input: { elicitationId: string; responseJson: string }): Promise<unknown> | unknown }) {
  const [response, setResponse] = useState("{}");
  const [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    try {
      const value: unknown = JSON.parse(response);
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Response must be a JSON object");
      setError("");
      await onSubmit({ elicitationId: item._id, responseJson: response });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Invalid response"); }
  }
  return <section className="approval-card mcp-elicitation"><div><h2>MCP input required</h2><p>{item.serverId} / {item.toolName}</p></div><pre>{formatPrompts(item.promptsJson)}</pre><form onSubmit={(event) => void submit(event)}><textarea aria-label="MCP input response" onChange={(event) => setResponse(event.target.value)} value={response} />{error ? <p>{error}</p> : null}<div><button onClick={() => void onCancel?.(item._id)} type="button">Cancel</button><button type="submit">Continue</button></div></form></section>;
}

function formatPrompts(value: string): string {
  try { return JSON.stringify(JSON.parse(value), null, 2); }
  catch { return "Input details unavailable."; }
}
