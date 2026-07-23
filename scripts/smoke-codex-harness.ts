if (Bun.env.RELAY_E2E_CODEX !== "1") {
  console.info("Skipping real Codex harness smoke; set RELAY_E2E_CODEX=1 to opt in.");
  process.exit(0);
}

const child = Bun.spawn(["bun", "test", "apps/daemon/src/codex-harness.e2e.test.ts"], {
  env: { ...Bun.env, RELAY_E2E_CODEX: "1", RELAY_CODEX_ENABLED: "1" },
  stderr: "inherit",
  stdout: "inherit",
});
process.exit(await child.exited);
