import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { GovernancePanel } from "./governance-panel";

test("renders a pending approval card and its audit trail", () => {
  const markup = renderToStaticMarkup(<GovernancePanel
    approvals={[{ _id: "approval", capability: "exec", decision: "pending", risk: "high", summary: "rm -f output.txt" }]}
    audit={[{ _id: "audit", capability: "exec", decision: "ask", risk: "high", summary: "rm -f output.txt" }]}
    onResolve={async () => undefined}
  />);

  expect(markup).toContain("Approval required");
  expect(markup).toContain("rm -f output.txt");
  expect(markup).toContain("Allow");
  expect(markup).toContain("Deny");
  expect(markup).toContain("ask");
});
