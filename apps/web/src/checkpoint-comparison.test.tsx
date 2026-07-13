import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CheckpointComparison } from "./checkpoint-comparison";

test("renders controls for comparing any two checkpoints", () => {
  const markup = renderToStaticMarkup(<CheckpointComparison checkpoints={[
    { _id: "checkpoint-1", messageId: "message-1" },
    { _id: "checkpoint-2", messageId: "message-2" },
  ]} onCompare={async () => undefined} />);
  expect(markup).toContain('aria-label="From checkpoint"');
  expect(markup).toContain('aria-label="To checkpoint"');
  expect(markup).toContain("Compare");
  expect(markup).not.toContain("disabled");
});
