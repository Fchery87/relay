import { join } from "node:path";

type DaemonEnvironment = Readonly<Record<string, string | undefined>>;

export function resolveDaemonHome({ env, homeDirectory, platform }: { env: DaemonEnvironment; homeDirectory: string; platform: string }): string {
  const configuredHome = env.RELAY_DAEMON_HOME?.trim();
  if (configuredHome) return configuredHome;

  if (platform === "darwin") return join(homeDirectory, "Library", "Application Support", "Relay");
  if (platform === "win32") return join(env.APPDATA ?? join(homeDirectory, "AppData", "Roaming"), "Relay");
  return join(env.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"), "relay");
}
