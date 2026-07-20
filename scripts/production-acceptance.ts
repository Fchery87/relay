const suites = ["apps/daemon/src/acceptance.e2e.test.ts", "apps/daemon/src/kernel-daemon.wiring.test.ts", "packages/harness-runtime/src/local-harness-runtime.integration.test.ts"];
const proc = Bun.spawnSync(["bun", "test", ...suites], { stdout: "inherit", stderr: "inherit", env: Bun.env });
if (proc.exitCode !== 0) process.exit(proc.exitCode);
console.log(`Production acceptance passed: ${suites.length} deterministic browser-to-kernel boundary suites.`);
