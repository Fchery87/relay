import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { WorkspaceSidebar } from "./workspace-sidebar";

const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("mirrors the canonical Relay Switchboard tokens in production CSS", () => {
  const requiredTokens = [
    "--color-canvas: #0A0A0B",
    "--color-surface: #111213",
    "--color-surface-raised: #17181A",
    "--color-surface-hover: #1D1F21",
    "--color-border: #26282B",
    "--color-border-strong: #34373B",
    "--color-on-surface: #EDEEEC",
    "--color-on-surface-muted: #A3A7A3",
    "--color-on-surface-subtle: #6F7472",
    "--color-primary: #6FBFB4",
    "--color-accent: #8FD4C9",
    "--color-brass: #C7A95D",
    "--color-on-brass: #171207",
    "--color-success: #77A681",
    "--color-warning: #C58D58",
    "--color-error: #C8726B",
    "--color-info: #7E9F97",
    "--rounded-sm: 5px",
    "--rounded-md: 7px",
    "--rounded-lg: 10px",
    "--space-control-compact: 32px",
    "--space-control-comfortable: 40px",
    "--space-row-compact: 28px",
    "--space-row-comfortable: 36px",
  ];

  for (const token of requiredTokens) {
    expect(css).toContain(token);
  }
});

test("exposes the Relay vector identity at the shell seam", () => {
  const markup = renderToStaticMarkup(<WorkspaceSidebar activeProjectId={undefined} attention={[]} projects={[]} renderRuns={() => null} />);

  expect(markup).toContain("<svg");
  expect(markup).toContain('aria-label="Relay"');
  expect(markup).toContain('data-relay-mark="switchboard"');
});

test("implements density, responsive, focus, and motion behavior without decorative effects", () => {
  expect(css).toContain('[data-density="comfortable"]');
  expect(css).toContain("@media (max-width: 1040px)");
  expect(css).toContain("@media (max-width: 720px)");
  expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.tool-surface\[data-mobile-open="false"\]\s*{[^}]*display: none;/);
  expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.app-shell\s*{[^}]*grid-template-rows: auto minmax\(0, 1fr\);/);
  expect(css).toMatch(/\.thread-workbench\s*{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(280px, 336px\);/);
  expect(css).toMatch(/\.thread-view\s*{[^}]*min-width: 0;[^}]*width: 100%;/);
  expect(css).toMatch(/\.handoff-trace\s*{[^}]*min-width: 0;[^}]*width: 100%;/);
  expect(css).toMatch(/\.message > span:first-of-type\s*{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
  expect(css).toMatch(/\.composer textarea\s*{[^}]*min-width: 0;/);
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  expect(css).toContain(":focus-visible");
  expect(css).not.toContain("linear-gradient");
  expect(css).not.toContain("radial-gradient");
  expect(css).not.toContain("backdrop-filter");
  expect(css).toMatch(/\.relay-mark-rail,[\s\S]*?stroke: currentColor;/);
});

test("ships the Relay mark as the browser identity", () => {
  expect(indexHtml).toContain('rel="icon" href="/relay-mark.svg"');
  expect(indexHtml).toContain('name="theme-color" content="#0A0A0B"');
  expect(indexHtml).toContain("Relay Workbench");
});
