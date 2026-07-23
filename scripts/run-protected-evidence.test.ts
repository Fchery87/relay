import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureProtectedRun, writeProtectedRunEvidence } from "./run-protected-evidence";

test("protected evidence captures a passing command with redacted output", async () => {
  const evidence = await captureProtectedRun([
    "bun",
    "-e",
    "console.log('Bearer sk-protected-secret')",
  ]);

  expect(evidence.status).toBe("pass");
  expect(evidence.exitCode).toBe(0);
  expect(evidence.stdout).not.toContain("sk-protected-secret");
  expect(evidence.stdout).toContain("[REDACTED]");
});

test("protected evidence records the runner platform and runtime", async () => {
  const evidence = await captureProtectedRun(["bun", "-e", "console.log('ok')"]);

  expect(evidence.platform).toBe(process.platform);
  expect(evidence.arch).toBe(process.arch);
  expect(evidence.runtime).toBe(Bun.version);
});

test("protected evidence preserves a failing exit code and bounded stderr", async () => {
  const evidence = await captureProtectedRun([
    "bun",
    "-e",
    "console.error('failed with sk-protected-secret'); process.exit(23)",
  ]);

  expect(evidence.status).toBe("fail");
  expect(evidence.exitCode).toBe(23);
  expect(evidence.stderr).not.toContain("sk-protected-secret");
  expect(evidence.stderr.length).toBeLessThanOrEqual(20_000);
});

test("protected evidence writer creates a mode-restricted artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-protected-evidence-test-"));
  const output = join(root, "nested", "protected.json");
  try {
    const evidence = await captureProtectedRun(["bun", "-e", "console.log('ok')"]);
    await writeProtectedRunEvidence(output, evidence);
    const written = JSON.parse(await readFile(output, "utf8")) as { schemaVersion?: number; status?: string };
    expect(written).toMatchObject({ schemaVersion: 1, status: "pass" });
    expect((await stat(output)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("protected evidence CLI writes an artifact and preserves failure status", async () => {
  const root = await mkdtemp(join(tmpdir(), "relay-protected-evidence-cli-test-"));
  const output = join(root, "protected.json");
  try {
    const process = Bun.spawn([
      "bun",
      "run",
      join(import.meta.dir, "run-protected-evidence.ts"),
      "--output",
      output,
      "--",
      "bun",
      "-e",
      "process.exit(19)",
    ], { stderr: "pipe", stdout: "pipe" });
    expect(await process.exited).toBe(19);
    const written = JSON.parse(await readFile(output, "utf8")) as { status?: string; exitCode?: number };
    expect(written).toMatchObject({ status: "fail", exitCode: 19 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
