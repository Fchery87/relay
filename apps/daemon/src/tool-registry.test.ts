import { expect, test } from "bun:test";
import { TOOL_REGISTRY, toolContract } from "./tool-registry";
test("every executable tool has one truthful versioned contract", () => { expect([...TOOL_REGISTRY.keys()].sort()).toEqual(["bash", "edit", "glob", "grep", "mcp", "read", "skill", "str_replace", "task", "todo", "web_fetch", "web_search"]); for (const contract of TOOL_REGISTRY.values()) { expect(contract.description.length).toBeGreaterThan(10); expect(contract.maxOutputBytes).toBeGreaterThan(0); } expect(toolContract({ kind: "read", path: "x" }).name).toBe("read"); });
