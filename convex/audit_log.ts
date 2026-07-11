import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const capability = v.union(v.literal("read"), v.literal("edit"), v.literal("exec"), v.literal("task"));
const decision = v.union(v.literal("allow"), v.literal("deny"), v.literal("ask"));
const risk = v.union(v.literal("low"), v.literal("high"), v.literal("critical"));

export const record = mutationGeneric({
  args: { capability, decision, risk, summary: v.string(), threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.insert("auditLog", args),
});

export const listForThread = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.query("auditLog").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect(),
});
