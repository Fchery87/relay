import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

import { digestSecret, requireUser } from "./auth_helpers";

const PAIRING_TTL_MS = 5 * 60 * 1_000;

export const start = mutationGeneric({
  args: { code: v.string(), deviceToken: v.string() },
  handler: async (ctx, args) => {
    if (args.code.length < 8 || args.code.length > 128) throw new Error("Invalid pairing code");
    if (args.deviceToken.length < 32 || args.deviceToken.length > 512) throw new Error("Invalid device token");
    const codeHash = await digestSecret(args.code);
    const existing = await ctx.db.query("pairings").withIndex("by_code_hash", (q) => q.eq("codeHash", codeHash)).unique();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("pairings", {
      codeHash,
      deviceTokenHash: await digestSecret(args.deviceToken),
      expiresAt: Date.now() + PAIRING_TTL_MS,
      status: "waiting",
    });
  },
});

export const claim = mutationGeneric({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    const codeHash = await digestSecret(args.code);
    const pairing = await ctx.db.query("pairings").withIndex("by_code_hash", (q) => q.eq("codeHash", codeHash)).unique();
    if (!pairing || pairing.expiresAt <= Date.now()) throw new Error("Pairing code expired or invalid");
    if (pairing.status !== "waiting") throw new Error("Pairing code has already been claimed");
    await ctx.db.patch(pairing._id, { ownerId: userId, status: "claimed" });
  },
});

export const waitForClaim = queryGeneric({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const codeHash = await digestSecret(args.code);
    const pairing = await ctx.db.query("pairings").withIndex("by_code_hash", (q) => q.eq("codeHash", codeHash)).unique();
    if (!pairing || pairing.expiresAt <= Date.now()) return { status: "expired" as const };
    return { status: pairing.status };
  },
});
