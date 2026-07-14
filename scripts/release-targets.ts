export const releaseTargets = [
  { bunTarget: "bun-darwin-arm64", fileName: "relay-darwin-arm64" },
  { bunTarget: "bun-darwin-x64", fileName: "relay-darwin-x64" },
  { bunTarget: "bun-linux-arm64", fileName: "relay-linux-arm64" },
  { bunTarget: "bun-linux-x64-baseline", fileName: "relay-linux-x64" },
  { bunTarget: "bun-windows-x64-baseline", fileName: "relay-windows-x64.exe" },
] as const;
