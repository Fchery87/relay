import { expect, test } from "bun:test";

import { indexAtOffset } from "./virtual-list";

test("finds the row whose span contains an offset, not a fixed-height division", () => {
  // Cumulative offsets for rows of heights [50, 400, 20, 96, 96] — deliberately uneven, the way
  // real chat messages are (a long assistant reply next to short ones). A fixed-height estimate
  // of scrollTop / estimateRowHeight would misidentify the visible row as soon as any row's real
  // height diverges from the estimate; this search must stay correct against the real offsets.
  const offsets = [0, 50, 450, 470, 566, 662];

  expect(indexAtOffset(offsets, 0)).toBe(0);
  expect(indexAtOffset(offsets, 49)).toBe(0);
  expect(indexAtOffset(offsets, 50)).toBe(1);
  expect(indexAtOffset(offsets, 449)).toBe(1);
  expect(indexAtOffset(offsets, 450)).toBe(2);
  expect(indexAtOffset(offsets, 661)).toBe(4);
});

test("clamps to the last row once the offset reaches the end of the content", () => {
  const offsets = [0, 50, 450, 470, 566, 662];
  expect(indexAtOffset(offsets, 662)).toBe(4);
  expect(indexAtOffset(offsets, 10_000)).toBe(4);
});

test("handles an empty list without indexing off the array", () => {
  expect(indexAtOffset([0], 0)).toBe(0);
  expect(indexAtOffset([0], 500)).toBe(0);
});
