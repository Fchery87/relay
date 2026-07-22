import { machinePlatformSchema, type MachineRegistration, type ProjectRegistration } from "@relay/shared";

export type DaemonConfig = {
  deploymentUrl: string;
  heartbeatIntervalMs: number;
  pollIntervalMs: number;
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
  storedDeviceNonce,
  storedDeviceToken,
}: {
  env: Readonly<Record<string, string | undefined>>;
  hostname: () => string;
  projects: ProjectRegistration[];
  storedDeploymentUrl?: string;
  storedDeviceNonce?: string;
  storedDeviceToken?: string;
}): DaemonConfig {
  const parsedPlatform = machinePlatformSchema.safeParse(process.platform);
  if (!parsedPlatform.success) {
    throw new Error(`Unsupported platform: ${process.platform}`);
  }

  const pollIntervalMs = Number(env.RELAY_POLL_INTERVAL_MS ?? 200);
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 50) {
    throw new Error("RELAY_POLL_INTERVAL_MS must be a number >= 50");
  }

  return {
    deploymentUrl: storedDeploymentUrl ?? requiredEnv(env, "RELAY_CONVEX_URL"),
    heartbeatIntervalMs: 10_000,
    pollIntervalMs,
    registration: {
      daemonVersion: env.RELAY_DAEMON_VERSION ?? "0.0.0-dev",
      deviceNonce: storedDeviceNonce,
      deviceToken: storedDeviceToken ?? requiredEnv(env, "RELAY_DEVICE_TOKEN"),
      name: env.RELAY_MACHINE_NAME ?? hostname(),
      platform: parsedPlatform.data,
      projects,
    },
  };
}
