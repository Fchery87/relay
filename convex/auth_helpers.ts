import { getAuthUserId } from "@convex-dev/auth/server";
import type { QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

export async function requireUser(ctx: Parameters<typeof getAuthUserId>[0]): Promise<NonNullable<Awaited<ReturnType<typeof getAuthUserId>>>> {
  const userId = await getAuthUserId(ctx);
  if (userId === null) throw new Error("Not authenticated");
  return userId;
}

/** Require operator role — only users with an operator role can invoke admin mutations. */
export async function requireOperator(ctx: Parameters<typeof getAuthUserId>[0] & Pick<QueryCtx, "db">): Promise<NonNullable<Awaited<ReturnType<typeof getAuthUserId>>>> {
  const userId = await requireUser(ctx);
  const role = await ctx.db.query("operatorRoles").withIndex("by_user", (q) => q.eq("userId", userId as unknown as Id<"users">)).first();
  if (!role) throw new Error("Operator role required");
  return userId;
}

export async function digestSecret(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

type DatabaseCtx = Pick<QueryCtx, "db">;

export async function requireOwnedMachine(ctx: DatabaseCtx, userId: Id<"users">, machineId: Id<"machines">) {
  const machine = await ctx.db.get(machineId);
  if (!machine || machine.ownerId !== userId || machine.revokedAt) throw new Error("Machine does not belong to the current user");
  return machine;
}

export async function requireOwnedProject(ctx: DatabaseCtx, userId: Id<"users">, projectId: Id<"projects">) {
  const project = await ctx.db.get(projectId);
  if (!project) throw new Error("Project not found");
  await requireOwnedMachine(ctx, userId, project.machineId);
  return project;
}

export async function requireOwnedThread(ctx: DatabaseCtx, userId: Id<"users">, threadId: Id<"threads">) {
  const thread = await ctx.db.get(threadId);
  if (!thread) throw new Error("Thread not found");
  await requireOwnedProject(ctx, userId, thread.projectId);
  return thread;
}

export async function requireActiveMachine(ctx: DatabaseCtx, deviceToken: string) {
  const deviceTokenHash = await digestSecret(deviceToken);
  const machine = await ctx.db.query("machines").withIndex("by_device_token_hash", (q) => q.eq("deviceTokenHash", deviceTokenHash)).unique();
  if (!machine || machine.revokedAt || !machine.ownerId) throw new Error("Unknown or revoked device token");
  return machine;
}

export async function requireDeviceForThread(ctx: DatabaseCtx, deviceToken: string, threadId: Id<"threads">) {
  const machine = await requireActiveMachine(ctx, deviceToken);
  const thread = await ctx.db.get(threadId);
  if (!thread) throw new Error("Thread not found");
  const project = await ctx.db.get(thread.projectId);
  if (!project || project.machineId !== machine._id) throw new Error("Device does not own this thread");
  return machine;
}
