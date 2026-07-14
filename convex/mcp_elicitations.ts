import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { requireDeviceForThread, requireOwnedThread, requireUser } from "./auth_helpers";

const MAX_JSON_LENGTH = 100_000;

export const create = mutationGeneric({
  args: { deviceToken: v.string(), promptsJson: v.string(), serverId: v.string(), threadId: v.id("threads"), toolName: v.string() },
  handler: async (ctx, args) => {
    await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    if (args.promptsJson.length > MAX_JSON_LENGTH) throw new Error("MCP elicitation exceeds size limit");
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread) throw new Error("MCP elicitation thread not found");
    if (thread.status === "awaiting-approval" || thread.status === "restoring") throw new Error("Thread cannot accept MCP elicitation");
    const elicitationId = await ctx.db.insert("mcpElicitations", { promptsJson: args.promptsJson, resumeStatus: thread.status, serverId: args.serverId, status: "pending", threadId: args.threadId, toolName: args.toolName });
    await ctx.db.patch(thread._id, { status: "awaiting-approval" });
    return elicitationId;
  },
});

export const get = queryGeneric({ args: { deviceToken: v.string(), elicitationId: v.id("mcpElicitations") }, handler: async (ctx, args) => { const elicitation = await ctx.db.get("mcpElicitations", args.elicitationId); if (!elicitation) return null; await requireDeviceForThread(ctx, args.deviceToken, elicitation.threadId); return elicitation; } });
export const listForThread = queryGeneric({ args: { threadId: v.id("threads") }, handler: async (ctx, args) => { await requireOwnedThread(ctx, await requireUser(ctx), args.threadId); return ctx.db.query("mcpElicitations").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).take(100); } });

export const submit = mutationGeneric({
  args: { elicitationId: v.id("mcpElicitations"), responseJson: v.string() },
  handler: async (ctx, args) => {
    if (args.responseJson.length > MAX_JSON_LENGTH) throw new Error("MCP elicitation response exceeds size limit");
    const parsed: unknown = JSON.parse(args.responseJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("MCP elicitation response must be a JSON object");
    const elicitation = await ctx.db.get("mcpElicitations", args.elicitationId);
    if (!elicitation || elicitation.status !== "pending") throw new Error("MCP elicitation is not pending");
    await requireOwnedThread(ctx, await requireUser(ctx), elicitation.threadId);
    await ctx.db.patch(elicitation._id, { responseJson: args.responseJson, status: "submitted" });
    await ctx.db.patch(elicitation.threadId, { status: elicitation.resumeStatus });
  },
});

export const cancel = mutationGeneric({
  args: { elicitationId: v.id("mcpElicitations") },
  handler: async (ctx, args) => {
    const elicitation = await ctx.db.get("mcpElicitations", args.elicitationId);
    if (!elicitation || elicitation.status !== "pending") throw new Error("MCP elicitation is not pending");
    await requireOwnedThread(ctx, await requireUser(ctx), elicitation.threadId);
    await ctx.db.patch(elicitation._id, { status: "cancelled" });
    await ctx.db.patch(elicitation.threadId, { status: elicitation.resumeStatus });
  },
});
