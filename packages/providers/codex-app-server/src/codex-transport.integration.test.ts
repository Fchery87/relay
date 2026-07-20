import { expect, test } from "bun:test";
import { formatNotification, formatRequest, formatResponse, isNotification, isRequest, isResponse, parseMessage } from "./json-rpc-peer";

test("parses a valid JSON-RPC request", () => {
  const msg = parseMessage(formatRequest(1, "test/ping", { echo: true }));
  expect(isRequest(msg)).toBe(true);
  expect(isNotification(msg)).toBe(false);
  expect(isResponse(msg)).toBe(false);
});

test("parses a valid JSON-RPC notification", () => {
  const msg = parseMessage(formatNotification("test/event", { value: 42 }));
  expect(isNotification(msg)).toBe(true);
  expect(isRequest(msg)).toBe(false);
});

test("parses a valid JSON-RPC response with result", () => {
  const msg = parseMessage(formatResponse(99, { ok: true }));
  expect(isResponse(msg)).toBe(true);
  expect(isRequest(msg)).toBe(false);
});

test("parses a valid JSON-RPC error response", () => {
  const msg = parseMessage(formatResponse(5, undefined, { code: -32600, message: "Invalid Request" }));
  expect(isResponse(msg)).toBe(true);
});

test("rejects non-JSON-RPC messages", () => {
  expect(() => parseMessage(JSON.stringify({ foo: "bar" }))).toThrow();
});

test("rejects invalid JSON", () => {
  expect(() => parseMessage("not json")).toThrow();
});

test("round-trips a request through format/parse", () => {
  const original = { id: 42, method: "codex/turn", params: { prompt: "hello" } };
  const line = formatRequest(42, "codex/turn", { prompt: "hello" });
  const parsed = parseMessage(line);
  expect(isRequest(parsed)).toBe(true);
  if (isRequest(parsed)) {
    expect(parsed.id).toBe(42);
    expect(parsed.method).toBe("codex/turn");
  }
});

test("round-trips a notification through format/parse", () => {
  const line = formatNotification("codex/delta", { text: "hello world" });
  const parsed = parseMessage(line);
  expect(isNotification(parsed)).toBe(true);
});
