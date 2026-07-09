import { z } from "zod";

export const machinePlatformSchema = z.enum(["darwin", "linux", "win32"]);

export const projectRegistrationSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
});

export const machineRegistrationSchema = z.object({
  deviceToken: z.string().min(1),
  name: z.string().min(1),
  platform: machinePlatformSchema,
  daemonVersion: z.string().min(1),
  projects: z.array(projectRegistrationSchema),
});

export type MachineRegistration = z.infer<typeof machineRegistrationSchema>;
export type MachinePlatform = z.infer<typeof machinePlatformSchema>;
export type ProjectRegistration = z.infer<typeof projectRegistrationSchema>;

export function machinePresence({
  heartbeatAt,
  now,
  offlineAfterMs,
}: {
  heartbeatAt: number;
  now: number;
  offlineAfterMs: number;
}): "online" | "offline" {
  return now - heartbeatAt < offlineAfterMs ? "online" : "offline";
}
