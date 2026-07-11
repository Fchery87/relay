import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ModelControls } from "./model-controls";

test("renders the selected model and only its supported thinking levels", () => {
  const markup = renderToStaticMarkup(<ModelControls modelId="deepseek/deepseek-chat" onChange={async () => undefined} thinkingLevel="none" />);
  expect(markup).toContain("DeepSeek Chat");
  expect(markup).toContain("GPT-5 mini");
  expect(markup).toContain("None");
  expect(markup).not.toContain(">High<");
});

test("renders reasoning levels for a reasoning-capable model", () => {
  const markup = renderToStaticMarkup(<ModelControls modelId="openai/gpt-5-mini" onChange={async () => undefined} thinkingLevel="high" />);
  expect(markup).toContain("Low");
  expect(markup).toContain("Medium");
  expect(markup).toContain("High");
});
