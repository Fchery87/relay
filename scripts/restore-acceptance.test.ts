import { expect, test } from "bun:test";

import { parseRestoreAcceptanceArgs } from "./restore-acceptance";

test("restore acceptance args require a backup and parse isolated staging options", () => {
  expect(() => parseRestoreAcceptanceArgs([])).toThrow("--backup");
  expect(parseRestoreAcceptanceArgs([
    "--backup", "/tmp/backup",
    "--staging", "/tmp/staging",
    "--backend-bin", "/tmp/convex-local-backend",
    "--port", "3320",
    "--site-port", "3321",
    "--keep-staging",
  ])).toEqual({
    backupDir: "/tmp/backup",
    stagingDir: "/tmp/staging",
    backendBinary: "/tmp/convex-local-backend",
    port: 3320,
    sitePort: 3321,
    keepStaging: true,
  });
});

test("restore acceptance args reject malformed ports and unknown flags", () => {
  expect(() => parseRestoreAcceptanceArgs(["--backup", "/tmp/backup", "--port", "0"])).toThrow("port");
  expect(() => parseRestoreAcceptanceArgs(["--backup", "/tmp/backup", "--port", "3320", "--site-port", "3320"])).toThrow("different");
  expect(() => parseRestoreAcceptanceArgs(["--backup", "/tmp/backup", "--unknown"])).toThrow("Unknown argument");
});
