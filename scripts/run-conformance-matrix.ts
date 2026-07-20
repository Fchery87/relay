const commands = ["bun run typecheck", "bun run test", "bun run build", "bun run bundle:check", "bun run codex:schema:check", "bun run security:gate"];
for (const command of commands) {
  const proc = Bun.spawnSync(["bash", "-lc", command], { stdout: "inherit", stderr: "inherit", env: Bun.env });
  if (proc.exitCode !== 0) { console.error(`Conformance failed: ${command}`); process.exit(proc.exitCode); }
}
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, runtime: Bun.version, status: "pass", commands }, null, 2));
