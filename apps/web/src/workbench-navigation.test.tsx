import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { HandoffTrace } from "./handoff-trace";
import { resolveHandoffStage } from "./handoff-trace-utils";
import { WorkbenchTabs } from "./workbench-tabs";

test("renders an ordered handoff trace with one current stage", () => {
  const currentStage = resolveHandoffStage({
    hasPendingApproval: true,
    mode: "chat",
    status: "awaiting-approval",
  });
  const markup = renderToStaticMarkup(<HandoffTrace currentStage={currentStage} />);

  expect(currentStage).toBe("review");
  expect(markup).toContain('aria-label="Run workflow"');
  expect(markup).toContain("Request");
  expect(markup).toContain("Plan");
  expect(markup).toContain("Execute");
  expect(markup).toContain("Review");
  expect(markup).toContain("Deliver");
  expect(markup).toContain('aria-current="step"');
});

test("renders one selected contextual workbench surface", () => {
  const markup = renderToStaticMarkup(
    <WorkbenchTabs active="changes" onChange={() => undefined} showPlan />,
  );

  expect(markup).toContain('role="tablist"');
  expect(markup).toContain('aria-label="Task canvas views"');
  expect(markup).toContain("Session");
  expect(markup).toContain("Changes");
  expect(markup).toContain("Plan");
  expect(markup).not.toContain("Terminal");
  expect(markup).not.toContain("Agents");
  expect(markup).not.toContain("Connections");
  expect(markup).toContain('aria-selected="true"');
  expect(markup).toContain('aria-controls="workbench-panel"');
  expect(markup).toContain('tabindex="0"');
  expect(markup).toContain('tabindex="-1"');
});
