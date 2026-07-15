import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { HandoffTrace, resolveHandoffStage } from "./handoff-trace";
import { WorkbenchTabs } from "./workbench-tabs";

test("renders an ordered handoff trace with one current stage", () => {
  const currentStage = resolveHandoffStage({
    hasPendingApproval: true,
    mode: "chat",
    status: "awaiting-approval",
  });
  const markup = renderToStaticMarkup(<HandoffTrace currentStage={currentStage} />);

  expect(currentStage).toBe("review");
  expect(markup).toContain('aria-label="Run handoff"');
  expect(markup).toContain("Request");
  expect(markup).toContain("Plan");
  expect(markup).toContain("Tools");
  expect(markup).toContain("Review");
  expect(markup).toContain("Deliver");
  expect(markup).toContain('aria-current="step"');
});

test("renders one selected contextual workbench surface", () => {
  const markup = renderToStaticMarkup(
    <WorkbenchTabs active="changes" onChange={() => undefined} showPlan />,
  );

  expect(markup).toContain('role="tablist"');
  expect(markup).toContain("Terminal");
  expect(markup).toContain("Changes");
  expect(markup).toContain("Plan");
  expect(markup).toContain("Agents");
  expect(markup).toContain("Connections");
  expect(markup).toContain('aria-selected="true"');
  expect(markup).toContain('aria-controls="workbench-panel"');
  expect(markup).toContain('tabindex="0"');
  expect(markup).toContain('tabindex="-1"');
});
