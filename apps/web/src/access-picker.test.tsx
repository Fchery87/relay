import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AccessPicker } from "./access-picker";

test("trigger names the current profile", () => {
  const markup = renderToStaticMarkup(<AccessPicker onChange={async () => {}} value="workspace-write" />);
  expect(markup).toContain("Workspace write");
  expect(markup).not.toContain('role="listbox"');
});

test("open popover offers all three profiles with the network warning on full access", () => {
  const markup = renderToStaticMarkup(<AccessPicker defaultOpen onChange={async () => {}} value="read-only" />);
  expect(markup).toContain("Read-only");
  expect(markup).toContain("Workspace write");
  expect(markup).toContain("Full access");
  expect(markup).toContain("Network enabled");
  expect(markup).toContain("auto-approves all tools");
  expect(markup).toContain('aria-selected="true"');
});

test("locks while a turn is running", () => {
  const markup = renderToStaticMarkup(<AccessPicker disabled onChange={async () => {}} value="workspace-write" />);
  expect(markup).toContain("disabled");
  expect(markup).toContain("Locked while a turn is running");
});
