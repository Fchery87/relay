import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { MachineSidebar } from "./machine-sidebar";

const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("mirrors the canonical Relay Switchboard tokens in production CSS", () => {
  const requiredTokens = [
    "--color-canvas: #0D100E",
    "--color-surface: #131714",
    "--color-surface-raised: #1A1F1B",
    "--color-surface-hover: #222820",
    "--color-border: #2C332D",
    "--color-border-strong: #424B42",
    "--color-on-surface: #F0F0E8",
    "--color-on-surface-muted: #A8AA9F",
    "--color-on-surface-subtle: #7D8277",
    "--color-primary: #C7A95D",
    "--color-accent: #E1C779",
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

test("exposes the Relay vector identity and density preference at the shell seam", () => {
  const markup = renderToStaticMarkup(<MachineSidebar machines={[]} now={0} />);

  expect(markup).toContain("<svg");
  expect(markup).toContain('aria-label="Relay"');
  expect(markup).toContain('data-relay-mark="switchboard"');
  expect(markup).toContain("Compact");
  expect(markup).toContain("Comfortable");
  expect(markup).toContain('aria-pressed="true"');
});

test("implements density, responsive, focus, and motion behavior without decorative effects", () => {
  expect(css).toContain('[data-density="comfortable"]');
  expect(css).toContain("@media (max-width: 1040px)");
  expect(css).toContain("@media (max-width: 720px)");
  expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.machine-list\[data-mobile-open="false"\]\s*{[^}]*display: none;/);
  expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.tool-surface\[data-mobile-open="false"\]\s*{[^}]*display: none;/);
  expect(css).toMatch(/@media \(max-width: 720px\)[\s\S]*?\.app-shell\s*{[^}]*grid-template-rows: auto minmax\(0, 1fr\);/);
  expect(css).toMatch(/\.thread-workbench\s*{[^}]*grid-template-columns: minmax\(0, 1\.18fr\) minmax\(0, 0\.82fr\);/);
  expect(css).toMatch(/\.thread-view\s*{[^}]*min-width: 0;[^}]*width: 100%;/);
  expect(css).toMatch(/\.thread-toolbar\s*{[^}]*max-width: 100%;[^}]*min-width: 0;[^}]*overflow-x: auto;/);
  expect(css).toMatch(/\.handoff-trace\s*{[^}]*min-width: 0;[^}]*width: 100%;/);
  expect(css).toMatch(/\.message > span:first-of-type\s*{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/);
  expect(css).toMatch(/\.composer textarea\s*{[^}]*min-width: 0;/);
  expect(css).toMatch(/@media \(max-width: 1040px\)[\s\S]*?\.thread-header\s*{[^}]*flex-direction: column;/);
  expect(css).toContain("@media (prefers-reduced-motion: reduce)");
  expect(css).toContain(":focus-visible");
  expect(css).not.toContain("linear-gradient");
  expect(css).not.toContain("radial-gradient");
  expect(css).not.toContain("backdrop-filter");
  expect(css).toMatch(/\.relay-mark-rail,[\s\S]*?stroke: currentColor;/);
});

test("ships the Relay mark as the browser identity", () => {
  expect(indexHtml).toContain('rel="icon" href="/relay-mark.svg"');
  expect(indexHtml).toContain('name="theme-color" content="#0D100E"');
  expect(indexHtml).toContain("Relay Workbench");
});
