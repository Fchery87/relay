import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ThreadActivity } from "./thread-activity";

test("virtualizes long activity event lists", () => {
  const markup = renderToStaticMarkup(<ThreadActivity events={Array.from({ length: 100 }, (_, index) => ({
    _id: `event-${index}`,
    kind: "tool.completed",
    summary: `event ${index}`,
    tool: "bash",
  }))} />);

  expect(markup).toContain('data-virtual-list="true"');
  expect(markup).toContain("bash: event 0");
  expect(markup).not.toContain("event 40");
});
