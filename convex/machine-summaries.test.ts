import { expect, test } from "bun:test";

import { toProjectSummary } from "./machine-summaries";

test("maps a Convex project document id into the browser contract", () => {
  expect(
    toProjectSummary({
      _id: "project-1",
      name: "relay",
      path: "/workspace/relay",
    }),
  ).toEqual({ id: "project-1", name: "relay", path: "/workspace/relay" });
});
