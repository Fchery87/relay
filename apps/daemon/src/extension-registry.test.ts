import { expect, test } from "bun:test";
import { ExtensionRegistry } from "./extension-registry";
const manifest = { id: "sample.extension", version: "1.0.0", apiVersion: 1 as const, trust: "user" as const, contributions: ["tool" as const] };
test("extension registry validates, versions and revokes manifests", () => { const registry = new ExtensionRegistry(); registry.install(manifest); expect(registry.list()).toHaveLength(1); expect(() => registry.install(manifest)).toThrow("already installed"); registry.revoke(manifest.id); expect(registry.list()).toHaveLength(0); expect(registry.uninstall(manifest.id)).toBe(true); });
