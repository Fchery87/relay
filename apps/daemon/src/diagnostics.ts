import { join } from "node:path";
import { homedir } from "node:os";
import { resolveDaemonHome } from "./daemon-home";
import { openStore, writeDiagnosticExport } from "@relay/local-store";

export async function exportDaemonDiagnostics(path?: string): Promise<void> {
  const daemonHome = resolveDaemonHome({ env: Bun.env, homeDirectory: homedir(), platform: process.platform });
  const output = path ?? join(daemonHome, "diagnostics", `relay-diagnostics-${Date.now()}.json`);
  const db = openStore(join(daemonHome, "relay-kernel.sqlite"));
  try {
    await writeDiagnosticExport(db, output);
  } finally {
    db.close();
  }
  console.info(`Wrote anonymized Relay diagnostics: ${output}`);
}
