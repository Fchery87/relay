import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

const threadStatus = v.union(v.literal("idle"), v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed"));

export const createThread = mutationGeneric({
  args: { projectId: v.id("projects"), title: v.string() },
  handler: (ctx, args) => ctx.db.insert("threads", { ...args, status: "idle" }),
});

export const sendUserMessage = mutationGeneric({
  args: { content: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const messageId = await ctx.db.insert("messages", { ...args, role: "user", status: "queued" });
    await ctx.db.patch(args.threadId, { status: "queued" });
    return messageId;
  },
});

export const listThreadMessages = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect(),
});

export const listProjectThreads = queryGeneric({
  args: { projectId: v.id("projects") },
  handler: (ctx, args) => ctx.db.query("threads").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).collect(),
});

export const listThreadIds = queryGeneric({
  args: {},
  handler: async (ctx) => (await ctx.db.query("threads").collect()).map((thread) => thread._id),
});

export const removeThread = mutationGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    for await (const message of ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(message._id);
    for await (const comment of ctx.db.query("diffComments").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(comment._id);
    await ctx.db.delete(args.threadId);
  },
});

export const claimQueuedMessage = mutationGeneric({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    const machine = await ctx.db.query("machines").withIndex("by_device_token", (q) => q.eq("deviceToken", args.deviceToken)).unique();
    if (!machine) throw new Error("Unknown development device token");

    for await (const message of ctx.db.query("messages").withIndex("by_status", (q) => q.eq("status", "queued"))) {
      const thread = await ctx.db.get("threads", message.threadId);
      if (!thread) continue;
      const project = await ctx.db.get("projects", thread.projectId);
      if (!project || project.machineId !== machine._id) continue;
      const reviewComments = await ctx.db.query("diffComments")
        .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
        .filter((q) => q.eq(q.field("resolved"), false))
        .collect();
      await ctx.db.patch(message._id, { status: "complete" });
      await ctx.db.patch(thread._id, { status: "running" });
      return {
        content: message.content,
        projectPath: project.path,
        reviewComments: reviewComments.map((comment) => ({
          commentId: comment._id,
          content: comment.content,
          endLine: comment.endLine,
          filePath: comment.filePath,
          startLine: comment.startLine,
        })),
        threadId: thread._id,
      };
    }
    return null;
  },
});

export const beginAssistantMessage = mutationGeneric({
  args: { threadId: v.id("threads") },
  handler: (ctx, args) => ctx.db.insert("messages", { content: "", role: "assistant", status: "streaming", threadId: args.threadId }),
});

export const appendAssistantText = mutationGeneric({
  args: { content: v.string(), messageId: v.id("messages") },
  handler: (ctx, args) => ctx.db.patch(args.messageId, { content: args.content }),
});

export const completeAssistantMessage = mutationGeneric({
  args: { messageId: v.id("messages"), resolvedCommentIds: v.optional(v.array(v.id("diffComments"))), threadId: v.id("threads"), status: threadStatus },
  handler: async (ctx, args) => {
    if (args.status === "done") {
      for (const commentId of args.resolvedCommentIds ?? []) {
        const comment = await ctx.db.get("diffComments", commentId);
        if (comment?.threadId === args.threadId) await ctx.db.patch(commentId, { resolved: true });
      }
    }
    await ctx.db.patch(args.messageId, { status: "complete" });
    await ctx.db.patch(args.threadId, { status: args.status });
  },
});
