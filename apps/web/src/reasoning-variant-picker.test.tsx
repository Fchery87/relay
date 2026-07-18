import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { listThinkingLevels, MODEL_CATALOG } from "@relay/shared";

import { ReasoningVariantPicker } from "./reasoning-variant-picker";

test("hides when the model supports only one thinking level", () => {
  const singleLevelModel = MODEL_CATALOG.models.find((entry) => listThinkingLevels(entry).length <= 1);
  if (!singleLevelModel) throw new Error("Catalog needs at least one single-thinking-level model to test");
  const markup = renderToStaticMarkup(
    <ReasoningVariantPicker modelId={singleLevelModel.id} onChange={async () => {}} thinkingLevel="none" />,
  );
  expect(markup).toBe("");
});

test("trigger shows the active level label for a multi-level model", () => {
  const model = MODEL_CATALOG.models.find((entry) => listThinkingLevels(entry).length > 1);
  if (!model) throw new Error("Catalog needs at least one multi-thinking-level model to test");
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
