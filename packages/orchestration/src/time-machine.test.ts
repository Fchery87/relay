import { expect, test } from "bun:test";
import { firstDivergence } from "./time-machine";
const event = (sequence: number, type = "assistant.delta", payload: unknown = { text: "x" }) => ({ eventId: `e${sequence}`, sequence, streamVersion: sequence, type, runId: "r", correlationId: "c", occurredAt: sequence, payload } as any);
test("firstDivergence identifies the first changed canonical result", () => { expect(firstDivergence([event(1), event(2)], [event(1), event(2, "assistant.delta", { text: "y" })])?.sequence).toBe(2); expect(firstDivergence([event(1)], [event(1)])).toBeUndefined(); });
