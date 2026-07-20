const started = performance.now();
const proc = Bun.spawnSync(["bun", "test", "apps/daemon/src/acceptance.e2e.test.ts", "packages/harness-runtime/src/local-harness-runtime.integration.test.ts"], { stdout: "inherit", stderr: "inherit", env: Bun.env });
const report = { schemaVersion: 1, platform: process.platform, bun: Bun.version, suites: 2, durationMs: Math.round(performance.now() - started), exitCode: proc.exitCode, fixtureHash: "canonical-acceptance-v1" };
console.log(JSON.stringify(report)); if (proc.exitCode !== 0) process.exit(proc.exitCode);
