// ---------------------------------------------------------------------------
// Isolated Convex test fixture — signs up a real test user, pairs a real
// device, registers a machine/project, and creates a thread against an
// IsolatedConvexBackend (see isolated-self-hosted-convex.ts). Drives the
// real HTTP API the same way the browser/daemon do — no convex-test
// simulator involved — for live cross-tier recovery tests.
// ---------------------------------------------------------------------------

import { randomBytes } from "node:crypto";
import type { IsolatedConvexBackend } from "./isolated-self-hosted-convex";

type ConvexCallKind = "action" | "mutation" | "query";

async function call(backend: IsolatedConvexBackend, kind: ConvexCallKind, path: string, args: unknown, token?: string): Promise<unknown> {
  const res = await fetch(`${backend.url}/api/${kind}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ path, args: [args], format: "json" }),
  });
  const body = (await res.json()) as { status: "success" | "error"; value?: unknown; errorMessage?: string };
  if (body.status === "error") throw new Error(`${path} failed: ${body.errorMessage}`);
  return body.value;
}

export type IsolatedFixture = {
  readonly backend: IsolatedConvexBackend;
  readonly userToken: string;
  readonly deviceToken: string;
  readonly deviceNonce: string;
  readonly machineId: string;
  readonly projectId: string;
  readonly threadId: string;
  call(kind: ConvexCallKind, path: string, args: unknown, asUser?: boolean): Promise<unknown>;
  /** Perform a real call, then discard its successful response for fault injection. */
  callAndDropResponse(kind: ConvexCallKind, path: string, args: unknown, asUser?: boolean): Promise<never>;
};

/**
 * Sign up a fresh test user, pair a fresh device, register a machine with
 * one project, and create a thread — the minimum real state every
 * cross-tier scenario needs. Each call produces entirely fresh identities;
 * safe to call once per test against a freshly-started isolated backend.
 */
export async function buildIsolatedFixture(backend: IsolatedConvexBackend, options?: { email?: string; password?: string; projectPath?: string }): Promise<IsolatedFixture> {
  const email = options?.email ?? `e2e-${randomBytes(6).toString("hex")}@example.com`;
  const password = options?.password ?? `correct horse battery staple ${randomBytes(8).toString("hex")}`;

  const signup = (await call(backend, "action", "auth:signIn", {
    provider: "password",
    params: { email, password, flow: "signUp" },
  })) as { tokens: { token: string } };
  const userToken = signup.tokens.token;

  const deviceToken = randomBytes(32).toString("hex");
  const deviceNonce = randomBytes(16).toString("hex");
  const code = randomBytes(8).toString("hex");

  await call(backend, "mutation", "pairing:start", { code, deviceNonce, deviceToken });
  await call(backend, "mutation", "pairing:claim", { code }, userToken);

  const projectPath = options?.projectPath ?? `/tmp/relay-e2e-${randomBytes(4).toString("hex")}`;
  const machineId = (await call(backend, "mutation", "machines:registerMachine", {
    deviceToken,
    deviceNonce,
    name: "e2e-test-machine",
    platform: "linux",
    daemonVersion: "0.0.0-e2e",
    projects: [{ name: "e2e-project", path: projectPath }],
  })) as string;

  const machines = (await call(backend, "query", "machines:listMachinesAndProjects", {}, userToken)) as Array<{
    id: string;
    projects: Array<{ id: string; path: string }>;
  }>;
  const machine = machines.find((m) => m.id === machineId);
  const project = machine?.projects.find((p) => p.path === projectPath) ?? machine?.projects[0];
  if (!project) throw new Error("No project found after machine registration");
  const projectId = project.id;

  const threadId = (await call(backend, "mutation", "conversations:createThread", {
    projectId,
    title: "e2e cross-tier recovery",
  }, userToken)) as string;

  return {
    backend,
    userToken,
    deviceToken,
    deviceNonce,
    machineId,
    projectId,
    threadId,
    call: (kind, path, args, asUser = false) => call(backend, kind, path, args, asUser ? userToken : undefined),
    callAndDropResponse: async (kind, path, args, asUser = false) => {
      await call(backend, kind, path, args, asUser ? userToken : undefined);
      throw new Error("simulated lost response");
    },
  };
}
