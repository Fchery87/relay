import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";

import { HandoffTrace } from "./handoff-trace";
import { WorkbenchTabs } from "./workbench-tabs";
import { WorkspaceSidebar } from "./workspace-sidebar";

const appSource = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const threadSource = readFileSync(new URL("./thread-view.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");

test("uses task and operations language across the shell", () => {
  const sidebar = renderToStaticMarkup(
    <WorkspaceSidebar
      activeProjectId="project-1"
      attention={[{ kind: "approval", projectId: "project-1", projectName: "relay", threadId: "t1", title: "Fix auth" }]}
      projects={[{ id: "project-1", machineId: "machine-1", machineName: "workstation-14", name: "relay", path: "/workspace/relay", presence: "online" }]}
      renderRuns={() => null}
    />,
  );
  const tabs = renderToStaticMarkup(<WorkbenchTabs active="session" onChange={() => undefined} showPlan />);
  const workflow = renderToStaticMarkup(<HandoffTrace currentStage="execute" />);

  expect(sidebar).toContain("Needs you");
  expect(sidebar).toContain("Projects");
  expect(sidebar).toContain("Settings");
  expect(tabs).toContain("Session");
  expect(tabs).toContain("Changes");
  expect(tabs).not.toContain("Terminal");
  expect(tabs).not.toContain("Connections");
  expect(workflow).toContain("Execute");
  expect(workflow).toContain('aria-current="step"');
});

test("implements the slim run bar, task canvas, inspector, and composer selectors", () => {
  expect(appSource).toContain("CommandPalette");
  expect(appSource).toContain("useShellState");
  expect(threadSource).toContain('className="run-bar"');
  expect(threadSource).toContain('aria-label="Task canvas"');
  expect(threadSource).toContain('id="workbench-panel"');
  expect(threadSource).toContain('role="tabpanel"');
  expect(threadSource).toContain("TerminalDrawer");
  expect(threadSource).toContain("InspectorPanel");
  expect(threadSource).toContain('aria-label="Context inspector"');
  expect(threadSource).toContain("Composer");
});

test("ships shell toggles, inspector collapse, and drawer styling", () => {
  expect(css).toMatch(/\.thread-workbench\s*{[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(280px, 336px\);/);
  expect(css).toMatch(/\.thread-workbench\[data-inspector-open="false"\]\s*{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  expect(css).toMatch(/\.app-shell\[data-sidebar-open="false"\]\s*{[^}]*grid-template-columns: minmax\(0, 1fr\);/);
  expect(css).toContain(".run-bar");
  expect(css).toContain(".terminal-drawer");
  expect(css).toContain(".command-palette");
  expect(css).toContain(".needs-you");
  expect(css).toContain(".settings-layout");
});
