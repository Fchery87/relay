import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { PairingForm } from "./pairing-panel";

test("renders a pairing-code claim form", () => {
  const html = renderToStaticMarkup(<PairingForm onSubmit={async () => undefined} />);
  expect(html).toContain("Pair daemon");
  expect(html).toContain('name="code"');
  expect(html).toContain("Pair device");
});
