import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { ThreadMessages, ThreadRunControls } from "./thread-messages";

test("renders queued user messages as visibly pending", () => {
  const markup = renderToStaticMarkup(<ThreadMessages messages={[
    { _id: "message-1", content: "change direction", role: "user", status: "queued" },
  ]} />);
  expect(markup).toContain("change direction");
  expect(markup).toContain("Queued");
  expect(markup).toContain("message-pending");
  expect(markup).toContain('role="log"');
  expect(markup).toContain('aria-live="polite"');
  expect(markup).toContain('role="status"');
});

test("renders Stop only for a running turn and disables it while the request is pending", () => {
  const running = renderToStaticMarkup(<ThreadRunControls onStop={async () => undefined} status="running" stopRequested={false} />);
  const stopping = renderToStaticMarkup(<ThreadRunControls onStop={async () => undefined} status="running" stopRequested />);
  const idle = renderToStaticMarkup(<ThreadRunControls onStop={async () => undefined} status="stopped" stopRequested={false} />);
  expect(running).toContain("Stop");
  expect(stopping).toContain("Stopping...");
  expect(stopping).toContain("disabled");
  expect(idle).not.toContain("Stop");
  expect(idle).toContain("Awaiting input");
  expect(renderToStaticMarkup(<ThreadRunControls onStop={async () => undefined} status="restoring" stopRequested={false} />)).toContain("Restoring...");
});

test("renders a restore action beside the assistant turn that owns a checkpoint", () => {
  const markup = renderToStaticMarkup(<ThreadMessages
    checkpoints={[{ _id: "checkpoint-1", messageId: "message-1" }]}
    messages={[{ _id: "message-1", content: "Implemented the change", role: "assistant", status: "complete" }]}
    onRestore={async () => undefined}
  />);
  expect(markup).toContain("Implemented the change");
  expect(markup).toContain("Restore");
  expect(markup).toContain('aria-label="Restore checkpoint for this turn"');
});

test("virtualizes a long thread instead of mounting every message row", () => {
  const markup = renderToStaticMarkup(<ThreadMessages messages={Array.from({ length: 100 }, (_, index) => ({
    _id: `message-${index}`,
    content: `message ${index}`,
    role: "assistant" as const,
    status: "complete" as const,
  }))} />);

  expect(markup).toContain('data-virtual-list="true"');
  expect(markup).toContain("message 0");
  expect(markup).not.toContain("message 40");
});
