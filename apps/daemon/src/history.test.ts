import { expect, test } from "bun:test";

import { historyToChatMessages, isPlanningAllowed } from "./agent-loop";

test("maps history to chat messages and drops the just-claimed user message", () => {
  const history = [
    { content: "first question", role: "user" },
    { content: "first answer", role: "assistant" },
    { content: "second question", role: "user" },
  ];
  const messages = historyToChatMessages(history, "second question");
  expect(messages).toEqual([
    { content: "first question", role: "user" },
    { blocks: [{ kind: "text", text: "first answer" }], role: "assistant" },
  ]);
});

test("keeps a trailing user message that is not the claimed one and skips blanks", () => {
  const history = [
    { content: "  ", role: "assistant" },
    { content: "older question", role: "user" },
  ];
  expect(historyToChatMessages(history, "a different new message")).toEqual([{ content: "older question", role: "user" }]);
  expect(historyToChatMessages(undefined, "x")).toEqual([]);
});

test("drops the claimed message even when the server truncated it in history", () => {
  const longContent = "y".repeat(5000);
  const history = [{ content: longContent.slice(0, 4000), role: "user" }];
  expect(historyToChatMessages(history, longContent)).toEqual([]);
});

test("planning phase allows read-only tools and refuses mutating ones", () => {
  expect(isPlanningAllowed({ kind: "read", path: "a.ts" })).toBe(true);
  expect(isPlanningAllowed({ kind: "grep", pattern: "x" })).toBe(true);
  expect(isPlanningAllowed({ kind: "glob", pattern: "**/*.ts" })).toBe(true);
  expect(isPlanningAllowed({ items: [], kind: "todo" })).toBe(true);
  expect(isPlanningAllowed({ content: "x", kind: "edit", path: "a.ts" })).toBe(false);
  expect(isPlanningAllowed({ kind: "str_replace", newString: "b", oldString: "a", path: "a.ts" })).toBe(false);
  expect(isPlanningAllowed({ command: "rm -rf /", kind: "bash" })).toBe(false);
  expect(isPlanningAllowed({ capabilities: [], kind: "task", role: "build", task: "x" })).toBe(false);
});
