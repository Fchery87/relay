import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PlanPanel } from "./plan-panel";

test("renders planner and builder controls with an editable draft approval", () => {
  const html = renderToStaticMarkup(<PlanPanel buildModelId="openai/gpt-5-mini" canConfigureModels={false} onApprove={() => undefined} onModelPairChange={() => undefined} onUpdateDraft={() => undefined} plan={{ content: "1. Add schema", revision: 0, status: "draft" }} planModelId="deepseek/deepseek-v4-flash" phase="review" />);
  expect(html).toContain("Planner");
  expect(html).toContain("Builder");
  expect(html).toContain("1. Add schema");
  expect(html).toContain("Approve plan");
});
