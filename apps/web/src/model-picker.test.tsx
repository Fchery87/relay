import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MODEL_CATALOG } from "@relay/shared";

import { groupModelsByProvider } from "./model-utils";
import { ModelPicker } from "./model-picker";

test("groups catalog models by provider preserving catalog order", () => {
  const groups = groupModelsByProvider(MODEL_CATALOG.models);
  expect(groups.length).toBeGreaterThan(0);
  const providers = groups.map((group) => group.provider);
  expect(new Set(providers).size).toBe(providers.length);
  for (const group of groups) {
    expect(group.models.length).toBeGreaterThan(0);
    for (const model of group.models) expect(model.provider).toBe(group.provider);
  }
});

test("trigger shows the active model name", () => {
  const model = MODEL_CATALOG.models[0]!;
  const markup = renderToStaticMarkup(
    <ModelPicker modelId={model.id} onChange={async () => {}} thinkingLevel="none" />,
  );
  expect(markup).toContain(model.name);
  expect(markup).toContain('aria-haspopup="listbox"');
  expect(markup).not.toContain('role="listbox"');
});

test("open popover lists provider groups without a thinking section", () => {
  const model = MODEL_CATALOG.models.find((entry) => entry.id === MODEL_CATALOG.defaultModelId)!;
  const markup = renderToStaticMarkup(
    <ModelPicker defaultOpen modelId={model.id} onChange={async () => {}} thinkingLevel="none" />,
  );
  expect(markup).toContain('role="listbox"');
  expect(markup).toContain(model.provider.toUpperCase());
  // Thinking is now a separate ReasoningVariantPicker, not inside the model popover
  expect(markup).not.toContain("Thinking");
});
