export type ProtectedTestEnvironment = {
  readonly RELAY_CROSS_TIER?: string;
};

/** Protected live profiles must never run as an incidental part of ordinary CI. */
export function protectedCrossTierTestEnabled(env: ProtectedTestEnvironment): boolean {
  return env.RELAY_CROSS_TIER === "1";
}
