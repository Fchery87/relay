// ---------------------------------------------------------------------------
// Verify the self-hosted Convex backend against the pinned checksum manifest
// and confirm it is live. Run after install/upgrade, and as part of release
// evidence — never assumes "latest" is trustworthy without a checksum match.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type PinManifest = {
  readonly binaryPath: string;
  readonly binarySha256: string;
  readonly releaseArchivePath?: string;
  readonly releaseArchiveSha256?: string;
  readonly pinnedAt: string;
  readonly notes?: string;
};

const manifestPath = process.env.RELAY_CONVEX_PIN_MANIFEST
  ?? join(import.meta.dir, "..", "docs", "operations", "self-hosted-convex-pin.json");

async function sha256(path: string): Promise<string> {
  const data = await readFile(path);
  return createHash("sha256").update(data).digest("hex");
}

async function main() {
  const findings: string[] = [];

  const manifestText = await readFile(manifestPath, "utf8").catch(() => null);
  if (!manifestText) {
    console.error(`No pin manifest at ${manifestPath}. Run this after recording one — see docs/operations/self-hosted-convex.md.`);
    process.exit(1);
  }
  const manifest = JSON.parse(manifestText!) as PinManifest;

  const binaryPath = manifest.binaryPath.replace(/^~/, homedir());
  const actualBinarySha256 = await sha256(binaryPath).catch((error: unknown) => {
    findings.push(`Cannot read pinned binary at ${binaryPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  });
  if (actualBinarySha256 && actualBinarySha256 !== manifest.binarySha256) {
    findings.push(`Binary checksum mismatch: expected ${manifest.binarySha256}, got ${actualBinarySha256}. The installed backend does not match the pinned, vetted version.`);
  }

  if (manifest.releaseArchivePath && manifest.releaseArchiveSha256) {
    const archivePath = manifest.releaseArchivePath.replace(/^~/, homedir());
    const actualArchiveSha256 = await sha256(archivePath).catch(() => null);
    if (actualArchiveSha256 && actualArchiveSha256 !== manifest.releaseArchiveSha256) {
      findings.push(`Release archive checksum mismatch at ${archivePath}.`);
    }
  }

  const backendUrl = process.env.RELAY_SELF_HOSTED_URL ?? "http://127.0.0.1:3210";
  const versionResponse = await fetch(`${backendUrl}/version`).catch(() => null);
  let reportedVersion = "unreachable";
  if (versionResponse?.ok) {
    reportedVersion = (await versionResponse.text()).trim() || "unknown";
  } else {
    findings.push(`Backend at ${backendUrl} did not respond to /version — is it running? See docs/operations/self-hosted-convex.md.`);
  }

  console.log(`Pinned at: ${manifest.pinnedAt}`);
  console.log(`Binary: ${binaryPath}`);
  console.log(`Binary sha256 (pinned): ${manifest.binarySha256}`);
  console.log(`Binary sha256 (actual): ${actualBinarySha256 ?? "unreadable"}`);
  console.log(`Backend /version reports: ${reportedVersion} (upstream may report "unknown" — the checksum is the authoritative pin, not this string)`);

  if (findings.length > 0) {
    console.error("\nVerification FAILED:");
    for (const finding of findings) console.error(`  - ${finding}`);
    process.exit(1);
  }
  console.log("\nVerification passed: installed backend matches the pinned, vetted checksum and is live.");
}

await main();
