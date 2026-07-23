// ---------------------------------------------------------------------------
// Functional acceptance for a restored self-hosted Convex + daemon backup.
// The restore is started on loopback with random non-default ports unless
// explicitly overridden and is deleted on exit unless --keep-staging is
// supplied. Password credentials for the restored account are accepted only
// through environment variables so they never appear in process arguments.
//
// Usage:
//   RELAY_RESTORE_ACCEPTANCE_EMAIL=user@example.com \
//   RELAY_RESTORE_ACCEPTANCE_PASSWORD='...' \
//   bun run scripts/restore-acceptance.ts --backup ./backup
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import { access, mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { redactSecrets } from "../apps/daemon/src/observability/logger";

export type RestoreAcceptanceOptions = {
  readonly backupDir: string;
  readonly stagingDir?: string;
  readonly backendBinary?: string;
  readonly repoRoot?: string;
  readonly port?: number;
  readonly sitePort?: number;
  readonly keepStaging: boolean;
};

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePort(value: string, flag: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`${flag} must be an integer between 1 and 65535`);
  return port;
}

export function parseRestoreAcceptanceArgs(argv: readonly string[]): RestoreAcceptanceOptions {
  let backupDir: string | undefined;
  let stagingDir: string | undefined;
  let backendBinary: string | undefined;
  let repoRoot: string | undefined;
  let port: number | undefined;
  let sitePort: number | undefined;
  let keepStaging = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--backup":
        backupDir = takeValue(argv, index, argument);
        index += 1;
        break;
      case "--staging":
        stagingDir = takeValue(argv, index, argument);
        index += 1;
        break;
      case "--backend-bin":
        backendBinary = takeValue(argv, index, argument);
        index += 1;
        break;
      case "--repo-root":
        repoRoot = takeValue(argv, index, argument);
        index += 1;
        break;
      case "--port":
        port = parsePort(takeValue(argv, index, argument), argument);
        index += 1;
        break;
      case "--site-port":
        sitePort = parsePort(takeValue(argv, index, argument), argument);
        index += 1;
        break;
      case "--keep-staging":
        keepStaging = true;
        break;
      default:
        throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (!backupDir) throw new Error("--backup is required");
  if (port !== undefined && sitePort !== undefined && port === sitePort) {
    throw new Error("--port and --site-port must be different");
  }
  return {
    backupDir,
    ...(stagingDir === undefined ? {} : { stagingDir }),
    ...(backendBinary === undefined ? {} : { backendBinary }),
    ...(repoRoot === undefined ? {} : { repoRoot }),
    ...(port === undefined ? {} : { port }),
    ...(sitePort === undefined ? {} : { sitePort }),
    keepStaging,
  };
}

async function run(command: readonly string[], options: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<void> {
  const process = Bun.spawn([...command], {
    cwd: options.cwd,
    env: options.env === undefined ? Bun.env : options.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) {
    const detail = redactSecrets(`${stdout}\n${stderr}`).trim().slice(-2_000);
    throw new Error(`${command.join(" ")} failed${detail ? `: ${detail}` : ""}`);
  }
}

async function freePort(): Promise<number> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      return new Response("ok");
    },
  });
  const port = server.port;
  server.stop(true);
  return port;
}

async function waitForHealthy(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastError = "unknown error";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/version`);
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await Bun.sleep(100);
  }
  throw new Error(`Restored backend did not become healthy: ${lastError}`);
}

type ConvexResponse = { readonly status: "success" | "error"; readonly value?: unknown; readonly errorMessage?: string };

async function callConvex(url: string, kind: "action" | "mutation" | "query", path: string, args: unknown, token?: string): Promise<unknown> {
  const response = await fetch(`${url}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify({ path, args: [args], format: "json" }),
  });
  const body = await response.json() as ConvexResponse;
  if (body.status === "error") throw new Error(`${path} failed: ${body.errorMessage ?? "unknown Convex error"}`);
  return body.value;
}

async function ensureEmptyOrMissing(path: string): Promise<void> {
  const entries = await readdir(path).catch(() => [] as string[]);
  if (entries.length > 0) throw new Error(`Refusing to reuse non-empty staging directory: ${path}`);
}

