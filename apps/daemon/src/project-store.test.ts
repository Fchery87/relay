import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addProject, listProjects, removeProject } from "./project-store";

test("seeds from env on first load and persists to projects.json", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-projects-"));
  const env = { RELAY_PROJECTS: JSON.stringify([{ name: "relay", path: "/repos/relay" }]) };
  expect(await listProjects({ daemonHome, env })).toEqual([{ name: "relay", path: "/repos/relay" }]);
  expect(await listProjects({ daemonHome, env: {} })).toEqual([{ name: "relay", path: "/repos/relay" }]); // persisted
});

test("add and remove round-trip and reject duplicates", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-projects-"));
  await addProject({ daemonHome, env: {}, name: "web", path: "/repos/web" });
  await expect(addProject({ daemonHome, env: {}, name: "dup", path: "/repos/web" })).rejects.toThrow("already registered");
  await removeProject({ daemonHome, env: {}, path: "/repos/web" });
  expect(await listProjects({ daemonHome, env: {} })).toEqual([]);
});

test("empty seed when no env and no prior file", async () => {
  const daemonHome = await mkdtemp(join(tmpdir(), "relay-projects-"));
  expect(await listProjects({ daemonHome, env: {} })).toEqual([]);
});
