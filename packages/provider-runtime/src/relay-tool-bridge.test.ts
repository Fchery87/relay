import { expect, test } from "bun:test";
import { executeRelayTool, type RelayToolRequest } from "./relay-tool-bridge";

test("relay tool bridge returns ok result", async () => {
  const result = await executeRelayTool(
    { id: "r1", name: "bash", input: { command: "echo hi" }, timeoutMs: 5000 },
    async (name, input, _signal) => `${name}: ${JSON.stringify(input)}`,
  );
  expect(result.ok).toBe(true);
  expect(result.result).toBe('bash: {"command":"echo hi"}');
});

test("relay tool bridge returns error on thrown executor", async () => {
  const result = await executeRelayTool(
    { id: "r2", name: "failing", input: {}, timeoutMs: 5000 },
    async () => { throw new Error("boom"); },
  );
  expect(result.ok).toBe(false);
  expect(result.error).toBe("boom");
});

test("relay tool bridge enforces minimum timeout", async () => {
  const result = await executeRelayTool(
    { id: "r3", name: "quick", input: null, timeoutMs: 0 },
    async () => "done",
  );
  expect(result.ok).toBe(true);
});

test("relay tool bridge enforces maximum timeout", async () => {
  const result = await executeRelayTool(
    { id: "r4", name: "slow", input: null, timeoutMs: 999_999 },
    async () => "still works",
  );
  expect(result.ok).toBe(true);
});
