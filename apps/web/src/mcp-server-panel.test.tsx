import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { McpServerPanel } from "./mcp-server-panel";

test("renders server connection status and secret-safe configuration controls", () => {
  const html = renderToStaticMarkup(<McpServerPanel onCreate={() => undefined} onRemove={() => undefined} onUpdate={() => undefined} servers={[
    { _id: "server", enabled: true, name: "Docs", status: "connected", toolCount: 3, transport: { authEnvVar: "DOCS_MCP_TOKEN", kind: "http", url: "https://mcp.example.test" } },
  ]} />);
  expect(html).toContain("MCP servers");
  expect(html).toContain("Docs");
  expect(html).toContain("Connected · 3 tools");
  expect(html).toContain("DOCS_MCP_TOKEN");
  expect(html).not.toContain('type="password"');
  expect(html).toContain("Add server");
  expect(html).toContain("Remove");
});

test("renders stdio command configuration and errors", () => {
  const html = renderToStaticMarkup(<McpServerPanel onCreate={() => undefined} onRemove={() => undefined} onUpdate={() => undefined} servers={[
    { _id: "local", enabled: false, error: "process exited", name: "Local", status: "error", transport: { args: ["server.ts"], command: "bun", kind: "stdio" } },
  ]} />);
  expect(html).toContain("bun");
  expect(html).toContain("server.ts");
  expect(html).toContain("process exited");
});
