import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_MODEL_ID } from "@relay/shared";

import { Composer } from "./composer";

const noop = async () => {};

function render(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  return renderToStaticMarkup(
    <Composer
      attachmentError={undefined}
      attachments={[]}
      content=""
      isPlanRun={false}
      isSubmitting={false}
      modelId={DEFAULT_MODEL_ID}
      onAttachFiles={noop}
      onContentChange={() => {}}
      onModelChange={noop}
      onPermissionChange={noop}
      onRemoveAttachment={() => {}}
      onSubmit={noop}
      permissionProfile="workspace-write"
      receipt={undefined}
      status="idle"
      thinkingLevel="none"
      {...overrides}
    />,
  );
}

test("idle composer offers model and access pickers plus attach and send", () => {
  const markup = render();
  expect(markup).toContain("Tell Relay what to do next");
  expect(markup).toContain('aria-label="Model"');
  expect(markup).toContain('aria-label="Access"');
  expect(markup).toContain("Add context");
  expect(markup).toContain(">Run<");
  expect(markup).not.toContain("Directive</label>");
  expect(markup).not.toContain("Scope · worktree");
});

test("running turns lock access and switch send to steering", () => {
  const markup = render({ status: "running" });
  expect(markup).toContain("Steer Relay at the next safe boundary");
  expect(markup).toContain("Queue steering");
  expect(markup).toContain("Locked while a turn is running");
});

test("plan runs show the plan pair instead of the model picker", () => {
  const markup = render({ isPlanRun: true });
  expect(markup).toContain("Plan pair");
  expect(markup).not.toContain('aria-label="Model"');
});

test("attachments render with remove affordances and errors surface", () => {
  const markup = render({
    attachmentError: "too big",
    attachments: [{ content: "x", name: "notes.md" }],
  });
  expect(markup).toContain("notes.md");
  expect(markup).toContain("Remove notes.md");
  expect(markup).toContain("too big");
});
