const extension = process.platform === "win32" ? ".exe" : "";
const binaryPath = Bun.env.RELAY_SMOKE_BINARY ?? `dist/relay${extension}`;
const child = Bun.spawn([binaryPath, "--help"], { stderr: "inherit", stdout: "inherit" });
if ((await child.exited) !== 0) throw new Error(`Daemon smoke test failed: ${binaryPath}`);
