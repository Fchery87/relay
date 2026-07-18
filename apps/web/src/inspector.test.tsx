import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { InspectorPanel } from "./inspector";
import { EMPTY_USAGE_SUMMARY } from "./usage-panel";

test("inspector shows stage trace, environment, agents, and usage", () => {
  const markup = renderToStaticMarkup(
    <InspectorPanel
      capabilityCeiling={["read", "edit"]}
      currentStage="execute"
      machineName="mbp"
      pendingApprovalCount={0}
      permissionProfile="workspace-write"
      projectName="relay"
      subagentRuns={[]}
      usage={EMPTY_USAGE_SUMMARY}
    />,
  );
  expect(markup).toContain("Stage");
  expect(markup).toContain("handoff-trace");
  expect(markup).toContain("mbp");
  expect(markup).toContain("workspace-write");
  expect(markup).toContain("read · edit");
  expect(markup).toContain("No delegated runs.");
  expect(markup).not.toContain("Needs you");
});

test("pending approvals surface as a brass needs-you section", () => {
  const markup = renderToStaticMarkup(
    <InspectorPanel
      capabilityCeiling={[]}
      currentStage="review"
      machineName="mbp"
      pendingApprovalCount={2}
      permissionProfile="read-only"
      projectName="relay"
      subagentRuns={[{ _id: "s1", capabilities: [], depth: 0, roleId: "r1", status: "running", task: "scan tests" }]}
      usage={EMPTY_USAGE_SUMMARY}
    />,
  );
  expect(markup).toContain("Needs you");
  expect(markup).toContain("2 pending approvals");
  expect(markup).toContain("scan tests");
});
