import { machinePlatformSchema, type MachineRegistration, type ProjectRegistration } from "@relay/shared";

export type DaemonConfig = {
  deploymentUrl: string;
  heartbeatIntervalMs: number;
  registration: MachineRegistration;
};

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
  projects,
  storedDeploymentUrl,
  storedDeviceToken,
}: {
  env: Readonly<Record<string, string | undefined>>;
  hostname: () => string;
  projects: ProjectRegistration[];
  storedDeploymentUrl?: string;
  storedDeviceToken?: string;
}): DaemonConfig {
  const parsedPlatform = machinePlatformSchema.safeParse(process.platform);
  if (!parsedPlatform.success) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  return {
    deploymentUrl: storedDeploymentUrl ?? requiredEnv(env, "RELAY_CONVEX_URL"),
    heartbeatIntervalMs: 10_000,
    registration: {
      daemonVersion: env.RELAY_DAEMON_VERSION ?? "0.0.0-dev",
      deviceToken: storedDeviceToken ?? requiredEnv(env, "RELAY_DEVICE_TOKEN"),
      name: env.RELAY_MACHINE_NAME ?? hostname(),
      platform: parsedPlatform.data,
      projects,
    },
  };
}
