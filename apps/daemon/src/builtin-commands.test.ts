import { describe, expect, test } from "bun:test";
import { BUILTIN_COMMANDS, getBuiltinCommand } from "./builtin-commands";

describe("BUILTIN_COMMANDS", () => {
  test("contains exactly eleven built-in commands", () => {
    expect(BUILTIN_COMMANDS).toHaveLength(11);
  });

  test("every prompt built-in has non-empty template and description", () => {
    for (const cmd of BUILTIN_COMMANDS) {
      if (cmd.kind === "prompt") {
        expect(cmd.template.length).toBeGreaterThan(0);
        expect(cmd.description.length).toBeGreaterThan(0);
      }
    }
  });

  test("every action built-in has action set and no template", () => {
    for (const cmd of BUILTIN_COMMANDS) {
      if (cmd.kind === "action") {
        expect(cmd.action.length).toBeGreaterThan(0);
        expect((cmd as any).template).toBeUndefined();
      }
    }
  });

  test("all names are unique", () => {
    const names = BUILTIN_COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("getBuiltinCommand finds by name", () => {
    expect(getBuiltinCommand("help")?.name).toBe("help");
    expect(getBuiltinCommand("nonexistent")).toBeUndefined();
  });
});
