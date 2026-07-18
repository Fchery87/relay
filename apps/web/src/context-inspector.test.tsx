import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ContextInspector } from "./context-inspector";

test("renders a labelled modal inspector with a focused close control", () => {
  const markup = renderToStaticMarkup(<ContextInspector onClose={() => undefined} open title="Run context"><p>Evidence</p></ContextInspector>);

  expect(markup).toContain("<dialog");
  expect(markup).toContain('aria-labelledby="context-inspector-title"');
  expect(markup).toContain('autofocus=""');
  expect(markup).toContain('aria-label="Close inspector"');
  expect(markup).toContain("Run context");
});

test("keeps the mobile inspector out of the tree while closed", () => {
  expect(renderToStaticMarkup(<ContextInspector onClose={() => undefined} open={false} title="Run context"><p>Evidence</p></ContextInspector>)).toBe("");
});
