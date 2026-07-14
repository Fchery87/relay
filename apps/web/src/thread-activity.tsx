import type { ReactNode } from "react";

import { VirtualList } from "./virtual-list";

export type ThreadEvent = { _id: string; kind: string; output?: string; serverId?: string; status?: string; summary?: string; taskId?: string; tool?: string };

export function ThreadActivity({ events }: { events: readonly ThreadEvent[] }) {
  const activity = events.filter((event) => event.kind === "tool.completed" || event.kind === "checkpoint.reverted" || event.kind === "mcp.task");
  return <section><h2>Activity</h2><VirtualList className="activity-events" estimateRowHeight={28} items={activity}>{(event) => <p className="activity-line">{formatActivityEvent(event)}</p>}</VirtualList></section>;
}

export function ThreadTerminal({ children, events }: { children?: ReactNode; events: readonly ThreadEvent[] }) {
  const output = events.filter((event) => event.kind === "command.output" && event.output);
  return <section className="terminal"><h2>Terminal</h2>{output.length === 0 ? <pre>No command output.</pre> : <VirtualList className="terminal-output" estimateRowHeight={24} items={output}>{(event) => <pre>{event.output}</pre>}</VirtualList>}{children}</section>;
}

function formatActivityEvent(event: ThreadEvent): string {
  if (event.kind === "checkpoint.reverted") return "Checkpoint restored";
  if (event.kind === "mcp.task") return `MCP task ${event.taskId}: ${event.status}`;
  return `${event.tool}: ${event.summary}`;
}
