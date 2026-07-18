import { queryGeneric } from "convex/server";

import { requireUser } from "./auth_helpers";

export const me = queryGeneric({
  args: {},
  handler: async (ctx) => {
    const userId = await requireUser(ctx);
    const user = await ctx.db.get(userId);
    return { email: user && "email" in user ? user.email ?? null : null };
  },
});
