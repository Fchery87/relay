const commands = [
  ["bun", "run", "typecheck"],
  ["bun", "run", "test"],
  ["bun", "run", "test:e2e:harness"],
  ["bun", "run", "build"],
  ["bun", "run", "bundle:check"],
  ["bun", "run", "codex:schema:check"],
  ["bun", "run", "security:gate"],
] as const;
for (const command of commands) {
  const env = command[2] === "test" ? { ...Bun.env, RELAY_REQUIRE_MCP_FIXTURES: "1" } : Bun.env;
  const proc = Bun.spawnSync([...command], { stdout: "inherit", stderr: "inherit", env });
  if (proc.exitCode !== 0) { console.error(`Conformance failed: ${command.join(" ")}`); process.exit(proc.exitCode); }
}
console.log(JSON.stringify({ platform: process.platform, arch: process.arch, runtime: Bun.version, status: "pass", commands: commands.map((command) => command.join(" ")) }, null, 2));
