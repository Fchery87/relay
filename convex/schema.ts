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
    status: v.union(v.literal("idle"), v.literal("queued"), v.literal("running"), v.literal("done"), v.literal("failed")),
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
});
