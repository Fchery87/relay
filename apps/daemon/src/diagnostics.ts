import { replayRunFromEvents } from "@relay/contracts";
export function replayDiagnostics(events: Parameters<typeof replayRunFromEvents>[0]): Readonly<{ runId: string; sequence: number; status: string }> { const snapshot = replayRunFromEvents(events); return { runId: snapshot.runId as string, sequence: snapshot.sequence, status: snapshot.status }; }
