import { expect, test } from "bun:test";

import { groupCommentsByFile, isReviewableDiff } from "./diff-view";

test("groups resolved and unresolved comments under their anchored files", () => {
  const grouped = groupCommentsByFile([
    { _id: "one", content: "First", endLine: 4, filePath: "src/a.ts", resolved: false, startLine: 3 },
    { _id: "two", content: "Second", endLine: 9, filePath: "src/b.ts", resolved: true, startLine: 9 },
  ]);

  expect(grouped.get("src/a.ts")?.[0]).toMatchObject({ content: "First", resolved: false });
  expect(grouped.get("src/b.ts")?.[0]).toMatchObject({ content: "Second", resolved: true });
});

test("only exposes comment controls for an actual Git patch", () => {
  expect(isReviewableDiff("No changes.")).toBe(false);
  expect(isReviewableDiff("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts")).toBe(true);
});
