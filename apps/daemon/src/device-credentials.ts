import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const credentialsSchema = z.object({
  deploymentUrl: z.string().url().optional(),
  deviceToken: z.string().min(1),
});

function credentialsPath(daemonHome: string): string {
  return join(daemonHome, "device.json");
}

export async function loadDeviceCredentials({ daemonHome }: { daemonHome: string }): Promise<{ deploymentUrl?: string; deviceToken: string } | null> {
  try {
    const contents = await readFile(credentialsPath(daemonHome), "utf8");
    return credentialsSchema.parse(JSON.parse(contents));
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function saveDeviceCredentials({ daemonHome, deploymentUrl, deviceToken }: { daemonHome: string; deploymentUrl?: string; deviceToken: string }): Promise<void> {
  await mkdir(daemonHome, { mode: 0o700, recursive: true });
  const targetPath = credentialsPath(daemonHome);
  const temporaryPath = `${targetPath}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify({ deploymentUrl, deviceToken })}\n`, { mode: 0o600 });
  await rename(temporaryPath, targetPath);
}
