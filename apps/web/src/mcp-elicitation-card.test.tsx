import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { McpElicitationCards } from "./mcp-elicitation-card";

test("renders pending MCP prompts as an approval-style response card", () => {
  const html = renderToStaticMarkup(<McpElicitationCards items={[{ _id: "input", promptsJson: '[{"id":"date","label":"Date"}]', serverId: "travel", status: "pending", toolName: "book" }]} onSubmit={() => undefined} />);
  expect(html).toContain("MCP input required");
  expect(html).toContain("Date");
  expect(html).toContain("Continue");
  expect(html).toContain("Cancel");
});
