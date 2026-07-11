import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  machines: defineTable({
    deviceToken: v.string(),
    name: v.string(),
    platform: v.union(v.literal("darwin"), v.literal("linux"), v.literal("win32")),
    daemonVersion: v.string(),
    lastHeartbeatAt: v.number(),
  }).index("by_device_token", ["deviceToken"]),
  projects: defineTable({
    machineId: v.id("machines"),
    name: v.string(),
    path: v.string(),
  }).index("by_machine", ["machineId"]).index("by_machine_path", ["machineId", "path"]),
  threads: defineTable({
    projectId: v.id("projects"),
    status: v.union(v.literal("idle"), v.literal("queued"), v.literal("running"), v.literal("awaiting-approval"), v.literal("done"), v.literal("failed")),
    title: v.string(),
  }).index("by_project", ["projectId"]),
  messages: defineTable({
    content: v.string(),
    role: v.union(v.literal("assistant"), v.literal("user")),
    status: v.union(v.literal("complete"), v.literal("queued"), v.literal("streaming")),
    threadId: v.id("threads"),
  }).index("by_thread", ["threadId"]).index("by_status", ["status"]),
  events: defineTable({
    kind: v.union(v.literal("command.output"), v.literal("tool.completed")),
    output: v.optional(v.string()),
    summary: v.optional(v.string()),
    threadId: v.id("threads"),
    tool: v.optional(v.union(v.literal("bash"), v.literal("edit"), v.literal("read"))),
  }).index("by_thread", ["threadId"]),
  commands: defineTable({
    command: v.string(),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("complete"), v.literal("failed")),
    threadId: v.id("threads"),
  }).index("by_status", ["status"]).index("by_thread", ["threadId"]),
  diffs: defineTable({
    content: v.string(),
    threadId: v.id("threads"),
  }).index("by_thread", ["threadId"]),
  diffComments: defineTable({
    content: v.string(),
    endLine: v.number(),
    filePath: v.string(),
    resolved: v.boolean(),
    startLine: v.number(),
    threadId: v.id("threads"),
  }).index("by_thread", ["threadId"]),
  approvals: defineTable({
    capability: v.union(v.literal("read"), v.literal("edit"), v.literal("exec"), v.literal("task")),
    decision: v.union(v.literal("pending"), v.literal("allow"), v.literal("deny")),
    risk: v.union(v.literal("low"), v.literal("high"), v.literal("critical")),
    resumeStatus: v.optional(v.union(v.literal("idle"), v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed"))),
    summary: v.string(),
    threadId: v.id("threads"),
  }).index("by_thread", ["threadId"]),
  auditLog: defineTable({
    capability: v.union(v.literal("read"), v.literal("edit"), v.literal("exec"), v.literal("task")),
    decision: v.union(v.literal("allow"), v.literal("deny"), v.literal("ask")),
    risk: v.union(v.literal("low"), v.literal("high"), v.literal("critical")),
    summary: v.string(),
    threadId: v.id("threads"),
  }).index("by_thread", ["threadId"]),
  gitActions: defineTable({
    action: v.union(v.literal("stage"), v.literal("commit"), v.literal("push")),
    message: v.optional(v.string()),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("complete"), v.literal("failed")),
    threadId: v.id("threads"),
  }).index("by_status", ["status"]).index("by_thread", ["threadId"]),
});
