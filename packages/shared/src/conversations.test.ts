import { expect, test } from "bun:test";

import { messageSchema } from "./conversations";

test("accepts a queued user message", () => {
  expect(
    messageSchema.parse({
      content: "Explain this repository",
      role: "user",
      status: "queued",
      threadId: "thread-1",
    }),
  ).toMatchObject({ role: "user", status: "queued" });
});

test("accepts an in-progress assistant message", () => {
  expect(
    messageSchema.parse({
      content: "I am reading the project.",
      role: "assistant",
      status: "streaming",
      threadId: "thread-1",
    }),
  ).toMatchObject({ role: "assistant", status: "streaming" });
});
