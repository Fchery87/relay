import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { prepareCodexHarnessHome, resolveCodexHarnessHome } from "./codex-harness-home";

test("Codex harness defaults to an isolated home", () => {
  expect(resolveCodexHarnessHome("/tmp/daemon-home")).toEqual({
    path: "/tmp/daemon-home/codex-home",
    isolated: true,
  });
});

test("Codex harness uses an isolated writable home even when local auth is configured", () => {
  expect(resolveCodexHarnessHome("/tmp/daemon-home", "/home/user/.codex")).toEqual({
    path: "/tmp/daemon-home/codex-home",
    isolated: true,
    seededFrom: "/home/user/.codex",
  });
});

test("prepareCodexHarnessHome seeds only auth/config files from the explicit home", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-codex-home-test-"));
  const source = join(root, "source");
  const daemonHome = join(root, "daemon");
  await Bun.write(join(source, "auth.json"), '{"tokens":true}');
  await Bun.write(join(source, "config.toml"), 'model = "gpt-5"\n');
  await Bun.write(join(source, "installation_id"), 'install-id\n');
  await Bun.write(join(source, "models_cache.json"), '{"stale":true}');

  const home = resolveCodexHarnessHome(daemonHome, source);
  await prepareCodexHarnessHome(home);

  expect(await readFile(join(home.path, "auth.json"), "utf8")).toBe('{"tokens":true}');
  expect(await readFile(join(home.path, "config.toml"), "utf8")).toBe('model = "gpt-5"\n');
  expect(await readFile(join(home.path, "installation_id"), "utf8")).toBe('install-id\n');
  expect(await Bun.file(join(home.path, "models_cache.json")).exists()).toBe(false);
});
