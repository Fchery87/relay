import { expect, test } from "bun:test";

import { formatOutgoingMessage } from "./message-attachments";

test("adds bounded text attachments to the outgoing agent request", () => {
  expect(formatOutgoingMessage("Review this", [{ content: "const relay = true;", name: "relay.ts" }])).toBe(
    "Review this\n\n<attachment name=\"relay.ts\">\nconst relay = true;\n</attachment>",
  );
});

test("removes line breaks from attachment names", () => {
  expect(formatOutgoingMessage("", [{ content: "notes", name: "unsafe\nname.md" }])).toContain('name="unsafe name.md"');
});
