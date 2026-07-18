import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { GitActionConfirmation } from "./git-action-confirmation";

test("requires an explicit review before a remote push", () => {
  const markup = renderToStaticMarkup(<GitActionConfirmation action="push" onCancel={() => undefined} onConfirm={() => undefined} projectName="relay" />);

  expect(markup).toContain("Review before execution");
  expect(markup).toContain("Push changes");
  expect(markup).toContain("relay");
  expect(markup).toContain("Configured upstream · non-force");
  expect(markup).toContain("Remote state is not frozen");
});

test("does not render a confirmation without a pending action", () => {
  expect(renderToStaticMarkup(<GitActionConfirmation action={undefined} onCancel={() => undefined} onConfirm={() => undefined} projectName="relay" />)).toBe("");
});
