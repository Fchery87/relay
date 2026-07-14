export function isDeviceTokenRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Unknown device token") || message.includes("Device token has been revoked");
}
