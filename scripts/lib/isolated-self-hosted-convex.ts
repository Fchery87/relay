// ---------------------------------------------------------------------------
// Isolated self-hosted Convex backend lifecycle — spins up a throwaway
// convex-local-backend instance (fresh temp data dir, fresh instance
// credentials, dedicated ports) for live cross-tier tests, and tears it
// down cleanly. Never touches the developer's real backend at
// ~/.local/share/convex-selfhost or its data.
//
// Requires the convex-local-backend binary to already be installed
// (see docs/operations/self-hosted-convex.md). If it isn't found, the
// caller gets `null` back rather than a throw, so tests can skip cleanly
// instead of failing where the binary isn't available (e.g. ordinary CI).
// ---------------------------------------------------------------------------

import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

export type IsolatedConvexBackend = {
  readonly url: string;
  readonly siteUrl: string;
  readonly adminKey: string;
  readonly instanceSecret: string;
  readonly instanceName: string;
  readonly dataDir: string;
  readonly port: number;
  readonly sitePort: number;
  stop(): Promise<void>;
  /**
   * Kill the backend process and start a fresh one on the same port against
   * the same SQLite file/storage dir — simulates a backend restart with
   * data preserved, for kill-point tests. Resolves once the new process is
   * healthy again.
   */
  restart(): Promise<void>;
};

export async function findSelfHostedBackendBinary(): Promise<string | null> {
  const candidates = [
    process.env.RELAY_CONVEX_BACKEND_BIN,
    join(homedir(), ".local/share/convex-selfhost/convex-local-backend"),
  ].filter((path): path is string => Boolean(path));
  for (const path of candidates) {
    if (await Bun.file(path).exists()) return path;
  }
  return null;
}

// Binds to port 0 to get an OS-assigned free port, then releases it before
// the real backend process binds the same port. Inherently a TOCTOU race —
// another process could grab the port in between — but the window is a
// handful of milliseconds and this is test-only infrastructure spinning up
// a throwaway backend, not a production allocator; a genuine collision
// fails fast as a backend-startup error rather than corrupting anything.
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close();
        reject(new Error("Could not determine a free port"));
      }
    });
  });
}

async function runToCompletion(command: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

async function waitForHealthy(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/version`);
      if (res.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Backend at ${url} did not become healthy within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * Start an isolated, throwaway self-hosted Convex backend. Returns `null`
 * (rather than throwing) if the backend binary isn't installed, so callers
 * can skip live tests cleanly.
 */
export async function startIsolatedSelfHostedConvex(): Promise<IsolatedConvexBackend | null> {
  const binaryPath = await findSelfHostedBackendBinary();
  if (!binaryPath) return null;

  const dataDir = await mkdtemp(join(tmpdir(), "relay-isolated-convex-"));
  const instanceSecret = randomBytes(32).toString("hex");
  const instanceName = `relay-test-${randomUUID().slice(0, 8)}`;

  const keygen = await runToCompletion([binaryPath, "keygen", "admin-key", "--instance-name", instanceName, "--instance-secret", instanceSecret]);
  if (keygen.exitCode !== 0) {
    await rm(dataDir, { recursive: true, force: true });
    throw new Error(`convex-local-backend keygen failed: ${keygen.stderr}`);
  }
  const adminKey = keygen.stdout.trim();

  const port = await findFreePort();
  const sitePort = await findFreePort();
  const dbPath = join(dataDir, "backend.sqlite3");
  const storagePath = join(dataDir, "storage");
  const url = `http://127.0.0.1:${port}`;
  const siteUrl = `http://127.0.0.1:${sitePort}`;

  const spawnAndWait = async (): Promise<ReturnType<typeof Bun.spawn>> => {
    const spawned = Bun.spawn(
      [
        binaryPath,
        dbPath,
        "--instance-name", instanceName,
        "--instance-secret", instanceSecret,
        "--interface", "127.0.0.1",
        "--port", String(port),
        "--site-proxy-port", String(sitePort),
        "--local-storage", storagePath,
        "--disable-beacon",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    try {
      await waitForHealthy(url, 15_000);
    } catch (error) {
      spawned.kill();
      throw error;
    }
    return spawned;
  };

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = await spawnAndWait();
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    proc.kill();
    await proc.exited;
    await rm(dataDir, { recursive: true, force: true });
  };

  const restart = async () => {
    proc.kill();
    await proc.exited;
    proc = await spawnAndWait();
  };

  return { url, siteUrl, adminKey, instanceSecret, instanceName, dataDir, port, sitePort, stop, restart };
}

/**
 * Deploy this repo's convex/ schema and functions to an isolated backend.
 * Spawns the real Convex CLI against the isolated instance — takes a few
 * seconds (codegen + typecheck). `repoRoot` must contain `convex/`.
 */
export async function deploySchema(backend: IsolatedConvexBackend, repoRoot: string): Promise<void> {
  const proc = Bun.spawn(["bunx", "convex", "deploy", "--yes"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      CONVEX_SELF_HOSTED_URL: backend.url,
      CONVEX_SELF_HOSTED_ADMIN_KEY: backend.adminKey,
      // Never let a cloud deployment variable leak in and get mixed with
      // self-hosted vars — the CLI refuses to run if both are set.
      CONVEX_DEPLOYMENT: undefined,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`convex deploy failed against isolated backend ${backend.url}:\n${stdout}\n${stderr}`);
  }
}

function pemFromPkcs8(bytes: ArrayBuffer): string {
  const base64 = Buffer.from(bytes).toString("base64");
  const chunks = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PRIVATE KEY-----\n${chunks.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Generate a fresh RS256 keypair for Convex Auth's JWT signing (per
 * docs/operations/self-hosted-convex.md step 6) and push it, plus SITE_URL,
 * to the isolated instance's env. Required before any signIn action call
 * succeeds — Convex Auth signs session tokens with this key.
 */
export async function setupAuthKeys(backend: IsolatedConvexBackend, repoRoot: string, siteUrl = "http://localhost:5173"): Promise<void> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const privateKeyPem = pemFromPkcs8(pkcs8);
  const publicJwk = await crypto.subtle.exportKey("jwk", keyPair.publicKey);
  const jwks = JSON.stringify({ keys: [{ ...publicJwk, use: "sig", alg: "RS256" }] });

  const env = {
    ...process.env,
    CONVEX_SELF_HOSTED_URL: backend.url,
    CONVEX_SELF_HOSTED_ADMIN_KEY: backend.adminKey,
    CONVEX_DEPLOYMENT: undefined,
  };

  for (const [name, value] of [["JWT_PRIVATE_KEY", privateKeyPem], ["JWKS", jwks], ["SITE_URL", siteUrl]] as const) {
    const proc = Bun.spawn(["bunx", "convex", "env", "set", name, "--", value], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) throw new Error(`convex env set ${name} failed against isolated backend ${backend.url}:\n${stdout}\n${stderr}`);
  }
}
