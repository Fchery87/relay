import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

import { digestSecret, requireUser } from "./auth_helpers";

const PAIRING_TTL_MS = 5 * 60 * 1_000;
const MAX_START_ATTEMPTS_PER_WINDOW = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export const start = mutationGeneric({
  args: { code: v.string(), deviceNonce: v.string(), deviceToken: v.string() },
  handler: async (ctx, args) => {
    if (args.code.length < 8 || args.code.length > 128) throw new Error("Invalid pairing code");
    if (args.deviceToken.length < 32 || args.deviceToken.length > 512) throw new Error("Invalid device token");
    if (args.deviceNonce.length < 16 || args.deviceNonce.length > 256) throw new Error("Invalid device nonce");
    const codeHash = await digestSecret(args.code);

    // Reject collisions — an attacker who intercepts a code cannot replace
    // a pending pairing with their own device token.
    const existing = await ctx.db.query("pairings").withIndex("by_code_hash", (q) => q.eq("codeHash", codeHash)).unique();
    if (existing) {
      if (existing.expiresAt > Date.now()) throw new Error("Pairing code is already active");
      await ctx.db.delete(existing._id);
    }

    // Rate-limit start attempts per device token hash to deter brute-force.
    const deviceTokenHash = await digestSecret(args.deviceToken);
    const recent = await ctx.db.query("pairings").withIndex("by_device_token_hash", (q) => q.eq("deviceTokenHash", deviceTokenHash)).filter((q) => q.gt(q.field("_creationTime"), Date.now() - RATE_LIMIT_WINDOW_MS)).take(MAX_START_ATTEMPTS_PER_WINDOW);
    if (recent.length >= MAX_START_ATTEMPTS_PER_WINDOW) throw new Error("Too many pairing attempts — wait before retrying");

    await ctx.db.insert("pairings", {
      codeHash,
      deviceNonce: args.deviceNonce,
      deviceTokenHash,
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
    // Atomically consume pairing — first claim wins.
    await ctx.db.patch(pairing._id, { ownerId: userId, status: "claimed" });
  },
});

export const waitForClaim = queryGeneric({
  args: { code: v.string() },
  handler: async (ctx, args) => {
    const codeHash = await digestSecret(args.code);
    const pairing = await ctx.db.query("pairings").withIndex("by_code_hash", (q) => q.eq("codeHash", codeHash)).unique();
    if (!pairing || pairing.expiresAt <= Date.now()) return { status: "expired" as const, nonce: "" };
    if (pairing.status === "claimed") return { nonce: pairing.deviceNonce, status: "claimed" as const };
    return { nonce: "", status: pairing.status };
  },
});
