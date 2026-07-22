import { describe, expect, test } from "bun:test";
import { MutableReactorRegistry } from "@relay/orchestration";
import type { EffectReactor } from "@relay/contracts";

describe("reactor registry cross-tier wiring", () => {
  test("registers a provider reactor and builds a valid registry", () => {
    const registry = new MutableReactorRegistry();

    const reactor: EffectReactor = {
      execute: async () => [],
      recover: async () => [],
    };

    registry.register("provider.send_turn", reactor);
    const built = registry.build();
    expect(built["provider.send_turn"]).toBe(reactor);
  });

  test("rejects duplicate reactor registration", () => {
    const registry = new MutableReactorRegistry();
    const reactor: EffectReactor = {
      execute: async () => [],
      recover: async () => [],
    };

    registry.register("provider.send_turn", reactor);
    expect(() => registry.register("provider.send_turn", reactor)).toThrow(
      "Reactor already registered",
    );
  });

  test("build returns empty for unregistered kinds", () => {
    const registry = new MutableReactorRegistry();
    const built = registry.build();
    expect(built["provider.send_turn"]).toBeUndefined();
  });
});
