import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPlatformSecretStore, loadDeviceCredentials, saveDeviceCredentials, type DeviceCredentialSecretStore } from "./device-credentials";

async function withDaemonHome(run: (daemonHome: string) => Promise<void>) {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-daemon-"));
  try {
    await run(daemonHome);
  } finally {
    await rm(daemonHome, { force: true, recursive: true });
  }
}

function inMemorySecretStore(): { secrets: Map<string, string>; store: DeviceCredentialSecretStore } {
  const secrets = new Map<string, string>();
  return {
    secrets,
    store: {
      read: async ({ daemonHome }) => secrets.get(daemonHome) ?? null,
      write: async ({ daemonHome, secret }) => { secrets.set(daemonHome, secret); },
    },
  };
}

test("stores paired device credentials outside the metadata file", async () => {
  await withDaemonHome(async (daemonHome) => {
    const { secrets, store } = inMemorySecretStore();
    await saveDeviceCredentials({ daemonHome, deploymentUrl: "https://relay.convex.cloud", deviceToken: "paired-device-token", secretStore: store });

    expect(await loadDeviceCredentials({ daemonHome, secretStore: store })).toEqual({
      deploymentUrl: "https://relay.convex.cloud",
      deviceToken: "paired-device-token",
    });
    expect(secrets.get(daemonHome)).toBe("paired-device-token");
    expect(await readFile(join(daemonHome, "device.json"), "utf8")).not.toContain("paired-device-token");
    const credentialsStat = await stat(join(daemonHome, "device.json"));
    expect(credentialsStat.mode & 0o077).toBe(0);
  });
});

test("migrates a legacy plaintext credential into the secure store on load", async () => {
  await withDaemonHome(async (daemonHome) => {
    const { secrets, store } = inMemorySecretStore();
    await writeFile(join(daemonHome, "device.json"), JSON.stringify({ deploymentUrl: "https://relay.convex.cloud", deviceToken: "legacy-token" }));

    expect(await loadDeviceCredentials({ daemonHome, secretStore: store })).toMatchObject({ deviceToken: "legacy-token" });
    expect(secrets.get(daemonHome)).toBe("legacy-token");
    expect(await readFile(join(daemonHome, "device.json"), "utf8")).not.toContain("legacy-token");
  });
});

test("fails closed when metadata exists but the secure store has no credential", async () => {
  await withDaemonHome(async (daemonHome) => {
    const { store } = inMemorySecretStore();
    await writeFile(join(daemonHome, "device.json"), JSON.stringify({ credentialStore: "os", deploymentUrl: "https://relay.convex.cloud" }));

    await expect(loadDeviceCredentials({ daemonHome, secretStore: store })).rejects.toThrow("secure credential store");
  });
});

test("platform secure-store commands keep the device token out of argv", async () => {
  const calls: Array<{ args: string[]; executable: string; stdin?: string }> = [];
  const store = createPlatformSecretStore({
    platform: "linux",
    run: async (command) => {
      calls.push(command);
      return command.args[0] === "lookup" ? { exitCode: 0, stderr: "", stdout: "secret-from-keyring\n" } : { exitCode: 0, stderr: "", stdout: "" };
    },
  });

  await store.write({ daemonHome: "/tmp/relay-keyring-home", secret: "secret-from-keyring" });
  expect(await store.read({ daemonHome: "/tmp/relay-keyring-home" })).toBe("secret-from-keyring");
  expect(calls).toHaveLength(2);
  for (const call of calls) expect(call.args).not.toContain("secret-from-keyring");
  expect(calls[0]?.stdin).toBe("secret-from-keyring");
});

test("Windows secure storage persists only DPAPI ciphertext", async () => {
  await withDaemonHome(async (daemonHome) => {
    const calls: Array<{ args: string[]; executable: string; stdin?: string }> = [];
    const store = createPlatformSecretStore({
      platform: "win32",
      run: async (command) => {
        calls.push(command);
        return calls.length === 1 ? { exitCode: 0, stderr: "", stdout: "dpapi-ciphertext\n" } : { exitCode: 0, stderr: "", stdout: "windows-secret\n" };
      },
    });

    await store.write({ daemonHome, secret: "windows-secret" });
    expect(await readFile(join(daemonHome, "device.token.dpapi"), "utf8")).toBe("dpapi-ciphertext\n");
    expect(await store.read({ daemonHome })).toBe("windows-secret");
    expect(calls[0]?.args).not.toContain("windows-secret");
    expect(calls[0]?.stdin).toBe("windows-secret");
    expect(calls[1]?.stdin).toBe("dpapi-ciphertext\n");
  });
});

test("returns null before a daemon has been paired", async () => {
  await withDaemonHome(async (daemonHome) => {
    expect(await loadDeviceCredentials({ daemonHome })).toBeNull();
  });
});
