import { expect, test } from "bun:test";
import { ExtensionRegistry } from "./extension-registry";
import type { ExtensionContribution } from "@relay/contracts";

const fullContributions: readonly ExtensionContribution[] = ["skill", "command", "tool", "hook", "provider", "renderer", "role", "workflow"];

test("external extension lifecycle supports install upgrade revoke uninstall", () => {
  const registry = new ExtensionRegistry();
  registry.install({ id: "fixture.sample", version: "1.0.0", apiVersion: 1, trust: "user", contributions: ["skill", "tool", "renderer"] });
  registry.install({ id: "fixture.sample", version: "1.1.0", apiVersion: 1, trust: "user", contributions: ["skill", "tool", "renderer"] });
  expect(registry.get("fixture.sample")?.version).toBe("1.1.0");
  registry.revoke("fixture.sample"); expect(registry.list()).toHaveLength(0);
  expect(registry.uninstall("fixture.sample")).toBe(true);
});

test("a fixture extension adds all contribution kinds without modifying Relay core", () => {
  const registry = new ExtensionRegistry();
  registry.install({ id: "full.fixture", version: "1.0.0", apiVersion: 1, trust: "user", contributions: fullContributions });
  const installed = registry.get("full.fixture");
  expect(installed).toBeDefined();
  expect(installed!.contributions).toEqual(fullContributions);
  expect(registry.list()).toHaveLength(1);
});

test("duplicate contribution kinds are rejected", () => {
  expect(() => new ExtensionRegistry().install({ id: "dup.test", version: "1.0.0", apiVersion: 1, trust: "user", contributions: ["tool", "tool"] })
  ).toThrow("Duplicate");
});

test("revoked extension is hidden from list but queryable by id for historical run references", () => {
  const registry = new ExtensionRegistry();
  registry.install({ id: "history.test", version: "1.0.0", apiVersion: 1, trust: "user", contributions: ["skill"] });
  registry.revoke("history.test");
  expect(registry.list()).toHaveLength(0);
  // Historical runs can still look up the old manifest by id
  expect(registry.get("history.test")).toBeDefined();
  expect(registry.get("history.test")!.revoked).toBe(true);
  // Uninstalling removes the historical reference
  expect(registry.uninstall("history.test")).toBe(true);
  expect(registry.get("history.test")).toBeUndefined();
});

test("conflicting versions reject downgrade", () => {
  const registry = new ExtensionRegistry();
  registry.install({ id: "conflict.test", version: "2.0.0", apiVersion: 1, trust: "user", contributions: ["tool"] });
  // Same version is rejected
  expect(() => registry.install({ id: "conflict.test", version: "2.0.0", apiVersion: 1, trust: "user", contributions: ["tool"] })
  ).toThrow("already installed");
  // Upgrade works
  registry.install({ id: "conflict.test", version: "2.1.0", apiVersion: 1, trust: "user", contributions: ["tool", "skill"] });
  expect(registry.get("conflict.test")?.version).toBe("2.1.0");
  expect(registry.get("conflict.test")?.contributions).toEqual(["tool", "skill"]);
});

test("invalid extension ids are rejected", () => {
  expect(() => new ExtensionRegistry().install({ id: "", version: "1.0.0", apiVersion: 1, trust: "user", contributions: ["tool"] })
  ).toThrow(/id/);
  expect(() => new ExtensionRegistry().install({ id: "UPPERCASE", version: "1.0.0", apiVersion: 1, trust: "user", contributions: ["tool"] })
  ).toThrow(/id/);
});

test("invalid extension versions are rejected", () => {
  expect(() => new ExtensionRegistry().install({ id: "valid.id", version: "1.0", apiVersion: 1, trust: "user", contributions: ["tool"] })
  ).toThrow(/version/);
});

test("unsupported api versions are rejected", () => {
  expect(() => new ExtensionRegistry().install({ id: "valid.id", version: "1.0.0", apiVersion: 2 as any, trust: "user", contributions: ["tool"] })
  ).toThrow(/manifest/);
});

test("an old run referencing a removed extension returns undefined", () => {
  const registry = new ExtensionRegistry();
  registry.install({ id: "removed.ext", version: "1.0.0", apiVersion: 1, trust: "user", contributions: ["skill"] });
  expect(registry.uninstall("removed.ext")).toBe(true);
  // Old run referencing the removed extension:
  expect(registry.get("removed.ext")).toBeUndefined();
});
