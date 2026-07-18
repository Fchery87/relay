import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DiffView, groupCommentsByFile, isReviewableDiff, parseFileStats, resolveFileKind, splitFiles, summarizeFiles } from "./diff-view";

const PATCH_WITH_TWO_FILES = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@",
  " line one",
  "+added line",
  " line two",
  " line three",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "index 000..333",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+brand new",
  "+second line",
].join("\n");

const DELETED_FILE_PATCH = [
  "diff --git a/old.ts b/old.ts",
  "deleted file mode 100644",
  "index 111..000",
  "--- a/old.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-removed one",
  "-removed two",
].join("\n");

const RENAMED_FILE_PATCH = [
  "diff --git a/old.ts b/new.ts",
  "similarity index 90%",
  "rename from old.ts",
  "rename to new.ts",
  "index 111..222 100644",
  "--- a/old.ts",
  "+++ b/new.ts",
  "@@ -1 +1 @@",
  "-old content",
  "+new content",
].join("\n");

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

test("counts additions and deletions in a patch", () => {
  expect(parseFileStats(" line\n+add\n+add2\n-del")).toEqual({ additions: 2, deletions: 1 });
  // +++ and --- headers must not be counted as content lines
  expect(parseFileStats("--- a/x.ts\n+++ b/x.ts\n+real")).toEqual({ additions: 1, deletions: 0 });
  expect(parseFileStats("")).toEqual({ additions: 0, deletions: 0 });
});

test("resolves change kind from git patch headers", () => {
  expect(resolveFileKind("new file mode 100644\n--- /dev/null\n+++ b/x.ts")).toBe("added");
  expect(resolveFileKind("deleted file mode 100644\n--- a/x.ts\n+++ /dev/null")).toBe("deleted");
  expect(resolveFileKind("rename from old.ts\nrename to new.ts")).toBe("renamed");
  expect(resolveFileKind("--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@")).toBe("modified");
});

test("splits a multi-file patch into parsed files with stats", () => {
  const files = splitFiles(PATCH_WITH_TWO_FILES);
  expect(files).toHaveLength(2);
  expect(files[0]).toMatchObject({ name: "src/a.ts", kind: "modified", additions: 1, deletions: 0 });
  expect(files[1]).toMatchObject({ name: "src/new.ts", kind: "added", additions: 2, deletions: 0 });
});

test("returns an empty array when there is no diff content", () => {
  expect(splitFiles("No changes.")).toEqual([]);
  expect(splitFiles("")).toEqual([]);
});

test("summarizes aggregate stats across all files", () => {
  const files = splitFiles(PATCH_WITH_TWO_FILES);
  const summary = summarizeFiles(files);
  expect(summary).toEqual({ fileCount: 2, additions: 3, deletions: 0 });
});

test("renders an empty state when no files are present", () => {
  const markup = renderToStaticMarkup(<DiffView comments={[]} content="No changes." />);
  expect(markup).toContain("diff-empty");
  expect(markup).toContain("◇");
  expect(markup).toContain("No changes.");
});

test("renders a file summary bar with counts for a real patch", () => {
  const markup = renderToStaticMarkup(<DiffView comments={[]} content={PATCH_WITH_TWO_FILES} />);
  expect(markup).toContain("diff-summary");
  expect(markup).toContain("2 files changed");
  expect(markup).toContain("+3");
});

test("renders per-file headers with kind badges and line stats", () => {
  const markup = renderToStaticMarkup(<DiffView comments={[]} content={DELETED_FILE_PATCH} />);
  expect(markup).toContain("diff-file-header");
  expect(markup).toContain("old.ts");
  expect(markup).toContain('data-kind="deleted"');
  expect(markup).toContain("−2");
});

test("renders renamed file kind badge", () => {
  const markup = renderToStaticMarkup(<DiffView comments={[]} content={RENAMED_FILE_PATCH} />);
  expect(markup).toContain('data-kind="renamed"');
});
