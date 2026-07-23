import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const credentialsSchema = z.object({
  credentialStore: z.string().optional(),
  deploymentUrl: z.string().url().optional(),
  deviceNonce: z.string().min(1).optional(),
  deviceToken: z.string().min(1).optional(),
});

const serviceName = "com.relay.daemon.device";

export type DeviceCredentialSecretStore = {
  read(input: { daemonHome: string }): Promise<string | null>;
  write(input: { daemonHome: string; secret: string }): Promise<void>;
};

type SecretCommand = {
  args: string[];
  executable: string;
  stdin?: string;
};

type SecretCommandResult = {
  exitCode: number;
  stderr: string;
  stdout: string;
};

type SecretCommandRunner = (command: SecretCommand) => Promise<SecretCommandResult>;

function credentialsPath(daemonHome: string): string {
  return join(daemonHome, "device.json");
}

function dpapiPath(daemonHome: string): string {
  return join(daemonHome, "device.token.dpapi");
}

function credentialKey(daemonHome: string): string {
  return createHash("sha256").update(daemonHome).digest("hex");
}

async function runSecretCommand({ args, executable, stdin }: SecretCommand): Promise<SecretCommandResult> {
  const child = Bun.spawn([executable, ...args], { stderr: "pipe", stdin: "pipe", stdout: "pipe" });
  if (stdin !== undefined) await child.stdin.write(stdin);
  child.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stderr, stdout };
}

function requireSuccessfulCommand(result: SecretCommandResult, operation: string): string {
  if (result.exitCode !== 0) {
    throw new Error(`Relay secure credential store ${operation} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }
  return result.stdout.trim();
}

function createUnixSecretStore({ platform, run = runSecretCommand }: { platform: string; run?: SecretCommandRunner }): DeviceCredentialSecretStore {
  if (platform === "darwin") {
    return {
      async read({ daemonHome }) {
        const result = await run({ args: ["find-generic-password", "-a", credentialKey(daemonHome), "-s", serviceName, "-w"], executable: "security" });
        if (result.exitCode !== 0 && /could not be found|SecKeychainSearchCopyNext/i.test(result.stderr)) return null;
        return requireSuccessfulCommand(result, "read");
      },
      async write({ daemonHome, secret }) {
        requireSuccessfulCommand(await run({ args: ["add-generic-password", "-a", credentialKey(daemonHome), "-s", serviceName, "-U", "-w"], executable: "security", stdin: secret }), "write");
      },
    };
  }

  return {
    async read({ daemonHome }) {
      const result = await run({ args: ["lookup", "application", serviceName, "account", credentialKey(daemonHome)], executable: "secret-tool" });
      if (result.exitCode !== 0 && /not found|No secret found/i.test(result.stderr)) return null;
      return requireSuccessfulCommand(result, "read");
    },
    async write({ daemonHome, secret }) {
      requireSuccessfulCommand(await run({ args: ["store", "--label=Relay daemon credential", "application", serviceName, "account", credentialKey(daemonHome)], executable: "secret-tool", stdin: secret }), "write");
    },
  };
}

function createWindowsSecretStore({ run = runSecretCommand }: { run?: SecretCommandRunner }): DeviceCredentialSecretStore {
  const powershell = "powershell.exe";
  return {
    async read({ daemonHome }) {
      let ciphertext: string;
      try {
        ciphertext = await readFile(dpapiPath(daemonHome), "utf8");
      } catch (error: unknown) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
      }
      const result = await run({
        args: ["-NoProfile", "-NonInteractive", "-Command", "$secure = ConvertTo-SecureString ([Console]::In.ReadToEnd()); $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }"],
        executable: powershell,
        stdin: ciphertext,
      });
      return requireSuccessfulCommand(result, "read");
    },
    async write({ daemonHome, secret }) {
      const result = await run({
        args: ["-NoProfile", "-NonInteractive", "-Command", "$secure = ConvertTo-SecureString ([Console]::In.ReadToEnd()) -AsPlainText -Force; ConvertFrom-SecureString $secure"],
        executable: powershell,
        stdin: secret,
      });
      const ciphertext = requireSuccessfulCommand(result, "write");
      await writeFile(dpapiPath(daemonHome), `${ciphertext}\n`, { mode: 0o600 });
    },
  };
}

export function createPlatformSecretStore({ platform = process.platform, run }: { platform?: string; run?: SecretCommandRunner } = {}): DeviceCredentialSecretStore {
  if (platform === "win32") return createWindowsSecretStore({ run });
  if (platform === "darwin" || platform === "linux") return createUnixSecretStore({ platform, run });
  throw new Error(`Relay secure credential storage is unsupported on platform ${platform}`);
}

const defaultSecretStore = createPlatformSecretStore();

function metadataFor(input: { credentialStore: string; deploymentUrl?: string; deviceNonce?: string }): string {
  return `${JSON.stringify({
    credentialStore: input.credentialStore,
    ...(input.deploymentUrl ? { deploymentUrl: input.deploymentUrl } : {}),
    ...(input.deviceNonce ? { deviceNonce: input.deviceNonce } : {}),
  })}\n`;
}

async function writeMetadata({ credentialStore, daemonHome, deploymentUrl, deviceNonce }: { credentialStore: string; daemonHome: string; deploymentUrl?: string; deviceNonce?: string }): Promise<void> {
  await mkdir(daemonHome, { mode: 0o700, recursive: true });
  const targetPath = credentialsPath(daemonHome);
  const temporaryPath = `${targetPath}.tmp`;
  await writeFile(temporaryPath, metadataFor({ credentialStore, deploymentUrl, deviceNonce }), { mode: 0o600 });
  await rename(temporaryPath, targetPath);
}

export async function loadDeviceCredentials({ daemonHome, secretStore = defaultSecretStore }: { daemonHome: string; secretStore?: DeviceCredentialSecretStore }): Promise<{ deploymentUrl?: string; deviceNonce?: string; deviceToken: string } | null> {
  let contents: string;
  try {
    contents = await readFile(credentialsPath(daemonHome), "utf8");
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }

  const parsed = credentialsSchema.parse(JSON.parse(contents));
  if (parsed.deviceToken) {
    await secretStore.write({ daemonHome, secret: parsed.deviceToken });
    await writeMetadata({ credentialStore: "os", daemonHome, deploymentUrl: parsed.deploymentUrl, deviceNonce: parsed.deviceNonce });
    return { ...(parsed.deploymentUrl ? { deploymentUrl: parsed.deploymentUrl } : {}), ...(parsed.deviceNonce ? { deviceNonce: parsed.deviceNonce } : {}), deviceToken: parsed.deviceToken };
  }

  const deviceToken = await secretStore.read({ daemonHome });
  if (!deviceToken) throw new Error("Relay secure credential store has no device credential for this daemon");
  return { ...(parsed.deploymentUrl ? { deploymentUrl: parsed.deploymentUrl } : {}), ...(parsed.deviceNonce ? { deviceNonce: parsed.deviceNonce } : {}), deviceToken };
}

export async function saveDeviceCredentials({ daemonHome, deploymentUrl, deviceNonce, deviceToken, secretStore = defaultSecretStore }: { daemonHome: string; deploymentUrl?: string; deviceNonce?: string; deviceToken: string; secretStore?: DeviceCredentialSecretStore }): Promise<void> {
  await mkdir(daemonHome, { mode: 0o700, recursive: true });
  await secretStore.write({ daemonHome, secret: deviceToken });
  await writeMetadata({ credentialStore: "os", daemonHome, deploymentUrl, deviceNonce });
}
