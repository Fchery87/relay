import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AuthForm } from "./auth-panel";

test("renders email-password sign-in and account creation controls", () => {
  const html = renderToStaticMarkup(<AuthForm onSubmit={async () => undefined} />);
  expect(html).toContain('type="email"');
  expect(html).toContain('type="password"');
  expect(html).toContain("Sign in");
  expect(html).toContain("Create account");
  expect(html).toContain('data-relay-mark="switchboard"');
  expect(html).toContain("Continue to your agent workbench");
});
