import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadDeviceCredentials, saveDeviceCredentials } from "./device-credentials";

async function withDaemonHome(run: (daemonHome: string) => Promise<void>) {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-daemon-"));
  try {
    await run(daemonHome);
  } finally {
    await rm(daemonHome, { force: true, recursive: true });
  }
}

test("stores paired device credentials in an owner-only file", async () => {
  await withDaemonHome(async (daemonHome) => {
    await saveDeviceCredentials({ daemonHome, deviceToken: "paired-device-token" });

    expect(await loadDeviceCredentials({ daemonHome })).toEqual({
      deviceToken: "paired-device-token",
    });
    const credentialsStat = await stat(join(daemonHome, "device.json"));
    expect(credentialsStat.mode & 0o077).toBe(0);
  });
});

test("returns null before a daemon has been paired", async () => {
  await withDaemonHome(async (daemonHome) => {
    expect(await loadDeviceCredentials({ daemonHome })).toBeNull();
  });
});
