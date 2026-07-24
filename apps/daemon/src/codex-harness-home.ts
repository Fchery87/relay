import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export type CodexHarnessHome = {
  readonly path: string;
  readonly isolated: boolean;
  readonly seededFrom?: string;
};

const SEEDED_FILES = ["auth.json", "config.toml", "installation_id"] as const;

/**
 * Protected runs are hermetic by default. When a caller explicitly points at a
 * user-authenticated Codex home, the harness still uses a writable temporary
 * home but seeds only the auth/config files needed for login. This avoids
 * mutating or depending on stale caches inside the user's long-lived home.
 */
export function resolveCodexHarnessHome(daemonHome: string, configuredHome?: string): CodexHarnessHome {
  const explicitHome = configuredHome?.trim();
  return explicitHome
    ? { path: join(daemonHome, "codex-home"), isolated: true, seededFrom: explicitHome }
    : { path: join(daemonHome, "codex-home"), isolated: true };
}

export async function prepareCodexHarnessHome(home: CodexHarnessHome): Promise<void> {
  await mkdir(home.path, { recursive: true });
  if (!home.seededFrom) return;
  for (const file of SEEDED_FILES) {
    try {
      await copyFile(join(home.seededFrom, file), join(home.path, file));
    } catch (error) {
      const maybe = error as NodeJS.ErrnoException;
      if (maybe.code !== "ENOENT") throw error;
    }
  }
}
