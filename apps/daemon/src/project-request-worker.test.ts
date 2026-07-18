import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runQueuedProjectRequest } from "./project-request-worker";
import { listProjects, removeProject } from "./project-store";

test("resolves pending project when path exists on disk", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-pr-"));
  const validDir = await mkdtemp(join(tmpdir(), "relay-valid-project-"));

  const resolutions: Array<{ error?: string; ok: boolean; projectId: string }> = [];
  const handled = await runQueuedProjectRequest({
    daemonHome,
    env: { RELAY_DEVICE_TOKEN: "device" },
    gateway: {
      listPending: async () => [{ id: "proj-1", name: "valid", path: validDir }],
      resolvePending: async (input) => { resolutions.push(input); },
    },
  });

  expect(handled).toBe(true);
  expect(resolutions).toMatchObject([{ projectId: "proj-1", ok: true }]);
  // Project was added to the store
  const projects = await listProjects({ daemonHome, env: {} });
  expect(projects).toContainEqual({ name: "valid", path: validDir });
});

test("resolves pending project with error when path does not exist", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-pr-"));
  const resolutions: Array<{ error?: string; ok: boolean; projectId: string }> = [];
  const handled = await runQueuedProjectRequest({
    daemonHome,
    env: { RELAY_DEVICE_TOKEN: "device" },
    gateway: {
      listPending: async () => [{ id: "proj-2", name: "missing", path: "/nonexistent/path" }],
      resolvePending: async (input) => { resolutions.push(input); },
    },
  });

  expect(handled).toBe(true);
  expect(resolutions).toHaveLength(1);
  expect(resolutions[0]!.ok).toBe(false);
  expect(resolutions[0]!.error).toBeDefined();
});

test("returns false when no pending projects", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-pr-"));
  const handled = await runQueuedProjectRequest({
    daemonHome,
    env: { RELAY_DEVICE_TOKEN: "device" },
    gateway: {
      listPending: async () => [],
      resolvePending: async () => {},
    },
  });
  expect(handled).toBe(false);
});