async function main(options: RestoreAcceptanceOptions): Promise<void> {
  const backupDir = resolve(options.backupDir);
  const repoRoot = resolve(options.repoRoot ?? join(import.meta.dir, ".."));
  const stagingDir = resolve(options.stagingDir ?? await mkdtemp(join(tmpdir(), "relay-restore-acceptance-")));
  const ownsStaging = options.stagingDir === undefined;
  const backendBinary = resolve(options.backendBinary ?? Bun.env.RELAY_CONVEX_BACKEND_BIN ?? join(homedir(), ".local/share/convex-selfhost/convex-local-backend"));
  let backendProcess: ReturnType<typeof Bun.spawn> | undefined;
  let backendUrl = "";

  try {
    if (!isAbsolute(stagingDir)) throw new Error("staging directory must resolve to an absolute path");
    await ensureEmptyOrMissing(stagingDir);
    await mkdir(stagingDir, { recursive: true });
    await access(backendBinary);

    await run(["bash", join(repoRoot, "scripts/restore-self-hosted-convex.sh"), "--backup", backupDir, "--staging", stagingDir], { cwd: repoRoot });

    const manifest = JSON.parse(await readFile(join(stagingDir, "manifest.json"), "utf8")) as { instanceName?: string };
    const instanceName = manifest.instanceName ?? "convex-self-hosted";
    const instanceSecret = (await readFile(join(stagingDir, "convex", "instance-secret.txt"), "utf8")).trim();
    const adminKey = (await readFile(join(stagingDir, "convex", "admin-key.txt"), "utf8")).trim();
    if (!instanceSecret || !adminKey) throw new Error("Backup must include instance-secret.txt and admin-key.txt");

    const port = options.port ?? await freePort();
    const sitePort = options.sitePort ?? await freePort();
    backendUrl = `http://127.0.0.1:${port}`;
    backendProcess = Bun.spawn([
      backendBinary,
      join(stagingDir, "convex", "convex_local_backend.sqlite3"),
      "--instance-name", instanceName,
      "--instance-secret", instanceSecret,
      "--interface", "127.0.0.1",
      "--port", String(port),
      "--site-proxy-port", String(sitePort),
      "--local-storage", join(stagingDir, "convex", "convex_local_storage"),
      "--disable-beacon",
    ], { stdout: "ignore", stderr: "ignore" });
    await waitForHealthy(backendUrl);

    const env = { ...Bun.env, CONVEX_SELF_HOSTED_URL: backendUrl, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey, CONVEX_DEPLOYMENT: undefined };
    await run(["bunx", "convex", "deploy", "--yes"], { cwd: repoRoot, env });

    const email = Bun.env.RELAY_RESTORE_ACCEPTANCE_EMAIL;
    const password = Bun.env.RELAY_RESTORE_ACCEPTANCE_PASSWORD;
    if (!email || !password) throw new Error("Set RELAY_RESTORE_ACCEPTANCE_EMAIL and RELAY_RESTORE_ACCEPTANCE_PASSWORD; credentials are never accepted as CLI arguments");
    const auth = await callConvex(backendUrl, "action", "auth:signIn", { provider: "password", params: { email, password, flow: "signIn" } }) as { tokens?: { token?: string } };
    const userToken = auth.tokens?.token;
    if (!userToken) throw new Error("Restored password sign-in returned no user token");

    const restoredMachines = await callConvex(backendUrl, "query", "machines:listMachinesAndProjects", {}, userToken);
    const deviceToken = randomBytes(32).toString("hex");
    const deviceNonce = randomBytes(16).toString("hex");
    const pairingCode = randomBytes(8).toString("hex");
    await callConvex(backendUrl, "mutation", "pairing:start", { code: pairingCode, deviceNonce, deviceToken });
    await callConvex(backendUrl, "mutation", "pairing:claim", { code: pairingCode }, userToken);
    const machineId = await callConvex(backendUrl, "mutation", "machines:registerMachine", {
      deviceToken,
      deviceNonce,
      name: "restore-acceptance-machine",
      platform: "linux",
      daemonVersion: "restore-acceptance",
      projects: [{ name: "restore-acceptance-project", path: join(stagingDir, "project") }],
    }) as string;
    await callConvex(backendUrl, "mutation", "machines:heartbeat", { deviceToken });
    const machines = await callConvex(backendUrl, "query", "machines:listMachinesAndProjects", {}, userToken) as Array<{ id: string; projects?: Array<{ id: string; path: string }> }>;
    const machine = machines.find((candidate) => candidate.id === machineId);
    const projectId = machine?.projects?.[0]?.id;
    if (!projectId) throw new Error("Restored machine registration did not return a project");
    const threadId = await callConvex(backendUrl, "mutation", "conversations:createThread", { projectId, title: "restore acceptance" }, userToken) as string;
    const threads = await callConvex(backendUrl, "query", "conversations:listProjectThreads", { projectId }, userToken) as Array<{ _id?: string }>;
    if (!threads.some((thread) => thread._id === threadId)) throw new Error("Restored thread was not readable after creation");
    await callConvex(backendUrl, "query", "projections/publish:projectionMetrics", {}, userToken);

    console.log(JSON.stringify({
      backendUrl,
      checks: ["manifest-restore", "backend-health", "schema-deploy", "restored-password-sign-in", "restored-owner-read", "fresh-pairing", "machine-heartbeat", "project-read", "thread-create-read", "projection-metrics-read"],
      restoredMachineCount: Array.isArray(restoredMachines) ? restoredMachines.length : 0,
      stagingDir: options.keepStaging ? stagingDir : undefined,
      status: "pass",
    }, null, 2));
  } finally {
    if (backendProcess) {
      backendProcess.kill();
      await backendProcess.exited.catch(() => undefined);
    }
    if (!options.keepStaging && (ownsStaging || options.stagingDir !== undefined)) {
      await rm(stagingDir, { recursive: true, force: true });
    }
  }
}

if (import.meta.main) {
  if (Bun.argv.includes("--help")) {
    console.log("Usage: RELAY_RESTORE_ACCEPTANCE_EMAIL=... RELAY_RESTORE_ACCEPTANCE_PASSWORD=... bun run scripts/restore-acceptance.ts --backup DIR [--staging DIR] [--backend-bin PATH] [--keep-staging]");
  } else {
    await main(parseRestoreAcceptanceArgs(Bun.argv.slice(2)));
  }
}
