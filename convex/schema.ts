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
});
