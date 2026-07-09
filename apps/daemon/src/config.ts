import { machinePlatformSchema, projectRegistrationSchema, type MachineRegistration } from "@relay/shared";
import { z } from "zod";

export type DaemonConfig = {
  deploymentUrl: string;
  heartbeatIntervalMs: number;
  registration: MachineRegistration;
};

const projectsSchema = z.array(projectRegistrationSchema);

function requiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
}

export function loadDaemonConfig({
  env,
  hostname,
}: {
  env: Readonly<Record<string, string | undefined>>;
  hostname: () => string;
}): DaemonConfig {
  const parsedPlatform = machinePlatformSchema.safeParse(process.platform);
  if (!parsedPlatform.success) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  const projectsInput: unknown = JSON.parse(requiredEnv(env, "RELAY_PROJECTS"));
  const projects = projectsSchema.parse(projectsInput);

  return {
    deploymentUrl: requiredEnv(env, "RELAY_CONVEX_URL"),
    heartbeatIntervalMs: 10_000,
    registration: {
      daemonVersion: env.RELAY_DAEMON_VERSION ?? "0.0.0-dev",
      deviceToken: requiredEnv(env, "RELAY_DEVICE_TOKEN"),
      name: env.RELAY_MACHINE_NAME ?? hostname(),
      platform: parsedPlatform.data,
      projects,
    },
  };
}
