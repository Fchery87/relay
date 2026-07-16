export type RuntimeMode = "legacy" | "shadow" | "kernel";

const VALID_RUNTIME_MODES = new Set<string>(["legacy", "shadow", "kernel"]);

export function resolveRuntimeMode(
  env: Readonly<Record<string, string | undefined>>,
): RuntimeMode {
  const raw = (env.RELAY_RUNTIME_MODE ?? "legacy").trim();
  if (!VALID_RUNTIME_MODES.has(raw)) {
    throw new Error(
      `Invalid RELAY_RUNTIME_MODE: "${raw}". Expected one of: legacy, shadow, kernel.`,
    );
  }
  return raw as RuntimeMode;
}

export function resolveMaxConcurrentRuns(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env.RELAY_KERNEL_MAX_CONCURRENT_RUNS;
  if (raw == null) return 4;
  const trimmed = raw.trim();
  if (trimmed === "" || !/^\d+$/.test(trimmed)) {
    throw new Error(
      `RELAY_KERNEL_MAX_CONCURRENT_RUNS must be a positive integer, got: "${raw}"`,
    );
  }
  const parsed = parseInt(trimmed, 10);
  if (parsed <= 0) {
    throw new Error(
      `RELAY_KERNEL_MAX_CONCURRENT_RUNS must be a positive integer, got: "${raw}"`,
    );
  }
  return parsed;
}
