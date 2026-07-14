import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

test("refuses a system installation directory before downloading a release", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-install-test-"));
  temporaryDirectories.push(root);
  const binDirectory = join(root, "bin");
  await Bun.$`mkdir -p ${binDirectory}`;
  const curlPath = join(binDirectory, "curl");
  await writeFile(curlPath, "#!/usr/bin/env bash\nprintf 'curl should not run\\n' >&2\nexit 99\n");
  await chmod(curlPath, 0o755);

  const result = Bun.spawn(["sh", "scripts/install.sh"], {
    cwd: import.meta.dir + "/..",
    env: {
      ...Bun.env,
      HOME: join(root, "home"),
      PATH: `${binDirectory}:${Bun.env.PATH ?? ""}`,
      RELAY_INSTALL_DIR: "/usr/local/bin",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([result.exited, new Response(result.stderr).text()]);

  expect(exitCode).toBe(1);
  expect(stderr).toContain("Refusing to install into a system directory");
  expect(stderr).not.toContain("curl should not run");
});
