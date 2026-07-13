import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const MAX_JSON_LENGTH = 100_000;

export const create = mutationGeneric({
  args: { promptsJson: v.string(), serverId: v.string(), threadId: v.id("threads"), toolName: v.string() },
  handler: async (ctx, args) => {
    if (args.promptsJson.length > MAX_JSON_LENGTH) throw new Error("MCP elicitation exceeds size limit");
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread) throw new Error("MCP elicitation thread not found");
    if (thread.status === "awaiting-approval" || thread.status === "restoring") throw new Error("Thread cannot accept MCP elicitation");
    const elicitationId = await ctx.db.insert("mcpElicitations", { ...args, resumeStatus: thread.status, status: "pending" });
    await ctx.db.patch(thread._id, { status: "awaiting-approval" });
    return elicitationId;
  },
});

export const get = queryGeneric({ args: { elicitationId: v.id("mcpElicitations") }, handler: (ctx, args) => ctx.db.get("mcpElicitations", args.elicitationId) });
export const listForThread = queryGeneric({ args: { threadId: v.id("threads") }, handler: (ctx, args) => ctx.db.query("mcpElicitations").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).take(100) });

export const submit = mutationGeneric({
  args: { elicitationId: v.id("mcpElicitations"), responseJson: v.string() },
  handler: async (ctx, args) => {
    if (args.responseJson.length > MAX_JSON_LENGTH) throw new Error("MCP elicitation response exceeds size limit");
    const parsed: unknown = JSON.parse(args.responseJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("MCP elicitation response must be a JSON object");
    const elicitation = await ctx.db.get("mcpElicitations", args.elicitationId);
    if (!elicitation || elicitation.status !== "pending") throw new Error("MCP elicitation is not pending");
    await ctx.db.patch(elicitation._id, { responseJson: args.responseJson, status: "submitted" });
    await ctx.db.patch(elicitation.threadId, { status: elicitation.resumeStatus });
  },
});

export const cancel = mutationGeneric({
  args: { elicitationId: v.id("mcpElicitations") },
  handler: async (ctx, args) => {
    const elicitation = await ctx.db.get("mcpElicitations", args.elicitationId);
    if (!elicitation || elicitation.status !== "pending") throw new Error("MCP elicitation is not pending");
    await ctx.db.patch(elicitation._id, { status: "cancelled" });
    await ctx.db.patch(elicitation.threadId, { status: elicitation.resumeStatus });
  },
});
