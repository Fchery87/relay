import { makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";
import { DEFAULT_MODEL_ID, MODEL_CATALOG, listThinkingLevels } from "@relay/shared";
import { requireActiveMachine, requireDeviceForThread, requireOwnedProject, requireOwnedThread, requireUser } from "./auth_helpers";

const threadStatus = v.union(v.literal("idle"), v.literal("queued"), v.literal("running"), v.literal("awaiting-approval"), v.literal("restoring"), v.literal("stopped"), v.literal("done"), v.literal("failed"));
const removeUsageForThread = makeFunctionReference<"mutation", { threadId: string }, null>("usage:removeForThreadBatch");
const MAX_PLAN_SECTION_BYTES = 400_000;

export const createThread = mutationGeneric({
  args: {
    mode: v.optional(v.union(v.literal("chat"), v.literal("plan"))),
    permissionProfile: v.optional(v.union(v.literal("read-only"), v.literal("workspace-write"), v.literal("full-access"))),
    projectId: v.id("projects"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOwnedProject(ctx, await requireUser(ctx), args.projectId);
    return ctx.db.insert("threads", {
    ...args,
    permissionProfile: args.permissionProfile ?? "workspace-write",
    buildModelId: args.mode === "plan" ? DEFAULT_MODEL_ID : undefined,
    modelId: DEFAULT_MODEL_ID,
    planModelId: args.mode === "plan" ? DEFAULT_MODEL_ID : undefined,
    planPhase: args.mode === "plan" ? "planning" : undefined,
    status: "idle",
    stopRequested: false,
    thinkingLevel: "none",
    usageTotals: { cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, thinkingTokensUnavailableCalls: 0 },
    });
  },
});

export const updateModelSelection = mutationGeneric({
  args: { modelId: v.string(), thinkingLevel: v.union(v.literal("none"), v.literal("low"), v.literal("medium"), v.literal("high")), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    const model = MODEL_CATALOG.models.find((entry) => entry.id === args.modelId);
    if (!model) throw new Error("Model is not in the catalog");
    if (!listThinkingLevels(model).includes(args.thinkingLevel)) throw new Error("Thinking level is not supported by this model");
    await ctx.db.patch(args.threadId, { modelId: args.modelId, thinkingLevel: args.thinkingLevel });
  },
});

export const updatePermissionProfile = mutationGeneric({
  args: {
    permissionProfile: v.union(v.literal("read-only"), v.literal("workspace-write"), v.literal("full-access")),
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const thread = await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    if (thread.status === "running" || thread.status === "awaiting-approval" || thread.status === "restoring") {
      throw new Error("The permission profile cannot change while a turn is executing");
    }
    await ctx.db.patch(args.threadId, { permissionProfile: args.permissionProfile });
  },
});

export const sendUserMessage = mutationGeneric({
  args: { content: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const thread = await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    if (thread.mode === "plan" && thread.planPhase === "review") throw new Error("Approve or edit the draft plan before sending another message");
    if (thread.mode === "plan" && thread.planPhase === "planning") {
      const queued = await ctx.db.query("messages").withIndex("by_queued_thread", (q) => q.eq("queuedThreadId", args.threadId)).take(100);
      if (queued.length >= 100) throw new Error("Plan follow-up queue is full");
      const queuedBytes = queued.reduce((total, message) => total + utf8Bytes(message.content), 0);
      if (queuedBytes + utf8Bytes(args.content) > MAX_PLAN_SECTION_BYTES) throw new Error("Plan follow-up queue exceeds its size limit");
    }
    const messageId = await ctx.db.insert("messages", { ...args, queuedThreadId: args.threadId, role: "user", status: "queued" });
    if (thread.status !== "running" && thread.status !== "awaiting-approval" && thread.status !== "restoring") await ctx.db.patch(args.threadId, { status: "queued" });
    return messageId;
  },
});

function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }

export const claimSteeringMessages = mutationGeneric({
  args: { deviceToken: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread || thread.status !== "running" || thread.stopRequested === true) return [];
    const messages = await ctx.db.query("messages").withIndex("by_queued_thread", (q) => q.eq("queuedThreadId", args.threadId)).take(100);
    for (const message of messages) await ctx.db.patch(message._id, { queuedThreadId: undefined, status: "complete" });
    return messages.map(({ content }) => ({ content }));
  },
});

export const requestStop = mutationGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    const thread = await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    if (thread.status !== "running") throw new Error("Only a running thread can be stopped");
    await ctx.db.patch(args.threadId, { stopRequested: true });
  },
});

export const getStopState = queryGeneric({
  args: { deviceToken: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread) throw new Error("Thread not found");
    return { requested: thread.stopRequested === true };
  },
});

