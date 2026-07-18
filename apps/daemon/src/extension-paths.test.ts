import { describe, expect, test } from "bun:test";
import { resolveExtensionRoots } from "./extension-paths";

describe("resolveExtensionRoots", () => {
  test("trusted project yields project scope before user scope", () => {
    expect(resolveExtensionRoots({ daemonHome: "/home/u/.config/relay", kind: "commands", projectRoot: "/repo", projectTrusted: true })).toEqual([
      { root: "/repo/.relay/commands", scope: "project" },
      { root: "/home/u/.config/relay/commands", scope: "user" },
    ]);
  });

  test("untrusted project yields user scope only", () => {
    expect(resolveExtensionRoots({ daemonHome: "/home/u/.config/relay", kind: "skills", projectRoot: "/repo", projectTrusted: false })).toEqual([
      { root: "/home/u/.config/relay/skills", scope: "user" },
    ]);
  });
});
