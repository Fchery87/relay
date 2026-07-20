import type { CanonicalEvent, RunSnapshot } from "@relay/contracts";
import { replayRunFromEvents } from "@relay/contracts";

export type TimeMachinePoint = Readonly<{ sequence: number; snapshot: RunSnapshot; eventCount: number }>;
export function reconstructAt(events: readonly CanonicalEvent[], sequence: number): TimeMachinePoint {
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error("Invalid replay sequence");
  const prefix = events.filter(event => event.sequence <= sequence).sort((a, b) => a.sequence - b.sequence);
  if (prefix.length === 0 || prefix.at(-1)!.sequence !== sequence) throw new Error(`Sequence ${sequence} is unavailable`);
  return { sequence, snapshot: replayRunFromEvents(prefix), eventCount: prefix.length };
}
export type ReplayDivergence = Readonly<{ sequence: number; left?: CanonicalEvent; right?: CanonicalEvent; reason: string }>;
export function firstDivergence(left: readonly CanonicalEvent[], right: readonly CanonicalEvent[]): ReplayDivergence | undefined {
  const count = Math.max(left.length, right.length);
  for (let i = 0; i < count; i++) { const a = left[i]; const b = right[i]; if (!a || !b) return { sequence: a?.sequence ?? b!.sequence, left: a, right: b, reason: "event-count" }; if (a.type !== b.type || JSON.stringify(a.payload) !== JSON.stringify(b.payload)) return { sequence: Math.min(a.sequence, b.sequence), left: a, right: b, reason: "event-or-payload" }; }
  return undefined;
}
