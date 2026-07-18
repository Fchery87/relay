import { describe, expect, test } from "bun:test";
import { parseFrontmatter } from "./frontmatter";

describe("parseFrontmatter", () => {
  test("parses key: value pairs and body", () => {
    const doc = "---\ndescription: Review the diff\nargument-hint: [pr-number]\n---\nDo the review of $ARGUMENTS.";
    expect(parseFrontmatter(doc)).toEqual({
      attributes: { "argument-hint": "[pr-number]", description: "Review the diff" },
      body: "Do the review of $ARGUMENTS.",
    });
  });

  test("returns empty attributes when no frontmatter block", () => {
    expect(parseFrontmatter("just a body")).toEqual({ attributes: {}, body: "just a body" });
  });

  test("ignores malformed lines instead of throwing", () => {
    const doc = "---\ndescription: ok\nnot a pair\n---\nbody";
    expect(parseFrontmatter(doc).attributes).toEqual({ description: "ok" });
  });

  test("handles values containing colons", () => {
    const doc = "---\ndescription: run: everything\n---\nbody";
    expect(parseFrontmatter(doc).attributes.description).toBe("run: everything");
  });
});