export const acknowledgeStop = mutationGeneric({
  args: { deviceToken: v.string(), messageId: v.id("messages"), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread) throw new Error("Thread not found");
    const message = await ctx.db.get("messages", args.messageId);
    if (!message || message.threadId !== args.threadId || !thread || thread.activeAssistantMessageId !== args.messageId) throw new Error("Stop acknowledgement does not match the active turn");
    if (thread.status !== "running" || thread.stopRequested !== true) throw new Error("Stop was not requested for the active turn");
    await ctx.db.patch(args.messageId, { status: "complete" });
    const queued = await ctx.db.query("messages").withIndex("by_queued_thread", (q) => q.eq("queuedThreadId", args.threadId)).first();
    await ctx.db.patch(args.threadId, { activeAssistantMessageId: undefined, status: queued ? "queued" : "stopped", stopRequested: false });
  },
});

export const listThreadMessages = queryGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    return ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", args.threadId)).collect();
  },
});

export const listProjectThreads = queryGeneric({
  args: { projectId: v.id("projects") },
  handler: async (ctx, args) => {
    await requireOwnedProject(ctx, await requireUser(ctx), args.projectId);
    return ctx.db.query("threads").withIndex("by_project", (q) => q.eq("projectId", args.projectId)).collect();
  },
});

export const listThreadIds = queryGeneric({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    const machine = await requireActiveMachine(ctx, args.deviceToken);
    const projects = await ctx.db.query("projects").withIndex("by_machine", (q) => q.eq("machineId", machine._id)).collect();
    const threadIds = await Promise.all(projects.map(async (project) => (await ctx.db.query("threads").withIndex("by_project", (q) => q.eq("projectId", project._id)).collect()).map((thread) => thread._id)));
    return threadIds.flat();
  },
});

