import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { listThinkingLevels, MODEL_CATALOG } from "@relay/shared";

import { ReasoningVariantPicker } from "./reasoning-variant-picker";

test("all catalog models have at least two thinking levels so the picker never hides", () => {
  // With the v4 model migration every catalog model supports ≥2 thinking levels.
  // The "hide when single level" code path still exists but cannot be reached
  // through the production catalog. This test confirms the invariant.
  for (const entry of MODEL_CATALOG.models) {
    expect(listThinkingLevels(entry).length).toBeGreaterThanOrEqual(2);
  }
});

test("trigger shows the active level label for a multi-level model", () => {
  const model = MODEL_CATALOG.models.find((entry) => entry.id === "openai/gpt-5-mini");
  if (!model) throw new Error("Catalog needs gpt-5-mini to test");
  const markup = renderToStaticMarkup(
    <ReasoningVariantPicker modelId={model.id} onChange={async () => {}} thinkingLevel="medium" />,
  );
  expect(markup).toContain("Medium");
  expect(markup).toContain('aria-haspopup="listbox"');
  expect(markup).not.toContain('role="listbox"');
});

test("open popover lists all supported levels with descriptions", () => {
  const model = MODEL_CATALOG.models.find((entry) => listThinkingLevels(entry).length > 1);
  if (!model) throw new Error("Catalog needs at least one multi-thinking-level model to test");
  const levels = listThinkingLevels(model);
  const markup = renderToStaticMarkup(
    <ReasoningVariantPicker defaultOpen modelId={model.id} onChange={async () => {}} thinkingLevel="none" />,
  );
  expect(markup).toContain('role="listbox"');
  expect(markup).toContain("Reasoning variants");
  for (const level of levels) {
    // Each level should appear at least once in the popover (as a label)
    const label = level === "none" ? "Standard" : level.charAt(0).toUpperCase() + level.slice(1);
    expect(markup).toContain(label);
  }
});

test("disabled picker does not render a popover", () => {
  const model = MODEL_CATALOG.models.find((entry) => listThinkingLevels(entry).length > 1)!;
  const markup = renderToStaticMarkup(
    <ReasoningVariantPicker defaultOpen disabled modelId={model.id} onChange={async () => {}} thinkingLevel="high" />,
  );
  expect(markup).toContain("High");
  expect(markup).not.toContain('role="listbox"');
});
