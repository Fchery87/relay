const profile = process.argv.find((arg) => arg.startsWith("--profile="))?.split("=")[1] ?? "pr";
const suites = [
  "packages/orchestration/src/orchestration-engine.integration.test.ts",
  "packages/harness-runtime/src/local-harness-runtime.integration.test.ts",
  "packages/local-store/src/event-store.integration.test.ts",
];
const proc = Bun.spawnSync(["bun", "test", ...suites], { stdout: "inherit", stderr: "inherit", env: { ...Bun.env, RELAY_CRASH_PROFILE: profile } });
if (proc.exitCode !== 0) process.exit(proc.exitCode);
console.log(`Crash/recovery matrix passed (${profile}): ${suites.length} deterministic suites.`);
