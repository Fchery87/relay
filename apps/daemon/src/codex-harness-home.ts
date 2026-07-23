import { join } from "node:path";

export type CodexHarnessHome = {
  readonly path: string;
  readonly isolated: boolean;
};

/**
 * Protected runs are hermetic by default. A caller must explicitly provide a
 * Codex home to reuse an authenticated local session; the caller owns that
 * home and the harness never removes it.
 */
export function resolveCodexHarnessHome(daemonHome: string, configuredHome?: string): CodexHarnessHome {
  const explicitHome = configuredHome?.trim();
  return explicitHome
    ? { path: explicitHome, isolated: false }
    : { path: join(daemonHome, "codex-home"), isolated: true };
}
