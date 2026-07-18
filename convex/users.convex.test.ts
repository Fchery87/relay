/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { expect, test } from "vitest";

import { api } from "./_generated/api";
import schema from "./schema.ts";

const modules = import.meta.glob("./**/*.ts");

test("me returns the signed-in user's email or null", async () => {
  const t = convexTest(schema, modules);
  const userId = await t.run((ctx) => ctx.db.insert("users", { email: "op@example.com" }));
  const owner = t.withIdentity({ subject: `${userId}|session` });
  expect(await owner.query(api.users.me, {})).toEqual({ email: "op@example.com" });

  const anonId = await t.run((ctx) => ctx.db.insert("users", {}));
  const anon = t.withIdentity({ subject: `${anonId}|session` });
  expect(await anon.query(api.users.me, {})).toEqual({ email: null });
});