export const removeThread = mutationGeneric({
  args: { threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireOwnedThread(ctx, await requireUser(ctx), args.threadId);
    for await (const server of ctx.db.query("mcpServers").withIndex("by_approval_thread_id", (q) => q.eq("approvalThreadId", args.threadId))) await ctx.db.delete(server._id);
    for await (const elicitation of ctx.db.query("mcpElicitations").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(elicitation._id);
    for await (const plan of ctx.db.query("plans").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(plan._id);
    for await (const run of ctx.db.query("subagentRuns").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(run._id);
    for await (const event of ctx.db.query("events").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(event._id);
    for await (const comparison of ctx.db.query("checkpointComparisons").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(comparison._id);
    for await (const action of ctx.db.query("checkpointActions").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(action._id);
    for await (const checkpoint of ctx.db.query("checkpoints").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(checkpoint._id);
    for await (const message of ctx.db.query("messages").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(message._id);
    for await (const comment of ctx.db.query("diffComments").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(comment._id);
    for await (const approval of ctx.db.query("approvals").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(approval._id);
    for await (const audit of ctx.db.query("auditLog").withIndex("by_thread", (q) => q.eq("threadId", args.threadId))) await ctx.db.delete(audit._id);
    await ctx.scheduler.runAfter(0, removeUsageForThread, { threadId: args.threadId });
    await ctx.db.delete(args.threadId);
  },
});

export const claimQueuedMessage = mutationGeneric({
  args: { deviceToken: v.string() },
  handler: async (ctx, args) => {
    const machine = await requireActiveMachine(ctx, args.deviceToken);

    for await (const message of ctx.db.query("messages").withIndex("by_status", (q) => q.eq("status", "queued"))) {
      const thread = await ctx.db.get("threads", message.threadId);
      if (!thread) continue;
      if (thread.status === "running" || thread.status === "awaiting-approval" || thread.status === "restoring" || thread.status === "stopped") continue;
      if (thread.mode === "plan" && thread.planPhase === "review") continue;
      const project = await ctx.db.get("projects", thread.projectId);
      if (!project || project.machineId !== machine._id || project.archivedAt) continue;
      if (project.status === "pending" || project.status === "error") continue;
      const reviewComments = await ctx.db.query("diffComments")
        .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
        .filter((q) => q.eq(q.field("resolved"), false))
        .collect();
      await ctx.db.patch(message._id, { queuedThreadId: undefined, status: "complete" });
      await ctx.db.patch(thread._id, { status: "running" });

      // Build history: last 40 non-queued messages
      const historyMessages = await ctx.db.query("messages")
        .withIndex("by_thread", (q) => q.eq("threadId", thread._id))
        .filter((q) => q.neq(q.field("status"), "queued"))
        .order("desc")
        .take(40);
      const history = historyMessages.reverse().map((m) => ({
        content: m.content.length > 4000 ? m.content.slice(0, 4000) : m.content,
        role: m.role,
      }));

      return {
        content: message.content,
        history,
        modelId: thread.mode === "plan" ? (thread.planPhase === "planning" ? thread.planModelId : thread.buildModelId) ?? DEFAULT_MODEL_ID : thread.modelId ?? DEFAULT_MODEL_ID,
        permissionProfile: thread.permissionProfile ?? "workspace-write",
        planPhase: thread.mode === "plan" ? thread.planPhase : undefined,
        projectId: project._id,
        projectPath: project.path,
        reviewComments: reviewComments.map((comment) => ({
          commentId: comment._id,
          content: comment.content,
          endLine: comment.endLine,
          filePath: comment.filePath,
          startLine: comment.startLine,
        })),
        threadId: thread._id,
        thinkingLevel: thread.thinkingLevel ?? "none",
      };
    }
    return null;
  },
});

export const beginAssistantMessage = mutationGeneric({
  args: { deviceToken: v.string(), threadId: v.id("threads") },
  handler: async (ctx, args) => {
    await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    const messageId = await ctx.db.insert("messages", { content: "", role: "assistant", status: "streaming", threadId: args.threadId });
    await ctx.db.patch(args.threadId, { activeAssistantMessageId: messageId });
    return messageId;
  },
});

export const appendAssistantText = mutationGeneric({
  args: { content: v.string(), deviceToken: v.string(), messageId: v.id("messages") },
  handler: async (ctx, args) => {
    const message = await ctx.db.get("messages", args.messageId);
    if (!message) throw new Error("Assistant message not found");
    await requireDeviceForThread(ctx, args.deviceToken, message.threadId);
    await ctx.db.patch(args.messageId, { content: args.content });
  },
});

export const completeAssistantMessage = mutationGeneric({
  args: { deviceToken: v.string(), messageId: v.id("messages"), resolvedCommentIds: v.optional(v.array(v.id("diffComments"))), threadId: v.id("threads"), status: threadStatus },
  handler: async (ctx, args) => {
    await requireDeviceForThread(ctx, args.deviceToken, args.threadId);
    const thread = await ctx.db.get("threads", args.threadId);
    if (!thread) throw new Error("Thread not found");
    const message = await ctx.db.get("messages", args.messageId);
    if (!message || message.threadId !== args.threadId || !thread || thread.activeAssistantMessageId !== args.messageId) throw new Error("Assistant completion does not match the active turn");
    if (args.status === "done" && thread.stopRequested === true) {
      await ctx.db.patch(args.messageId, { status: "complete" });
      const queued = await ctx.db.query("messages").withIndex("by_queued_thread", (q) => q.eq("queuedThreadId", args.threadId)).first();
      await ctx.db.patch(args.threadId, { activeAssistantMessageId: undefined, status: queued ? "queued" : "stopped", stopRequested: false });
      return;
    }
    if (args.status === "done") {
      for (const commentId of args.resolvedCommentIds ?? []) {
        const comment = await ctx.db.get("diffComments", commentId);
        if (comment?.threadId === args.threadId) await ctx.db.patch(commentId, { resolved: true });
      }
    }
    await ctx.db.patch(args.messageId, { status: "complete" });
    const queued = args.status === "done"
      ? await ctx.db.query("messages").withIndex("by_queued_thread", (q) => q.eq("queuedThreadId", args.threadId)).first()
      : null;
    await ctx.db.patch(args.threadId, { activeAssistantMessageId: undefined, status: queued ? "queued" : args.status });
    if (args.status === "done" && thread.mode === "plan" && thread.planPhase === "building") await ctx.db.patch(args.threadId, { planPhase: "complete" });
  },
});

// --- Paginated queries (bounded reads for growing data) ---

export const listThreadMessagesPaginated = queryGeneric({
  args: {
    cursor: v.optional(v.string()),
    limit: v.number(),
    threadId: v.id("threads"),
  },
  handler: async (ctx, args) => {
    const userId = await requireUser(ctx);
    await requireOwnedThread(ctx, userId, args.threadId);
    return ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
  },
});

export const listProjectThreadsPaginated = queryGeneric({
  args: {
    cursor: v.optional(v.string()),
    limit: v.number(),
    projectId: v.id("projects"),
  },
  handler: async (ctx, args) => {
    await requireOwnedProject(ctx, await requireUser(ctx), args.projectId);
    return ctx.db
      .query("threads")
      .withIndex("by_project", (q) => q.eq("projectId", args.projectId))
      .paginate({ cursor: args.cursor ?? null, numItems: args.limit });
  },
});
