import { homedir } from "node:os";
import { join } from "node:path";

import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

import { saveDeviceCredentials } from "./device-credentials";

const startPairingMutation = makeFunctionReference<"mutation", { code: string; deviceToken: string }, null>("pairing:start");
const waitForPairingQuery = makeFunctionReference<"query", { code: string }, { status: "waiting" | "claimed" | "expired" }>("pairing:waitForClaim");

type PairingState = { status: "waiting" | "claimed" | "expired" };

type PairDeviceInput = {
  daemonHome: string;
  deviceToken: string;
  generateCode: () => string;
  output: (line: string) => void;
  pollIntervalMs: number;
  start: (input: { code: string; deviceToken: string }) => Promise<unknown>;
  waitForClaim: (input: { code: string }) => Promise<PairingState>;
  writeCredentials: (input: { daemonHome: string; deviceToken: string }) => Promise<void>;
};

export async function pairDevice({ daemonHome, deviceToken, generateCode, output, pollIntervalMs, start, waitForClaim, writeCredentials }: PairDeviceInput): Promise<void> {
  const code = generateCode();
  await start({ code, deviceToken });
  output(`Pair this daemon in Relay with code: ${code}`);

  for (;;) {
    const pairing = await waitForClaim({ code });
    if (pairing.status === "claimed") {
      await writeCredentials({ daemonHome, deviceToken });
      return;
    }
    if (pairing.status === "expired") {
      throw new Error("Pairing code expired. Run relay connect again.");
    }
    await Bun.sleep(pollIntervalMs);
  }
}

function randomOpaqueValue(length: number): string {
  const alphabet = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export async function runConnect({
  daemonHome = Bun.env.RELAY_DAEMON_HOME ?? join(homedir(), ".relay"),
  deploymentUrl = Bun.env.RELAY_CONVEX_URL,
}: {
  daemonHome?: string;
  deploymentUrl?: string;
} = {}): Promise<void> {
  if (!deploymentUrl) {
    throw new Error("RELAY_CONVEX_URL must be set");
  }

  const client = new ConvexHttpClient(deploymentUrl);
  await pairDevice({
    daemonHome,
    deviceToken: randomOpaqueValue(48),
    generateCode: () => randomOpaqueValue(10),
    output: (line) => console.info(line),
    pollIntervalMs: 1_000,
    start: (input) => client.mutation(startPairingMutation, input),
    waitForClaim: (input) => client.query(waitForPairingQuery, input),
    writeCredentials: saveDeviceCredentials,
  });
  console.info("Daemon paired.");
}

if (import.meta.main) {
  runConnect().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
