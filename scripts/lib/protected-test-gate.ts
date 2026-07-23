export type ProtectedTestEnvironment = {
  readonly RELAY_CROSS_TIER?: string;
};

/** Protected live profiles must never run as an incidental part of ordinary CI. */
export function protectedCrossTierTestEnabled(env: ProtectedTestEnvironment): boolean {
  return env.RELAY_CROSS_TIER === "1";
}

export function protectedCrossTierPrerequisitesMet(input: {
  readonly enabled: boolean;
  readonly backendAvailable: boolean;
  readonly loopbackAvailable: boolean;
}): boolean {
  if (!input.enabled) return false;
  if (!input.backendAvailable || !input.loopbackAvailable) {
    throw new Error(
      "RELAY_CROSS_TIER=1 requires the self-hosted backend binary and loopback binding",
    );
  }
  return true;
}
