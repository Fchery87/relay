import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrustStore } from "./trust";

describe("TrustStore", () => {
  test("unknown project reports unknown, decisions persist across instances", async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-trust-"));
    const store = new TrustStore({ daemonHome: home });
    expect(await store.get("/repo")).toBe("unknown");
    await store.set("/repo", "trusted");
    expect(await new TrustStore({ daemonHome: home }).get("/repo")).toBe("trusted");
  });

  test("untrusted decision persists and is distinguishable from unknown", async () => {
    const home = await mkdtemp(join(tmpdir(), "relay-trust-"));
    const store = new TrustStore({ daemonHome: home });
    await store.set("/repo", "untrusted");
    expect(await store.get("/repo")).toBe("untrusted");
  });
});
