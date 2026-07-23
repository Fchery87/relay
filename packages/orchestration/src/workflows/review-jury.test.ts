import { expect, test } from "bun:test";
import {
  juryFindingToReviewComment,
  mergeJuryFindings,
  parseJuryFindings,
  runReviewJury,
} from "./review-jury";

test("parses bounded reviewer findings with source locations", () => {
  expect(parseJuryFindings(
    "FINDINGS:\n- P1 | Missing auth check | The mutation accepts a foreign project id. | convex/projects.ts:12-14\n- P3 | Naming | Clarify the field name.",
    "reviewer-security",
  )).toEqual([
    {
      severity: "P1",
      title: "Missing auth check",
      detail: "The mutation accepts a foreign project id.",
      source: "reviewer-security",
      filePath: "convex/projects.ts",
      startLine: 12,
      endLine: 14,
    },
    {
      severity: "P3",
      title: "Naming",
      detail: "Clarify the field name.",
      source: "reviewer-security",
    },
  ]);
});

test("merges jury findings by content and orders them by severity", () => {
  const merged = mergeJuryFindings([
    { severity: "P3", title: "Docs", detail: "Add a note", source: "reviewer" },
    { severity: "P0", title: "Auth", detail: "Fix it", source: "reviewer-security" },
    { severity: "P0", title: "auth", detail: "fix it", source: "reviewer" },
  ]);
  expect(merged).toHaveLength(2);
  expect(merged.map((finding) => finding.severity)).toEqual(["P0", "P3"]);
  expect(juryFindingToReviewComment(merged[0]!, 0)).toMatchObject({
    commentId: "jury-p0-1",
    filePath: "WORKFLOW",
    startLine: 1,
    endLine: 1,
  });
});

test("runs reviewers concurrently and returns deterministic findings", async () => {
  const findings = await runReviewJury([
    async () => [{ severity: "P2", title: "B", detail: "b", source: "reviewer" }],
    async () => [{ severity: "P1", title: "A", detail: "a", source: "reviewer-security" }],
  ], "run-1");
  expect(findings.map((finding) => finding.title)).toEqual(["A", "B"]);
});
