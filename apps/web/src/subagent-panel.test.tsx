import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { SubagentPanel } from "./subagent-panel";

test("renders an editable role roster and drillable subagent tree", () => {
  const html = renderToStaticMarkup(<SubagentPanel onUpdateRole={() => undefined} roles={[{
    _id: "role", capabilities: ["read", "task"], contextMode: "fresh", description: "Map code", maxTurns: 20, modelId: "deepseek/deepseek-chat", name: "explore", prompt: "Explore", thinkingLevel: "high", writer: false,
  }]} runs={[{
    _id: "run", capabilities: ["read"], depth: 1, roleId: "role", status: "complete", task: "Map the repo", result: { artifacts: [], findings: ["src/app.ts:1"], status: "success", summary: "Mapped." },
  }]} />);
  expect(html).toContain("explore");
  expect(html).toContain("Map the repo");
  expect(html).toContain("Mapped.");
  expect(html).toContain("src/app.ts:1");
});
